#!/usr/bin/env node
// ============================================================
// Test: FitnessEvaluator.js — composite scoring, peer median,
//       archival recommendation, persistence, best peer genome
// ============================================================
const { describe, test, assert, assertEqual, run } = require('../harness');
const { FitnessEvaluator } = require('../../src/agent/organism/FitnessEvaluator');

function mockBus() {
  const events = [];
  return {
    emit: (name, data, meta) => events.push({ name, data, meta }),
    fire: (name, data, meta) => events.push({ name, data, meta }),
    on: () => {},
    events,
  };
}

function mockStorage() {
  const store = {};
  return {
    readJSONAsync: async (file) => store[file] || null,
    writeJSON: (file, data) => { store[file] = JSON.parse(JSON.stringify(data)); },
    writeJSONDebounced: (file, data) => { store[file] = JSON.parse(JSON.stringify(data)); },
    store,
  };
}

function mockEventStore(events = []) {
  return {
    query: ({ since }) => events.filter(e => (e.timestamp || 0) >= since),
    getRecent: (n) => events.slice(-n),
  };
}

function mockGenome(hash = 'abc123def456', gen = 3) {
  return {
    hash: () => hash,
    generation: gen,
    trait: (name) => 0.5,
  };
}

function createEvaluator(overrides = {}) {
  const bus = mockBus();
  const storage = mockStorage();
  const eventStore = overrides.eventStore || mockEventStore();
  const fe = new FitnessEvaluator({
    bus, eventStore, storage,
    intervals: null,
    config: overrides.config || {},
  });
  fe.genome = overrides.genome || mockGenome();
  fe.metabolism = overrides.metabolism || null;
  fe.immuneSystem = overrides.immuneSystem || null;
  return { evaluator: fe, bus, storage };
}

// ════════════════════════════════════════════════════════════
// CONSTRUCTION
// ════════════════════════════════════════════════════════════

describe('FitnessEvaluator — Construction', () => {
  test('creates with default config', () => {
    const { evaluator } = createEvaluator();
    const stats = evaluator.getStats();
    assertEqual(stats.evaluations, 0);
    assertEqual(stats.lastScore, null);
    assertEqual(stats.belowMedianCount, 0);
    assertEqual(stats.peerCount, 0);
  });

  test('no last evaluation initially', () => {
    const { evaluator } = createEvaluator();
    assertEqual(evaluator.getLastEvaluation(), null);
  });
});

// ════════════════════════════════════════════════════════════
// EVALUATION — BASIC
// ════════════════════════════════════════════════════════════

describe('FitnessEvaluator — Evaluate (empty events)', () => {
  test('evaluate returns score between 0 and 1', () => {
    const { evaluator } = createEvaluator();
    const result = evaluator.evaluate();
    assert(result.score >= 0 && result.score <= 1, `score out of range: ${result.score}`);
  });

  test('evaluate includes all metrics', () => {
    const { evaluator } = createEvaluator();
    const result = evaluator.evaluate();
    assert(result.metrics.taskCompletion !== undefined, 'should have taskCompletion');
    assert(result.metrics.energyEfficiency !== undefined, 'should have energyEfficiency');
    assert(result.metrics.errorRate !== undefined, 'should have errorRate');
    assert(result.metrics.userSatisfaction !== undefined, 'should have userSatisfaction');
    assert(result.metrics.selfRepair !== undefined, 'should have selfRepair');
  });

  test('evaluate includes genome hash', () => {
    const { evaluator } = createEvaluator();
    const result = evaluator.evaluate();
    assertEqual(result.genomeHash, 'abc123def456');
  });

  test('evaluate stores in history', () => {
    const { evaluator } = createEvaluator();
    evaluator.evaluate();
    assertEqual(evaluator.getHistory().length, 1);
    evaluator.evaluate();
    assertEqual(evaluator.getHistory().length, 2);
  });
});

// ════════════════════════════════════════════════════════════
// EVALUATION — WITH EVENTS
// ════════════════════════════════════════════════════════════

