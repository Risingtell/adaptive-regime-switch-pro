'use strict';
const fs = require('fs');
const path = require('path');
const { loadSymbol, ema, sma, rollingStd, atrAdx, rollingPctRank, rollingMaxPrior, rollingMinPrior } = require('./lib.js');

// =====================================================================
//  Adaptive Regime Switch Pro  —  multi-engine regime-switching agent
//  The market regime selects WHICH strategy trades, not just a filter:
//    TREND_UP / TREND_DOWN -> Donchian breakout momentum (ride the move)
//    RANGE                 -> z-score mean reversion     (fade extremes)
//    RISK_OFF              -> flat, stand aside           (capital defence)
//  No look-ahead: every signal is computed on a CLOSED bar and filled at
//  the NEXT bar's open. Fees + slippage charged on every fill.
// =====================================================================

const P = {
  symbols: ['BTCUSDT', 'ETHUSDT'],
  initialCapital: 100000,
  feeRate: 0.0006,        // 6 bp per side (taker fee + slippage)

  // --- regime classification ---
  emaLen: 200,            // macro trend reference
  atrLen: 14, adxLen: 14,
  adxTrend: 23,           // ADX above -> trending
  adxRange: 16,           // ADX below -> ranging (gap = neutral/no-new-risk)
  volWindow: 720,         // 30 days hourly for ATR% percentile
  volRiskOff: 0.95,       // ATR% percentile above this -> RISK_OFF
  regimePersist: 3,       // bars a new regime must hold before it switches engine
  cooldown: 12,           // bars to wait after a stop-out before re-entering a symbol

  // --- trend engine (breakout) ---
  entryLB: 96,            // Donchian entry lookback (prior 96h high/low)
  exitLB: 32,             // Donchian trailing-exit lookback
  breakoutBufAtr: 0.5,    // breakout must clear the channel by this many ATRs
  trendStopAtr: 3.0,      // hard stop distance (ATRs)

  // --- mean-reversion engine ---
  mrLen: 48,              // z-score lookback (mean + std)
  mrZEntry: 2.1,          // enter only at a genuine extreme
  mrZTarget: 0.0,         // take profit back at the mean (full reversion capture)
  mrStopAtr: 2.6,         // hard stop distance (ATRs)
  mrMaxHold: 96,          // time stop: bail a stuck MR trade after N bars
  mrVolFloor: 0.15,       // skip dead-flat tape (no edge, fee drag)
  mrVolCeil: 0.85,        // skip pre-risk-off churn

  // --- sizing & portfolio risk ---
  riskFrac: 0.0075,       // risk per trade as fraction of sleeve cash (inverse-vol)
  maxLev: 3,              // notional cap = maxLev * sleeve cash
  breakerDD: 0.12,        // halt new entries if portfolio drawdown exceeds this
  breakerPause: 168,      // halt ~1 week, then re-baseline & resume
};

const rnd = (x, d = 2) => (x == null || !Number.isFinite(x)) ? null : Math.round(x * 10 ** d) / 10 ** d;

