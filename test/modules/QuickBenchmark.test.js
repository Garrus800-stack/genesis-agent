#!/usr/bin/env node
// Test: QuickBenchmark.js — Adaptation validation engine (v6.0.2 V6-12)
const { describe, test, assert, assertEqual, run } = require('../harness');
const { createBus } = require('../../src/agent/core/EventBus');
const { QuickBenchmark, THRESHOLDS } = require('../../src/agent/cognitive/QuickBenchmark');

// ── Mock factories ──────────────────────────────────────────

function mockStorage() {
  const data = {};
  return {
    readJSON: async (key) => data[key] || null,
    writeJSON: (key, val) => { data[key] = val; },
    writeJSONDebounced: (key, val) => { data[key] = val; },
    _data: data,
  };
}

function mockCostGuard(remaining = 400_000, limit = 500_000) {
  return {
    getStatus: () => ({ sessionRemaining: remaining, sessionLimit: limit }),
  };
}

function createBenchmark(overrides = {}) {
  const bus = createBus();
  const storage = mockStorage();
  const qb = new QuickBenchmark({ bus, storage });
  qb.costGuard = overrides.costGuard || null;
  return { qb, bus, storage };
}

// ── Tests ───────────────────────────────────────────────────

describe('QuickBenchmark — Budget Check', () => {
  test('hasBudget returns true when no CostGuard', () => {
    const { qb } = createBenchmark();
    assertEqual(qb.hasBudget(), true);
  });

  test('hasBudget returns true when budget above floor', () => {
    const { qb } = createBenchmark({ costGuard: mockCostGuard(400_000, 500_000) });
    assertEqual(qb.hasBudget(), true);
  });

  test('hasBudget returns false when budget below floor', () => {
    const { qb } = createBenchmark({ costGuard: mockCostGuard(50_000, 500_000) });
    assertEqual(qb.hasBudget(), false);
  });

  test('hasBudget returns true when CostGuard throws', () => {
    const { qb } = createBenchmark({ costGuard: { getStatus: () => { throw new Error('fail'); } } });
    assertEqual(qb.hasBudget(), true);
  });
});

describe('QuickBenchmark — Compare Logic', () => {
  test('confirms when post equals baseline', () => {
    const { qb } = createBenchmark();
    const baseline = { successRate: 0.67, passed: 2, total: 3, tasks: [], timestamp: Date.now() };
    const post = { successRate: 0.67, passed: 2, total: 3, tasks: [], timestamp: Date.now() };
    const verdict = qb.compare(baseline, post);
    assertEqual(verdict.decision, 'confirm');
    assertEqual(verdict.delta, 0);
  });

  test('confirms when post improves', () => {
    const { qb } = createBenchmark();
    const baseline = { successRate: 0.67, passed: 2, total: 3, tasks: [], timestamp: Date.now() };
    const post = { successRate: 1.0, passed: 3, total: 3, tasks: [], timestamp: Date.now() };
    const verdict = qb.compare(baseline, post);
    assertEqual(verdict.decision, 'confirm');
    assert(verdict.delta > 0, 'delta should be positive');
    assertEqual(verdict.confidence, 'high');
  });

  test('confirms when regression is within noise margin', () => {
    const { qb } = createBenchmark();
    const baseline = { successRate: 0.70, passed: 2, total: 3, tasks: [], timestamp: Date.now() };
    const post = { successRate: 0.69, passed: 2, total: 3, tasks: [], timestamp: Date.now() };
    const verdict = qb.compare(baseline, post);
    assertEqual(verdict.decision, 'confirm');
  });

  test('rolls back on significant regression', () => {
    const { qb } = createBenchmark();
    const baseline = { successRate: 0.80, passed: 2, total: 3, tasks: [], timestamp: Date.now() };
    const post = { successRate: 0.33, passed: 1, total: 3, tasks: [], timestamp: Date.now() };
    const verdict = qb.compare(baseline, post);
    assertEqual(verdict.decision, 'rollback');
    assert(verdict.delta < 0, 'delta should be negative');
  });

  test('handles inconclusive moderate regression', () => {
    const { qb } = createBenchmark();
    const baseline = { successRate: 0.70, passed: 2, total: 3, tasks: [], timestamp: Date.now() };
    const post = { successRate: 0.67, passed: 2, total: 3, tasks: [], timestamp: Date.now() };
    const verdict = qb.compare(baseline, post);
    // -0.03 is between -0.02 (noise) and -0.05 (regression) → inconclusive
    assertEqual(verdict.decision, 'inconclusive');
  });

  test('increments comparisons stat', () => {
    const { qb } = createBenchmark();
    const a = { successRate: 0.5, passed: 1, total: 2, tasks: [], timestamp: Date.now() };
    const b = { successRate: 0.5, passed: 1, total: 2, tasks: [], timestamp: Date.now() };
    qb.compare(a, b);
    qb.compare(a, b);
    assertEqual(qb.stats.comparisons, 2);
  });
});

describe('QuickBenchmark — Result Parsing', () => {
  test('parses structured object result', () => {
    const { qb } = createBenchmark();
    const raw = {
      tasks: [
        { name: 'task1', success: true, latencyMs: 100, tokenEstimate: 500 },
        { name: 'task2', success: false, latencyMs: 200, tokenEstimate: 600 },
        { name: 'task3', success: true, latencyMs: 150, tokenEstimate: 550 },
      ],
    };
    const result = qb._parseResult(raw);
    assertEqual(result.total, 3);
    assertEqual(result.passed, 2);
    assert(Math.abs(result.successRate - 0.667) < 0.01, 'success rate ~66.7%');
    assertEqual(result.tasks.length, 3);
  });

  test('parses result with passed/total fields', () => {
    const { qb } = createBenchmark();
    const raw = { passed: 2, total: 3, results: [] };
    const result = qb._parseResult(raw);
    assertEqual(result.passed, 2);
    assertEqual(result.total, 3);
  });

  test('returns zero for unparseable result', () => {
    const { qb } = createBenchmark();
    const result = qb._parseResult('invalid string');
    assertEqual(result.successRate, 0);
    assertEqual(result.total, 0);
  });

  test('returns zero for null result', () => {
    const { qb } = createBenchmark();
    const result = qb._parseResult(null);
    assertEqual(result.successRate, 0);
  });
});

describe('QuickBenchmark — Baseline Caching', () => {
  test('invalidateBaseline clears cache', () => {
    const { qb } = createBenchmark();
    qb._cachedBaseline = { successRate: 0.5, passed: 1, total: 2, tasks: [], timestamp: Date.now() };
    qb._baselineTimestamp = Date.now();
    qb.invalidateBaseline();
    assertEqual(qb._cachedBaseline, null);
    assertEqual(qb._baselineTimestamp, 0);
  });
});

describe('QuickBenchmark — Thresholds', () => {
  test('regression threshold is -5pp', () => {
    assertEqual(THRESHOLDS.regressionFloor, -0.05);
  });

  test('noise margin is 2pp', () => {
    assertEqual(THRESHOLDS.noiseMargin, 0.02);
  });

  test('budget floor is 20%', () => {
    assertEqual(THRESHOLDS.budgetFloor, 0.20);
  });
});

run();
