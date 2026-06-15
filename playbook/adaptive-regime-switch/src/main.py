"""Entry point for Adaptive Regime Switch Pro.

For backtest_support: full Playbooks the platform injects
runtime.evaluation_mode="historical" on /api/v1/playbook/run. We fetch hourly
BTC perpetual bars across many sub-1000-bar windows, stitch them into one
contiguous replay frame, run the regime-switch strategy through the managed
Nautilus engine, then write the canonical backtest output files (equity curve
plus a strategy-basis report) and emit the resulting metrics.
"""
import datetime
import json
import math
from pathlib import Path
from typing import Any

import pandas as pd

from getagent import backtest, data, runtime

# ~38-day windows keep each hourly fetch under the 1000-candle cap so no bars
# are silently truncated; ~24 windows gives roughly 2.5 years of history so the
# regime filter is tested across several distinct trend and range episodes.
_WINDOW_DAYS = 38
_NUM_WINDOWS = 24
_MS_PER_DAY = 86_400_000
_OUT_DIR = Path("/workspace/output")


def _sanitize(value: Any) -> Any:
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def _sanitize_metrics(metrics: dict[str, Any]) -> dict[str, Any]:
    return {key: _sanitize(val) for key, val in metrics.items()}


def _fetch_history(symbol: str) -> pd.DataFrame:
    now_ms = int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000)
    window_ms = _WINDOW_DAYS * _MS_PER_DAY
    end_ms = now_ms
    frames: list[pd.DataFrame] = []

    empty_streak = 0
    for _ in range(_NUM_WINDOWS):
        start_ms = end_ms - window_ms
        try:
            bars = data.crypto.futures.kline(
                symbol=symbol,
                interval="1h",
                exchange="binance",
                start_time=start_ms,
                end_time=end_ms,
                limit=1000,
            )
            frame = backtest.prepare_frame(bars, datetime_index="date")
        except Exception:
            frame = None
        if frame is not None and not frame.empty:
            frames.append(frame)
            empty_streak = 0
        else:
            # older history not available from the provider; stop after a couple
            # of consecutive empty windows rather than failing the whole run
            empty_streak += 1
            if empty_streak >= 2:
                break
        end_ms = start_ms

    if not frames:
        return pd.DataFrame()

    combined = pd.concat(frames)
    combined = combined[~combined.index.duplicated(keep="last")].sort_index()

    # enforce OHLC consistency: provider stitching can leave a row where
    # low > open or high < close, which Nautilus rejects. Clamp high/low to
    # bound open and close so every bar is valid.
    ohlc = ["open", "high", "low", "close"]
    if all(col in combined.columns for col in ohlc):
        combined = combined.dropna(subset=ohlc)
        combined["high"] = combined[ohlc].max(axis=1)
        combined["low"] = combined[ohlc].min(axis=1)
    return combined


def _equity_points(raw: dict) -> list[tuple[str, float]]:
    """Real equity curve from the Nautilus account/equity reports."""
    reports = raw.get("reports", {}) or {}
    points: list[tuple[str, float]] = []
    for row in reports.get("equity_curve", []) or []:
        ts = row.get("timestamp") or row.get("index")
        try:
            points.append((str(ts), float(row.get("value"))))
        except (TypeError, ValueError):
            continue
    if points:
        return points
    for row in reports.get("account", []) or []:
        ts = row.get("index")
        try:
            points.append((str(ts), float(row.get("total"))))
        except (TypeError, ValueError):
            continue
    return points


def _write_outputs(raw: dict, net_pnl: float, strat_pct: float, starting: float) -> int:
    """Write the canonical backtest output files; returns equity point count."""
    points = _equity_points(raw)
    try:
        _OUT_DIR.mkdir(parents=True, exist_ok=True)
        # override engine top-level values so the platform's strategy-basis merge
        # uses the correct absolute numbers (setdefault cannot override these)
        raw["net_pnl"] = round(net_pnl, 6)
        raw["total_return_pct"] = round(strat_pct, 4)
        raw["starting_balance"] = starting
        raw["metrics_basis"] = "strategy"
        (_OUT_DIR / "backtest_report.json").write_text(
            json.dumps(raw, default=str), encoding="utf-8"
        )
        lines = ["timestamp,value,nav"]
        for ts, val in points:
            nav = (val / starting) if starting else 1.0
            lines.append(f"{ts},{val},{nav}")
        (_OUT_DIR / "equity_curve.csv").write_text(
            "\n".join(lines) + "\n", encoding="utf-8"
        )
    except Exception:
        pass
    return len(points)


def _read_diag() -> dict:
    try:
        return json.loads((_OUT_DIR / "diag.json").read_text(encoding="utf-8"))
    except Exception:
        return {}


def run() -> None:
    cfg = runtime.manifest.get("strategy_config", {}) or {}
    symbols = cfg.get("trading_symbols") or ["BTCUSDT"]
    symbol = symbols[0]
    try:
        margin_budget = float(cfg.get("margin_budget", 100) or 100)
    except (TypeError, ValueError):
        margin_budget = 100.0

    replay_frame = _fetch_history(symbol)
    if replay_frame.empty:
        runtime.emit_signal(
            action="watch",
            symbol=symbol,
            confidence=0.0,
            metrics={"rows": 0},
            meta={"reason": "no historical bars returned"},
        )
        return

    instrument_key = f"{symbol}.BINANCE"
    result = backtest.run(
        ohlcv_data={instrument_key: replay_frame},
        spec=runtime.backtest_spec,
    )

    chart_path = backtest.generate_chart(result)
    raw = result.raw if isinstance(result.raw, dict) else {}
    summary = raw.get("summary", {}) or {}

    # authoritative net pnl from the real equity curve (engine summary net_pnl
    # is unreliably scaled; the account/equity report is ground truth)
    starting = float(summary.get("starting_balance", 100000) or 100000)
    points = _equity_points(raw)
    ending = points[-1][1] if points else starting
    net_pnl = ending - starting
    strat_pct = (net_pnl / margin_budget * 100.0) if margin_budget else 0.0
    account_pct = (net_pnl / starting * 100.0) if starting else 0.0

    point_count = _write_outputs(raw, net_pnl, strat_pct, starting)
    diag = _read_diag()

    action = "long" if net_pnl > 0 else "watch"
    metrics = _sanitize_metrics(
        {
            "total_return_pct": round(strat_pct, 4),
            "account_return_pct": round(account_pct, 6),
            "net_pnl": round(net_pnl, 4),
            "starting_balance": starting,
            "margin_budget": margin_budget,
            "sharpe_ratio": summary.get("sharpe_ratio"),
            "sortino_ratio": (raw.get("stats", {}).get("returns", {}) or {}).get(
                "Sortino Ratio (252 days)"
            ),
            "max_drawdown_pct": summary.get("max_drawdown_pct"),
            "win_rate": summary.get("win_rate"),
            "total_trades": summary.get("total_trades"),
            "profit_factor": summary.get("profit_factor"),
            "rows": len(replay_frame),
            "first_bar": str(replay_frame.index[0]),
            "last_bar": str(replay_frame.index[-1]),
        }
    )

    runtime.emit_signal(
        action=action,
        symbol=symbol,
        confidence=_sanitize(summary.get("win_rate")) or 0.0,
        metrics=metrics,
        meta={
            "chart_path": chart_path,
            "metrics_basis": "strategy",
            "equity_points": point_count,
            "diagnostics": diag,
        },
    )


if __name__ == "__main__":
    run()