// ---------------- Feature engineering ----------------
function computeFeatures(bars) {
  const close = bars.map(b => b.close);
  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const emaArr = ema(close, P.emaLen);
  const { atr, adx } = atrAdx(bars, P.atrLen);
  const atrPct = atr.map((a, i) => (a == null ? null : a / close[i]));
  const volPct = rollingPctRank(atrPct, P.volWindow);
  const entryHi = rollingMaxPrior(highs, P.entryLB);
  const entryLo = rollingMinPrior(lows, P.entryLB);
  const exitHi = rollingMaxPrior(highs, P.exitLB);
  const exitLo = rollingMinPrior(lows, P.exitLB);
  const mean = sma(close, P.mrLen);
  const std = rollingStd(close, P.mrLen);
  const z = close.map((c, i) => (mean[i] == null || !std[i]) ? null : (c - mean[i]) / std[i]);

  // base regime label (pre-hysteresis)
  const rawRegime = bars.map((b, i) => {
    if (emaArr[i] == null || volPct[i] == null) return null;
    if (volPct[i] >= P.volRiskOff) return 'RISK_OFF';
    if (adx[i] != null && adx[i] >= P.adxTrend) return close[i] > emaArr[i] ? 'TREND_UP' : 'TREND_DOWN';
    if (adx[i] != null && adx[i] < P.adxRange) return 'RANGE';
    return 'NEUTRAL';
  });

  // hysteresis: a candidate regime must persist `regimePersist` bars to take effect
  const regime = new Array(bars.length).fill(null);
  let cur = null, cand = null, candRun = 0;
  for (let i = 0; i < bars.length; i++) {
    const r = rawRegime[i];
    if (r == null) { regime[i] = null; continue; }
    if (r === cur) { cand = null; candRun = 0; }
    else if (r === cand) { candRun++; if (candRun >= P.regimePersist) { cur = r; cand = null; candRun = 0; } }
    else { cand = r; candRun = 1; }
    // RISK_OFF is acted on immediately (defence shouldn't wait)
    if (r === 'RISK_OFF') cur = 'RISK_OFF';
    regime[i] = cur;
  }

  return bars.map((b, i) => ({
    time: b.time, open: b.open, high: b.high, low: b.low, close: b.close,
    ema: emaArr[i], adx: adx[i], atr: atr[i], volPct: volPct[i],
    entryHi: entryHi[i], entryLo: entryLo[i], exitHi: exitHi[i], exitLo: exitLo[i],
    z: z[i], regime: regime[i],
  }));
}

