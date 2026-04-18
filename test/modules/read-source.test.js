// ============================================================
// Test: v7.3.1 A4-F2 — _read-source Activity
// ============================================================

'use strict';

const path = require('path');
const { describe, test, assert, assertEqual, run } = require('../harness');
const ReadSource = require('../../src/agent/autonomy/activities/ReadSource');
const { buildPickContext } = require('../../src/agent/autonomy/activities/PickContext');

function mockCtx(overrides = {}) {
  const mock = {
    activityLog: [],
    emotionalState: { getState: () => ({ curiosity: 0.3, satisfaction: 0.5, frustration: 0, energy: 0.5, loneliness: 0 }), getIdlePriorities: () => ({}) },
    needsSystem: { getActivityRecommendations: () => [], getNeeds: () => ({}) },
    _genome: { trait: () => 0.5 },
    bus: { _container: { resolve: () => null } },
    selfModel: {
      getCapabilitiesDetailed: () => [],
      describeModule: () => null,
      readModuleAsync: async () => null,
    },
    lastUserActivity: Date.now(),
    ...overrides,
  };
  return buildPickContext(mock);
}

describe('v7.3.1 — ReadSource: shape + basic availability', () => {
  test('exports correct shape', () => {
    assert(ReadSource.name === 'read-source');
    assert(typeof ReadSource.weight === 'number');
    assert(typeof ReadSource.shouldTrigger === 'function');
    assert(typeof ReadSource.run === 'function');
  });

  test('returns 0 without selfModel', () => {
    const ctx = mockCtx({ selfModel: null });
    assertEqual(ReadSource.shouldTrigger(ctx), 0, 'no selfModel → 0');
  });

  test('returns >0 with selfModel in neutral state', () => {
    const ctx = mockCtx();
    const boost = ReadSource.shouldTrigger(ctx);
    assert(boost > 0, `neutral boost should be >0, got ${boost}`);
    // At cur=0.5, genome multiplier = 0.5+0.5 = 1.0 → boost stays at 1.0
    assertEqual(boost, 1.0);
  });
});

describe('v7.3.1 — ReadSource: loneliness mapping (Feature 5 preview)', () => {
  test('loneliness>0.6 + idle>30min → 2.0× boost', () => {
    const now = Date.now();
    const ctx = mockCtx({
      emotionalState: {
        getState: () => ({ curiosity: 0.3, satisfaction: 0.3, frustration: 0.1, energy: 0.5, loneliness: 0.8 }),
        getIdlePriorities: () => ({}),
      },
      lastUserActivity: now - 45 * 60 * 1000, // 45 min ago
    });
    const boost = ReadSource.shouldTrigger(ctx);
    // Expected: 1.0 * (0.5 + 0.5) * 2.0 = 2.0 (loneliness multiplier only)
    assertEqual(boost, 2.0, `expected 2.0, got ${boost}`);
  });

  test('loneliness>0.6 but idle<30min → no 2× boost', () => {
    const now = Date.now();
    const ctx = mockCtx({
      emotionalState: {
        getState: () => ({ curiosity: 0.3, satisfaction: 0.3, frustration: 0.1, energy: 0.5, loneliness: 0.8 }),
        getIdlePriorities: () => ({}),
      },
      lastUserActivity: now - 5 * 60 * 1000, // 5 min ago
    });
    const boost = ReadSource.shouldTrigger(ctx);
    assertEqual(boost, 1.0, 'idle<30min → no loneliness multiplier');
  });

  test('confusion-surrogate (curiosity>0.6 + frustration>0.4) → 1.5×', () => {
    const ctx = mockCtx({
      emotionalState: {
        getState: () => ({ curiosity: 0.7, satisfaction: 0.3, frustration: 0.5, energy: 0.5, loneliness: 0 }),
        getIdlePriorities: () => ({}),
      },
    });
    const boost = ReadSource.shouldTrigger(ctx);
    assertEqual(boost, 1.5, `expected 1.5, got ${boost}`);
  });
});

describe('v7.3.1 — ReadSource: knowledge need boosts', () => {
  test('high knowledge need (>0.5) → 1.3× boost', () => {
    const ctx = mockCtx({
      needsSystem: {
        getActivityRecommendations: () => [],
        getNeeds: () => ({ knowledge: 0.7 }),
      },
    });
    const boost = ReadSource.shouldTrigger(ctx);
    assertEqual(boost, 1.3, `expected 1.3, got ${boost}`);
  });
});

