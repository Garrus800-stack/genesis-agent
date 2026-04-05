#!/usr/bin/env node
// Test: IntrospectionEngine.js — Meta-cognitive awareness
const { describe, test, assert, assertEqual, run } = require('../harness');
const { NullBus } = require('../../src/agent/core/EventBus');
const { IntrospectionEngine } = require('../../src/agent/consciousness/IntrospectionEngine');

function createEngine(overrides = {}) {
  return new IntrospectionEngine({
    bus: NullBus,
    storage: null,
    eventStore: null,
    intervals: { register: () => {}, clear: () => {} },
    config: {},
    ...overrides,
  });
}

describe('IntrospectionEngine — Construction', () => {
  test('constructs without errors', () => {
    const ie = createEngine();
    assert(ie, 'should construct');
  });

  test('tick interval is reasonable', () => {
    const ie = createEngine();
    assert(ie._tickIntervalMs >= 1000, 'tick should be at least 1s');
    assert(ie._tickIntervalMs <= 60000, 'tick should be at most 60s');
  });

  test('metacognitive strength is in [0, 1]', () => {
    const ie = createEngine();
    assert(ie._metacognitiveStrength >= 0);
    assert(ie._metacognitiveStrength <= 1);
  });
});

describe('IntrospectionEngine — Self Theory', () => {
  test('getSelfTheory returns initial structure', () => {
    const ie = createEngine();
    const theory = ie.getSelfTheory();
    assert(theory !== undefined, 'should return something');
  });

  test('observation log starts empty', () => {
    const ie = createEngine();
    assertEqual(ie._observationLog.length, 0);
  });
});

describe('IntrospectionEngine — Lifecycle', () => {
  test('start registers interval', () => {
    let registered = false;
    const ie = createEngine({
      intervals: { register: () => { registered = true; }, clear: () => {} },
    });
    ie.start();
    assert(registered, 'should register introspection interval');
  });

  test('stop clears interval', () => {
    let cleared = false;
    const ie = createEngine({
      intervals: { register: () => {}, clear: () => { cleared = true; } },
    });
    ie.start();
    ie.stop();
    assert(cleared, 'should clear introspection interval');
  });
});

run();
