// ============================================================
// GENESIS — test/modules/v7926-continuation-telemetry.contract.test.js
// Contract test for v7.9.26 ContinuationLoop observability:
//   • Per-round llm:continuation-round telemetry (model, attempt,
//     doneReason, partialChars, deltaChars, verdict) — one per round,
//     emitted before the complete/failed terminal event.
//   • The round event fires on the failure path too, so a sequence
//     that never completes is observable round by round (this is the
//     signal that makes the cloud-continuation runaway diagnosable).
// This release adds observability only — no change to loop control flow.
// ============================================================

'use strict';

// Zero out the inter-attempt backoff (module constant, must be set before require).
process.env.GENESIS_OFFLINE_TESTS = '1';

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { runContinuation } = require(path.join(ROOT, 'src/agent/foundation/backends/ContinuationLoop'));
const { MockBackend } = require(path.join(ROOT, 'src/agent/foundation/backends/MockBackend'));

function chunkedBackend(scripts) {
  return new MockBackend({ mode: 'chunked', chunkedScripts: scripts });
}

function captureEvents() {
  const log = [];
  return { bus: { emit: (name, payload) => log.push({ name, payload }) }, log };
}

const VERIFIED = { status: 'verified-prefill' }; // caps at maxContinuations (6 default)

describe('v7.9.26 ContinuationLoop per-round telemetry', () => {

  test('emits one llm:continuation-round per round with correct fields', async () => {
    const { bus, log } = captureEvents();
    const backend = chunkedBackend([
      { chunks: ['First part. '], doneReason: 'length' },    // truncated → continue
      { chunks: ['Second part done.'], doneReason: 'stop' },  // structurally complete
    ]);
    const res = await runContinuation({
      backend,
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'go' }],
      options: { modelName: 'mock', eventBus: bus, capability: VERIFIED },
    });

    const rounds = log.filter(e => e.name === 'llm:continuation-round');
    assertEqual(rounds.length, 2, 'two round events emitted');

    assertEqual(rounds[0].payload.attempt, 1, 'round 1 attempt');
    assertEqual(rounds[0].payload.deltaChars, 12, 'round 1 deltaChars = len("First part. ")');
    assertEqual(rounds[0].payload.partialChars, 12, 'round 1 cumulative chars');
    assertEqual(rounds[0].payload.verdict, 'incomplete', 'round 1 still truncated');
    assertEqual(rounds[0].payload.model, 'mock', 'round 1 model threaded');

    assertEqual(rounds[1].payload.attempt, 2, 'round 2 attempt');
    assertEqual(rounds[1].payload.deltaChars, 17, 'round 2 deltaChars = len("Second part done.")');
    assertEqual(rounds[1].payload.partialChars, 29, 'round 2 cumulative chars');
    assertEqual(rounds[1].payload.verdict, 'complete', 'round 2 completes');

    // The round event precedes the terminal complete event.
    const names = log.map(e => e.name);
    assert(names.indexOf('llm:continuation-round') < names.indexOf('llm:continuation-complete'),
      'round telemetry precedes the complete event');
    assertEqual(res.attempts, 2, 'completed in two attempts');
  });

  test('round events fire on the failure path too (runaway is observable)', async () => {
    const { bus, log } = captureEvents();
    const scripts = [];
    for (let i = 0; i < 6; i++) scripts.push({ chunks: ['x'.repeat(50)], doneReason: 'length' });
    const backend = chunkedBackend(scripts);
    const res = await runContinuation({
      backend,
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'go' }],
      options: { modelName: 'mock', eventBus: bus, capability: VERIFIED, maxContinuations: 6 },
    });

    const rounds = log.filter(e => e.name === 'llm:continuation-round');
    assertEqual(rounds.length, 6, 'one round event per attempt, even when never completing');
    assertEqual(rounds[0].payload.attempt, 1);
    assertEqual(rounds[5].payload.attempt, 6, 'attempt numbers run through the cap');
    assert(rounds.every(r => r.payload.verdict === 'incomplete'), 'every round verdict incomplete');
    assert(rounds.every(r => r.payload.deltaChars === 50), 'per-round growth reported');
    assertEqual(res.attempts, 6, 'ran to the cap');

    const failed = log.find(e => e.name === 'llm:continuation-failed');
    assertEqual(failed.payload.reason, 'max-continuations', 'terminal reason is the cap');
  });

});

run();
