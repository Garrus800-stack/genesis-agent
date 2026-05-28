#!/usr/bin/env node
// ============================================================
// GENESIS — test/modules/v7912-all-models-unavailable.contract.test.js
//
// v7.9.12: areAllModelsUnavailable() — the shared predicate that drives
// IdleMind rest-mode and ResourceRegistry service:llm resolution.
//
// Semantics under test:
//   - all discovered models marked  → true
//   - at least one model free        → false
//   - empty model list               → false (boot problem, not marker
//                                       exhaustion — must not be confused
//                                       with rest-mode)
//   - expired marker is swept        → a model whose TTL elapsed counts as
//                                       available again, and the per-model
//                                       isMarkedUnavailable() lazy-clear
//                                       fires model:unavailable-cleared
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const { ModelBridge } = require('../../src/agent/foundation/ModelBridge');
const { createBus } = require('../../src/agent/core/EventBus');

function makeBridge() {
  const bus = createBus();
  const cleared = [];
  bus.on('model:unavailable-cleared', (d) => cleared.push(d), { source: 'test' });
  const mb = new ModelBridge({ bus });
  return { mb, bus, cleared };
}

const HOUR = 60 * 60 * 1000;

describe('v7.9.12 — areAllModelsUnavailable()', () => {

  test('empty model list returns false (boot problem, not rest-mode)', () => {
    const { mb } = makeBridge();
    mb.availableModels = [];
    assertEqual(mb.areAllModelsUnavailable(), false,
      'empty availableModels must return false');
  });

  test('all models marked returns true', () => {
    const { mb } = makeBridge();
    mb.availableModels = [
      { name: 'a', backend: 'ollama' },
      { name: 'b', backend: 'ollama' },
    ];
    mb.markUnavailable('a', HOUR, 'rate-limit');
    mb.markUnavailable('b', HOUR, 'rate-limit');
    assertEqual(mb.areAllModelsUnavailable(), true,
      'both models marked → true');
  });

  test('one free model returns false', () => {
    const { mb } = makeBridge();
    mb.availableModels = [
      { name: 'a', backend: 'ollama' },
      { name: 'b', backend: 'ollama' },
    ];
    mb.markUnavailable('a', HOUR, 'rate-limit');
    // 'b' left unmarked
    assertEqual(mb.areAllModelsUnavailable(), false,
      'one unmarked model → false');
  });

  test('expired marker is swept and counts as available', () => {
    const { mb, cleared } = makeBridge();
    mb.availableModels = [{ name: 'a', backend: 'ollama' }];
    // Mark with a TTL already in the past by setting the map entry directly
    // to a past `until`. markUnavailable computes until=now+ttl, so to force
    // an expired entry we write the map directly (mirrors what a stale
    // persisted marker would look like after a long downtime).
    mb._unavailableUntil.set('a', { until: Date.now() - 1000, reason: 'rate-limit', ttlMs: HOUR });
    const result = mb.areAllModelsUnavailable();
    assertEqual(result, false,
      'expired marker means the model is available again → false');
    assert(cleared.some(c => c.modelName === 'a' && c.automatic === true),
      'sweeping an expired marker fires model:unavailable-cleared with automatic:true');
  });

  test('mixed expired + active markers resolves correctly', () => {
    const { mb } = makeBridge();
    mb.availableModels = [
      { name: 'a', backend: 'ollama' },
      { name: 'b', backend: 'ollama' },
    ];
    // a expired, b active
    mb._unavailableUntil.set('a', { until: Date.now() - 1000, reason: 'timeout', ttlMs: HOUR });
    mb.markUnavailable('b', HOUR, 'rate-limit');
    assertEqual(mb.areAllModelsUnavailable(), false,
      'a recovered (expired) so not all unavailable → false');
  });

  test('non-array availableModels returns false defensively', () => {
    const { mb } = makeBridge();
    mb.availableModels = null;
    assertEqual(mb.areAllModelsUnavailable(), false,
      'null availableModels must not throw, returns false');
  });

});

if (require.main === module) run();
