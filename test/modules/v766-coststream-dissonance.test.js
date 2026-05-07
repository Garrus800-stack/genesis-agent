// ============================================================
// GENESIS — test/modules/v766-coststream-dissonance.test.js
//
// Coverage for v7.6.6 Track C — CostStream dissonance-pushback
// listener. Same counter-only pattern as the v7.6.3 failover-listener.
// Verifies tally accumulation, getStats() exposure, stop() cleanup,
// and that the listener does not interfere with the existing failover
// or cost-call paths.
// ============================================================

const fs = require('fs');
const path = require('path');
const os = require('os');

const { describe, test, assert, assertEqual, run } = require('../harness');

const ROOT = path.resolve(__dirname, '..', '..');
const { CostStream } = require(path.join(ROOT, 'src/agent/foundation/CostStream.js'));

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-coststream-diss-'));
}

/**
 * Minimal bus that records subscriptions and lets us fire events
 * synchronously into registered handlers.
 */
function makeBus() {
  const handlers = new Map();
  return {
    on(event, handler /*, opts */) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(handler);
      return () => handlers.get(event).delete(handler);
    },
    fire(event, payload) {
      const set = handlers.get(event);
      if (!set) return;
      for (const h of set) h(payload);
    },
    _handlerCount(event) {
      return handlers.get(event)?.size ?? 0;
    },
  };
}

describe('v7.6.6 — CostStream dissonance listener', () => {

  test('asyncLoad subscribes to goal:dissonance-pushback', async () => {
    const bus = makeBus();
    const cs = new CostStream({ bus, storage: null, genesisDir: freshDir() });
    await cs.asyncLoad();
    assertEqual(bus._handlerCount('goal:dissonance-pushback'), 1,
      'one handler subscribed');
    cs.stop();
  });

  test('handler increments tally on dissonance event', async () => {
    const bus = makeBus();
    const cs = new CostStream({ bus, storage: null, genesisDir: freshDir() });
    await cs.asyncLoad();

    bus.fire('goal:dissonance-pushback', {
      goalId: 'pending_x', proposedDescription: 'foo',
      matchedGoalId: 'g1', dissonanceScore: 0.63, source: 'user',
    });

    const stats = cs.getStats();
    assertEqual(stats.dissonance.total, 1, 'tally counts the event');
    assertEqual(stats.dissonance.lastScore, 0.63, 'lastScore extracted');
    assertEqual(stats.dissonance.lastSource, 'user', 'lastSource extracted');
    assert(typeof stats.dissonance.lastAt === 'number', 'lastAt is a number');
    cs.stop();
  });

  test('multiple events accumulate', async () => {
    const bus = makeBus();
    const cs = new CostStream({ bus, storage: null, genesisDir: freshDir() });
    await cs.asyncLoad();

    bus.fire('goal:dissonance-pushback', { dissonanceScore: 0.5, source: 'user' });
    bus.fire('goal:dissonance-pushback', { dissonanceScore: 0.7, source: 'auto' });
    bus.fire('goal:dissonance-pushback', { dissonanceScore: 0.9, source: 'user' });

    const stats = cs.getStats();
    assertEqual(stats.dissonance.total, 3, 'three events tallied');
    assertEqual(stats.dissonance.lastScore, 0.9, 'last score wins');
    assertEqual(stats.dissonance.lastSource, 'user', 'last source wins');
    cs.stop();
  });

  test('handler does NOT write a JSONL row (counter-only by design)', async () => {
    const dir = freshDir();
    const bus = makeBus();
    const cs = new CostStream({ bus, storage: null, genesisDir: dir });
    await cs.asyncLoad();

    bus.fire('goal:dissonance-pushback', { dissonanceScore: 0.5 });

    // No cost row should have been queued
    assertEqual(cs._writeQueue.length, 0,
      'dissonance does not enter the cost-row write queue');
    cs.stop();
  });

  test('stop() unsubscribes the dissonance handler', async () => {
    const bus = makeBus();
    const cs = new CostStream({ bus, storage: null, genesisDir: freshDir() });
    await cs.asyncLoad();
    assertEqual(bus._handlerCount('goal:dissonance-pushback'), 1, 'subscribed');

    cs.stop();
    assertEqual(bus._handlerCount('goal:dissonance-pushback'), 0,
      'unsubscribed after stop');
  });

  test('stop() prevents further tally updates', async () => {
    const bus = makeBus();
    const cs = new CostStream({ bus, storage: null, genesisDir: freshDir() });
    await cs.asyncLoad();
    cs.stop();

    // After stop, even if a stray fire reached the handler (it would not
    // because we unsubbed), the _stopped guard catches it.
    cs._onDissonancePushback({ dissonanceScore: 0.42 });
    const stats = cs.getStats();
    assertEqual(stats.dissonance.total, 0, 'no tally update after stop');
  });

  test('failover and dissonance counters are independent', async () => {
    const bus = makeBus();
    const cs = new CostStream({ bus, storage: null, genesisDir: freshDir() });
    await cs.asyncLoad();

    bus.fire('model:failover-unavailable', { reason: 'no-local-fallback' });
    bus.fire('goal:dissonance-pushback', { dissonanceScore: 0.55 });

    const stats = cs.getStats();
    assertEqual(stats.failover.total, 1, 'failover counted independently');
    assertEqual(stats.dissonance.total, 1, 'dissonance counted independently');
    cs.stop();
  });

});

run();
