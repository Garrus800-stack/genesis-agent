#!/usr/bin/env node
// Test: SelfModificationPipeline — Circuit Breaker (v4.12.8)
const { describe, test, assert, assertEqual, run } = require('../harness');

// Minimal mock SelfModificationPipeline — we only test the circuit breaker logic,
// not the full LLM/sandbox/git pipeline (those are tested in selfmodpipeline.test.js)
const { NullBus } = require('../../src/agent/core/EventBus');

// We need to extract the circuit breaker behavior without invoking the full pipeline.
// Strategy: construct with minimal deps, test the public CB API directly.

function createPipeline() {
  const events = [];
  const bus = {
    emit: (name, data, meta) => events.push({ name, data, meta }),
    fire: (name, data, meta) => events.push({ name, data, meta }),
    on: () => {},
  };
  // Load the real class
  const { SelfModificationPipeline } = require('../../src/agent/hexagonal/SelfModificationPipeline');
  const pipeline = new SelfModificationPipeline({
    lang: { t: (k) => k },
    bus,
    selfModel: null,
    model: null,
    prompts: null,
    sandbox: null,
    reflector: null,
    skills: null,
    cloner: null,
    reasoning: null,
    hotReloader: null,
    guard: null,
    tools: null,
    eventStore: null,
    rootDir: '/tmp',
    astDiff: null,
  });
  return { pipeline, events };
}

describe('SelfMod Circuit Breaker — Initial State', () => {
  test('starts unfrozen with 0 failures', () => {
    const { pipeline } = createPipeline();
    const status = pipeline.getCircuitBreakerStatus();
    assertEqual(status.frozen, false);
    assertEqual(status.failures, 0);
    assertEqual(status.threshold, 3);
  });
});

describe('SelfMod Circuit Breaker — Failure Tracking', () => {
  test('recordFailure increments counter', () => {
    const { pipeline } = createPipeline();
    pipeline._recordFailure('test fail 1');
    assertEqual(pipeline.getCircuitBreakerStatus().failures, 1);
    pipeline._recordFailure('test fail 2');
    assertEqual(pipeline.getCircuitBreakerStatus().failures, 2);
  });

  test('recordSuccess resets counter', () => {
    const { pipeline } = createPipeline();
    pipeline._recordFailure('fail');
    pipeline._recordFailure('fail');
    pipeline._recordSuccess('ok');
    assertEqual(pipeline.getCircuitBreakerStatus().failures, 0);
  });

  test('3 consecutive failures → frozen', () => {
    const { pipeline, events } = createPipeline();
    pipeline._recordFailure('fail 1');
    pipeline._recordFailure('fail 2');
    assertEqual(pipeline.getCircuitBreakerStatus().frozen, false);
    pipeline._recordFailure('fail 3');
    assertEqual(pipeline.getCircuitBreakerStatus().frozen, true);
    assert(pipeline.getCircuitBreakerStatus().reason.includes('3 consecutive'));
    // Should have emitted selfmod:frozen event
    assert(events.some(e => e.name === 'selfmod:frozen'), 'should emit frozen event');
  });

  test('success after 2 failures prevents freeze', () => {
    const { pipeline } = createPipeline();
    pipeline._recordFailure('a');
    pipeline._recordFailure('b');
    pipeline._recordSuccess('saved');
    pipeline._recordFailure('c');
    assertEqual(pipeline.getCircuitBreakerStatus().frozen, false);
    assertEqual(pipeline.getCircuitBreakerStatus().failures, 1);
  });
});

describe('SelfMod Circuit Breaker — Freeze Behavior', () => {
  test('modify() returns error when frozen', async () => {
    const { pipeline } = createPipeline();
    pipeline._recordFailure('a');
    pipeline._recordFailure('b');
    pipeline._recordFailure('c');
    const result = await pipeline.modify('change something');
    assert(result.includes('frozen'), 'should mention frozen');
    assert(result.includes('self-repair-reset'), 'should mention reset command');
  });

  test('repair() returns error when frozen', async () => {
    const { pipeline } = createPipeline();
    pipeline._recordFailure('a');
    pipeline._recordFailure('b');
    pipeline._recordFailure('c');
    const result = await pipeline.repair();
    assert(result.includes('frozen'), 'should mention frozen');
  });
});

describe('SelfMod Circuit Breaker — Reset', () => {
  test('resetCircuitBreaker unfreezes', () => {
    const { pipeline, events } = createPipeline();
    pipeline._recordFailure('a');
    pipeline._recordFailure('b');
    pipeline._recordFailure('c');
    assertEqual(pipeline.getCircuitBreakerStatus().frozen, true);
    pipeline.resetCircuitBreaker();
    assertEqual(pipeline.getCircuitBreakerStatus().frozen, false);
    assertEqual(pipeline.getCircuitBreakerStatus().failures, 0);
    assert(events.some(e => e.name === 'selfmod:circuit-reset'));
  });

  test('handleCircuitReset returns success message when frozen', async () => {
    const { pipeline } = createPipeline();
    pipeline._recordFailure('a');
    pipeline._recordFailure('b');
    pipeline._recordFailure('c');
    const result = await pipeline.handleCircuitReset();
    assert(result.includes('re-enabled'), 'should confirm re-enabled');
    assertEqual(pipeline.getCircuitBreakerStatus().frozen, false);
  });

  test('handleCircuitReset returns info when not frozen', async () => {
    const { pipeline } = createPipeline();
    const result = await pipeline.handleCircuitReset();
    assert(result.includes('not frozen'), 'should say not frozen');
  });
});

describe('SelfMod Circuit Breaker — Events', () => {
  test('emits selfmod:failure on each failure', () => {
    const { pipeline, events } = createPipeline();
    pipeline._recordFailure('test');
    const failEvents = events.filter(e => e.name === 'selfmod:failure');
    assertEqual(failEvents.length, 1);
    assertEqual(failEvents[0].data.count, 1);
  });

  test('emits selfmod:success on success', () => {
    const { pipeline, events } = createPipeline();
    pipeline._recordSuccess('test.js');
    const successEvents = events.filter(e => e.name === 'selfmod:success');
    assertEqual(successEvents.length, 1);
  });
});

run();