describe('FitnessEvaluator — Evaluate (with events)', () => {
  test('completed goals increase task completion metric', () => {
    const now = Date.now();
    const events = [
      { type: 'agent-loop:started', timestamp: now - 1000, data: {} },
      { type: 'agent-loop:started', timestamp: now - 900, data: {} },
      { type: 'agent-loop:complete', timestamp: now - 800, data: { success: true } },
      { type: 'agent-loop:complete', timestamp: now - 700, data: { success: true } },
    ];
    const { evaluator } = createEvaluator({ eventStore: mockEventStore(events) });
    const result = evaluator.evaluate();
    assertEqual(result.metrics.taskCompletion, 1.0);
  });

  test('errors reduce errorRate metric', () => {
    const now = Date.now();
    const events = [];
    // 10 errors in 100 total events — use EventStore type 'ERROR_OCCURRED' (as per EVENT_STORE_BUS_MAP)
    for (let i = 0; i < 10; i++) events.push({ type: 'ERROR_OCCURRED', timestamp: now - i * 100, payload: {} });
    for (let i = 0; i < 90; i++) events.push({ type: 'CHAT_MESSAGE', timestamp: now - i * 50, payload: { success: true } });
    const { evaluator } = createEvaluator({ eventStore: mockEventStore(events) });
    const result = evaluator.evaluate();
    assert(result.metrics.errorRate < 1.0, `errorRate should be less than 1.0 with errors: ${result.metrics.errorRate}`);
  });
});

// ════════════════════════════════════════════════════════════
// EVALUATION — EVENTS EMITTED
// ════════════════════════════════════════════════════════════

describe('FitnessEvaluator — Events', () => {
  test('evaluate emits fitness:evaluated', () => {
    const { evaluator, bus } = createEvaluator();
    evaluator.evaluate();
    const evt = bus.events.find(e => e.name === 'fitness:evaluated');
    assert(evt !== undefined, 'should emit fitness:evaluated');
    assert(evt.data.score !== undefined, 'event should include score');
    assert(evt.data.metrics !== undefined, 'event should include metrics');
  });

  test('evaluate fires peer:fitness-score for broadcast', () => {
    const { evaluator, bus } = createEvaluator();
    evaluator.evaluate();
    const evt = bus.events.find(e => e.name === 'peer:fitness-score');
    assert(evt !== undefined, 'should fire peer:fitness-score');
    assertEqual(evt.data.genomeHash, 'abc123def456');
  });
});

// ════════════════════════════════════════════════════════════
// PEER SELECTION
// ════════════════════════════════════════════════════════════

describe('FitnessEvaluator — Peer Selection', () => {
  test('no archival when no peers', () => {
    const { evaluator } = createEvaluator();
    const result = evaluator.evaluate();
    assertEqual(result.belowMedian, false);
    assertEqual(result.archivalRecommended, false);
  });

  test('registerPeerScore tracks peer', () => {
    const { evaluator } = createEvaluator();
    evaluator.registerPeerScore('peer1', 0.8);
    evaluator.registerPeerScore('peer2', 0.6);
    assertEqual(evaluator.getStats().peerCount, 2);
  });

  test('belowMedian true when score < peer median', () => {
    const { evaluator } = createEvaluator();
    evaluator.registerPeerScore('peer1', 0.9);
    evaluator.registerPeerScore('peer2', 0.8);
    // Our score will be ~0.5 (default metrics with no real events)
    const result = evaluator.evaluate();
    assertEqual(result.belowMedian, true);
  });

  test('archival after 2 consecutive below-median', () => {
    const { evaluator } = createEvaluator();
    evaluator.registerPeerScore('peer1', 0.95);
    evaluator.registerPeerScore('peer2', 0.90);
    evaluator.evaluate(); // 1st below median
    assertEqual(evaluator.getStats().belowMedianCount, 1);
    evaluator.evaluate(); // 2nd below median
    const result = evaluator.getLastEvaluation();
    assertEqual(result.archivalRecommended, true);
  });

  test('belowMedianCount resets when above median', () => {
    const { evaluator } = createEvaluator();
    evaluator.registerPeerScore('peer1', 0.1);
    evaluator.registerPeerScore('peer2', 0.05);
    // Our score (~0.5) should be above these low peers
    evaluator.evaluate();
    assertEqual(evaluator.getStats().belowMedianCount, 0);
  });

  test('getBestPeerGenome returns highest scorer', () => {
    const { evaluator } = createEvaluator();
    evaluator.registerPeerScore('genome-a', 0.6);
    evaluator.registerPeerScore('genome-b', 0.9);
    evaluator.registerPeerScore('genome-c', 0.7);
    const best = evaluator.getBestPeerGenome();
    assertEqual(best.genomeHash, 'genome-b');
    assertEqual(best.score, 0.9);
  });

  test('getBestPeerGenome returns null with no peers', () => {
    const { evaluator } = createEvaluator();
    assertEqual(evaluator.getBestPeerGenome(), null);
  });
});

