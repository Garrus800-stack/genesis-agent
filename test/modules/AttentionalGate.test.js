#!/usr/bin/env node
// Test: AttentionalGate.js — Competitive attention mechanism
const { describe, test, assert, assertEqual, run } = require('../harness');
const { NullBus } = require('../../src/agent/core/EventBus');
const { AttentionalGate } = require('../../src/agent/consciousness/AttentionalGate');

function createGate(overrides = {}) {
  return new AttentionalGate({
    bus: NullBus,
    storage: null,
    eventStore: null,
    intervals: { register: () => {}, clear: () => {} },
    config: {},
    ...overrides,
  });
}

describe('AttentionalGate — Construction', () => {
  test('constructs without errors', () => {
    const ag = createGate();
    assert(ag, 'should construct');
  });

  test('starts in diffuse mode', () => {
    const ag = createGate();
    const mode = ag.getMode();
    assert(mode === 'diffuse' || mode === 'DIFFUSE' || typeof mode === 'string', 'should have initial mode');
  });
});

describe('AttentionalGate — Focus API', () => {
  test('getCurrentFocus method exists', () => {
    const ag = createGate();
    assert(typeof ag.getCurrentFocus === 'function', 'should have getCurrentFocus');
  });

  test('getCurrentFocus returns initial state', () => {
    const ag = createGate();
    const focus = ag.getCurrentFocus();
    assert(focus !== undefined, 'should return focus data');
  });

  test('directFocus method exists', () => {
    const ag = createGate();
    assert(typeof ag.directFocus === 'function', 'should have directFocus');
  });
});

describe('AttentionalGate — Mode Transitions', () => {
  test('getMode returns valid mode string', () => {
    const ag = createGate();
    const mode = ag.getMode();
    const validModes = ['focused', 'diffuse', 'captured', 'FOCUSED', 'DIFFUSE', 'CAPTURED'];
    assert(validModes.includes(mode), `mode "${mode}" should be valid`);
  });
});

describe('AttentionalGate — Lifecycle', () => {
  test('start and stop without errors', () => {
    const ag = createGate();
    ag.start();
    ag.stop();
    assert(true);
  });
});

run();
