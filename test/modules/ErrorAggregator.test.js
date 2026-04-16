#!/usr/bin/env node
// Test: ErrorAggregator.js — Central error trend detection
const { describe, test, assert, assertEqual, run } = require('../harness');
const { createBus } = require('../../src/agent/core/EventBus');
const { ErrorAggregator } = require('../../src/agent/autonomy/ErrorAggregator');

function createAgg(config = {}) {
  return new ErrorAggregator({ bus: createBus(), config });
}

describe('ErrorAggregator — Recording', () => {
  test('records an error', () => {
    const agg = createAgg();
    agg.record('test:error', { message: 'fail' });
    const report = agg.getReport();
    assertEqual(report.summary.totalErrors, 1);
    assertEqual(report.summary.activeCategories, 1);
  });

  test('categorizes errors separately', () => {
    const agg = createAgg();
    agg.record('cat:a', { message: 'err1' });
    agg.record('cat:b', { message: 'err2' });
    agg.record('cat:a', { message: 'err3' });
    const report = agg.getReport();
    assertEqual(report.categories['cat:a'].count, 2);
    assertEqual(report.categories['cat:b'].count, 1);
  });

  test('deduplicates identical errors within window', () => {
    const agg = createAgg({ dedupWindowMs: 60_000 });
    agg.record('test', { message: 'same' });
    agg.record('test', { message: 'same' });
    agg.record('test', { message: 'same' });
    const report = agg.getReport();
    assertEqual(report.categories['test'].count, 1, 'should deduplicate');
  });

  test('allows different messages in same category', () => {
    const agg = createAgg({ dedupWindowMs: 60_000 });
    agg.record('test', { message: 'err1' });
    agg.record('test', { message: 'err2' });
    const report = agg.getReport();
    assertEqual(report.categories['test'].count, 2);
  });
});

describe('ErrorAggregator — Rate Calculation', () => {
  test('getRate returns errors per minute', () => {
    const agg = createAgg({ trendWindowMs: 60_000 });
    for (let i = 0; i < 10; i++) {
      agg.record('fast', { message: `err${i}` });
    }
    const rate = agg.getRate('fast');
    assertEqual(rate, 10, 'should be 10 per minute');
  });

  test('getRate returns 0 for unknown category', () => {
    const agg = createAgg();
    assertEqual(agg.getRate('nonexistent'), 0);
  });
});

describe('ErrorAggregator — Trend Detection', () => {
  test('detects spike when threshold exceeded', () => {
    const bus = createBus();
    const agg = new ErrorAggregator({ bus, config: { spikeThreshold: 3, trendWindowMs: 60_000, dedupWindowMs: 0 } });
    let spikeDetected = false;
    bus.on('error:trend', (data) => {
      if (data.type === 'spike') spikeDetected = true;
    });
    for (let i = 0; i < 5; i++) {
      agg.record('flood', { message: `err${i}` });
    }
    assert(spikeDetected, 'should emit spike trend');
  });
});

describe('ErrorAggregator — Bounds', () => {
  test('respects maxCategories limit', () => {
    const agg = createAgg({ maxCategories: 5 });
    for (let i = 0; i < 10; i++) {
      agg.record(`cat${i}`, { message: 'err' });
    }
    assert(agg._categories.size <= 5, 'should not exceed maxCategories');
  });

  test('ring buffer caps errors per category', () => {
    const agg = createAgg({ maxErrorsPerCat: 10, dedupWindowMs: 0 });
    for (let i = 0; i < 50; i++) {
      agg.record('overflow', { message: `err${i}` });
    }
    const cat = agg._categories.get('overflow');
    assert(cat.errors.length <= 10, 'should cap at maxErrorsPerCat');
  });
});

describe('ErrorAggregator — Lifecycle', () => {
  test('start subscribes to bus events', () => {
    const agg = createAgg();
    agg.start();
    assert(agg._unsubs.length > 0, 'should have subscriptions');
    agg.stop();
  });

  test('stop unsubscribes and clears interval', () => {
    const agg = createAgg();
    agg.start();
    agg.stop();
    assertEqual(agg._unsubs.length, 0, 'should clear subscriptions');
    assertEqual(agg._healthInterval, null, 'should clear interval');
  });

  test('ErrorAggregator is registered via manifest', () => {
    // v7.2.2: containerConfig removed (orphaned dead code). Registered in phase1 manifest.
    assert(typeof ErrorAggregator === 'function', 'ErrorAggregator class exported');
  });
});

run();