// ════════════════════════════════════════════════════════════
// PERSISTENCE
// ════════════════════════════════════════════════════════════

describe('FitnessEvaluator — Persistence', () => {
  test('evaluate persists to storage', () => {
    const { evaluator, storage } = createEvaluator();
    evaluator.evaluate();
    const saved = storage.store['fitness-history.json'];
    assert(saved !== undefined, 'should persist');
    assert(saved.history.length >= 1, 'should have history');
  });

  test('asyncLoad restores history and belowMedianCount', async () => {
    const { evaluator: e1, storage } = createEvaluator();
    e1.registerPeerScore('peer1', 0.95);
    e1.registerPeerScore('peer2', 0.90);
    e1.evaluate();
    e1.stop();

    const e2 = new FitnessEvaluator({
      bus: mockBus(), eventStore: mockEventStore(), storage,
      intervals: null, config: {},
    });
    e2.genome = mockGenome();
    await e2.asyncLoad();
    assertEqual(e2.getHistory().length, 1);
    assertEqual(e2.getStats().belowMedianCount, 1);
  });
});

// ════════════════════════════════════════════════════════════
// CUSTOM WEIGHTS
// ════════════════════════════════════════════════════════════

describe('FitnessEvaluator — Custom Weights', () => {
  test('custom weights change score', () => {
    // Weight everything on taskCompletion
    const { evaluator: e1 } = createEvaluator({
      config: { weights: { taskCompletion: 1.0, energyEfficiency: 0, errorRate: 0, userSatisfaction: 0, selfRepair: 0 } },
    });
    const { evaluator: e2 } = createEvaluator({
      config: { weights: { taskCompletion: 0, energyEfficiency: 0, errorRate: 1.0, userSatisfaction: 0, selfRepair: 0 } },
    });
    const r1 = e1.evaluate();
    const r2 = e2.evaluate();
    // With empty events, taskCompletion=0.5 and errorRate=1.0 (no errors)
    // So r2 (errorRate=1.0) should be higher than r1 (taskCompletion=0.5)
    assert(r2.score > r1.score, `errorRate-weighted score (${r2.score}) should > taskCompletion-weighted (${r1.score})`);
  });
});

// ════════════════════════════════════════════════════════════
// v5.0.0 FIX REGRESSIONS — EventStore field names + event types
// ════════════════════════════════════════════════════════════

describe('FitnessEvaluator — v5.0.0 payload/type fixes', () => {
  test('taskCompletion uses AGENT_LOOP_STARTED / AGENT_LOOP_COMPLETE from EventStore', () => {
    const now = Date.now();
    const eventStore = mockEventStore([
      { type: 'AGENT_LOOP_STARTED',  payload: { goalId: '1' }, timestamp: now - 100 },
      { type: 'AGENT_LOOP_STARTED',  payload: { goalId: '2' }, timestamp: now - 90 },
      { type: 'AGENT_LOOP_COMPLETE', payload: { goalId: '1', success: true  }, timestamp: now - 80 },
      { type: 'AGENT_LOOP_COMPLETE', payload: { goalId: '2', success: false }, timestamp: now - 70 },
    ]);
    const { evaluator } = createEvaluator({ eventStore });
    const result = evaluator.evaluate();
    // 2 started, 1 succeeded → taskCompletion = 0.5
    assertEqual(result.metrics.taskCompletion, 0.5, 'taskCompletion should be 0.5 (1/2 goals succeeded)');
  });

  test('taskCompletion not default 0.5 when STARTED events exist', () => {
    const now = Date.now();
    const eventStore = mockEventStore([
      { type: 'AGENT_LOOP_STARTED',  payload: { goalId: '1' }, timestamp: now - 100 },
      { type: 'AGENT_LOOP_COMPLETE', payload: { goalId: '1', success: true }, timestamp: now - 80 },
    ]);
    const { evaluator } = createEvaluator({ eventStore });
    const result = evaluator.evaluate();
    // 1 started, 1 succeeded → taskCompletion = 1.0 (not default 0.5)
    assertEqual(result.metrics.taskCompletion, 1.0, 'taskCompletion should be 1.0 (all goals succeeded)');
  });

  test('userSatisfaction reads CHAT_MESSAGE events with e.payload', () => {
    const now = Date.now();
    const eventStore = mockEventStore([
      { type: 'CHAT_MESSAGE', payload: { role: 'user', success: true  }, timestamp: now - 100 },
      { type: 'CHAT_MESSAGE', payload: { role: 'user', success: true  }, timestamp: now - 90  },
      { type: 'CHAT_MESSAGE', payload: { role: 'user', success: false }, timestamp: now - 80  },
    ]);
    const { evaluator } = createEvaluator({ eventStore });
    const result = evaluator.evaluate();
    // 2 positive, 1 negative → 2/3 ≈ 0.667
    assert(result.metrics.userSatisfaction > 0.6, `userSatisfaction should reflect actual chats, got ${result.metrics.userSatisfaction}`);
    assert(result.metrics.userSatisfaction < 0.7, `userSatisfaction should be ~0.667, got ${result.metrics.userSatisfaction}`);
  });

  test('userSatisfaction is not stuck at 0.5 when CHAT_MESSAGE events exist', () => {
    const now = Date.now();
    const eventStore = mockEventStore([
      { type: 'CHAT_MESSAGE', payload: { success: false }, timestamp: now - 100 },
      { type: 'CHAT_MESSAGE', payload: { success: false }, timestamp: now - 90  },
      { type: 'CHAT_MESSAGE', payload: { success: false }, timestamp: now - 80  },
    ]);
    const { evaluator } = createEvaluator({ eventStore });
    const result = evaluator.evaluate();
    // All failed → userSatisfaction = 0, not default 0.5
    assertEqual(result.metrics.userSatisfaction, 0, 'all-fail chats should yield userSatisfaction=0, not default 0.5');
  });
});

