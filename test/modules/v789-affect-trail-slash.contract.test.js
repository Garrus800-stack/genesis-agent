// ============================================================
// GENESIS — test/modules/v789-affect-trail-slash.contract.test.js
// Contract test for v7.8.9 /affect-trail slash command:
//   • Without data → "No AgentLoop boundaries recorded yet"
//   • With boundaries → Markdown with header + lines
//   • Limit parsing ("/affect-trail 5") works
//   • Pass-rate, theta, and missedStarts in header
// Every test name carries `koennen-v789 contract:` prefix.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { commandHandlersGoals } = require(path.join(ROOT, 'src/agent/hexagonal/CommandHandlersGoals'));

// ── Helpers ───────────────────────────────────────────────

function makeBoundary(opts = {}) {
  return {
    candidateId: opts.id || 'cand_x',
    goalId: opts.goalId || 'g1',
    taskTitle: opts.title || 'task title',
    outcome: opts.outcome || 'success',
    affect: {
      satisfaction_end: opts.sat ?? 0.7,
      frustration_peak: opts.frP ?? 0.2,
      surprise_sum: opts.surSum ?? 3.0,
      step_count: opts.stepCount ?? 5,
    },
    gatePass: opts.gatePass !== false,
    recordedAt: opts.recordedAt || Date.now(),
  };
}

function makeLog({ boundaries = [], stats = {} } = {}) {
  return {
    getRecentBoundaries(limit) {
      return boundaries.slice(-limit);
    },
    getStats() {
      return {
        totalEvaluated: stats.totalEvaluated ?? boundaries.length,
        gatePassed: stats.gatePassed ?? boundaries.filter(b => b.gatePass).length,
        gatePassRate: stats.gatePassRate ?? (boundaries.length
          ? boundaries.filter(b => b.gatePass).length / boundaries.length
          : 0),
        activeTasksTracked: stats.activeTasksTracked ?? 0,
        missedStarts: stats.missedStarts ?? 0,
        currentTheta: stats.currentTheta ?? 0.45,
      };
    },
  };
}

// Reconstruct minimal `this` context the way the mixin is delegated.
function makeContext(koennenCandidateLog) {
  return { koennenCandidateLog };
}

// ── Tests ─────────────────────────────────────────────────

describe('koennen-v789 contract: /affect-trail slash command', () => {

  test('koennen-v789 contract: without data returns "No boundaries recorded yet"', async () => {
    const ctx = makeContext(makeLog());
    const result = await commandHandlersGoals.affectTrail.call(ctx, '/affect-trail');
    assert(result.includes('No AgentLoop boundaries recorded yet'), 'empty state message');
  });

  test('koennen-v789 contract: missing service yields graceful message', async () => {
    const ctx = makeContext(null);
    const result = await commandHandlersGoals.affectTrail.call(ctx, '/affect-trail');
    assert(result.includes('KoennenCandidateLog not available'), 'graceful fallback');
  });

  test('koennen-v789 contract: with boundaries renders header + lines', async () => {
    const log = makeLog({
      boundaries: [
        makeBoundary({ id: 'c1', title: 'analyze auth flow', sat: 0.78, frP: 0.15, gatePass: true }),
        makeBoundary({ id: 'c2', title: 'refactor cache',    sat: 0.55, frP: 0.42, gatePass: false }),
      ],
      stats: { totalEvaluated: 2, gatePassed: 1, gatePassRate: 0.5, currentTheta: 0.45, missedStarts: 0 },
    });
    const ctx = makeContext(log);
    const result = await commandHandlersGoals.affectTrail.call(ctx, '/affect-trail');
    assert(result.includes('**Affect Trail**'), 'header present');
    assert(result.includes('50% pass rate'), 'pass-rate rendered');
    assert(result.includes('θ=0.45'), 'theta in header');
    assert(result.includes('analyze auth flow'), 'first title present');
    assert(result.includes('refactor cache'), 'second title present');
    assert(result.includes('✓'), 'pass symbol for gatePass=true');
    assert(result.includes('·'), 'fail symbol for gatePass=false');
  });

  test('koennen-v789 contract: limit parsing /affect-trail 3 returns at most 3', async () => {
    const boundaries = [];
    for (let i = 0; i < 5; i++) {
      boundaries.push(makeBoundary({ id: `c${i}`, title: `task ${i}` }));
    }
    let lastLimit = null;
    const log = {
      getRecentBoundaries(limit) {
        lastLimit = limit;
        return boundaries.slice(-limit);
      },
      getStats() {
        return { totalEvaluated: 5, gatePassed: 5, gatePassRate: 1, currentTheta: 0.45, missedStarts: 0 };
      },
    };
    const ctx = makeContext(log);
    await commandHandlersGoals.affectTrail.call(ctx, '/affect-trail 3');
    assertEqual(lastLimit, 3, 'limit parsed correctly');
  });

  test('koennen-v789 contract: missedStarts surfaces in header when >0', async () => {
    const log = makeLog({
      boundaries: [makeBoundary({ id: 'c1' })],
      stats: { totalEvaluated: 1, gatePassed: 1, gatePassRate: 1, currentTheta: 0.45, missedStarts: 4 },
    });
    const ctx = makeContext(log);
    const result = await commandHandlersGoals.affectTrail.call(ctx, '/affect-trail');
    assert(result.includes('4 missed starts'), 'missedStarts in header');
  });

});

if (require.main === module) run();