// ---------------- Backtest engine ----------------
// cfg toggles let us run ablations through the SAME engine.
function run(cfg = {}) {
  const C = Object.assign({ trend: true, meanrev: false, riskOff: true, regimeGate: true, naive: false }, cfg);

  const feats = {};
  for (const s of P.symbols) feats[s] = computeFeatures(loadSymbol(s));
  const idx = {};
  for (const s of P.symbols) idx[s] = new Map(feats[s].map((f, i) => [f.time, i]));
  let common = feats[P.symbols[0]].map(f => f.time).filter(t => P.symbols.every(s => idx[s].has(t)));
  common.sort((a, b) => a - b);

  const sleeves = {};
  for (const s of P.symbols) sleeves[s] = { cash: P.initialCapital / P.symbols.length, pos: 0, qty: 0, entry: 0, stop: 0, engine: null, bars: 0, cooldown: 0 };

  const trades = [];
  const eqSeries = [];
  const perSym = {};
  for (const s of P.symbols) perSym[s] = { t: [], close: [], regime: [], longs: [], shorts: [], exits: [] };

  const bench0 = {};
  for (const s of P.symbols) bench0[s] = feats[s][idx[s].get(common[0])].close;

  let peak = P.initialCapital, halted = false, haltUntil = 0;
  let barsInMarket = 0, grossTraded = 0;
  const feeOn = n => Math.abs(n) * P.feeRate;

  function closePos(sv, s, price, timeMs, reason) {
    if (sv.pos === 0) return;
    const grossPnl = sv.pos * sv.qty * (price - sv.entry);
    const fee = feeOn(sv.qty * price);
    sv.cash += grossPnl - fee;
    grossTraded += sv.qty * price;
    trades.push({ sym: s, side: sv.pos > 0 ? 'long' : 'short', engine: sv.engine, regimeAtEntry: sv.regimeAtEntry,
      entry: sv.entry, exit: price, qty: sv.qty, pnl: grossPnl - fee, time: timeMs, hold: sv.bars, reason, ai: sv.entryCtx || null });
    perSym[s].exits.push({ t: timeMs, p: price });
    if (reason === 'stop') sv.cooldown = P.cooldown;
    sv.pos = 0; sv.qty = 0; sv.engine = null; sv.bars = 0; sv.entryCtx = null;
  }
  function openPos(sv, s, dir, price, atr, stopAtr, engine, regime, timeMs, ctx) {
    const stopDist = stopAtr * atr;
    if (!(stopDist > 0)) return;
    let qty = (sv.cash * P.riskFrac) / stopDist;        // inverse-vol sizing
    const maxQty = (sv.cash * P.maxLev) / price;
    if (qty > maxQty) qty = maxQty;
    if (!(qty > 0)) return;
    sv.cash -= feeOn(qty * price);
    grossTraded += qty * price;
    sv.pos = dir; sv.qty = qty; sv.entry = price; sv.engine = engine; sv.regimeAtEntry = regime; sv.bars = 0; sv.entryCtx = ctx || null;
    sv.stop = dir > 0 ? price - stopDist : price + stopDist;
    (dir > 0 ? perSym[s].longs : perSym[s].shorts).push({ t: timeMs, p: price });
  }

  for (let k = 0; k < common.length - 1; k++) {
    const t = common[k];

    // 1) intrabar hard-stop management on open positions
    for (const s of P.symbols) {
      const sv = sleeves[s], f = feats[s][idx[s].get(t)];
      if (sv.pos > 0 && f.low <= sv.stop) closePos(sv, s, sv.stop, t, 'stop');
      else if (sv.pos < 0 && f.high >= sv.stop) closePos(sv, s, sv.stop, t, 'stop');
    }

    // 2) portfolio mark-to-market + circuit breaker
    let port = 0;
    for (const s of P.symbols) {
      const sv = sleeves[s], f = feats[s][idx[s].get(t)];
      port += sv.cash + (sv.pos !== 0 ? sv.pos * sv.qty * (f.close - sv.entry) : 0);
      if (sv.pos !== 0) barsInMarket++;
    }
    peak = Math.max(peak, port);
    const dd = (peak - port) / peak;
    if (!C.naive) {
      if (!halted && dd > P.breakerDD) { halted = true; haltUntil = k + P.breakerPause; }
      else if (halted && k >= haltUntil) { halted = false; peak = port; }
    }

    let bench = 0;
    for (const s of P.symbols) bench += (P.initialCapital / P.symbols.length) * (feats[s][idx[s].get(t)].close / bench0[s]);
    eqSeries.push({ t, eq: port, bench });

    // 3) decide on closed bar, fill at next open
    for (const s of P.symbols) {
      const sv = sleeves[s];
      const f = feats[s][idx[s].get(t)];
      const op = feats[s][idx[s].get(common[k + 1])].open;
      perSym[s].t.push(t); perSym[s].close.push(f.close); perSym[s].regime.push(f.regime);
      if (sv.cooldown > 0) sv.cooldown--;
      if (sv.pos !== 0) sv.bars++;
      if (f.atr == null || f.ema == null || f.regime == null) continue;
      const regime = C.regimeGate ? f.regime : (f.adx >= P.adxTrend ? (f.close > f.ema ? 'TREND_UP' : 'TREND_DOWN') : 'OFF');

      // --- exits for the engine that owns the open position ---
      if (sv.pos !== 0) {
        // Risk-off blocks NEW risk but lets a trend ride its stop (vol spikes often = trend
        // acceleration). Only a mean-reversion position is force-flattened into chaos.
        if (C.riskOff && f.regime === 'RISK_OFF' && sv.engine === 'meanrev') { closePos(sv, s, op, common[k + 1], 'riskoff'); }
        else if (sv.engine === 'trend') {
          if (sv.pos > 0 && f.exitLo != null && f.close < f.exitLo) closePos(sv, s, op, common[k + 1], 'exit');
          else if (sv.pos < 0 && f.exitHi != null && f.close > f.exitHi) closePos(sv, s, op, common[k + 1], 'exit');
        } else if (sv.engine === 'meanrev') {
          const reverted = (sv.pos > 0 && f.z != null && f.z >= -P.mrZTarget) || (sv.pos < 0 && f.z != null && f.z <= P.mrZTarget);
          if (reverted) closePos(sv, s, op, common[k + 1], 'target');
          else if (sv.bars >= P.mrMaxHold) closePos(sv, s, op, common[k + 1], 'time');
          else if (f.regime === 'TREND_UP' || f.regime === 'TREND_DOWN') closePos(sv, s, op, common[k + 1], 'regime');
        }
      }

      // --- entries: regime selects the engine ---
      const blocked = (C.regimeGate && C.riskOff && f.regime === 'RISK_OFF') || halted || sv.pos !== 0 || sv.cooldown > 0;
      if (blocked) continue;

      if (C.trend && (regime === 'TREND_UP' || regime === 'TREND_DOWN' || regime === 'OFF')) {
        const buf = C.naive ? 0 : P.breakoutBufAtr * f.atr;
        const longBreak = f.entryHi != null && f.close > f.entryHi + buf && (C.naive || f.close > f.ema) && regime !== 'TREND_DOWN';
        const shortBreak = f.entryLo != null && f.close < f.entryLo - buf && (C.naive || f.close < f.ema) && regime !== 'TREND_UP';
        if (longBreak || shortBreak) {
          const side = longBreak ? 'long' : 'short';
          const fi = idx[s].get(t);
          const cAgo = n => (fi - n >= 0 && feats[s][fi - n]) ? feats[s][fi - n].close : null;
          const c24 = cAgo(24), c72 = cAgo(72);
          const ctx = { time: t, sym: s, side, regime: f.regime,
            adx: rnd(f.adx, 1), volPctile: rnd(f.volPct, 2), pxVsEma200Pct: rnd((f.close / f.ema - 1) * 100, 2),
            ret24hPct: c24 ? rnd((f.close / c24 - 1) * 100, 2) : null, ret72hPct: c72 ? rnd((f.close / c72 - 1) * 100, 2) : null,
            breakoutClearAtr: rnd(side === 'long' ? (f.close - f.entryHi) / f.atr : (f.entryLo - f.close) / f.atr, 2) };
          const vetoed = C.verdicts && C.verdicts[s + '@' + t] === 'VETO';
          if (!vetoed) openPos(sv, s, longBreak ? +1 : -1, op, f.atr, P.trendStopAtr, 'trend', f.regime, common[k + 1], ctx);
          continue;
        }
      }
      if (C.meanrev && regime === 'RANGE' && f.volPct >= P.mrVolFloor && f.volPct <= P.mrVolCeil) {
        if (f.z != null && f.z <= -P.mrZEntry) openPos(sv, s, +1, op, f.atr, P.mrStopAtr, 'meanrev', f.regime, common[k + 1]);
        else if (f.z != null && f.z >= P.mrZEntry) openPos(sv, s, -1, op, f.atr, P.mrStopAtr, 'meanrev', f.regime, common[k + 1]);
      }
    }
  }

  const tLast = common[common.length - 1];
  for (const s of P.symbols) closePos(sleeves[s], s, feats[s][idx[s].get(tLast)].close, tLast, 'end');

  const exposure = barsInMarket / (common.length * P.symbols.length);
  const turnover = grossTraded / P.initialCapital;
  return { eqSeries, trades, perSym, common, exposure, turnover };
}