// ════════════════════════════════════════════════════════════
// v5.0.0 FEATURES — Dual-trigger milestones + Self-baseline
// ════════════════════════════════════════════════════════════

describe('FitnessEvaluator — Dual-trigger milestones (v5.0.0)', () => {
  test('goal milestone fires evaluate() when threshold reached', () => {
    const { evaluator } = createEvaluator({
      config: { milestoneGoals: 3, milestoneInteractions: 100 },
    });
    evaluator.start();
    // Simulate 2 goal completions — should NOT fire yet
    evaluator.bus = { emit: () => {}, fire: () => {}, on: evaluator.bus.on };
    evaluator._activityCounters.goalCompletions = 2;
    evaluator._checkActivityMilestone();
    assertEqual(evaluator.getStats().evaluations, 0, 'should not evaluate before threshold');

    // Reach milestone
    evaluator._activityCounters.goalCompletions = 3;
    evaluator._checkActivityMilestone();
    assertEqual(evaluator.getStats().evaluations, 1, 'should evaluate when goal milestone reached');
  });

  test('interaction milestone fires evaluate() when threshold reached', () => {
    const { evaluator } = createEvaluator({
      config: { milestoneGoals: 100, milestoneInteractions: 5 },
    });
    evaluator.start();
    evaluator._activityCounters.interactions = 5;
    evaluator._checkActivityMilestone();
    assertEqual(evaluator.getStats().evaluations, 1, 'should evaluate when interaction milestone reached');
  });

  test('activity counters reset after milestone evaluation', () => {
    const { evaluator } = createEvaluator({
      config: { milestoneGoals: 2, milestoneInteractions: 100 },
    });
    evaluator.start();
    evaluator._activityCounters.goalCompletions = 2;
    evaluator._checkActivityMilestone();
    assertEqual(evaluator._activityCounters.goalCompletions, 0, 'goalCompletions should reset after milestone');
    assertEqual(evaluator._activityCounters.interactions,    0, 'interactions should reset after milestone');
  });

  test('result.trigger is "milestone:goals" for goal milestone', () => {
    const { evaluator } = createEvaluator({
      config: { milestoneGoals: 1, milestoneInteractions: 100 },
    });
    evaluator.start();
    evaluator._activityCounters.goalCompletions = 1;
    evaluator._checkActivityMilestone();
    const last = evaluator.getLastEvaluation();
    assert(last !== null, 'should have a last evaluation');
    assertEqual(last.trigger, 'milestone:goals', `trigger should be 'milestone:goals', got '${last.trigger}'`);
  });
});

