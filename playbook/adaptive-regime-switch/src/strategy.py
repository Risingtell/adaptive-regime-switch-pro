"""Adaptive Regime Switch Pro — Nautilus replay strategy.

Regime-gated trend follower for BTC perpetual futures on hourly bars.

On every bar the strategy classifies the market into one of three regimes and
only takes directional risk in the trending regime:

  TREND    -> directional-strength reading is high and price agrees with the
              long-horizon trend filter. Breakouts are traded in the trend
              direction.
  RANGE    -> directional strength is weak. Stand aside (fading has no edge).
  RISK_OFF -> volatility is extreme. Refuse to open new risk.

Risk stack: volatility-scaled trailing stop, persistence buffer (hysteresis) on
the trend-strength reading, cooldown after a stop-out, inverse-volatility
position sizing, and a strategy-capital drawdown circuit breaker.

All indicators are computed incrementally (Wilder smoothing) from closed bars,
so the decision on each bar uses only information available at that bar's close.
"""

import json
from collections import deque
from decimal import Decimal
from pathlib import Path
from typing import Optional

from nautilus_trader.config import StrategyConfig
from nautilus_trader.model.data import Bar, BarType
from nautilus_trader.model.enums import OrderSide, TimeInForce
from nautilus_trader.model.identifiers import InstrumentId
from nautilus_trader.model.instruments import Instrument
from nautilus_trader.model.objects import Quantity
from nautilus_trader.trading.strategy import Strategy


class RegimeSwitchConfig(StrategyConfig):
    instrument_id: Optional[InstrumentId] = None
    bar_type: Optional[BarType] = None
    instrument_ids: tuple[InstrumentId, ...] = ()
    bar_types: tuple[BarType, ...] = ()

    leverage: int = 3
    margin_budget: str = "100"
    adx_period: int = 14
    atr_period: int = 14
    ema_trend_period: int = 200
    donchian_period: int = 20
    adx_enter: float = 22.0
    adx_exit: float = 18.0
    vol_riskoff: float = 0.030
    atr_stop_mult: float = 2.0
    atr_trail_mult: float = 3.0
    cooldown_bars: int = 12
    breaker_dd: float = 0.15
    breaker_cooldown: int = 48
    ref_vol: float = 0.010
    taker_fee: float = 0.0005