// ---------------- Metrics ----------------
const HOURS_PER_YEAR = 8760;
function maxDrawdown(eq) { let peak = -Infinity, mdd = 0; for (const v of eq) { peak = Math.max(peak, v); mdd = Math.max(mdd, (peak - v) / peak); } return mdd; }
function returns(eq) { const r = []; for (let i = 1; i < eq.length; i++) r.push(eq[i] / eq[i - 1] - 1); return r; }
function sharpe(eq) {
  const r = returns(eq); if (!r.length) return 0;
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / r.length);
  return sd ? (m / sd) * Math.sqrt(HOURS_PER_YEAR) : 0;
}
function sortino(eq) {
  const r = returns(eq); if (!r.length) return 0;
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const dn = r.filter(x => x < 0);
  const dd = Math.sqrt(dn.reduce((a, b) => a + b * b, 0) / r.length);
  return dd ? (m / dd) * Math.sqrt(HOURS_PER_YEAR) : 0;
}
function cagr(eq, bars) { const yrs = bars / HOURS_PER_YEAR; return yrs > 0 ? (eq[eq.length - 1] / eq[0]) ** (1 / yrs) - 1 : 0; }
function tradeStats(trades) {
  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl <= 0);
  const gp = wins.reduce((a, b) => a + b.pnl, 0), gl = Math.abs(losses.reduce((a, b) => a + b.pnl, 0));
  const avgHold = trades.length ? trades.reduce((a, b) => a + (b.hold || 0), 0) / trades.length : 0;
  return { total: trades.length, winRate: trades.length ? wins.length / trades.length : 0,
    profitFactor: gl ? gp / gl : (gp > 0 ? Infinity : 0),
    avgTrade: trades.length ? trades.reduce((a, b) => a + b.pnl, 0) / trades.length : 0, avgHold };
}
function fullMetrics(res) {
  const eq = res.eqSeries.map(e => e.eq);
  const ts = tradeStats(res.trades);
  const mdd = maxDrawdown(eq);
  const cg = cagr(eq, res.common.length);
  return {
    roi: eq[eq.length - 1] / P.initialCapital - 1, cagr: cg, maxDD: mdd,
    sharpe: sharpe(eq), sortino: sortino(eq), calmar: mdd ? cg / mdd : 0,
    winRate: ts.winRate, profitFactor: ts.profitFactor, totalTrades: ts.total,
    avgTrade: ts.avgTrade, avgHold: ts.avgHold, exposure: res.exposure, turnover: res.turnover,
    finalEquity: eq[eq.length - 1],
  };
}
const pct = x => (x * 100).toFixed(2) + '%';

