#!/usr/bin/env node
// ============================================================
// GENESIS — test/modules/v7912-resource-llm-availability.contract.test.js
//
// v7.9.12: ResourceRegistry resolves service:llm to unavailable when every
// model is marked unavailable, and bridges model-availability markers onto
// the service:llm token so blocked goals can recover.
//
// The bug this guards against: service:llm is resolved live in isAvailable()
// and never cached. _update() — the only thing that fires resource:available
// / resource:unavailable — is therefore never called for service:llm
// organically. Without the two bridge listeners, a goal that blocks on
// service:llm during an all-models-down outage would NEVER unblock, because
// GoalDriver._onResourceAvailable would never receive a resource:available
// for service:llm on recovery.
//
// Under test:
//   - isAvailable('service:llm') false when areAllModelsUnavailable() true
//   - isAvailable('service:llm') true when a model is available again
//   - marking all models fires resource:unavailable for service:llm
//   - clearing fires resource:available for service:llm (the recovery signal)
//   - single-model mark (not all down) does NOT flip the token
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const { ResourceRegistry } = require('../../src/agent/foundation/ResourceRegistry');
const { createBus } = require('../../src/agent/core/EventBus');

// Bridge stub with controllable all-down state and a live activeBackend.
function makeBridgeStub() {
  return {
    activeBackend: 'ollama',
    _allDown: false,
    areAllModelsUnavailable() { return this._allDown; },
  };
}

// A registry where service:ollama is registered available, so service:llm
// resolution only hinges on the all-models-down check.
function makeRegistry(bridge) {
  const bus = createBus();
  const rr = new ResourceRegistry({ bus, modelBridge: bridge });
  rr.register('service:ollama', true); // backend itself reachable
  return { rr, bus };
}

describe('v7.9.12 — ResourceRegistry service:llm availability', () => {

  test('service:llm available when models up, unavailable when all down', () => {
    const bridge = makeBridgeStub();
    const { rr } = makeRegistry(bridge);

    bridge._allDown = false;
    assertEqual(rr.isAvailable('service:llm'), true,
      'service:llm available when models up and backend reachable');

    bridge._allDown = true;
    assertEqual(rr.isAvailable('service:llm'), false,
      'service:llm unavailable when all models marked');
  });

  test('service:llm false when no active backend regardless of markers', () => {
    const bridge = makeBridgeStub();
    bridge.activeBackend = null;
    const { rr } = makeRegistry(bridge);
    assertEqual(rr.isAvailable('service:llm'), false,
      'no backend → service:llm unavailable');
  });

  test('marking all models fires resource:unavailable for service:llm', async () => {
    const bridge = makeBridgeStub();
    const { rr, bus } = makeRegistry(bridge);
    await rr.asyncLoad(); // wires the bridge listeners

    const unav = [];
    bus.on('resource:unavailable', (d) => unav.push(d), { source: 'test' });

    // First establish service:llm as available in the cache via a marker
    // event while NOT all-down (so the token gets cached as available).
    bridge._allDown = false;
    bus.fire('model:marked-unavailable', { modelName: 'm0', reason: 'rate-limit', ttlMs: 1000 }, { source: 'test' });

    // Now all models go down.
    bridge._allDown = true;
    bus.fire('model:marked-unavailable', { modelName: 'm1', reason: 'rate-limit', ttlMs: 1000 }, { source: 'test' });

    const llmEvt = unav.find(e => e.token === 'service:llm');
    assert(llmEvt, 'resource:unavailable fired for service:llm when all models down');
  });

  test('clearing a model fires resource:available for service:llm (recovery)', async () => {
    const bridge = makeBridgeStub();
    const { rr, bus } = makeRegistry(bridge);
    await rr.asyncLoad();

    const avail = [];
    bus.on('resource:available', (d) => { if (d.token === 'service:llm') avail.push(d); }, { source: 'test' });

    // Go all-down first (caches service:llm = false)
    bridge._allDown = true;
    bus.fire('model:marked-unavailable', { modelName: 'm0', reason: 'rate-limit', ttlMs: 1000 }, { source: 'test' });

    // A model recovers
    bridge._allDown = false;
    bus.fire('model:unavailable-cleared', { modelName: 'm0', automatic: true }, { source: 'test' });

    assert(avail.length >= 1, 'resource:available fired for service:llm on recovery — this is the unblock signal GoalDriver needs');
  });

  test('single-model mark (not all down) does not flip the token', async () => {
    const bridge = makeBridgeStub();
    const { rr, bus } = makeRegistry(bridge);
    await rr.asyncLoad();

    const events = [];
    bus.on('resource:unavailable', (d) => { if (d.token === 'service:llm') events.push(d); }, { source: 'test' });

    // One model marked but others fine → areAllModelsUnavailable stays false
    bridge._allDown = false;
    bus.fire('model:marked-unavailable', { modelName: 'm0', reason: 'rate-limit', ttlMs: 1000 }, { source: 'test' });
    bus.fire('model:marked-unavailable', { modelName: 'm1', reason: 'rate-limit', ttlMs: 1000 }, { source: 'test' });

    assertEqual(events.length, 0, 'service:llm stays available while not all models are down');
  });

});

if (require.main === module) run();
