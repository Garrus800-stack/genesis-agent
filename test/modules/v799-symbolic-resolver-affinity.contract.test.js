// ============================================================
// GENESIS — v799-symbolic-resolver-affinity.contract.test.js
//
// Pins the v7.9.9 invariants that prevent SymbolicResolver
// lesson-poisoning across unrelated goals.
//
//   A plan-failure-reflection lesson from goal A may only be
//   injected as AVOID-past-failure into goal B if (a) the
//   lesson is recent (≤ 14 days), (b) the current goal shares
//   ≥ 2 non-stopword tokens with the lesson's original goal,
//   and (c) the per-pursuit AVOID counter is below the cap.
// ============================================================

'use strict';

const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const { describe, test, assert, assertEqual, run } = require('../harness');

const { SymbolicResolver } = require(path.join(ROOT, 'src/agent/intelligence/SymbolicResolver'));

// ── Mocks ───────────────────────────────────────────────────

function mockBus() {
  const listeners = new Map();
  const emitted = [];
  return {
    on: (evt, h) => {
      if (!listeners.has(evt)) listeners.set(evt, []);
      listeners.get(evt).push(h);
      return () => {};
    },
    fire: (evt, payload) => {
      emitted.push({ evt, payload });
      (listeners.get(evt) || []).forEach(h => h(payload));
    },
    getEmitted: (evt) => emitted.filter(e => e.evt === evt),
  };
}

function lesson(opts = {}) {
  return {
    id: opts.id || 'l-' + Math.random().toString(36).slice(2, 8),
    insight: opts.insight || 'Goal "X" failed (structural): module not found',
    strategy: {
      classification: opts.classification || 'structural',
      goalDescription: opts.goalDescription || 'Add File Existence Check to ReadSource Activity',
    },
    confidence: opts.confidence ?? 0.80,
    useCount: opts.useCount || 1,
    lastUsed: opts.lastUsed || Date.now(),
    source: opts.source || 'plan-failure-reflection',
  };
}

function mockLessonsStore(lessons) {
  return {
    recall: (_cat, _ctx, n) => lessons.slice(0, n || 3),
  };
}

// ── Tests ───────────────────────────────────────────────────