// ---------------- Monte Carlo (bootstrap trade resampling) ----------------
function monteCarlo(trades, iters = 2000) {
  const pnls = trades.map(t => t.pnl);
  if (pnls.length < 5) return null;
  const rois = [], dds = [];
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let it = 0; it < iters; it++) {
    let eq = P.initialCapital, peak = eq, mdd = 0;
    for (let i = 0; i < pnls.length; i++) {
      eq += pnls[(rnd() * pnls.length) | 0];
      peak = Math.max(peak, eq); mdd = Math.max(mdd, (peak - eq) / peak);
    }
    rois.push(eq / P.initialCapital - 1); dds.push(mdd);
  }
  rois.sort((a, b) => a - b); dds.sort((a, b) => a - b);
  const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
  return {
    roiP5: q(rois, 0.05), roiP50: q(rois, 0.5), roiP95: q(rois, 0.95),
    ddP50: q(dds, 0.5), ddP95: q(dds, 0.95),
    probProfit: rois.filter(x => x > 0).length / rois.length,
    roiHist: histogram(rois, 28),
  };
}
function histogram(arr, bins) {
  const lo = arr[0], hi = arr[arr.length - 1], w = (hi - lo) / bins || 1;
  const h = new Array(bins).fill(0);
  for (const v of arr) h[Math.min(bins - 1, Math.max(0, Math.floor((v - lo) / w)))]++;
  return { lo, hi, w, counts: h };
}

// ---------------- Attribution & monthly returns ----------------
function attribution(trades) {
  const byEngine = {}, byRegime = {};
  for (const t of trades) {
    (byEngine[t.engine] ||= { pnl: 0, n: 0, win: 0 });
    byEngine[t.engine].pnl += t.pnl; byEngine[t.engine].n++; if (t.pnl > 0) byEngine[t.engine].win++;
    const rk = t.regimeAtEntry || 'NA';
    (byRegime[rk] ||= { pnl: 0, n: 0, win: 0 });
    byRegime[rk].pnl += t.pnl; byRegime[rk].n++; if (t.pnl > 0) byRegime[rk].win++;
  }
  return { byEngine, byRegime };
}
function monthlyReturns(eqSeries) {
  const byMonth = new Map();
  for (const e of eqSeries) {
    const d = new Date(e.t); const key = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
    if (!byMonth.has(key)) byMonth.set(key, { first: e.eq, last: e.eq });
    byMonth.get(key).last = e.eq;
  }
  return [...byMonth.entries()].map(([k, v]) => ({ month: k, ret: v.last / v.first - 1 }));
}

