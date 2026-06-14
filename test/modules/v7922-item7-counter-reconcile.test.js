'use strict';
// v7.9.22 Item 7 — FitnessEvaluator reconciles crash-lost counters at boot from the
// since-evaluation window (archived completions + assistant-role chat events).
const { describe, test, assert, run } = require('../harness');
const { FitnessEvaluator } = require('../../src/agent/organism/FitnessEvaluator');

const makeStorage = (files) => ({
  readJSONAsync: async (name) => (name in files ? files[name] : null),
  writeJSON: () => {}, writeJSONDebounced: () => {},
});
const makeEventStore = (events) => ({
  query: ({ since }) => events.filter(e => (e.timestamp || 0) >= (since || 0)),
});
const iso = (ms) => new Date(ms).toISOString();
const T = 1_000_000;

describe('v7.9.22 Item 7 — activity-counter reconcile at boot', () => {
  test('archived completions newer than _lastEvalTimestamp counted; failed + older excluded', async () => {
    const storage = makeStorage({
      'fitness-history.json': { activityCounters: { goalCompletions: 1, interactions: 0 }, lastEvalTimestamp: T },
      'goals/archive.json': [
        { status: 'completed', completedAt: iso(T + 5000) },
        { status: 'completed', completedAt: iso(T + 6000) },
        { status: 'failed',    completedAt: iso(T + 7000) },
        { status: 'completed', completedAt: iso(T - 5000) },
      ],
    });
    const fe = new FitnessEvaluator({ storage, eventStore: makeEventStore([]), config: {} });
    await fe.asyncLoad();
    assert(fe._activityCounters.goalCompletions === 2, `expected 2, got ${fe._activityCounters.goalCompletions}`);
  });

  test('a higher restored counter is not regressed by the reconcile', async () => {
    const storage = makeStorage({
      'fitness-history.json': { activityCounters: { goalCompletions: 10, interactions: 0 }, lastEvalTimestamp: T },
      'goals/archive.json': [ { status: 'completed', completedAt: iso(T + 5000) } ],
    });
    const fe = new FitnessEvaluator({ storage, eventStore: makeEventStore([]), config: {} });
    await fe.asyncLoad();
    assert(fe._activityCounters.goalCompletions === 10, `restored 10 must not regress, got ${fe._activityCounters.goalCompletions}`);
  });

  test('interactions reconcile counts only assistant-role events newer than the eval', async () => {
    const events = [
      { type: 'CHAT_MESSAGE', timestamp: T + 1000, payload: { role: 'user' } },
      { type: 'CHAT_MESSAGE', timestamp: T + 2000, payload: { role: 'assistant' } },
      { type: 'CHAT_MESSAGE', timestamp: T + 3000, payload: { role: 'assistant' } },
      { type: 'CHAT_MESSAGE', timestamp: T - 1000, payload: { role: 'assistant' } },
    ];
    const storage = makeStorage({
      'fitness-history.json': { activityCounters: { goalCompletions: 0, interactions: 1 }, lastEvalTimestamp: T },
    });
    const fe = new FitnessEvaluator({ storage, eventStore: makeEventStore(events), config: {} });
    await fe.asyncLoad();
    assert(fe._activityCounters.interactions === 2, `expected 2 assistant turns, got ${fe._activityCounters.interactions}`);
  });

  test('pins the Date.parse comparison: an ISO completedAt vs epoch-ms is not coerced to NaN', async () => {
    const storage = makeStorage({
      'fitness-history.json': { activityCounters: { goalCompletions: 0, interactions: 0 }, lastEvalTimestamp: T },
      'goals/archive.json': [ { status: 'completed', completedAt: iso(T + 9000) } ],
    });
    const fe = new FitnessEvaluator({ storage, eventStore: makeEventStore([]), config: {} });
    await fe.asyncLoad();
    assert(fe._activityCounters.goalCompletions === 1, `Date.parse must catch the newer ISO stamp, got ${fe._activityCounters.goalCompletions}`);
  });
});

run();