describe('v7.9.9 SymbolicResolver Affinity Gates', () => {

  test('AFFINITY-01: no token overlap → AVOID-lesson dropped', () => {
    const sr = new SymbolicResolver({
      bus: mockBus(),
      lessonsStore: mockLessonsStore([lesson({
        goalDescription: 'Add File Existence Check to ReadSource Activity',
      })]),
    });
    // Current goal totally unrelated — no overlap with "ReadSource".
    const res = sr.resolve('ANALYZE', 'analyze the codebase', null, {
      goalDescription: 'Add Contextual Awareness to Tidy Activity',
    });
    assertEqual(res.level, 'pass',
      'cross-goal contamination must be filtered (no token overlap)');
  });

  test('AFFINITY-02: ≥ 2 token overlap → AVOID-lesson applied', () => {
    const sr = new SymbolicResolver({
      bus: mockBus(),
      lessonsStore: mockLessonsStore([lesson({
        goalDescription: 'Tidy Activity Cleanup with Smart Backup',
      })]),
    });
    // Current goal shares "tidy" + "backup" + "cleanup" (3 non-stopword overlap)
    const res = sr.resolve('ANALYZE', 'analyze code', null, {
      goalDescription: 'Smart Tidy Backup Cleanup Refactor',
    });
    assertEqual(res.level, 'guided',
      'lessons with strong goal-affinity must pass through as GUIDED');
  });

  test('AVOID-COUNTER-01: maxAvoidLessonsPerPursuit caps at 1', () => {
    const bus = mockBus();
    const sr = new SymbolicResolver({
      bus,
      lessonsStore: mockLessonsStore([lesson({
        id: 'l-shared',
        goalDescription: 'Tidy Activity Cleanup Backup',
      })]),
    });
    // Start a fresh pursuit (resets counter).
    bus.fire('agent-loop:starting-pursuit', { goalDescription: 'Tidy Backup Activity Cleanup' });
    // First call applies the lesson.
    const r1 = sr.resolve('ANALYZE', 'first step', null, {
      goalDescription: 'Tidy Backup Activity Cleanup',
    });
    assertEqual(r1.level, 'guided', 'first AVOID-lesson should pass');
    // Second call should be capped.
    const r2 = sr.resolve('SEARCH', 'second step', null, {
      goalDescription: 'Tidy Backup Activity Cleanup',
    });
    assertEqual(r2.level, 'pass',
      'second AVOID-lesson same pursuit must be capped');
    // Third call also capped.
    const r3 = sr.resolve('CODE_GENERATE', 'third step', null, {
      goalDescription: 'Tidy Backup Activity Cleanup',
    });
    assertEqual(r3.level, 'pass',
      'third AVOID-lesson same pursuit must be capped');
  });

  test('AVOID-COUNTER-02: counter resets on new pursuit-start event', () => {
    const bus = mockBus();
    const sr = new SymbolicResolver({
      bus,
      lessonsStore: mockLessonsStore([lesson({
        goalDescription: 'Tidy Backup Cleanup Activity',
      })]),
    });
    // Pursuit 1 — counter goes to 1
    bus.fire('agent-loop:starting-pursuit', { goalDescription: 'Tidy Backup Cleanup' });
    const r1 = sr.resolve('ANALYZE', 'step', null, { goalDescription: 'Tidy Backup Cleanup Refactor' });
    assertEqual(r1.level, 'guided');
    // Pursuit 2 — counter resets, first AVOID passes again
    bus.fire('agent-loop:starting-pursuit', { goalDescription: 'Tidy Backup Cleanup' });
    const r2 = sr.resolve('ANALYZE', 'step', null, { goalDescription: 'Tidy Backup Cleanup Refactor' });
    assertEqual(r2.level, 'guided',
      'counter must reset between pursuits');
  });

  test('RECENCY-01: lesson older than 14 days dropped', () => {
    const sr = new SymbolicResolver({
      bus: mockBus(),
      lessonsStore: mockLessonsStore([lesson({
        goalDescription: 'Tidy Backup Cleanup Activity',
        lastUsed: Date.now() - 20 * 24 * 60 * 60 * 1000, // 20 days ago
      })]),
    });
    const res = sr.resolve('ANALYZE', 'step', null, {
      goalDescription: 'Tidy Backup Cleanup Refactor',
    });
    assertEqual(res.level, 'pass',
      'stale lessons (>14 days) must be filtered regardless of affinity');
  });

  test('THRESHOLD-01: guidedThreshold raised from 0.50 to 0.75', () => {
    const src = require('fs').readFileSync(
      path.join(ROOT, 'src/agent/intelligence/SymbolicResolver.js'), 'utf8');
    assert(/guidedThreshold:\s*0\.75/.test(src),
      'guidedThreshold default must be 0.75 (v7.9.9 raised from 0.50)');
  });

  test('NON-AVOID-01: proven-approach lessons bypass the gates', () => {
    // Schema-based or non-failure-class lessons shouldn't be subject to
    // the AVOID-counter or affinity-check.
    const sr = new SymbolicResolver({
      bus: mockBus(),
      lessonsStore: mockLessonsStore([lesson({
        classification: 'success', // non-prediction class
        source: 'auto-captured',
        goalDescription: 'Some Other Goal Completely Unrelated',
      })]),
    });
    const res = sr.resolve('ANALYZE', 'step', null, {
      goalDescription: 'Tidy Backup Cleanup Refactor',
    });
    assertEqual(res.level, 'guided',
      'proven-approach lessons skip the AVOID-gates');
  });

}); // describe

run().catch(err => { console.error(err); process.exit(1); });
