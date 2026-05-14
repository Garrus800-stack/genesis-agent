// ============================================================
// GENESIS — test/modules/v782-failover-quota.test.js (v7.8.2)
//
// Regression test for the v7.8.1 quota-classifier over-match.
//
// v7.8.1 introduced `quota-exhausted` (24h TTL) but the regex was too
// greedy: `limit.{0,20}reached` and bare `reset.{0,20}(in|on|at)`
// matched normal per-minute rate-limit responses like
// "rate-limit reached" or "reset in 60 seconds". Result: Genesis
// marked backends as unavailable for 24h on a transient 60s rate-limit.
//
// v7.8.2 tightens the patterns to require either a calendar-scale word
// (weekly/monthly/daily) or a long reset window (days/weeks/months).
// These tests pin that contract.
// ============================================================

'use strict';

const assert = require('assert');

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`    ✅ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`    ❌ ${name}: ${err.message}`);
  }
}

const { ModelBridge } = require('../../src/agent/foundation/ModelBridge');
const bridge = new ModelBridge({});
const classify = (msg) => bridge._classifyFailoverReason(new Error(msg));

// ── quota-exhausted: legitimate matches ─────────────────────

test('quota-exhausted: "Weekly quota exhausted"', () => {
  assert.strictEqual(classify('Weekly quota exhausted'), 'quota-exhausted');
});

test('quota-exhausted: "Monthly limit reached"', () => {
  assert.strictEqual(classify('Monthly limit reached'), 'quota-exhausted');
});

test('quota-exhausted: "You have reached your weekly usage limit"', () => {
  assert.strictEqual(
    classify('You have reached your weekly usage limit'),
    'quota-exhausted'
  );
});

test('quota-exhausted: "Daily usage quota exceeded"', () => {
  assert.strictEqual(
    classify('Daily usage quota exceeded for this account'),
    'quota-exhausted'
  );
});

test('quota-exhausted: "Reset in 7 days"', () => {
  assert.strictEqual(classify('Reset in 7 days'), 'quota-exhausted');
});

test('quota-exhausted: "Quota exceeded"', () => {
  assert.strictEqual(classify('quota exceeded for this account'), 'quota-exhausted');
});

// ── rate-limit: must NOT be misclassified as quota (v7.8.1 regression) ──

test('rate-limit: "Rate limit exceeded, reset in 60 seconds" (NOT quota)', () => {
  // v7.8.1 regression: matched `limit.{0,20}reached` and `reset.{0,20}in`,
  // giving 24h TTL for a 1-minute reset window. Must now be rate-limit (5min TTL).
  assert.strictEqual(
    classify('Rate limit exceeded, reset in 60 seconds'),
    'rate-limit'
  );
});

test('rate-limit: "Rate limit will reset in 30 seconds" (NOT quota)', () => {
  assert.strictEqual(
    classify('Rate limit will reset in 30 seconds'),
    'rate-limit'
  );
});

test('rate-limit: "API rate-limit reached" (NOT quota)', () => {
  assert.strictEqual(classify('API rate-limit reached'), 'rate-limit');
});

test('rate-limit: "429 Too Many Requests" (NOT quota)', () => {
  assert.strictEqual(classify('429 Too Many Requests'), 'rate-limit');
});

test('rate-limit: "Rate limit reset in 1 hour" (hours are NOT calendar-scale)', () => {
  // 1 hour is rate-limit territory, not weekly quota.
  assert.strictEqual(classify('Rate limit reset in 1 hour'), 'rate-limit');
});

// ── unrelated text must NOT match quota (v7.8.1 false-positive) ─────

test('other: "Weekly digest is unavailable" (no quota/limit context)', () => {
  // v7.8.1 matched bare `weekly`, returned quota-exhausted. Must now fall through.
  assert.strictEqual(classify('Weekly digest is unavailable'), 'other');
});

test('other: "Weekly maintenance window is active" (no quota/limit context)', () => {
  assert.strictEqual(
    classify('Weekly maintenance window is active'),
    'other'
  );
});

// ── boundary: subscription-required still wins over quota ──────────

test('subscription-required: precedence over quota for upgrade-gated cloud', () => {
  // "requires a subscription" + "weekly limit" → subscription-required first.
  assert.strictEqual(
    classify('this model requires a subscription, weekly limit not relevant'),
    'subscription-required'
  );
});

// ── summary ─────────────────────────────────────────────────────────

if (failed > 0) {
  console.log(`\n  ${failed} failure(s):`);
  for (const f of failures) console.log(`    - ${f.name}: ${f.error}`);
  process.exit(1);
}
console.log(`    ${passed} passed`);
