'use strict';
// Source-flexible hourly candle fetcher for the live paper-trading loop.
// Exchange APIs are geo-restricted in many regions; we try several US-accessible
// public sources in order and normalize to oldest-first bars {time(ms),open,high,low,close}.
// A local CSV fallback (the backtest data) lets the pipeline be tested offline.
const fs = require('fs');
const path = require('path');

const SYMS = {
  BTC: { coinbase: 'BTC-USD', kraken: 'XBTUSD', gecko: 'bitcoin', csv: 'BTCUSDT' },
  ETH: { coinbase: 'ETH-USD', kraken: 'ETHUSD', gecko: 'ethereum', csv: 'ETHUSDT' },
};

const getJSON = async (url, opts = {}) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'rising-regime/1.0' }, ...opts });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
};

async function fromCoinbase(sym) {
  // [ time(s), low, high, open, close, volume ], newest first, max 300
  const j = await getJSON(`https://api.exchange.coinbase.com/products/${SYMS[sym].coinbase}/candles?granularity=3600`);
  return j.map(r => ({ time: r[0] * 1000, low: +r[1], high: +r[2], open: +r[3], close: +r[4] })).sort((a, b) => a.time - b.time);
}
async function fromKraken(sym) {
  const j = await getJSON(`https://api.kraken.com/0/public/OHLC?pair=${SYMS[sym].kraken}&interval=60`);
  const arr = Object.values(j.result || {}).find(Array.isArray) || [];
  return arr.map(r => ({ time: r[0] * 1000, open: +r[1], high: +r[2], low: +r[3], close: +r[4] })).sort((a, b) => a.time - b.time);
}
async function fromGecko(sym) {
  // [ time(ms), open, high, low, close ] — coarser granularity, last-resort only
  const j = await getJSON(`https://api.coingecko.com/api/v3/coins/${SYMS[sym].gecko}/ohlc?vs_currency=usd&days=30`);
  return j.map(r => ({ time: r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4] }));
}
function fromCSV(sym) {
  const dir = path.join(__dirname, '..', 'data');
  const files = fs.readdirSync(dir).filter(f => f.startsWith(SYMS[sym].csv + '-1h-') && f.endsWith('.csv')).sort();
  const bars = [];
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/)) {
      const c = line.split(','); if (!/^\d/.test(c[0])) continue;
      let t = +c[0]; if (t > 1e14) t = Math.floor(t / 1000);
      bars.push({ time: t, open: +c[1], high: +c[2], low: +c[3], close: +c[4] });
    }
  }
  return bars.sort((a, b) => a.time - b.time);
}

// returns { bars, source }
async function fetchCandles(sym, { allowCsv = false, csvOnly = false } = {}) {
  if (csvOnly) return { bars: fromCSV(sym), source: 'csv-archive' };
  const chain = [['coinbase', fromCoinbase], ['kraken', fromKraken], ['coingecko', fromGecko]];
  for (const [name, fn] of chain) {
    try { const bars = await fn(sym); if (bars && bars.length > 60) return { bars, source: name }; }
    catch (e) { /* try next source */ }
  }
  if (allowCsv) return { bars: fromCSV(sym), source: 'csv-archive' };
  throw new Error('all live sources failed for ' + sym);
}

module.exports = { fetchCandles, SYMS };
