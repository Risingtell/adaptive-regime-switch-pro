'use strict';
// Has the AI co-pilot review the agent's entries. Robust to the Gemini free-tier
// daily cap (~20/day on this key): it uses every cached verdict instantly, and spends
// any remaining fresh-call budget on the MOST RECENT unreviewed entries first, so the
// live decision log fills in from newest to oldest as quota allows across days.
// Always writes public/ai-log.json from whatever has been reviewed so far.
//   AI_FRESH=<n>  cap fresh network calls this run (default: unlimited until cap hit)
const fs = require('fs');
const path = require('path');
const { run } = require('./backtest.js');
const ai = require('./ai-copilot.js');

const FRESH_BUDGET = parseInt(process.env.AI_FRESH || '99999', 10);
const mkCtx = e => ({ time: e.time, sym: e.sym, side: e.side, regime: e.regime, adx: e.adx,
  volPctile: e.volPctile, pxVsEma200Pct: e.pxVsEma200Pct, ret24hPct: e.ret24hPct, ret72hPct: e.ret72hPct, breakoutClearAtr: e.breakoutClearAtr });

(async () => {
  if (!ai.hasKey()) { console.error('No GEMINI_API_KEY in .env'); process.exit(1); }
  const res = run();
  const entries = res.trades.filter(t => t.ai).map(t => ({ ...t.ai, pnl: t.pnl }));

  const verdicts = {}, decisions = [], counts = { CONFIRM: 0, CAUTION: 0, VETO: 0 };
  const record = (e, v) => {
    verdicts[e.sym + '@' + e.time] = v.verdict;
    counts[v.verdict] = (counts[v.verdict] || 0) + 1;
    decisions.push({ time: e.time, sym: e.sym, side: e.side, regime: e.regime, conviction: v.conviction, verdict: v.verdict, reason: v.reason, pnl: Math.round(e.pnl) });
  };

  // 1) use everything already cached
  const need = [];
  for (const e of entries) { const c = ai.reviewCached(mkCtx(e)); if (c) record(e, c); else need.push(e); }
  console.log(`${entries.length} entries · ${decisions.length} from cache · ${need.length} need review`);

  // 2) spend fresh budget on the most RECENT unreviewed entries first
  need.sort((a, b) => b.time - a.time);
  let fresh = 0, dailyHit = false;
  for (const e of need) {
    if (fresh >= FRESH_BUDGET) break;
    try { const v = await ai.review(mkCtx(e)); fresh++; record(e, v); if (fresh % 5 === 0) console.log(`  fresh ${fresh}...`); }
    catch (err) {
      if (err.daily) { dailyHit = true; console.log('  daily free-tier quota reached — stopping fresh calls for today.'); break; }
      console.error('  review error:', err.message); break;
    }
  }

  const vetoed = decisions.filter(d => d.verdict === 'VETO');
  const vetoedPnl = Math.round(vetoed.reduce((a, b) => a + b.pnl, 0));
  // most recent 14, plus any VETO decisions (the gate firing is the interesting part)
  const byTime = decisions.slice().sort((a, b) => a.time - b.time);
  const recent = byTime.slice(-14);
  for (const v of byTime) if (v.verdict === 'VETO' && !recent.includes(v)) recent.push(v);
  recent.sort((a, b) => a.time - b.time);
  const out = { model: ai.MODEL, generated: new Date().toISOString(), reviewed: decisions.length, total: entries.length,
    complete: decisions.length >= entries.length, counts, vetoedPnl, verdicts, recent };
  fs.writeFileSync(path.join(__dirname, 'public', 'ai-log.json'), JSON.stringify(out));

  console.log(`\nWrote ai-log.json — reviewed ${decisions.length}/${entries.length}` + (dailyHit ? ' (daily cap hit; re-run tomorrow to continue)' : ''));
  console.log(`CONFIRM ${counts.CONFIRM}  CAUTION ${counts.CAUTION}  VETO ${counts.VETO}  |  net P&L on VETO'd trades $${vetoedPnl}`);
})();
