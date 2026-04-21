// ============================================================
// Tests for cognitive/GateStats.js (v7.3.6 #6)
// ============================================================

const assert = require('assert');
const { describe, test, run } = require('../harness');
const { GateStats } = require('../../src/agent/cognitive/GateStats');

describe('GateStats — basic recording', () => {

  test('empty tracker has no counters', () => {
    const g = new GateStats();
    assert.deepStrictEqual(g.summary(), []);
    assert.deepStrictEqual(g.knownGates(), []);
    assert.deepStrictEqual(g.active(), []);
  });

  test('recordGate creates counter on first call', () => {
    const g = new GateStats();
    g.recordGate('injection-gate', 'pass');
    const s = g.summary();
    assert.strictEqual(s.length, 1);
    assert.strictEqual(s[0].name, 'injection-gate');
    assert.strictEqual(s[0].total, 1);
    assert.strictEqual(s[0].pass, 1);
    assert.strictEqual(s[0].block, 0);
    assert.strictEqual(s[0].warn, 0);
  });

  test('recordGate aggregates across calls with same name', () => {
    const g = new GateStats();
    g.recordGate('x', 'pass');
    g.recordGate('x', 'pass');
    g.recordGate('x', 'block');
    g.recordGate('x', 'warn');
    const s = g.summary()[0];
    assert.strictEqual(s.total, 4);
    assert.strictEqual(s.pass, 2);
    assert.strictEqual(s.block, 1);
    assert.strictEqual(s.warn, 1);
  });

  test('blockRate computed correctly', () => {
    const g = new GateStats();
    for (let i = 0; i < 8; i++) g.recordGate('y', 'pass');
    for (let i = 0; i < 2; i++) g.recordGate('y', 'block');
    const s = g.summary()[0];
    assert.strictEqual(s.blockRate, 0.2, `expected 0.2, got ${s.blockRate}`);
  });

  test('unknown verdict is ignored', () => {
    const g = new GateStats();
    g.recordGate('z', 'pass');
    g.recordGate('z', 'invalid-verdict');
    g.recordGate('z', null);
    g.recordGate('z', undefined);
    assert.strictEqual(g.summary()[0].total, 1, 'only the valid call counted');
  });

  test('invalid name is ignored (empty, non-string)', () => {
    const g = new GateStats();
    g.recordGate('', 'pass');
    g.recordGate(null, 'pass');
    g.recordGate(undefined, 'pass');
    g.recordGate(123, 'pass');
    assert.deepStrictEqual(g.summary(), []);
  });

  test('multiple gates tracked independently', () => {
    const g = new GateStats();
    g.recordGate('a', 'pass');
    g.recordGate('b', 'block');
    g.recordGate('c', 'warn');
    assert.deepStrictEqual(g.knownGates(), ['a', 'b', 'c']);
  });

  test('summary sorted by total desc (hottest first)', () => {
    const g = new GateStats();
    g.recordGate('rare', 'pass');
    for (let i = 0; i < 5; i++) g.recordGate('hot', 'pass');
    for (let i = 0; i < 2; i++) g.recordGate('mid', 'pass');
    const s = g.summary();
    assert.strictEqual(s[0].name, 'hot', 'hottest gate first');
    assert.strictEqual(s[1].name, 'mid');
    assert.strictEqual(s[2].name, 'rare');
  });
});

describe('GateStats — sampling', () => {

  test('no sample rate means 1:1 recording', () => {
    const g = new GateStats();
    for (let i = 0; i < 10; i++) g.recordGate('unsampled', 'pass');
    assert.strictEqual(g.summary()[0].total, 10);
  });

  test('sample rate 10 records every 10th call', () => {
    const g = new GateStats({ sampleRates: { 'hot-gate': 10 } });
    for (let i = 0; i < 100; i++) g.recordGate('hot-gate', 'pass');
    const s = g.summary()[0];
    // Recording 1 out of 10 → 10 raw records; summary multiplies back → 100
    assert.strictEqual(s.total, 100, `expected 100 estimated, got ${s.total}`);
    assert.strictEqual(s.sampled, 10);
  });

  test('sample rate 1 behaves as no sampling', () => {
    const g = new GateStats({ sampleRates: { 'g': 1 } });
    for (let i = 0; i < 5; i++) g.recordGate('g', 'pass');
    assert.strictEqual(g.summary()[0].total, 5);
  });
});

describe('GateStats — reset and age', () => {

  test('reset clears all counters', () => {
    const g = new GateStats();
    g.recordGate('x', 'pass');
    g.recordGate('y', 'block');
    assert.strictEqual(g.summary().length, 2);
    g.reset();
    assert.deepStrictEqual(g.summary(), []);
  });

  test('age() returns elapsed ms with injectable clock', () => {
    let now = 1000;
    const g = new GateStats({ nowFn: () => now });
    now = 5000;
    assert.strictEqual(g.age(), 4000);
  });
});

describe('GateStats — no-op contract (optional injection)', () => {

  test('optional chaining: undefined gateStats is safe', () => {
    // This simulates a service where gateStats was not injected
    const mockService = { gateStats: undefined };
    // This must not throw — the whole point of `?.`
    assert.doesNotThrow(() => {
      mockService.gateStats?.recordGate('x', 'pass');
    });
  });

  test('null gateStats is safe', () => {
    const mockService = { gateStats: null };
    assert.doesNotThrow(() => {
      mockService.gateStats?.recordGate('x', 'pass');
    });
  });
});

run();
