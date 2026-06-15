'use strict';
// Live forward paper-trading loop. Runs hourly (GitHub Actions), pulls recent candles,
// runs the SAME regime-switching logic as the backtest on the latest closed bar, keeps a
// paper portfolio in public/live-state.json, and (optionally) has the AI co-pilot vet new
// entries. No real funds. Fills are taken at the close of the decision bar (hourly live
// approximation). State persists across runs and is committed back to the repo.
const fs = require('fs');
const path = require('path');
const { ema, atrAdx, rollingPctRank, rollingMaxPrior, rollingMinPrior } = require('../lib.js');
const { fetchCandles } = require('./fetch-candles.js');
let ai = null; try { ai = require('../ai-copilot.js'); } catch (e) { /* ai optional */ }

// live params: same logic as the backtest, with a shorter vol window so a few hundred
// live bars are enough to classify the regime.
const LP = {
  initialCapital: 100000, feeRate: 0.0006,
  emaLen: 200, atrLen: 14, adxLen: 14, adxTrend: 23, adxRange: 16,
  volWindow: 168, volRiskOff: 0.95, regimePersist: 3, cooldown: 12,
  entryLB: 96, exitLB: 32, breakoutBufAtr: 0.5, trendStopAtr: 3.0,
  riskFrac: 0.0075, maxLev: 3,
};
const SYMS = ['BTC', 'ETH'];
const STATE = path.join(__dirname, '..', 'public', 'live-state.json');
const rnd = (x, d = 2) => (x == null || !Number.isFinite(x)) ? null : Math.round(x * 10 ** d) / 10 ** d;

function features(bars) {
  const close = bars.map(b => b.close), highs = bars.map(b => b.high), lows = bars.map(b => b.low);
  const emaArr = ema(close, LP.emaLen);
  const { atr, adx } = atrAdx(bars, LP.atrLen);
  const atrPct = atr.map((a, i) => a == null ? null : a / close[i]);
  const volPct = rollingPctRank(atrPct, LP.volWindow);
  const entryHi = rollingMaxPrior(highs, LP.entryLB), entryLo = rollingMinPrior(lows, LP.entryLB);
  const exitHi = rollingMaxPrior(highs, LP.exitLB), exitLo = rollingMinPrior(lows, LP.exitLB);
  const raw = bars.map((b, i) => {
    if (emaArr[i] == null || volPct[i] == null) return null;
    if (volPct[i] >= LP.volRiskOff) return 'RISK_OFF';
    if (adx[i] != null && adx[i] >= LP.adxTrend) return close[i] > emaArr[i] ? 'TREND_UP' : 'TREND_DOWN';
    if (adx[i] != null && adx[i] < LP.adxRange) return 'RANGE';
    return 'NEUTRAL';
  });
  const regime = new Array(bars.length).fill(null);
  let cur = null, cand = null, run = 0;
  for (let i = 0; i < bars.length; i++) {
    const r = raw[i]; if (r == null) { regime[i] = null; continue; }
    if (r === cur) { cand = null; run = 0; }
    else if (r === cand) { run++; if (run >= LP.regimePersist) { cur = r; cand = null; run = 0; } }
    else { cand = r; run = 1; }
    if (r === 'RISK_OFF') cur = 'RISK_OFF';
    regime[i] = cur;
  }
  return bars.map((b, i) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close,
    ema: emaArr[i], adx: adx[i], atr: atr[i], volPct: volPct[i],
    entryHi: entryHi[i], entryLo: entryLo[i], exitHi: exitHi[i], exitLo: exitLo[i], regime: regime[i] }));
}

function initState() {
  const half = LP.initialCapital / SYMS.length;
  const sleeves = {}; for (const s of SYMS) sleeves[s] = { cash: half, pos: 0, qty: 0, entry: 0, stop: 0, cooldown: 0, lastBar: 0, openedAt: 0, regime: null, ai: null };
  return { started: new Date().toISOString(), startedMs: Date.now(), initialCapital: LP.initialCapital,
    equity: LP.initialCapital, peak: LP.initialCapital, maxDD: 0, pnlPct: 0,
    sleeves, equityCurve: [], model: (ai && ai.PROVIDER) ? ai.MODEL : null,
    log: [{ t: new Date().toISOString(), action: 'start', detail: 'Paper account opened — monitoring BTC & ETH for regime signals' }] };
}

