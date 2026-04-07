// Test: v6.1.0 Coverage Push Part 3 — Wiring + LLM Utilities
// Targets: LLMPort cost/token helpers, CostGuard, utils._round

const { describe, test, assert, assertEqual, run } = require('../harness');

// ── CostGuard ───────────────────────────────────────────────

describe('CostGuard — token budget enforcement', () => {
  const { CostGuard } = require('../../src/agent/ports/CostGuard');

  function mockBus() {
    return { on: () => () => {}, emit() {}, fire() {}, off() {} };
  }

  test('constructor with defaults', () => {
    const cg = new CostGuard({ bus: mockBus() });
    assert(cg !== null, 'should construct');
    const usage = cg.getUsage();
    assertEqual(usage.session.tokens, 0);
  });

  test('checkBudget records tokens and allows under limit', () => {
    const cg = new CostGuard({ bus: mockBus() });
    const result = cg.checkBudget('chat', 1000);
    assert(result.allowed === true, 'should allow under budget');
    assertEqual(result.usage.session.tokens, 1000);
  });

  test('checkBudget accumulates across calls', () => {
    const cg = new CostGuard({ bus: mockBus() });
    cg.checkBudget('chat', 1000);
    cg.checkBudget('code', 500);
    const usage = cg.getUsage();
    assertEqual(usage.session.tokens, 1500);
    assertEqual(usage.session.calls, 2);
  });

  test('user chat bypasses budget cap', () => {
    const cg = new CostGuard({ bus: mockBus(), config: { sessionTokenLimit: 100 } });
    cg.checkBudget('chat', 200); // go over limit
    const result = cg.checkBudget('chat', 10, { priority: 10 }); // user chat (priority>=10)
    assert(result.allowed === true, 'user chat should bypass');
  });

  test('disabled mode always allows', () => {
    const cg = new CostGuard({ bus: mockBus(), config: { enabled: false } });
    const result = cg.checkBudget('chat', 999999999);
    assert(result.allowed === true, 'disabled mode should allow');
  });

  test('resetSession clears session counters', () => {
    const cg = new CostGuard({ bus: mockBus() });
    cg.checkBudget('chat', 5000);
    cg.resetSession();
    const usage = cg.getUsage();
    assertEqual(usage.session.tokens, 0);
    assertEqual(usage.session.calls, 0);
  });
});

// ── utils._round ────────────────────────────────────────────

describe('utils._round — 3-decimal rounding', () => {
  const { _round } = require('../../src/agent/core/utils');

  test('rounds to 3 decimals', () => {
    assertEqual(_round(1.23456), 1.235);
    assertEqual(_round(0.1 + 0.2), 0.3);
  });

  test('handles null/undefined as 0', () => {
    assertEqual(_round(null), 0);
    assertEqual(_round(undefined), 0);
    assertEqual(_round(0), 0);
  });

  test('handles negative values', () => {
    assertEqual(_round(-1.5678), -1.568);
  });
});

// ── utils.robustJsonParse ────────────────────────────────────

describe('utils.robustJsonParse — LLM output cleaning', () => {
  const { robustJsonParse } = require('../../src/agent/core/utils');

  test('parses clean JSON', () => {
    const result = robustJsonParse('{"key": "value"}');
    assertEqual(result.key, 'value');
  });

  test('strips markdown fences', () => {
    const result = robustJsonParse('```json\n{"a": 1}\n```');
    assertEqual(result.a, 1);
  });

  test('fixes trailing commas', () => {
    const result = robustJsonParse('{"a": 1, "b": 2,}');
    assertEqual(result.a, 1);
    assertEqual(result.b, 2);
  });

  test('handles single quotes', () => {
    const result = robustJsonParse("{'key': 'val'}");
    assertEqual(result.key, 'val');
  });

  test('extracts JSON from surrounding text', () => {
    const result = robustJsonParse('Here is the result: {"x": 42} done.');
    assertEqual(result.x, 42);
  });

  test('returns null for garbage', () => {
    assertEqual(robustJsonParse('not json at all'), null);
    assertEqual(robustJsonParse(''), null);
    assertEqual(robustJsonParse(null), null);
  });

  test('parses arrays', () => {
    const result = robustJsonParse('[1, 2, 3]');
    assert(Array.isArray(result), 'should parse array');
    assertEqual(result.length, 3);
  });
});

// ── utils.safeJsonParse ──────────────────────────────────────

describe('utils.safeJsonParse — safe drop-in for JSON.parse', () => {
  const { safeJsonParse } = require('../../src/agent/core/utils');

  test('parses valid JSON', () => {
    const result = safeJsonParse('{"a": 1}');
    assertEqual(result.a, 1);
  });

  test('returns fallback on invalid JSON', () => {
    const result = safeJsonParse('broken', { default: true });
    assert(result.default === true, 'should return fallback');
  });

  test('returns fallback for null/undefined input', () => {
    assertEqual(safeJsonParse(null, 'fb'), 'fb');
    assertEqual(safeJsonParse(undefined, 'fb'), 'fb');
  });
});

run();
