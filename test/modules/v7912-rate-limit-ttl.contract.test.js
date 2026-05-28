#!/usr/bin/env node
// ============================================================
// GENESIS — test/modules/v7912-rate-limit-ttl.contract.test.js
//
// v7.9.12: rate-limit failover TTL raised from 5min to 60min.
//
// Why: provider rate-limit windows are rarely shorter than an hour.
// Retrying a rate-limited model every 5 minutes just produces more
// 429s — the same reasoning that gave quota-exhausted a long TTL.
// A live field-trace showed Genesis hammering a 429-throttled cloud
// model on a 5-minute cadence, accumulating frustration and noise
// without any chance of the window having reset.
//
// This contract guards the *behavior*: a 429 error must classify as
// 'rate-limit' and the resulting unavailable-marker must carry a
// 60-minute TTL. The companion source-presence assertion lives in
// v756-fix.test.js (B4) and tracks the literal constant.
//
// If a future change needs a shorter rate-limit TTL, that is a
// deliberate decision — update this test with the new rationale,
// don't silently weaken it.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const { ModelBridge } = require('../../src/agent/foundation/ModelBridge');
const { createBus } = require('../../src/agent/core/EventBus');

const SIXTY_MIN_MS = 60 * 60 * 1000;

function makeBridge() {
  const bus = createBus();
  const fired = [];
  bus.on('model:marked-unavailable', (data) => fired.push(data), { source: 'test' });
  // genesisDir omitted on purpose: persistence is best-effort and a
  // missing dir must not throw (markUnavailable calls _persistUnavailable).
  const mb = new ModelBridge({ bus });
  return { mb, fired };
}

describe('v7.9.12 — rate-limit failover TTL is 60min', () => {

  test('429 error classifies as rate-limit', () => {
    const { mb } = makeBridge();
    assertEqual(mb._classifyFailoverReason(new Error('HTTP 429 Too Many Requests')), 'rate-limit',
      '429 must classify as rate-limit');
    assertEqual(mb._classifyFailoverReason(new Error('rate-limit exceeded')), 'rate-limit',
      'explicit rate-limit text must classify as rate-limit');
    assertEqual(mb._classifyFailoverReason(new Error('too many requests, slow down')), 'rate-limit',
      '"too many" must classify as rate-limit');
  });

  test('marking a rate-limited model carries a 60min TTL', () => {
    const { mb, fired } = makeBridge();
    // End-to-end: a 429 failover with no fallback marks the called model.
    // _handleFailoverError is the shared sink that calls markUnavailable with
    // UNAVAILABLE_TTL_MAP[reason]. We assert the resulting TTL through the
    // public event payload rather than the module-private map, so the test
    // stays honest about observable behavior. With no fallbackChain and no
    // other available backend, _findFallbackBackend returns null → the called
    // model is marked, then the error is rethrown.
    return (async () => {
      mb.availableModels = [];                // no fallback candidates
      mb._settings = { get: () => [] };       // empty fallbackChain
      try {
        await mb._handleFailoverError(new Error('HTTP 429'), {
          taskType: 'chat', temp: 0.7, startTime: Date.now(),
          options: {}, calledModel: 'rl-model', targetBackend: 'ollama',
          dispatch: async () => { throw new Error('unreachable — no fallback'); },
          label: 'Test',
        });
      } catch (_e) { /* expected rethrow */ }

      assert(fired.length >= 1, 'model:marked-unavailable must fire for the 429');
      const evt = fired.find(f => f.modelName === 'rl-model');
      assert(evt, 'marked event for rl-model must be present');
      assertEqual(evt.reason, 'rate-limit', 'marker reason must be rate-limit');
      assertEqual(evt.ttlMs, SIXTY_MIN_MS, `rate-limit TTL must be 60min (${SIXTY_MIN_MS}ms), got ${evt.ttlMs}`);
    })();
  });

  test('rate-limit TTL is NOT the old 5min value', () => {
    const { mb, fired } = makeBridge();
    return (async () => {
      mb.availableModels = [];
      mb._settings = { get: () => [] };
      try {
        await mb._handleFailoverError(new Error('429 too many requests'), {
          taskType: 'chat', temp: 0.7, startTime: Date.now(),
          options: {}, calledModel: 'rl-model-2', targetBackend: 'ollama',
          dispatch: async () => { throw new Error('unreachable'); },
          label: 'Test',
        });
      } catch (_e) { /* expected */ }
      const evt = fired.find(f => f.modelName === 'rl-model-2');
      assert(evt, 'marked event must be present');
      assert(evt.ttlMs !== 5 * 60 * 1000, 'rate-limit TTL must no longer be the old 5min value');
    })();
  });

});

if (require.main === module) run();
