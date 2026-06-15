# Adaptive Regime Switch Pro

A regime-gated trend-following Playbook for BTC perpetual futures on hourly
bars. The agent reads what kind of market it is in before it trades, and only
takes directional risk when the conditions actually favor a trend.

## 策略

Most bots run a single strategy in every market and give back their gains when
conditions change. This Playbook instead classifies the current market into one
of three states on every bar: a trending state, a quiet range state, and a
high-volatility risk-off state. It uses a long-horizon moving-average trend
filter, a directional-strength reading, and a volatility measure to decide which
state it is in. It only opens positions in the trending state. In the range
state it stands aside, because fading a quiet market has no durable edge on this
instrument. In the risk-off state it refuses to open new risk at all.

## 开仓

Inside a confirmed trend the agent waits for price to break out of its recent
channel in the direction of the broader trend. A breakout above the recent range
while the trend filter points up opens a long; a breakout below the recent range
while the trend filter points down opens a short. It does not try to pick tops or
bottoms, and it does not add to a position. A persistence buffer on the
trend-strength reading keeps it from flipping in and out on noise, and a cooldown
after any stop-out prevents it from re-entering straight into the same chop.

## 平仓

Every open position carries a volatility-scaled stop. As a trade moves in favor,
the stop trails behind price to lock in gains. A position is closed when price
hits the trailing stop, or when the market falls out of the trending state and
the directional-strength reading decays through its exit buffer. There is no
fixed take-profit target; the trailing stop is what converts a running trend into
realized profit and caps the loss on a failed breakout.

## 参数说明

Subscribers can tune leverage, the margin budget, and the trading symbol.
Leverage scales both upside and drawdown together and does not make the agent
more selective. Margin budget is the per-strategy capital the platform sizes
orders against and uses as the denominator for the return percentage. Position
size is also scaled inversely to volatility, so the agent commits less when the
market is wild and more when it is calm.

## 回测指标如何读

The backtest reports `total_return_pct` (strategy-budget return), the
account-level return alongside it, `sharpe_ratio`, `max_drawdown_pct`,
`win_rate`, and `total_trades`. Read drawdown and trade count together with
return: a trend system wins on a minority of trades and earns its keep by losing
small and letting the winners run, so a modest win rate with a healthy profit
factor and a contained drawdown is the intended shape.

## 风险

This is a trend strategy, and trend strategies bleed in choppy, directionless
markets where breakouts fail and stops get hit repeatedly. Gap-driven moves
around major news, thin liquidity, and persistent funding dislocation can all
produce a run of losing trades. The risk-off filter reduces but does not remove
this exposure. Past backtest performance is not a guarantee of live results, and
live execution pays fees and slippage on every fill. Only subscribe with capital
and leverage whose drawdown you can tolerate.
