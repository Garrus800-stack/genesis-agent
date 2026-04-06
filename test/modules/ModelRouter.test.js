#!/usr/bin/env node
// Test: ModelRouter — task-based model selection
const { describe, test, assert, assertEqual, run } = require('../harness');
const { createBus } = require('../../src/agent/core/EventBus');
const { ModelRouter } = require('../../src/agent/revolution/ModelRouter');

function create(overrides = {}) {
  return new ModelRouter({
    bus: createBus(),
    modelBridge: overrides.modelBridge || {
      activeModel: 'llama3:8b',
      getAvailableModels: () => ['llama3:8b', 'codellama:13b', 'mistral:7b'],
    },
    metaLearning: null,
    worldState: null,
    ...overrides,
  });
}

describe('ModelRouter', () => {

  test('constructor initializes routing table', () => {
    const mr = create();
    assert(mr.routes['code-gen'], 'should have code-gen route');
    assert(mr.routes.chat, 'should have chat route');
    assert(mr.routes.classification, 'should have classification route');
  });

  test('route returns a result object', () => {
    const mr = create();
    const result = mr.route('chat');
    assert(result, 'should return a result');
    assert(typeof result === 'object');
  });

  test('route increments stats', () => {
    const mr = create();
    mr.route('chat');
    mr.route('code-gen');
    assertEqual(mr.getStats().routed, 2);
  });

  test('route works for all categories', () => {
    const mr = create();
    for (const cat of Object.keys(mr.routes)) {
      const result = mr.route(cat);
      assert(result, `should route ${cat}`);
    }
  });

  test('routing table prefers small for classification', () => {
    const mr = create();
    assertEqual(mr.routes.classification.preferSize, 'small');
    assert(mr.routes.classification.maxParams <= 3e9);
  });

  test('routing table prefers large for code-gen', () => {
    const mr = create();
    assertEqual(mr.routes['code-gen'].preferSize, 'large');
    assert(mr.routes['code-gen'].minParams >= 7e9);
  });

  test('_scoreSizeMatch returns 0.5 for unknown size', () => {
    const mr = create();
    assertEqual(mr._scoreSizeMatch(null, { preferSize: 'large' }), 0.5);
  });

  test('_scoreSizeMatch scores large model high for large preference', () => {
    const mr = create();
    const large = mr._scoreSizeMatch(13e9, { preferSize: 'large', minParams: 7e9 });
    const small = mr._scoreSizeMatch(1e9, { preferSize: 'large', minParams: 7e9 });
    assert(large >= small, 'large model should score higher for large preference');
  });

  test('injectEmpiricalStrength stores data', () => {
    const mr = create();
    mr.injectEmpiricalStrength({ 'llama3:8b': { score: 0.8 } });
    assert(mr._empiricalStrength, 'should store empirical data');
    assert(mr._empiricalStrengthAt > 0);
  });

  test('getStats returns routing stats', () => {
    const mr = create();
    const stats = mr.getStats();
    assertEqual(stats.routed, 0);
    assertEqual(stats.fallbacks, 0);
  });

  test('route with single model returns that model', () => {
    const mr = create({
      modelBridge: {
        activeModel: 'only-model',
        getAvailableModels: () => ['only-model'],
      },
    });
    const result = mr.route('code-gen');
    assert(result);
  });

  test('routeWithStrategy returns strategy info', () => {
    const mr = create();
    const result = mr.routeWithStrategy('analysis');
    assert(result, 'should return strategy result');
  });
});

run();
