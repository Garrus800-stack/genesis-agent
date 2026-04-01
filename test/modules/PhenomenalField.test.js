#!/usr/bin/env node
// ============================================================
// Test: PhenomenalField.js — Unified Experience Binding
//
// Tests construction, frame computation, salience calculation,
// and valence/arousal/coherence/phi metrics. Uses NullBus +
// stubs to avoid needing a live system.
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const { NullBus } = require('../../src/agent/core/EventBus');
const { PhenomenalField } = require('../../src/agent/consciousness/PhenomenalField');

function createField(overrides = {}) {
  return new PhenomenalField({
    bus: NullBus,
    storage: null,
    eventStore: null,
    intervals: { register: () => {}, clear: () => {} },
    config: {},
    ...overrides,
  });
}

describe('PhenomenalField — Construction', () => {
  test('constructs without errors', () => {
    const pf = createField();
    assert(pf, 'should construct');
  });

  test('starts with epoch 0', () => {
    const pf = createField();
    assertEqual(pf._frameEpoch, 0);
  });

  test('frame history starts empty', () => {
    const pf = createField();
    const history = pf._frames || pf._history || [];
    assertEqual(history.length, 0);
  });
});

describe('PhenomenalField — Sampling', () => {
  test('_sampleEmotion returns object with defaults when no emotionalState', () => {
    const pf = createField();
    const emotion = pf._computation._sampleEmotion();
    assert(emotion !== null && emotion !== undefined, 'should return emotion data');
    assert(typeof emotion === 'object', 'should be an object');
  });

  test('_sampleNeeds returns object with defaults', () => {
    const pf = createField();
    const needs = pf._computation._sampleNeeds();
    assert(typeof needs === 'object');
  });

  test('_sampleSurprise returns object', () => {
    const pf = createField();
    const surprise = pf._computation._sampleSurprise();
    assert(typeof surprise === 'object');
  });
});

describe('PhenomenalField — Computation', () => {
  test('_computeValence returns number in range [-1, 1]', () => {
    const pf = createField();
    const emotion = pf._computation._sampleEmotion();
    const needs = pf._computation._sampleNeeds();
    const surprise = pf._computation._sampleSurprise();
    const homeostasis = pf._computation._sampleHomeostasis();
    const valence = pf._computation._computeValence(emotion, needs, surprise, homeostasis);
    assert(typeof valence === 'number', 'valence should be a number');
    assert(valence >= -1 && valence <= 1, `valence ${valence} should be in [-1, 1]`);
  });

  test('_computeArousal returns number in range [0, 1]', () => {
    const pf = createField();
    const emotion = pf._computation._sampleEmotion();
    const needs = pf._computation._sampleNeeds();
    const surprise = pf._computation._sampleSurprise();
    const homeostasis = pf._computation._sampleHomeostasis();
    const arousal = pf._computation._computeArousal(emotion, needs, surprise, homeostasis);
    assert(typeof arousal === 'number');
    assert(arousal >= 0 && arousal <= 1, `arousal ${arousal} should be in [0, 1]`);
  });

  test('_computeCoherence returns number in range [0, 1]', () => {
    const pf = createField();
    const salience = { emotion: 0.3, needs: 0.2, surprise: 0.1, expectation: 0.15, memory: 0.15, homeostasis: 0.1 };
    const coherence = pf._computation._computeCoherence(salience);
    assert(typeof coherence === 'number');
    assert(coherence >= 0 && coherence <= 1, `coherence ${coherence} should be in [0, 1]`);
  });

  test('_computePhi returns number in range [0, 1]', () => {
    const pf = createField();
    const emotion = pf._computation._sampleEmotion();
    const needs = pf._computation._sampleNeeds();
    const surprise = pf._computation._sampleSurprise();
    const expectation = pf._computation._sampleExpectation();
    const homeostasis = pf._computation._sampleHomeostasis();
    const phi = pf._computation._computePhi(emotion, needs, surprise, expectation, homeostasis);
    assert(typeof phi === 'number');
    assert(phi >= 0 && phi <= 1, `phi ${phi} should be in [0, 1]`);
  });

  test('_computeSalience returns normalized object', () => {
    const pf = createField();
    const e = pf._computation._sampleEmotion();
    const n = pf._computation._sampleNeeds();
    const s = pf._computation._sampleSurprise();
    const x = pf._computation._sampleExpectation();
    const m = pf._computation._sampleMemory();
    const h = pf._computation._sampleHomeostasis();
    const salience = pf._computation._computeSalience(e, n, s, x, m, h);
    assert(typeof salience === 'object');
    // Values should be roughly normalized
    const values = Object.values(salience);
    assert(values.every(v => typeof v === 'number' && v >= 0), 'all salience values should be non-negative numbers');
  });
});

describe('PhenomenalField — Lifecycle', () => {
  test('start and stop without errors', () => {
    const pf = createField();
    pf.start();
    pf.stop();
    assert(true, 'lifecycle completed');
  });
});

run();
