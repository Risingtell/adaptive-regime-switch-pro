'use strict';
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');

// ---------- Data loading ----------
function loadSymbol(sym) {
  const files = fs.readdirSync(DATA_DIR)
    .filter(f => f.startsWith(sym + '-1h-') && f.endsWith('.csv'))
    .sort();
  const map = new Map(); // openTimeMs -> bar (dedupe)
  for (const f of files) {
    const txt = fs.readFileSync(path.join(DATA_DIR, f), 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      if (!line) continue;
      const c = line.split(',');
      if (!/^\d/.test(c[0])) continue; // skip header
      let t = Number(c[0]);
      if (t > 1e14) t = Math.floor(t / 1000); // microseconds -> ms
      const bar = {
        time: t,
        open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[5],
      };
      if (Number.isFinite(bar.open) && Number.isFinite(bar.close)) map.set(t, bar);
    }
  }
  return [...map.values()].sort((a, b) => a.time - b.time);
}

// ---------- Indicators (Wilder where applicable) ----------
function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (prev === null) { prev = v; } else { prev = v * k + prev * (1 - k); }
    if (i >= period - 1) out[i] = prev;
  }
  return out;
}

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function rollingStd(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let m = 0; for (let j = i - period + 1; j <= i; j++) m += values[j];
    m /= period;
    let s = 0; for (let j = i - period + 1; j <= i; j++) { const d = values[j] - m; s += d * d; }
    out[i] = Math.sqrt(s / period);
  }
  return out;
}

// ATR + ADX (Wilder smoothing)
function atrAdx(bars, period = 14) {
  const n = bars.length;
  const atr = new Array(n).fill(null);
  const adx = new Array(n).fill(null);
  const plusDI = new Array(n).fill(null);
  const minusDI = new Array(n).fill(null);
  if (n < period + 1) return { atr, adx, plusDI, minusDI };

  let trS = 0, pdmS = 0, mdmS = 0;
  // seed with first `period` TR/DM (i=1..period)
  for (let i = 1; i <= period; i++) {
    const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    const up = bars[i].high - bars[i - 1].high;
    const dn = bars[i - 1].low - bars[i].low;
    const pdm = (up > dn && up > 0) ? up : 0;
    const mdm = (dn > up && dn > 0) ? dn : 0;
    trS += tr; pdmS += pdm; mdmS += mdm;
  }
  atr[period] = trS / period;
  let pDI = 100 * (pdmS / trS), mDI = 100 * (mdmS / trS);
  plusDI[period] = pDI; minusDI[period] = mDI;
  let dxSum = 0, dxCount = 0;
  const dxSeed = [];
  dxSeed.push(100 * Math.abs(pDI - mDI) / ((pDI + mDI) || 1));

  for (let i = period + 1; i < n; i++) {
    const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    const up = bars[i].high - bars[i - 1].high;
    const dn = bars[i - 1].low - bars[i].low;
    const pdm = (up > dn && up > 0) ? up : 0;
    const mdm = (dn > up && dn > 0) ? dn : 0;
    trS = trS - trS / period + tr;
    pdmS = pdmS - pdmS / period + pdm;
    mdmS = mdmS - mdmS / period + mdm;
    atr[i] = trS / period;
    pDI = 100 * (pdmS / trS); mDI = 100 * (mdmS / trS);
    plusDI[i] = pDI; minusDI[i] = mDI;
    const dx = 100 * Math.abs(pDI - mDI) / ((pDI + mDI) || 1);
    if (dxSeed.length < period) {
      dxSeed.push(dx);
      if (dxSeed.length === period) { adx[i] = dxSeed.reduce((a, b) => a + b, 0) / period; }
    } else {
      adx[i] = (adx[i - 1] * (period - 1) + dx) / period;
    }
  }
  return { atr, adx, plusDI, minusDI };
}

// rolling percentile rank of current value within trailing window
function rollingPctRank(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1 || values[i] == null) continue;
    let cnt = 0, tot = 0;
    for (let j = i - period + 1; j <= i; j++) {
      if (values[j] == null) continue;
      tot++; if (values[j] <= values[i]) cnt++;
    }
    out[i] = tot ? cnt / tot : null;
  }
  return out;
}

// max/min over the PRIOR `win` bars (excludes current bar) -> Donchian channel, no look-ahead
function rollingMaxPrior(values, win) {
  const out = new Array(values.length).fill(null);
  for (let i = win; i < values.length; i++) {
    let m = -Infinity;
    for (let j = i - win; j < i; j++) if (values[j] > m) m = values[j];
    out[i] = m;
  }
  return out;
}
function rollingMinPrior(values, win) {
  const out = new Array(values.length).fill(null);
  for (let i = win; i < values.length; i++) {
    let m = Infinity;
    for (let j = i - win; j < i; j++) if (values[j] < m) m = values[j];
    out[i] = m;
  }
  return out;
}

module.exports = { loadSymbol, ema, sma, rollingStd, atrAdx, rollingPctRank, rollingMaxPrior, rollingMinPrior, DATA_DIR };
