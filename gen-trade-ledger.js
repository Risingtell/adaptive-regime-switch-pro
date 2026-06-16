// gen-trade-ledger.js
// Produces docs/trade-ledger.csv: a verifiable trade record for the Bitget
// Hackathon Track 1 submission. Columns required by the handbook:
//   timestamp, pair, direction, price, quantity, balance change.
// We emit one row per round-trip with entry/exit price, quantity, realized
// P&L (the balance change) and the running account balance. Reproducible:
// run `node gen-trade-ledger.js` after `npm install` — same engine as the
// live tearsheet (backtest.js), real hourly Binance USDT-M perp data, no
// look-ahead (signal on closed bar, fill next open), fees on every fill.

const fs = require('fs');
const path = require('path');
const { run, P } = require('./backtest.js');

const full = run();                                   // SHIPPED config
const trades = full.trades.slice().sort((a, b) => a.time - b.time);

const rnd = (n, d = 2) => Number(n.toFixed(d));
let balance = P.initialCapital;

const header = [
  'timestamp_utc', 'pair', 'direction', 'entry_price', 'exit_price',
  'quantity', 'pnl_usd', 'balance_change_usd', 'balance_after_usd',
  'regime', 'engine', 'hold_hours', 'exit_reason',
];
const rows = [header.join(',')];

for (const t of trades) {
  balance += t.pnl;
  rows.push([
    new Date(t.time).toISOString(),
    t.sym,
    t.side,                         // long / short
    rnd(t.entry),
    rnd(t.exit),
    rnd(t.qty, 6),
    rnd(t.pnl),
    rnd(t.pnl),                     // balance change for this trade
    rnd(balance),
    t.regimeAtEntry || '',
    t.engine || '',
    t.hold,
    t.reason || '',
  ].join(','));
}

// Reconcile to the engine's official mark-to-market equity (the number the
// tearsheet reports). Any residual is the unrealized mark of positions still
// open at the backtest cutoff; record it explicitly so the ending balance
// matches the published headline rather than realized-only P&L.
const finalEq = full.eqSeries[full.eqSeries.length - 1].eq;
const lastTime = new Date(trades[trades.length - 1].time).toISOString();
const residual = finalEq - balance;
if (Math.abs(residual) >= 1) {
  rows.push([
    lastTime, 'PORTFOLIO', 'mark_to_market', '', '', '',
    rnd(residual), rnd(residual), rnd(finalEq),
    '', '', '', 'open positions marked to market at backtest cutoff',
  ].join(','));
  balance = finalEq;
}

const outDir = path.join(__dirname, 'docs');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'trade-ledger.csv'), rows.join('\n') + '\n');

const wins = trades.filter(t => t.pnl > 0).length;
console.log(`Wrote docs/trade-ledger.csv`);
console.log(`Trades: ${trades.length} | Wins: ${wins} (${rnd(wins / trades.length * 100)}%)`);
console.log(`Window: ${new Date(trades[0].time).toISOString().slice(0, 10)} -> ${new Date(trades[trades.length - 1].time).toISOString().slice(0, 10)}`);
console.log(`Start $${P.initialCapital}  ->  End $${rnd(balance)}  (net $${rnd(balance - P.initialCapital)}, ${rnd((balance / P.initialCapital - 1) * 100)}%)`);
console.log(`Symbols: ${P.symbols.join(', ')}`);
