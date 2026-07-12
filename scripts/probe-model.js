#!/usr/bin/env node
'use strict';
// ============================================================
// probe-model.js — v7.9.37 pass 4 (C4)
//
// One-minute truth for any Ollama model (local or :cloud):
//   node scripts/probe-model.js deepseek-v4-pro:cloud
//
// Prints: the model's REAL context window (/api/show), the num_ctx
// Genesis will actually send (after cap), the derived num_predict,
// time-to-first-chunk, tokens/sec, and the done_reason — the five
// numbers behind every "why does he never finish" field mystery.
// Field 2026-07-10: 48k prompts were sent with num_ctx:8192; eleven
// 180s first-chunk timeouts followed. This script makes that visible
// BEFORE a ten-hour idle run does.
// ============================================================

const { OllamaBackend } = require('../src/agent/foundation/backends/OllamaBackend');

async function main() {
  const model = process.argv[2];
  const baseUrl = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
  if (!model) {
    console.log('Usage: node scripts/probe-model.js <model> [promptChars]');
    console.log('  env OLLAMA_URL to override http://127.0.0.1:11434');
    process.exit(1);
  }
  const padChars = Number(process.argv[3] || 0);

  const b = new OllamaBackend({ baseUrl });
  console.log(`\n── probe: ${model} @ ${baseUrl} ──────────────────────`);

  // 1) Window truth
  const show = await b._fetchShow(model);
  let rawCtx = null;
  if (show?.model_info) {
    for (const [k, v] of Object.entries(show.model_info)) {
      if (k.endsWith('.context_length') && Number.isFinite(v)) { rawCtx = v; break; }
    }
  }
  if (!rawCtx && typeof show?.parameters === 'string') {
    const m = show.parameters.match(/num_ctx\s+(\d+)/);
    if (m) rawCtx = parseInt(m[1], 10);
  }
  const sentCtx = await b._ctxFor(model);
  const predict = b._predictFor(undefined, sentCtx);
  console.log(`model window (/api/show): ${rawCtx ?? 'unknown (show failed or no field)'}`);
  console.log(`num_ctx Genesis sends:    ${sentCtx}  (cap ${b._ctxConfig.numCtxCap})`);
  console.log(`num_predict default:      ${predict}`);

  // 2) Live stream: first-chunk latency, tokens/sec, done_reason
  const pad = padChars > 0 ? `\nContext filler:\n${'x '.repeat(Math.floor(padChars / 2))}` : '';
  const sys = 'You are a probe. Reply with exactly: OK probe done.' + pad;
  const t0 = Date.now();
  let tFirst = null, chars = 0, done = 'n/a';
  try {
    await b.stream(sys, [{ role: 'user', content: 'Reply now.' }],
      (chunk) => { if (tFirst == null) tFirst = Date.now(); chars += chunk.length; },
      undefined, 0.1, model, 64,
      (reason) => { done = reason; });
  } catch (err) {
    console.log(`stream:                   FAILED — ${err.message}`);
    process.exit(2);
  }
  const total = (Date.now() - t0) / 1000;
  const gen = tFirst ? (Date.now() - tFirst) / 1000 : total;
  console.log(`time to first chunk:      ${tFirst ? ((tFirst - t0) / 1000).toFixed(1) + 's' : 'never'}`);
  console.log(`tokens/sec (≈chars/4):    ${gen > 0 ? (chars / 4 / gen).toFixed(1) : 'n/a'}  (${chars} chars in ${total.toFixed(1)}s)`);
  console.log(`done_reason:              ${done}`);
  console.log('──────────────────────────────────────────────────────\n');
}

main().catch((e) => { console.error('probe failed:', e.message); process.exit(3); });
