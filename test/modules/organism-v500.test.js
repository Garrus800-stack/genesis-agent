#!/usr/bin/env node
// ============================================================
// Test: SelfMod genome-scaled circuit breaker threshold
// ============================================================
const { describe, test, assert, assertEqual, run } = require('../harness');

// ════════════════════════════════════════════════════════════
// GENOME-SCALED CIRCUIT BREAKER
// ════════════════════════════════════════════════════════════

describe('SelfMod — Genome-scaled circuit breaker', () => {
  function createPipeline(genomeTrait) {
    const events = [];
    const bus = {
      emit: (n, d, m) => events.push({ name: n, data: d }),
      fire: (n, d, m) => events.push({ name: n, data: d }),
      on: () => {},
    };
    const { SelfModificationPipeline } = require('../../src/agent/hexagonal/SelfModificationPipeline');
    const pipeline = new SelfModificationPipeline({
      lang: { t: (k) => k }, bus,
      selfModel: null, model: null, prompts: null, sandbox: null,
      reflector: null, skills: null, cloner: null, reasoning: null,
      hotReloader: null, guard: null, tools: null, eventStore: null,
      rootDir: '/tmp', astDiff: null,
    });
    if (genomeTrait !== undefined) {
      pipeline._genome = { trait: (name) => name === 'riskTolerance' ? genomeTrait : 0.5 };
    }
    return { pipeline, events };
  }

  test('default threshold is 3 without genome', () => {
    const { pipeline } = createPipeline();
    assertEqual(pipeline._getCircuitBreakerThreshold(), 3);
  });

  test('high riskTolerance (0.8) gives threshold ~4-5', () => {
    const { pipeline } = createPipeline(0.8);
    const threshold = pipeline._getCircuitBreakerThreshold();
    assert(threshold >= 4 && threshold <= 5, `expected 4-5, got ${threshold}`);
  });

  test('low riskTolerance (0.2) gives threshold 2', () => {
    const { pipeline } = createPipeline(0.2);
    const threshold = pipeline._getCircuitBreakerThreshold();
    assertEqual(threshold, 2);
  });

  test('minimum threshold is 2', () => {
    const { pipeline } = createPipeline(0.0);
    const threshold = pipeline._getCircuitBreakerThreshold();
    assert(threshold >= 2, `threshold should be at least 2, got ${threshold}`);
  });

  test('circuit breaker freezes at genome-scaled threshold', () => {
    const { pipeline } = createPipeline(0.2); // threshold = 2
    pipeline._recordFailure('fail 1');
    assertEqual(pipeline.getCircuitBreakerStatus().frozen, false);
    pipeline._recordFailure('fail 2');
    assertEqual(pipeline.getCircuitBreakerStatus().frozen, true);
  });

  test('high risk tolerance requires more failures to freeze', () => {
    const { pipeline } = createPipeline(0.8); // threshold = 4-5
    const threshold = pipeline._getCircuitBreakerThreshold();
    for (let i = 0; i < threshold - 1; i++) {
      pipeline._recordFailure(`fail ${i + 1}`);
    }
    assertEqual(pipeline.getCircuitBreakerStatus().frozen, false);
    pipeline._recordFailure('final fail');
    assertEqual(pipeline.getCircuitBreakerStatus().frozen, true);
  });

  test('getCircuitBreakerStatus reports dynamic threshold', () => {
    const { pipeline } = createPipeline(0.6);
    const status = pipeline.getCircuitBreakerStatus();
    assert(status.threshold >= 2 && status.threshold <= 5, `dynamic threshold expected, got ${status.threshold}`);
  });
});

run();