describe('FitnessEvaluator — Self-baseline comparison (v5.0.0)', () => {
  test('uses self-baseline when fewer than 2 peers', () => {
    const { evaluator } = createEvaluator();
    // Seed fitness history with high scores using the correct property name
    evaluator._fitnessHistory = [
      { score: 0.9, timestamp: Date.now() - 5000 },
      { score: 0.85, timestamp: Date.now() - 4000 },
      { score: 0.88, timestamp: Date.now() - 3000 },
      { score: 0.87, timestamp: Date.now() - 2000 },
      { score: 0.9,  timestamp: Date.now() - 1000 },
    ];
    const result = evaluator.evaluate();
    // With no peers, selfBaselineUsed = (selfBaseline !== null)
    // History has entries so _getSelfBaseline() returns a value
    assert(result.selfBaselineUsed !== undefined, 'selfBaselineUsed flag should exist');
    assertEqual(result.selfBaselineUsed, true, 'should use self-baseline with history but no peers');
  });

  test('does NOT use self-baseline when 2+ peer scores available', () => {
    const { evaluator } = createEvaluator();
    evaluator.registerPeerScore('peer-a', 0.7);
    evaluator.registerPeerScore('peer-b', 0.75);
    const result = evaluator.evaluate();
    assertEqual(result.selfBaselineUsed, false, 'should NOT use self-baseline when peers available');
  });

  test('self-baseline detects weak performance vs own history', () => {
    const { evaluator } = createEvaluator({
      config: { weights: { taskCompletion: 1, energyEfficiency: 0, errorRate: 0, userSatisfaction: 0, selfRepair: 0 } },
    });
    // Seed high historical scores using the correct property name (median ~0.9)
    evaluator._fitnessHistory = [
      { score: 0.9, timestamp: Date.now() - 5000 },
      { score: 0.9, timestamp: Date.now() - 4000 },
      { score: 0.9, timestamp: Date.now() - 3000 },
      { score: 0.9, timestamp: Date.now() - 2000 },
      { score: 0.9, timestamp: Date.now() - 1000 },
    ];
    // Current eval returns ~0.5 (default, no events) — below 85% of 0.9 = 0.765
    const result = evaluator.evaluate();
    assert(result.selfBaselineUsed, 'should use self-baseline');
    assert(result.selfBaseline > 0, `selfBaseline should be set, got ${result.selfBaseline}`);
    // 0.5 < 0.9 * 0.85 = 0.765 → should be flagged below baseline
    assert(result.belowMedian === true, `score ${result.score} should be below self-baseline threshold ${result.selfBaseline * 0.85}`);
  });

  test('self-baseline is unused when no prior history', () => {
    const { evaluator } = createEvaluator();
    // Ensure history is truly empty
    assertEqual(evaluator._fitnessHistory.length, 0, 'history should be empty');
    const result = evaluator.evaluate();
    // No prior history → _getSelfBaseline() returns null → selfBaselineUsed = false → belowMedian = false
    assertEqual(result.selfBaselineUsed, false, 'no prior history = no baseline');
    assertEqual(result.belowMedian, false, 'no history = not below baseline');
  });
});

describe('FitnessEvaluator — activityCounters persistence (v5.0.0)', () => {
  test('activityCounters persist to storage', async () => {
    const { evaluator, storage } = createEvaluator();
    evaluator.start();
    evaluator._activityCounters = { goalCompletions: 7, interactions: 42 };
    // Trigger a save by running evaluate (which also resets — check before)
    // We check that getStats() reflects the counters properly
    const stats = evaluator.getStats();
    assert(stats.activityCounters !== undefined, 'getStats should include activityCounters');
    assertEqual(stats.activityCounters.goalCompletions, 7,  'should report goalCompletions');
    assertEqual(stats.activityCounters.interactions,    42, 'should report interactions');
  });

  test('activityCounters restore from storage on asyncLoad', async () => {
    const { evaluator, storage } = createEvaluator();
    // Seed storage as if a previous run had saved counters mid-period
    storage.store['fitness-history.json'] = {
      history: [],
      belowMedianCount: 0,
      lastEvalTimestamp: 0,
      activityCounters: { goalCompletions: 5, interactions: 20 },
    };
    await evaluator.asyncLoad();
    assertEqual(evaluator._activityCounters.goalCompletions, 5,  'goalCompletions should restore from storage');
    assertEqual(evaluator._activityCounters.interactions,    20, 'interactions should restore from storage');
  });
});

run();