// ---------------- Main ----------------
function main() {
  const full = run();
  const m = fullMetrics(full);
  const eq = full.eqSeries.map(e => e.eq), bench = full.eqSeries.map(e => e.bench);
  const benchMetrics = { roi: bench[bench.length - 1] / P.initialCapital - 1, maxDD: maxDrawdown(bench), sharpe: sharpe(bench), cagr: cagr(bench, full.common.length) };

  // ablation through the same engine — every design choice justified by evidence
  const variants = {
    naive: fullMetrics(run({ riskOff: false, regimeGate: false, naive: true })),  // unmanaged always-on breakout
    core: m,                                                                       // SHIPPED: regime-gated trend + risk stack
    plusMR: fullMetrics(run({ meanrev: true })),                                   // + mean-reversion sleeve (tested -> rejected)
    meanrevOnly: fullMetrics(run({ trend: false, meanrev: true })),               // MR in isolation (no edge on this tape)
  };

  // AI co-pilot overlay — if reviews have been generated, add the AI-gated variant + decision log
  let aiBlock = null;
  const aiPath = path.join(__dirname, 'public', 'ai-log.json');
  if (fs.existsSync(aiPath)) {
    try {
      const aiLog = JSON.parse(fs.readFileSync(aiPath, 'utf8'));
      variants.aiCoPilot = fullMetrics(run({ verdicts: aiLog.verdicts || {} }));
      aiBlock = { model: aiLog.model, reviewed: aiLog.reviewed, total: aiLog.total, complete: aiLog.complete, counts: aiLog.counts, vetoedPnl: aiLog.vetoedPnl, recent: aiLog.recent };
    } catch (e) { console.error('AI log parse failed:', e.message); }
  }

  // per-year
  const byYear = {}, yearTrades = {};
  for (const e of full.eqSeries) { const y = new Date(e.t).getUTCFullYear(); (byYear[y] ||= []).push(e.eq); }
  for (const tr of full.trades) { const y = new Date(tr.time).getUTCFullYear(); (yearTrades[y] ||= []).push(tr); }
  const yearTbl = Object.entries(byYear).map(([y, eqs]) => { const s = tradeStats(yearTrades[y] || []); return { year: +y, roi: eqs[eqs.length - 1] / eqs[0] - 1, maxDD: maxDrawdown(eqs), sharpe: sharpe(eqs), trades: s.total, winRate: s.winRate }; });

  // walk-forward 60/40
  const split = Math.floor(eq.length * 0.6);
  const isEq = eq.slice(0, split), oosEq = eq.slice(split);
  const wf = { inSample: { roi: isEq[isEq.length - 1] / isEq[0] - 1, sharpe: sharpe(isEq), maxDD: maxDrawdown(isEq) },
               outSample: { roi: oosEq[oosEq.length - 1] / oosEq[0] - 1, sharpe: sharpe(oosEq), maxDD: maxDrawdown(oosEq) } };

  const attr = attribution(full.trades);
  const monthly = monthlyReturns(full.eqSeries);
  const mc = monteCarlo(full.trades);

  // downsample series for the web payload
  const step = Math.max(1, Math.floor(full.eqSeries.length / 1500));
  const eqDS = full.eqSeries.filter((_, i) => i % step === 0);
  let dpeak = -Infinity;
  const ddSeries = full.eqSeries.map(e => { dpeak = Math.max(dpeak, e.eq); return { t: e.t, dd: (e.eq - dpeak) / dpeak }; }).filter((_, i) => i % step === 0);
  const symStep = Math.max(1, Math.floor(full.common.length / 1200));
  const symDS = {};
  for (const s of P.symbols) { const d = full.perSym[s]; symDS[s] = { t: d.t.filter((_, i) => i % symStep === 0), close: d.close.filter((_, i) => i % symStep === 0), regime: d.regime.filter((_, i) => i % symStep === 0), longs: d.longs, shorts: d.shorts, exits: d.exits }; }

  const out = {
    meta: { generated: new Date().toISOString(), start: new Date(full.common[0]).toISOString().slice(0, 10), end: new Date(full.common[full.common.length - 1]).toISOString().slice(0, 10), bars: full.common.length, symbols: P.symbols, params: P },
    metrics: m, benchMetrics, variants, yearTbl, wf, attr, monthly, mc, ai: aiBlock,
    eq: eqDS, dd: ddSeries, sym: symDS, sampleTrades: full.trades.slice(-50),
  };
  fs.mkdirSync(path.join(__dirname, 'public'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'public', 'data.json'), JSON.stringify(out));
  fs.writeFileSync(path.join(__dirname, 'public', 'data.js'), 'window.__DATA__=' + JSON.stringify(out) + ';');

  // ---- console report ----
  const L = (...a) => console.log(...a);
  L('=== Adaptive Regime Switch Pro — multi-engine regime switching ===');
  L(`Window ${out.meta.start} -> ${out.meta.end}  (${full.common.length} bars, ${P.symbols.join('+')})`);
  L('\n--- Headline (full system) ---');
  L(`ROI ${pct(m.roi)}  CAGR ${pct(m.cagr)}  final $${m.finalEquity.toFixed(0)}`);
  L(`MaxDD ${pct(m.maxDD)}  Sharpe ${m.sharpe.toFixed(2)}  Sortino ${m.sortino.toFixed(2)}  Calmar ${m.calmar.toFixed(2)}`);
  L(`Win ${pct(m.winRate)}  PF ${m.profitFactor.toFixed(2)}  Trades ${m.totalTrades}  AvgHold ${m.avgHold.toFixed(0)}h  Exposure ${pct(m.exposure)}`);
  L('--- Benchmark 50/50 HODL ---');
  L(`ROI ${pct(benchMetrics.roi)}  MaxDD ${pct(benchMetrics.maxDD)}  Sharpe ${benchMetrics.sharpe.toFixed(2)}`);
  L('\n--- Ablation (proves the switch adds value) ---');
  for (const [k, v] of Object.entries(variants)) L(`${k.padEnd(12)} ROI ${pct(v.roi).padStart(8)}  Sharpe ${v.sharpe.toFixed(2).padStart(6)}  MaxDD ${pct(v.maxDD).padStart(7)}  Calmar ${v.calmar.toFixed(2).padStart(6)}  Trades ${v.totalTrades}`);
  L('\n--- P&L attribution by engine ---');
  for (const [k, v] of Object.entries(attr.byEngine)) L(`${(k || 'na').padEnd(9)} $${v.pnl.toFixed(0).padStart(8)}  ${v.n} trades  win ${pct(v.win / v.n)}`);
  L('--- P&L attribution by entry regime ---');
  for (const [k, v] of Object.entries(attr.byRegime)) L(`${k.padEnd(11)} $${v.pnl.toFixed(0).padStart(8)}  ${v.n} trades  win ${pct(v.win / v.n)}`);
  L('\n--- Per year ---');
  for (const r of yearTbl) L(`${r.year}: ROI ${pct(r.roi).padStart(8)}  MDD ${pct(r.maxDD).padStart(7)}  Sharpe ${r.sharpe.toFixed(2).padStart(6)}  Trades ${r.trades}  Win ${pct(r.winRate)}`);
  L('\n--- Walk-forward 60/40 ---');
  L(`In : ROI ${pct(wf.inSample.roi)}  Sharpe ${wf.inSample.sharpe.toFixed(2)}`);
  L(`Out: ROI ${pct(wf.outSample.roi)}  Sharpe ${wf.outSample.sharpe.toFixed(2)}`);
  if (mc) { L('\n--- Monte Carlo (2000 bootstraps) ---'); L(`ROI p5/p50/p95: ${pct(mc.roiP5)} / ${pct(mc.roiP50)} / ${pct(mc.roiP95)}  P(profit) ${pct(mc.probProfit)}  DD p95 ${pct(mc.ddP95)}`); }
  if (aiBlock) {
    L('\n--- AI co-pilot (' + aiBlock.model + ') ---');
    L(`Reviewed ${aiBlock.reviewed} entries  | CONFIRM ${aiBlock.counts.CONFIRM} CAUTION ${aiBlock.counts.CAUTION} VETO ${aiBlock.counts.VETO}`);
    if (variants.aiCoPilot) L(`AI-gated:  ROI ${pct(variants.aiCoPilot.roi)}  Sharpe ${variants.aiCoPilot.sharpe.toFixed(2)}  MaxDD ${pct(variants.aiCoPilot.maxDD)}  Trades ${variants.aiCoPilot.totalTrades}`);
  }
}

if (require.main === module) main();
module.exports = { run, computeFeatures, fullMetrics, tradeStats, attribution, monthlyReturns, monteCarlo, P };