class RegimeSwitchStrategy(Strategy):
    def __init__(self, config: RegimeSwitchConfig) -> None:
        super().__init__(config)
        self.cfg = config
        self._instrument: Optional[Instrument] = None

        # rolling history for the donchian channel (prior bars only)
        self._highs: deque[float] = deque(maxlen=config.donchian_period)
        self._lows: deque[float] = deque(maxlen=config.donchian_period)

        # previous bar values for true-range / directional movement
        self._prev_close: Optional[float] = None
        self._prev_high: Optional[float] = None
        self._prev_low: Optional[float] = None

        # Wilder-smoothed accumulators
        self._atr: Optional[float] = None
        self._tr_smooth: Optional[float] = None
        self._plus_dm_smooth: Optional[float] = None
        self._minus_dm_smooth: Optional[float] = None
        self._adx: Optional[float] = None
        self._seed_count: int = 0
        self._tr_seed: float = 0.0
        self._plus_seed: float = 0.0
        self._minus_seed: float = 0.0

        self._ema: Optional[float] = None
        self._dx_seed_vals: list[float] = []

        # position state
        self._pos: str = "NONE"
        self._entry_price: float = 0.0
        self._qty: float = 0.0
        self._stop_px: float = 0.0
        self._bar_index: int = 0
        self._cooldown_until: int = 0

        # circuit breaker on strategy risk capital
        try:
            base = float(config.margin_budget) * float(config.leverage)
        except (TypeError, ValueError):
            base = 300.0
        self._risk_base: float = base if base > 0 else 300.0
        self._realized: float = 0.0
        self._peak_realized: float = 0.0
        self._breaker_until: int = 0

        # diagnostics (written to output/diag.json on stop)
        self._diag = {
            "bars": 0,
            "warm_bars": 0,
            "regime_trend": 0,
            "regime_range": 0,
            "regime_riskoff": 0,
            "entries": 0,
            "entries_long": 0,
            "entries_short": 0,
            "first_entry_bar": None,
            "last_entry_bar": None,
            "max_adx": 0.0,
        }

    # ------------------------------------------------------------------ setup
    def on_start(self) -> None:
        bar_type = self.cfg.bar_type or (
            self.cfg.bar_types[0] if self.cfg.bar_types else None
        )
        instrument_id = self.cfg.instrument_id or (
            self.cfg.instrument_ids[0] if self.cfg.instrument_ids else None
        )
        if bar_type is None or instrument_id is None:
            raise RuntimeError("bar_type and instrument_id must be set")
        self._instrument = self.cache.instrument(instrument_id)
        self.subscribe_bars(bar_type)

    # ------------------------------------------------------------- indicators
    @staticmethod
    def _update_ema(prev: Optional[float], value: float, period: int) -> float:
        if prev is None:
            return value
        alpha = 2.0 / (period + 1)
        return alpha * value + (1.0 - alpha) * prev

    def _update_indicators(self, high: float, low: float, close: float) -> None:
        """Incremental Wilder ATR + ADX and a long-horizon EMA."""
        self._ema = self._update_ema(self._ema, close, self.cfg.ema_trend_period)

        if self._prev_close is None:
            self._prev_close, self._prev_high, self._prev_low = close, high, low
            return

        tr = max(
            high - low,
            abs(high - self._prev_close),
            abs(low - self._prev_close),
        )
        up_move = high - self._prev_high
        down_move = self._prev_low - low
        plus_dm = up_move if (up_move > down_move and up_move > 0) else 0.0
        minus_dm = down_move if (down_move > up_move and down_move > 0) else 0.0

        n = self.cfg.atr_period
        if self._atr is None:
            # seed period of simple sums before switching to Wilder smoothing
            self._seed_count += 1
            self._tr_seed += tr
            self._plus_seed += plus_dm
            self._minus_seed += minus_dm
            if self._seed_count >= n:
                self._atr = self._tr_seed / n
                self._tr_smooth = self._tr_seed
                self._plus_dm_smooth = self._plus_seed
                self._minus_dm_smooth = self._minus_seed
        else:
            self._atr = (self._atr * (n - 1) + tr) / n
            self._tr_smooth = self._tr_smooth - (self._tr_smooth / n) + tr
            self._plus_dm_smooth = (
                self._plus_dm_smooth - (self._plus_dm_smooth / n) + plus_dm
            )
            self._minus_dm_smooth = (
                self._minus_dm_smooth - (self._minus_dm_smooth / n) + minus_dm
            )

        # directional index + Wilder-smoothed ADX
        if self._tr_smooth and self._tr_smooth > 0:
            plus_di = 100.0 * (self._plus_dm_smooth / self._tr_smooth)
            minus_di = 100.0 * (self._minus_dm_smooth / self._tr_smooth)
            di_sum = plus_di + minus_di
            if di_sum > 0:
                dx = 100.0 * abs(plus_di - minus_di) / di_sum
                if self._adx is None:
                    self._dx_seed_vals.append(dx)
                    if len(self._dx_seed_vals) >= n:
                        self._adx = sum(self._dx_seed_vals) / len(self._dx_seed_vals)
                else:
                    self._adx = (self._adx * (n - 1) + dx) / n

        self._prev_close, self._prev_high, self._prev_low = close, high, low

    # ----------------------------------------------------------------- sizing
    def _position_qty(self, close: float, atr: float) -> float:
        """Inverse-volatility sizing, bounded, on the configured risk capital."""
        if close <= 0:
            return 0.0
        vol = atr / close if close > 0 else self.cfg.ref_vol
        if vol <= 0:
            vol = self.cfg.ref_vol
        scale = self.cfg.ref_vol / vol
        scale = max(0.4, min(2.0, scale))
        notional = self._risk_base * scale
        qty = notional / close
        step = 0.001
        qty = round(qty / step) * step
        if qty < step:
            qty = step
        return qty

    # -------------------------------------------------------------------- core
    def on_bar(self, bar: Bar) -> None:
        self._bar_index += 1
        high = float(bar.high)
        low = float(bar.low)
        close = float(bar.close)

        # donchian channel from PRIOR bars only (no look-ahead)
        prior_high = max(self._highs) if len(self._highs) == self._highs.maxlen else None
        prior_low = min(self._lows) if len(self._lows) == self._lows.maxlen else None

        self._update_indicators(high, low, close)

        instrument = self._instrument
        if instrument is None:
            self._highs.append(high)
            self._lows.append(low)
            return

        # manage an open position first (stops / regime exit)
        if self._pos != "NONE":
            self._manage_open(instrument, high, low, close)

        # entry logic only when warmed up and flat
        warm = self._adx is not None and self._ema is not None and self._atr is not None
        self._diag["bars"] += 1
        if warm:
            self._diag["warm_bars"] += 1
            if (self._adx or 0.0) > self._diag["max_adx"]:
                self._diag["max_adx"] = round(self._adx or 0.0, 2)
            reg = self._regime(close)
            if reg == "TREND":
                self._diag["regime_trend"] += 1
            elif reg == "RANGE":
                self._diag["regime_range"] += 1
            else:
                self._diag["regime_riskoff"] += 1
        if (
            self._pos == "NONE"
            and warm
            and prior_high is not None
            and prior_low is not None
            and self._bar_index >= self._cooldown_until
            and self._bar_index >= self._breaker_until
        ):
            self._maybe_enter(instrument, close, prior_high, prior_low)

        # update rolling window AFTER decisions so breakout used prior bars
        self._highs.append(high)
        self._lows.append(low)

    def _regime(self, close: float) -> str:
        atr = self._atr or 0.0
        adx = self._adx or 0.0
        vol = (atr / close) if close > 0 else 0.0
        if vol >= self.cfg.vol_riskoff:
            return "RISK_OFF"
        if adx >= self.cfg.adx_enter:
            return "TREND"
        return "RANGE"

    def _maybe_enter(
        self, instrument: Instrument, close: float, prior_high: float, prior_low: float
    ) -> None:
        if self._regime(close) != "TREND":
            return
        ema = self._ema or close
        atr = self._atr or 0.0
        if atr <= 0:
            return

        long_ok = close > prior_high and close > ema
        short_ok = close < prior_low and close < ema
        if not (long_ok or short_ok):
            return

        qty = self._position_qty(close, atr)
        if qty <= 0:
            return
        quantity = Quantity(Decimal(f"{qty:.3f}"), instrument.size_precision)

        if long_ok:
            self._submit(instrument.id, OrderSide.BUY, quantity)
            self._pos = "LONG"
            self._stop_px = close - self.cfg.atr_stop_mult * atr
            self._diag["entries_long"] += 1
        else:
            self._submit(instrument.id, OrderSide.SELL, quantity)
            self._pos = "SHORT"
            self._stop_px = close + self.cfg.atr_stop_mult * atr
            self._diag["entries_short"] += 1
        self._entry_price = close
        self._qty = qty
        self._diag["entries"] += 1
        if self._diag["first_entry_bar"] is None:
            self._diag["first_entry_bar"] = self._bar_index
        self._diag["last_entry_bar"] = self._bar_index

    def _manage_open(
        self, instrument: Instrument, high: float, low: float, close: float
    ) -> None:
        atr = self._atr or 0.0
        adx = self._adx or 0.0

        if self._pos == "LONG":
            # trail the stop up as price advances
            new_stop = close - self.cfg.atr_trail_mult * atr
            if new_stop > self._stop_px:
                self._stop_px = new_stop
            stopped = low <= self._stop_px
            regime_lost = adx < self.cfg.adx_exit or close < (self._ema or close)
            if stopped or regime_lost:
                self._close(instrument, OrderSide.SELL, close, stopped)
        elif self._pos == "SHORT":
            new_stop = close + self.cfg.atr_trail_mult * atr
            if new_stop < self._stop_px:
                self._stop_px = new_stop
            stopped = high >= self._stop_px
            regime_lost = adx < self.cfg.adx_exit or close > (self._ema or close)
            if stopped or regime_lost:
                self._close(instrument, OrderSide.BUY, close, stopped)

    def _close(
        self, instrument: Instrument, side: OrderSide, exit_price: float, stopped: bool
    ) -> None:
        for position in self.cache.positions_open(instrument_id=instrument.id):
            self._submit(instrument.id, side, position.quantity)

        # internal realized-pnl tracking for the circuit breaker (approximate)
        direction = 1.0 if self._pos == "LONG" else -1.0
        gross = direction * (exit_price - self._entry_price) * self._qty
        fees = 2.0 * self.cfg.taker_fee * self._entry_price * self._qty
        self._realized += gross - fees
        self._peak_realized = max(self._peak_realized, self._realized)
        drawdown = self._peak_realized - self._realized
        if drawdown > self.cfg.breaker_dd * self._risk_base:
            self._breaker_until = self._bar_index + self.cfg.breaker_cooldown

        if stopped:
            self._cooldown_until = self._bar_index + self.cfg.cooldown_bars

        self._pos = "NONE"
        self._entry_price = 0.0
        self._qty = 0.0
        self._stop_px = 0.0

    # ---------------------------------------------------------------- orders
    def _submit(
        self, instrument_id: InstrumentId, side: OrderSide, quantity: Quantity
    ) -> None:
        order = self.order_factory.market(
            instrument_id=instrument_id,
            order_side=side,
            quantity=quantity,
            time_in_force=TimeInForce.GTC,
        )
        self.submit_order(order)

    def on_stop(self) -> None:
        if self._instrument is not None:
            self.cancel_all_orders(self._instrument.id)
            self.close_all_positions(self._instrument.id)
        try:
            out = Path("/workspace/output")
            out.mkdir(parents=True, exist_ok=True)
            self._diag["realized_internal"] = round(self._realized, 4)
            (out / "diag.json").write_text(json.dumps(self._diag), encoding="utf-8")
        except Exception:
            pass