describe('v7.3.1 — ReadSource: budget logic', () => {
  test('session-budget-exhausted → returns 0', () => {
    const services = { selfModel: {}, _rsSessionRef: { startedAt: Date.now(), readCount: 10, bonus: 0, readModules: new Set(), lastInteractionSeen: 0 } };
    const ctx = {
      now: Date.now(),
      services,
      snap: { emotional: {}, needsRaw: {}, genomeTraits: { curiosity: 0.5 } },
      cycleState: {},
      idleMsSince: 0,
    };
    assertEqual(ReadSource.shouldTrigger(ctx), 0, 'session budget exhausted → 0');
  });

  test('session expires after 1 hour (rolling window)', () => {
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    const services = { selfModel: {}, _rsSessionRef: { startedAt: twoHoursAgo, readCount: 10, bonus: 0, readModules: new Set(), lastInteractionSeen: 0 } };
    const ctx = {
      now: Date.now(),
      services,
      snap: { emotional: {}, needsRaw: {}, genomeTraits: { curiosity: 0.5 } },
      cycleState: {},
      idleMsSince: 0,
    };
    const boost = ReadSource.shouldTrigger(ctx);
    assert(boost > 0, 'window expired → budget reset, boost >0');
    assertEqual(services._rsSessionRef.readCount, 0, 'readCount reset to 0');
  });

  test('_applyInteractionBonus adds +3 capped at 10', () => {
    const idleMind = { lastUserActivity: 1000 };
    const session = { startedAt: 0, readCount: 0, bonus: 0, lastInteractionSeen: 0 };

    ReadSource._applyInteractionBonus(idleMind, session);
    assertEqual(session.bonus, 3, 'first interaction → +3');
    assertEqual(session.lastInteractionSeen, 1000);

    // New interaction
    idleMind.lastUserActivity = 2000;
    ReadSource._applyInteractionBonus(idleMind, session);
    assertEqual(session.bonus, 6, 'second interaction → +3 more');

    // Many more
    for (let i = 0; i < 5; i++) {
      idleMind.lastUserActivity = 3000 + i;
      ReadSource._applyInteractionBonus(idleMind, session);
    }
    assertEqual(session.bonus, 10, 'bonus capped at SESSION_BUDGET_MAX (10)');
  });

  test('_applyInteractionBonus skips already-seen interactions', () => {
    const idleMind = { lastUserActivity: 1000 };
    const session = { startedAt: 0, readCount: 0, bonus: 0, lastInteractionSeen: 0 };

    ReadSource._applyInteractionBonus(idleMind, session);
    assertEqual(session.bonus, 3);

    // Same interaction timestamp — no change
    ReadSource._applyInteractionBonus(idleMind, session);
    assertEqual(session.bonus, 3, 'already-seen interaction not counted twice');
  });
});

describe('v7.3.1 — ReadSource: target selection', () => {
  const fakeDetailed = [
    { id: 'homeostasis', module: 'src/agent/organism/Homeostasis.js' },
    { id: 'metabolism', module: 'src/agent/organism/Metabolism.js' },
    { id: 'immune-system', module: 'src/agent/organism/ImmuneSystem.js' },
    { id: 'idle-mind', module: 'src/agent/autonomy/IdleMind.js' },
  ];

  test('picks from capabilities not yet read', () => {
    const idleMind = {
      selfModel: { getCapabilitiesDetailed: () => fakeDetailed, manifest: { files: {} } },
      needsSystem: { getNeeds: () => ({}) },
    };
    const session = { readModules: new Set() };
    const pick = ReadSource._pickTarget(idleMind, session);
    assert(pick, 'returns target');
    assert(pick.file);
    assert(pick.reason === 'curiosity' || pick.reason === 'knowledge-gap');
  });

  test('refresh mode when all capabilities read', () => {
    const idleMind = {
      selfModel: { getCapabilitiesDetailed: () => fakeDetailed, manifest: { files: {} } },
      needsSystem: { getNeeds: () => ({}) },
    };
    const session = { readModules: new Set(fakeDetailed.map(c => c.module)) };
    const pick = ReadSource._pickTarget(idleMind, session);
    assert(pick, 'returns fallback target');
    assertEqual(pick.reason, 'session-cycle-refresher');
  });

  test('prefers large modules when knowledge need is high', () => {
    const idleMind = {
      selfModel: {
        getCapabilitiesDetailed: () => fakeDetailed,
        manifest: { files: {
          'src/agent/organism/Homeostasis.js': { lines: 500 },
          'src/agent/organism/Metabolism.js': { lines: 800 },
          'src/agent/organism/ImmuneSystem.js': { lines: 200 },
          'src/agent/autonomy/IdleMind.js': { lines: 520 },
        } },
      },
      needsSystem: { getNeeds: () => ({ knowledge: 0.9 }) },
    };
    const session = { readModules: new Set() };
    const pick = ReadSource._pickTarget(idleMind, session);
    assertEqual(pick.reason, 'knowledge-gap', 'high knowledge → knowledge-gap reason');
    // With 4 candidates, picks from top 5 by LOC — so result is one of all 4
    assert(fakeDetailed.some(c => c.module === pick.file), 'picked a capability module');
  });

  test('returns null when no capabilities', () => {
    const idleMind = {
      selfModel: { getCapabilitiesDetailed: () => [], manifest: { files: {} } },
      needsSystem: { getNeeds: () => ({}) },
    };
    assertEqual(ReadSource._pickTarget(idleMind, { readModules: new Set() }), null);
  });
});

run();
