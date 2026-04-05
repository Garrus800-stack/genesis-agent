const { describe, test, assert, assertEqual, run } = require('../harness');
const { Homeostasis } = require('../../src/agent/organism/Homeostasis');

function makeHO() {
  return new Homeostasis({
    bus: { emit(){}, fire(){}, on(){} },
    storage: null, intervals: null, emotionalState: null, config: {},
  });
}

describe('HomeostasisVitals — _classifyVital', () => {
  test('classifies healthy value', () => {
    const ho = makeHO();
    const vital = { value: 0.5, healthy: { min: 0.3, max: 0.8 }, warning: { min: 0.1, max: 0.9 } };
    assertEqual(ho._classifyVital(vital), 'healthy');
  });
  test('classifies warning value', () => {
    const ho = makeHO();
    const vital = { value: 0.15, healthy: { min: 0.3, max: 0.8 }, warning: { min: 0.1, max: 0.9 } };
    assertEqual(ho._classifyVital(vital), 'warning');
  });
  test('classifies critical value', () => {
    const ho = makeHO();
    const vital = { value: 0.05, healthy: { min: 0.3, max: 0.8 }, warning: { min: 0.1, max: 0.9 } };
    assertEqual(ho._classifyVital(vital), 'critical');
  });
});

describe('HomeostasisVitals — _calculateErrorRate', () => {
  test('returns 0 with no event store', () => {
    const ho = makeHO();
    assertEqual(ho._calculateErrorRate(), 0);
  });
});

describe('HomeostasisVitals — _logCorrection', () => {
  test('records correction entry', () => {
    const ho = makeHO();
    ho._logCorrection('testVital', 'warning', 'reduce');
    assert(ho._corrections.length >= 1);
    assertEqual(ho._corrections[0].vital, 'testVital');
  });
  test('trims corrections over max', () => {
    const ho = makeHO();
    ho._maxCorrections = 3;
    for (let i = 0; i < 5; i++) ho._logCorrection(`v${i}`, 'warning', 'test');
    assert(ho._corrections.length <= 3);
  });
});

describe('HomeostasisVitals — _updateVitals', () => {
  test('does not crash', () => {
    const ho = makeHO();
    ho._updateVitals();
    assert(true);
  });
});

describe('HomeostasisVitals — _applyCorrections', () => {
  test('does not crash on healthy vitals', () => {
    const ho = makeHO();
    ho._applyCorrections();
    assert(true);
  });
});

run();
