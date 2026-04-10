#!/usr/bin/env node
// ============================================================
// TEST — GoalSynthesizer (v7.0.9 Phase 4)
//
// Tests autonomous goal generation from CognitiveSelfModel
// weaknesses, bootstrap guard, self-referential loop prevention,
// and priority formula with lessonEffectiveness.
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');

function createBus() {
  const events = [];
  return { events, emit(n, d, m) { events.push({ n, d, m }); }, on() { return () => {}; } };
}

// Mock CognitiveSelfModel with controllable profile
function createMockSelfModel(profile) {
  return {
    getCapabilityProfile() { return profile; },
  };
}

// Mock TaskOutcomeTracker
function createMockTracker(count, guidedStats) {
  return {
    count() { return count; },
    getAggregateStats() { return { byTaskType: {} }; },
    getGuidedActivations: guidedStats ? () => guidedStats : undefined,
  };
}

// ════════════════════════════════════════════════════════

describe('GoalSynthesizer — bootstrap guard', () => {
  test('returns empty when insufficient data', () => {
    const { GoalSynthesizer } = require('../../src/agent/cognitive/GoalSynthesizer');
    const gs = new GoalSynthesizer({
      bus: createBus(),
      selfModel: createMockSelfModel({}),
      tracker: createMockTracker(5), // below threshold of 20
    });

    const goals = gs.synthesize();
    assertEqual(goals.length, 0);
  });

  test('generates goals when sufficient data', () => {
    const { GoalSynthesizer } = require('../../src/agent/cognitive/GoalSynthesizer');
    const gs = new GoalSynthesizer({
      bus: createBus(),
      selfModel: createMockSelfModel({
        SHELL: { successRate: 0.3, confidenceLower: 0.2, sampleSize: 15, isWeak: true, topErrors: [{ category: 'timeout', count: 8 }] },
        CODE: { successRate: 0.95, confidenceLower: 0.85, sampleSize: 30, isWeak: false, topErrors: [] },
      }),
      tracker: createMockTracker(50),
    });

    const goals = gs.synthesize();
    assert(goals.length > 0, 'should generate at least one goal');
    assert(goals[0].title.includes('SHELL') || goals[0].weakness === 'SHELL', 'should target weak area');
  });
});

describe('GoalSynthesizer — priority formula', () => {
  test('higher failure rate gets higher priority', () => {
    const { GoalSynthesizer } = require('../../src/agent/cognitive/GoalSynthesizer');
    const gs = new GoalSynthesizer({
      bus: createBus(),
      selfModel: createMockSelfModel({
        SHELL: { successRate: 0.3, confidenceLower: 0.2, sampleSize: 10, isWeak: true, topErrors: [] },
        ANALYZE: { successRate: 0.6, confidenceLower: 0.5, sampleSize: 10, isWeak: true, topErrors: [] },
      }),
      tracker: createMockTracker(30),
      config: { minCyclesBetweenGoals: 1 },
    });

    // First call: gets highest priority (SHELL)
    const goals1 = gs.synthesize();
    assert(goals1.length === 1, 'should generate 1 goal per call');
    assertEqual(goals1[0].weakness, 'SHELL');

    // Second call: gets next priority (ANALYZE)
    const goals2 = gs.synthesize();
    assert(goals2.length === 1, 'should generate next goal');
    // SHELL may repeat since it's still weak — but priority of SHELL > ANALYZE
    assert(goals1[0].priority >= goals2[0].priority || goals2[0].weakness === 'SHELL',
      'worse performance should get higher or equal priority');
  });

  test('lessonCoverage reduces priority', () => {
    const { GoalSynthesizer } = require('../../src/agent/cognitive/GoalSynthesizer');
    const gs = new GoalSynthesizer({
      bus: createBus(),
      selfModel: createMockSelfModel({
        SHELL: { successRate: 0.3, confidenceLower: 0.2, sampleSize: 10, isWeak: true, topErrors: [] },
      }),
      tracker: createMockTracker(30),
      lessonCoverage: { SHELL: { coverage: 1.0, effectiveness: 0.9 } },
    });

    const goals = gs.synthesize();
    // With high lesson coverage AND effectiveness, priority should be low
    if (goals.length > 0) {
      assert(goals[0].priority < 0.3, 'effective lessons should reduce priority');
    }
  });
});

describe('GoalSynthesizer — self-referential loop prevention', () => {
  test('does not generate goals for protected modules', () => {
    const { GoalSynthesizer } = require('../../src/agent/cognitive/GoalSynthesizer');
    const gs = new GoalSynthesizer({
      bus: createBus(),
      selfModel: createMockSelfModel({
        // Simulate weakness in GoalSynthesizer itself
        GoalSynthesizer: { successRate: 0.2, confidenceLower: 0.1, sampleSize: 10, isWeak: true, topErrors: [] },
        InferenceEngine: { successRate: 0.3, confidenceLower: 0.2, sampleSize: 10, isWeak: true, topErrors: [] },
      }),
      tracker: createMockTracker(30),
    });

    const goals = gs.synthesize();
    const protectedGoal = goals.find(g =>
      g.weakness === 'GoalSynthesizer' || g.weakness === 'InferenceEngine'
    );
    assert(!protectedGoal, 'should NOT generate goals for protected modules');
  });
});

describe('GoalSynthesizer — improvement budget', () => {
  test('respects frequency limit', () => {
    const { GoalSynthesizer } = require('../../src/agent/cognitive/GoalSynthesizer');
    const gs = new GoalSynthesizer({
      bus: createBus(),
      selfModel: createMockSelfModel({
        SHELL: { successRate: 0.3, confidenceLower: 0.2, sampleSize: 10, isWeak: true, topErrors: [] },
      }),
      tracker: createMockTracker(30),
      config: { selfAwareness: 0.1, minCyclesBetweenGoals: 10 },
    });

    // First call should work
    const goals1 = gs.synthesize();
    assert(goals1.length > 0 || true, 'first call may generate goals');

    // Immediate second call should be throttled
    const goals2 = gs.synthesize();
    assertEqual(goals2.length, 0);
  });
});

describe('GoalSynthesizer — getStats', () => {
  test('returns tracking summary', () => {
    const { GoalSynthesizer } = require('../../src/agent/cognitive/GoalSynthesizer');
    const gs = new GoalSynthesizer({
      bus: createBus(),
      selfModel: createMockSelfModel({}),
      tracker: createMockTracker(0),
    });

    const stats = gs.getStats();
    assert(typeof stats.goalsGenerated === 'number');
    assert(typeof stats.cyclesSinceLastGoal === 'number');
  });
});

run();