async function main() {
  if (process.argv.includes('--init')) {
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(STATE, JSON.stringify(initState(), null, 0));
    console.log('wrote clean initial live-state.json'); return;
  }
  const dev = process.argv.includes('--dev'); // use CSV archive offline
  let st; try { st = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { st = initState(); }
  const now = new Date();
  let source = null;
  const logLenBefore = st.log.length;
  const pushLog = o => { st.log.unshift(Object.assign({ t: now.toISOString() }, o)); st.log = st.log.slice(0, 60); };

  for (const sym of SYMS) {
    let bars;
    try { const r = await fetchCandles(sym, { allowCsv: dev, csvOnly: dev }); bars = r.bars; source = r.source; }
    catch (e) { pushLog({ sym, action: 'error', detail: 'data fetch failed: ' + e.message }); continue; }
    const feats = features(bars);
    // use the last CLOSED bar (drop the still-forming final candle)
    const f = feats[feats.length - 2];
    if (!f || f.regime == null || f.atr == null) { pushLog({ sym, action: 'warmup', detail: 'insufficient history for a signal yet' }); continue; }
    const sv = st.sleeves[sym];
    const price = f.close;
    const fresh = f.time > sv.lastBar;

    // manage open position (stop -> donchian exit). marks use the latest closed bar.
    if (sv.pos !== 0) {
      if (sv.pos > 0 && f.low <= sv.stop) closePos(st, sv, sym, sv.stop, f, 'stop');
      else if (sv.pos < 0 && f.high >= sv.stop) closePos(st, sv, sym, sv.stop, f, 'stop');
      else if (fresh) {
        if (sv.pos > 0 && f.exitLo != null && f.close < f.exitLo) closePos(st, sv, sym, price, f, 'exit');
        else if (sv.pos < 0 && f.exitHi != null && f.close > f.exitHi) closePos(st, sv, sym, price, f, 'exit');
      }
    }

    // entries only on a freshly closed bar
    if (fresh) {
      if (sv.cooldown > 0) sv.cooldown--;
      const trend = f.regime === 'TREND_UP' || f.regime === 'TREND_DOWN';
      const canEnter = sv.pos === 0 && sv.cooldown === 0 && f.regime !== 'RISK_OFF' && trend;
      if (canEnter) {
        const buf = LP.breakoutBufAtr * f.atr;
        const longBreak = f.entryHi != null && f.close > f.entryHi + buf && f.close > f.ema && f.regime === 'TREND_UP';
        const shortBreak = f.entryLo != null && f.close < f.entryLo - buf && f.close < f.ema && f.regime === 'TREND_DOWN';
        if (longBreak || shortBreak) {
          const side = longBreak ? 'long' : 'short';
          const ctx = entryCtx(feats, feats.length - 2, sym, side);
          let verdict = null;
          if (ai && ai.hasKey()) { try { verdict = await ai.review(ctx); } catch (e) { verdict = null; } }
          if (verdict && verdict.verdict === 'VETO') {
            pushLog({ sym, action: 'veto', detail: `AI vetoed ${side} breakout`, regime: f.regime, price: rnd(price), verdict: 'VETO', reason: verdict.reason });
          } else {
            openPos(st, sv, sym, side === 'long' ? 1 : -1, price, f, verdict);
            pushLog({ sym, action: 'open', detail: `opened ${side}`, regime: f.regime, price: rnd(price), verdict: verdict ? verdict.verdict : null, reason: verdict ? verdict.reason : null });
          }
        }
      }
      sv.lastBar = f.time;
    }
    sv.markPrice = price; sv.regime = f.regime;
  }

  // hourly heartbeat if nothing else happened this run, so the feed shows it's alive
  if (st.log.length === logLenBefore) {
    const regs = SYMS.map(s => `${s} ${(st.sleeves[s].regime || '—').replace('_', '-').toLowerCase()}`).join(' · ');
    pushLog({ action: 'scan', detail: `hourly scan · ${regs} · no new signal` });
  }

  // portfolio mark-to-market
  let eq = 0;
  for (const sym of SYMS) { const sv = st.sleeves[sym]; eq += sv.cash + (sv.pos !== 0 ? sv.pos * sv.qty * (sv.markPrice - sv.entry) : 0); }
  st.equity = Math.round(eq); st.pnlPct = rnd((eq / LP.initialCapital - 1) * 100, 2);
  st.peak = Math.max(st.peak || eq, eq); st.maxDD = rnd(Math.max(st.maxDD || 0, (st.peak - eq) / st.peak) * 100, 2);
  st.lastUpdate = now.toISOString(); st.source = source; if (ai && ai.PROVIDER) st.model = ai.MODEL;
  st.equityCurve.push({ t: now.toISOString(), eq: Math.round(eq) }); st.equityCurve = st.equityCurve.slice(-2000);
  st.positions = SYMS.filter(s => st.sleeves[s].pos !== 0).map(s => { const v = st.sleeves[s]; return { sym: s, side: v.pos > 0 ? 'long' : 'short', entry: rnd(v.entry), mark: rnd(v.markPrice), qty: rnd(v.qty, 4), upnl: Math.round(v.pos * v.qty * (v.markPrice - v.entry)), regime: v.regime, ai: v.ai }; });

  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(st, null, 0));
  console.log(`[${st.lastUpdate}] source=${source} equity=$${st.equity} pnl=${st.pnlPct}% open=${st.positions.length} log=${st.log.length}`);
}

