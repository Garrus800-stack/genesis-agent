// ============================================================
// GENESIS — v7920-idlemind-completed-dedup.test.js
// Facet A: a COMPLETED idle goal (which lives only in goals/archive.json,
// not the live stack) is surfaced by buildRecentGoalContext and blocked
// from being re-proposed by the same overlap test the planner uses.
// ============================================================
const { describe, test, assert, assertEqual, run } = require('../harness');
const gi = require('../../src/agent/core/goal-intent');
// Re-exported from Plan.js too — assert that contract holds (existing tests rely on it).
const plan = require('../../src/agent/autonomy/activities/Plan.js');

const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();
const storageWith = (archive) => ({ readJSON: (f, def) => (f === 'goals/archive.json' ? archive : def) });

describe('v7920 idlemind completed-goal dedup', () => {

  test('a recently completed goal in the archive is surfaced (live stack misses it)', () => {
    const goalStack = { goals: [{ status: 'failed', description: 'Investigate flaky network retry', updated: iso(2) }] };
    const archive = [{ status: 'completed', title: 'Document the EventBus contract', description: 'Document the EventBus contract', updated: iso(1) }];
    const ctx = gi.buildRecentGoalContext({ goalStack, storage: storageWith(archive), now: Date.now() });
    assertEqual(ctx.recentCompleted.length, 1, 'completed goal from archive surfaced');
    assertEqual(ctx.recentFailures.length, 1, 'failed goal from live stack surfaced');
    assert(ctx.completedHint.includes('EventBus'), 'completed hint mentions the goal');
  });

  test('a re-proposal overlapping a completed goal is flagged redundant', () => {
    const completedDesc = 'Document the EventBus contract and its event payloads';
    const reproposed = 'Document EventBus contract payloads';
    const titleTokens = new Set(gi._tokenize(reproposed));
    const { redundant, overlap } = gi._overlapRedundant(titleTokens, gi._tokenize(completedDesc));
    assert(redundant, 'overlapping re-proposal is redundant');
    assert(overlap >= 2, 'at least the floor of distinct tokens overlap');
  });

  test('an unrelated new goal is NOT flagged against a completed goal', () => {
    const completedDesc = 'Document the EventBus contract';
    const unrelated = 'Map the Ollama backend retry paths';
    const titleTokens = new Set(gi._tokenize(unrelated));
    const { redundant } = gi._overlapRedundant(titleTokens, gi._tokenize(completedDesc));
    assert(!redundant, 'unrelated goal must not be blocked');
  });

  test('defensive: no storage -> degrades to live stack, no throw', () => {
    const goalStack = { goals: [{ status: 'completed', description: 'Live completed', updated: iso(1) }] };
    const ctx = gi.buildRecentGoalContext({ goalStack, storage: null, now: Date.now() });
    assertEqual(ctx.recentCompleted.length, 1, 'live completed still seen; archive read skipped safely');
  });

  test('completed goal older than the window is not surfaced', () => {
    const archive = [{ status: 'completed', description: 'Ancient task', updated: iso(40) }];
    const ctx = gi.buildRecentGoalContext({ goalStack: { goals: [] }, storage: storageWith(archive), now: Date.now() });
    assertEqual(ctx.recentCompleted.length, 0, 'aged-out completed goal excluded by the window');
  });

  test('Plan.js re-exports the dedup symbols (contract for existing tests)', () => {
    for (const k of ['_tokenize', '_recentRelevantFailures', '_overlapRedundant', 'buildRecentGoalContext', 'FAILURE_RELEVANCE_WINDOW_DAYS']) {
      assert(plan[k] !== undefined, `Plan.js re-exports ${k}`);
    }
  });

});

if (require.main === module) run();
