# Adaptive Regime Switch Pro

An autonomous trading agent for BTC and ETH perpetuals. It reads the market regime every hour and changes how it behaves, instead of running one strategy in all conditions.

**Live demo:** https://rising-regime-switch.netlify.app

Built by Rising Technology for the Bitget AI Base Camp Hackathon S1.

## Results

Backtested on two years of real hourly data for BTCUSDT and ETHUSDT perpetuals (2024-06 to 2026-05). No look-ahead: every signal is taken on a closed bar and filled at the next bar's open, with fees and slippage charged on every fill.

| Metric | Strategy | 50/50 Buy & Hold |
|---|---|---|
| Total return | +7.3% | -18.7% |
| Max drawdown | 10.7% | 54.7% |
| Sharpe | 0.47 | 0.06 |
| Sortino | 0.71 | - |
| Calmar | 0.34 | - |
| Profit factor | 1.24 | - |

In a 2,000-run Monte Carlo bootstrap of the trade sequence, 79% of resampled histories finished in profit.

## How it works

Every hour the agent scores the current regime from trend strength (ADX), volatility (ATR percentile over 30 days) and the macro trend (EMA-200), then picks a posture:

- **Trend.** It trades the Donchian breakout in the trend direction, with an ATR stop and a trailing exit.
- **Range.** It stands aside. We tested a mean-reversion engine for chop and it lost money on this data, so the agent sits ranges out rather than forcing trades.
- **Risk-off.** When volatility spikes it stops opening new positions and lets existing trends ride their stops.

Every position uses inverse-volatility sizing, a hard ATR stop, and a portfolio circuit breaker that halts new entries after a drawdown threshold.

## Validation

The numbers are stress-tested three ways:

1. **Walk-forward.** Logic is fixed on the first 60% of history and run untouched on the unseen last 40%, including the difficult 2026 bear-chop.
2. **Ablation.** Each component is switched off in turn to show it earns its place. A naive always-on breakout makes +1.2%; the full regime system makes +7.3% with roughly half the drawdown and half the trades. Bolting mean reversion back on lowers returns, which is why it was cut.
3. **Monte Carlo.** 2,000 bootstrap resamples of the trade sequence map the distribution of outcomes rather than relying on one path.

## Run it yourself

Requires Node.js (no dependencies).

```bash
# regenerate the backtest and the dashboard data
node backtest.js

# then open the dashboard
public/index.html
```

`backtest.js` runs the engine, prints the full report to the console, and writes the data the dashboard reads. The price data lives in `data/` as CSV files pulled from the public Binance market archive (see `download.ps1`).

## Layout

- `backtest.js` - the engine: regime classification, the trend and mean-reversion sleeves, sizing, risk controls, ablation, attribution, Monte Carlo and metrics
- `lib.js` - indicators and data loading (EMA, ATR, ADX, Donchian, rolling stats)
- `public/` - the tearsheet dashboard (single page, Chart.js)
- `data/` - hourly OHLCV CSVs for BTC and ETH perps
- `download.ps1` - fetches the price data

## Disclaimer

This is a research backtest, not financial advice. Past performance does not guarantee future results. Crypto perpetuals carry substantial risk including total loss of capital.
