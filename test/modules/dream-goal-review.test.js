// ============================================================
// Test: DreamCycle triggers goal review (v7.3.3)
//
// The dream cycle's Phase 6 calls goalStack.reviewGoals() so that
// once per night Genesis audits his own list and transitions goals
// that should have moved on.
//
// This test verifies the wiring:
//   - dream() with goalStack late-bound calls reviewGoals()
//   - dream() without goalStack does NOT crash
//   - low intensity (0.25) skips the review (cost-tier respect)
// ============================================================

'use strict';

const { describe, test, assert, run } = require('../harness');
const { DreamCycle } = require('../../src/agent/cognitive/DreamCycle');

function makeDream({ goalStack, intensity = 1.0, episodes = 20 } = {}) {
  const episodeList = Array.from({ length: episodes }, (_, i) => ({
    id: `ep_${i}`,
    content: `episode ${i}`,
    timestamp: Date.now() - i * 1000,
  }));
  const episodicMemory = {
    getRecent: () => episodeList,
    recent: () => episodeList,
    all: () => episodeList,
  };
  const bus = { emit: () => {}, fire: () => {} };

  const dream = new DreamCycle({
    bus,
    episodicMemory,
    schemaStore: {
      getAll: () => [],
      store: () => {},
      findSimilar: () => [],
    },
    knowledgeGraph: null,
    metaLearning: null,
    model: null,
    eventStore: null,
    storage: { readJSON: () => null, writeJSON: () => {}, writeJSONDebounced: () => {} },
    intervals: null,
    config: { useLLM: false, minEpisodes: 5, consolidationIntervalMs: 0 },
  });

  if (goalStack) dream.goalStack = goalStack;

  // Override unprocessed-filter so our seed episodes qualify
  dream._getUnprocessedEpisodes = () => episodeList;
  return dream;
}

// ── wiring tests ───────────────────────────────────
describe('v7.3.3 — DreamCycle Phase 6: goal review wiring', () => {
  test('reviewGoals is called when goalStack is present', async () => {
    let reviewCalled = false;
    const goalStack = {
      reviewGoals: () => {
        reviewCalled = true;
        return { reviewed: 3, changed: [] };
      },
    };
    const dream = makeDream({ goalStack });
    const report = await dream.dream();
    assert(reviewCalled === true, 'reviewGoals should be invoked during dream');
    const phase = report.phases?.find(p => p.name === 'goal-review');
    assert(phase, 'goal-review phase should be recorded');
    assert(phase.reviewed === 3, 'phase should carry review count');
  });

  test('no goalStack → dream does NOT crash', async () => {
    const dream = makeDream();  // no goalStack
    const report = await dream.dream();
    assert(report && !report.error, 'dream should complete cleanly without goalStack');
    const phase = report.phases?.find(p => p.name === 'goal-review');
    assert(!phase, 'goal-review phase should NOT appear when no goalStack');
  });

  test('reviewGoals throwing → dream does NOT crash (non-critical phase)', async () => {
    const goalStack = {
      reviewGoals: () => { throw new Error('fake failure'); },
    };
    const dream = makeDream({ goalStack });
    const report = await dream.dream();
    // dream() should still complete — goal review is optional
    assert(report, 'dream should return report');
    // phase may or may not be recorded, but dream must not crash
  });

  test('low intensity (0.25) → goal review is skipped', async () => {
    let reviewCalled = false;
    const goalStack = {
      reviewGoals: () => { reviewCalled = true; return { reviewed: 0, changed: [] }; },
    };
    const dream = makeDream({ goalStack });
    await dream.dream({ intensity: 0.25 });
    assert(reviewCalled === false, 'low-intensity dreams should skip goal review');
  });

  test('medium intensity (0.5) → goal review runs', async () => {
    let reviewCalled = false;
    const goalStack = {
      reviewGoals: () => { reviewCalled = true; return { reviewed: 0, changed: [] }; },
    };
    const dream = makeDream({ goalStack });
    await dream.dream({ intensity: 0.5 });
    assert(reviewCalled === true, 'medium-intensity dreams should run goal review');
  });

  test('missing reviewGoals method on goalStack → dream does NOT crash', async () => {
    const goalStack = { /* no reviewGoals */ };
    const dream = makeDream({ goalStack });
    const report = await dream.dream();
    assert(report && !report.error, 'dream should complete cleanly');
  });
});

run();
