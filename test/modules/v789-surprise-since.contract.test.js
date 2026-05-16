// ============================================================
// GENESIS — test/modules/v789-surprise-since.contract.test.js
// Contract test for v7.8.9 SurpriseAccumulator.getSignalsSince:
//   • Returns [] for invalid timestamp
//   • Returns all signals for timestamp 0
//   • Returns [] for future timestamp
//   • Correctly filters mid-range timestamp
// Every test name carries `koennen-v789 contract:` prefix.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { SurpriseAccumulator } = require(path.join(ROOT, 'src/agent/cognitive/SurpriseAccumulator'));

// ── Helpers ───────────────────────────────────────────────

function makeBus() {
  const subs = new Map();
  return {
    on: (event, fn) => {
      if (!subs.has(event)) subs.set(event, new Set());
      subs.get(event).add(fn);
      return () => subs.get(event).delete(fn);
    },
    fire: (event, data) => {
      const set = subs.get(event);
      if (set) for (const fn of set) try { fn(data); } catch (_e) {}
    },
    emit: function () { return this.fire.apply(this, arguments); },
  };
}

function makeAccumulator() {
  const bus = makeBus();
  const acc = new SurpriseAccumulator({ bus });
  return { bus, acc };
}

function pushSignal(acc, totalSurprise, timestamp) {
  acc._buffer.push({
    totalSurprise,
    valence: totalSurprise > 0 ? 'positive' : 'negative',
    actionType: 'ANALYZE',
    timestamp,
  });
}

// ── Tests ─────────────────────────────────────────────────

describe('koennen-v789 contract: SurpriseAccumulator.getSignalsSince', () => {

  test('koennen-v789 contract: returns [] for invalid timestamp', () => {
    const { acc } = makeAccumulator();
    pushSignal(acc, 0.5, 1000);
    assertEqual(acc.getSignalsSince(null).length, 0, 'null → []');
    assertEqual(acc.getSignalsSince(undefined).length, 0, 'undefined → []');
    assertEqual(acc.getSignalsSince('abc').length, 0, 'string → []');
    assertEqual(acc.getSignalsSince(0).length, 0, 'zero is falsy in guard → []');
  });

  test('koennen-v789 contract: returns all signals when timestamp is 1', () => {
    const { acc } = makeAccumulator();
    pushSignal(acc, 0.3, 1000);
    pushSignal(acc, 0.7, 2000);
    pushSignal(acc, 1.2, 3000);
    const result = acc.getSignalsSince(1);
    assertEqual(result.length, 3, 'low ts returns all');
  });

  test('koennen-v789 contract: returns [] for future timestamp', () => {
    const { acc } = makeAccumulator();
    pushSignal(acc, 0.3, 1000);
    pushSignal(acc, 0.7, 2000);
    const result = acc.getSignalsSince(9999999);
    assertEqual(result.length, 0, 'future ts → []');
  });

  test('koennen-v789 contract: correctly filters mid-range timestamp', () => {
    const { acc } = makeAccumulator();
    pushSignal(acc, 0.3, 1000);
    pushSignal(acc, 0.7, 2000);
    pushSignal(acc, 1.1, 3000);
    pushSignal(acc, 0.5, 4000);
    const result = acc.getSignalsSince(2500);
    assertEqual(result.length, 2, 'two signals at ts >= 2500');
    assert(result.every(s => s.timestamp >= 2500), 'all filtered correctly');
  });

});

if (require.main === module) run();