function feeOn(n) { return Math.abs(n) * LP.feeRate; }
function openPos(st, sv, sym, dir, price, f, verdict) {
  const stopDist = LP.trendStopAtr * f.atr; if (!(stopDist > 0)) return;
  let qty = (sv.cash * LP.riskFrac) / stopDist; const maxQty = (sv.cash * LP.maxLev) / price; if (qty > maxQty) qty = maxQty;
  if (!(qty > 0)) return;
  sv.cash -= feeOn(qty * price);
  sv.pos = dir; sv.qty = qty; sv.entry = price; sv.stop = dir > 0 ? price - stopDist : price + stopDist;
  sv.openedAt = f.time; sv.ai = verdict ? { verdict: verdict.verdict, conviction: verdict.conviction, reason: verdict.reason } : null;
}
function closePos(st, sv, sym, price, f, reason) {
  if (sv.pos === 0) return;
  const pnl = sv.pos * sv.qty * (price - sv.entry) - feeOn(sv.qty * price);
  sv.cash += sv.pos * sv.qty * (price - sv.entry) - feeOn(sv.qty * price);
  if (reason === 'stop') sv.cooldown = LP.cooldown;
  st.log.unshift({ t: new Date().toISOString(), sym, action: 'close', detail: `closed ${sv.pos > 0 ? 'long' : 'short'} (${reason})`, regime: f.regime, price: rnd(price), pnl: Math.round(pnl) });
  st.log = st.log.slice(0, 60);
  sv.pos = 0; sv.qty = 0; sv.entry = 0; sv.ai = null;
}
function entryCtx(feats, i, sym, side) {
  const f = feats[i]; const cAgo = n => (i - n >= 0 && feats[i - n]) ? feats[i - n].close : null;
  const c24 = cAgo(24), c72 = cAgo(72);
  return { time: f.time, sym: sym + 'USDT', side, regime: f.regime, adx: rnd(f.adx, 1), volPctile: rnd(f.volPct, 2),
    pxVsEma200Pct: rnd((f.close / f.ema - 1) * 100, 2), ret24hPct: c24 ? rnd((f.close / c24 - 1) * 100, 2) : null,
    ret72hPct: c72 ? rnd((f.close / c72 - 1) * 100, 2) : null,
    breakoutClearAtr: rnd(side === 'long' ? (f.close - f.entryHi) / f.atr : (f.entryLo - f.close) / f.atr, 2) };
}

main().catch(e => { console.error('live-trade failed:', e.message); process.exit(1); });
