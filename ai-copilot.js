'use strict';
// AI co-pilot: an LLM risk reviewer that judges each proposed trade entry using
// point-in-time features only (no future data). Deterministic (temperature 0),
// cached to disk so a run is reproducible and re-runs are instant, and rate-limited.
// Provider is auto-detected from .env: GROQ_API_KEY (preferred) or GEMINI_API_KEY.
const fs = require('fs');
const path = require('path');

const ENV = path.join(__dirname, '.env');
const envTxt = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : '';
const readEnv = k => ((envTxt.match(new RegExp(k + '=(.+)')) || [])[1] || process.env[k] || '').trim();
const GROQ_KEY = readEnv('GROQ_API_KEY');
const GEMINI_KEY = readEnv('GEMINI_API_KEY');

const PROVIDER = GROQ_KEY ? 'groq' : (GEMINI_KEY ? 'gemini' : null);
const MODEL = PROVIDER === 'groq' ? 'llama-3.3-70b-versatile' : 'gemini-2.5-flash-lite';
const MIN_GAP = PROVIDER === 'groq' ? 2200 : 5000; // stay under each free tier's per-minute limit

const CACHE_DIR = path.join(__dirname, 'ai-cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

const SYS = `You are a risk co-pilot for an autonomous crypto trend-following agent trading BTC and ETH perpetuals.
Review ONE proposed entry at a time, using ONLY the point-in-time features provided. You have no future data and no outside news.
Judge the quality of THIS entry as a trend trade in the stated regime.
Return STRICT JSON only: {"conviction": <integer 0-100>, "verdict": "CONFIRM"|"CAUTION"|"VETO", "reason": "<one short sentence, max 18 words>"}.
Weigh these risk factors and let them lower conviction:
- volPctile above 0.85 means volatility is already hot, so a breakout here is prone to whipsaw.
- |pxVsEma200Pct| above 12 means price is stretched far from its mean and chasing is risky.
- |ret72hPct| above 25 means the move is near-parabolic and late to join.
- breakoutClearAtr below 0.5 means a weak, unconvincing break.
A clean entry has a strong ADX, the move aligned with the regime, and none of the above stretched.
CONFIRM = clean, well-aligned entry with room to run. CAUTION = mixed or one risk factor present. VETO = chasing an overextended or low-quality break, or fighting context. Be discerning; do not rubber-stamp every breakout.`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
let lastCall = 0;
async function gate() {
  const wait = Math.max(0, lastCall + MIN_GAP - Date.now());
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
}

function sanitize(p) {
  let v = String(p.verdict || '').toUpperCase();
  if (!['CONFIRM', 'CAUTION', 'VETO'].includes(v)) v = 'CAUTION';
  const conv = Math.max(0, Math.min(100, Math.round(Number(p.conviction)) || 0));
  return { conviction: conv, verdict: v, reason: String(p.reason || '').slice(0, 160) };
}

async function callGroq(ctx, attempt = 0) {
  await gate();
  const body = {
    model: MODEL, temperature: 0, max_tokens: 200, response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: SYS }, { role: 'user', content: 'Proposed entry:\n' + JSON.stringify(ctx, null, 2) }],
  };
  let r;
  try {
    r = await fetch('https://api.groq.com/openai/v1/chat/completions',
      { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GROQ_KEY }, body: JSON.stringify(body) });
  } catch (e) { if (attempt >= 5) throw e; await sleep(4000 * (attempt + 1)); return callGroq(ctx, attempt + 1); }
  if (r.status === 429 || r.status >= 500) {
    const txt = await r.text();
    if (/per day|daily/i.test(txt)) { const e = new Error('daily-quota-exhausted'); e.daily = true; throw e; }
    if (attempt >= 6) throw new Error('rate-limited after retries');
    await sleep(6000 * (attempt + 1)); return callGroq(ctx, attempt + 1);
  }
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 120));
  const j = await r.json();
  const txt = ((j.choices || [])[0] || {}).message ? j.choices[0].message.content : '';
  let p; try { p = JSON.parse(txt); } catch (e) { p = { conviction: 50, verdict: 'CAUTION', reason: 'model output unparseable' }; }
  return sanitize(p);
}

async function callGemini(ctx, attempt = 0) {
  await gate();
  const body = {
    systemInstruction: { parts: [{ text: SYS }] },
    contents: [{ parts: [{ text: 'Proposed entry:\n' + JSON.stringify(ctx, null, 2) }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 200, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } },
  };
  let r;
  try {
    r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) { if (attempt >= 5) throw e; await sleep(4000 * (attempt + 1)); return callGemini(ctx, attempt + 1); }
  if (r.status === 429) {
    const txt = await r.text();
    if (/PerDay/i.test(txt)) { const e = new Error('daily-quota-exhausted'); e.daily = true; throw e; }
    if (attempt >= 6) throw new Error('rate-limited after retries');
    await sleep(9000 * (attempt + 1)); return callGemini(ctx, attempt + 1);
  }
  if (r.status >= 500) { if (attempt >= 5) throw new Error('server ' + r.status); await sleep(4000 * (attempt + 1)); return callGemini(ctx, attempt + 1); }
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 120));
  const j = await r.json();
  const c = (j.candidates || [])[0] || {};
  const txt = (c.content && c.content.parts) ? c.content.parts[0].text : '';
  let p; try { p = JSON.parse(txt); } catch (e) { p = { conviction: 50, verdict: 'CAUTION', reason: 'model output unparseable' }; }
  return sanitize(p);
}

const callLLM = ctx => PROVIDER === 'groq' ? callGroq(ctx) : callGemini(ctx);

function cachePath(ctx) { return path.join(CACHE_DIR, (ctx.sym + '@' + ctx.time + '_' + ctx.side).replace(/[^\w.@-]/g, '_') + '.json'); }
function reviewCached(ctx) { const ck = cachePath(ctx); return fs.existsSync(ck) ? JSON.parse(fs.readFileSync(ck, 'utf8')) : null; }
async function review(ctx) {
  const cached = reviewCached(ctx);
  if (cached) return cached;
  const res = await callLLM(ctx);
  fs.writeFileSync(cachePath(ctx), JSON.stringify(res));
  return res;
}

module.exports = { review, reviewCached, MODEL, PROVIDER, hasKey: () => !!PROVIDER };
