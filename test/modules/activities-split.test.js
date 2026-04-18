// ============================================================
// Test: v7.3.1 A1 — Activities Split Shape + Snapshot Boosts
// ------------------------------------------------------------
// Verifies:
//  1. All 14 activity files export correct shape
//  2. PickContext builds without error from minimal input
//  3. shouldTrigger() is a pure function over snapshots
//  4. Known scenarios produce expected boost values
//     (regression guard before Phase A2 dispatcher rewrite)
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const { buildPickContext } = require('../../src/agent/autonomy/activities/PickContext');

const ACTIVITIES = [
  'Reflect', 'Plan', 'Explore', 'Ideate', 'Tidy', 'Journal',
  'MCPExplore', 'Dream', 'Consolidate', 'Calibrate', 'Improve',
  'Research', 'SelfDefine', 'Study',
];

function loadActivity(name) {
  return require(`../../src/agent/autonomy/activities/${name}`);
}

// Helper: build a minimal neutral-state context
function neutralContext(overrides = {}) {
  const mock = {
    activityLog: [],
    emotionalState: { getState: () => ({ curiosity: 0.5, satisfaction: 0.5, frustration: 0, energy: 0.5, loneliness: 0 }), getIdlePriorities: () => ({}) },
    needsSystem: { getActivityRecommendations: () => [], getNeeds: () => ({}) },
    _genome: { trait: () => 0.5 },
    bus: { _container: { resolve: () => null } },
    ...overrides,
  };
  return buildPickContext(mock);
}

describe('v7.3.1 — Activity File Shape', () => {
  for (const name of ACTIVITIES) {
    test(`${name} exports correct shape`, () => {
      const a = loadActivity(name);
      assert(typeof a.name === 'string' && a.name.length > 0, `${name}.name must be non-empty string`);
      assert(typeof a.weight === 'number', `${name}.weight must be number`);
      assert(typeof a.cooldown === 'number', `${name}.cooldown must be number`);
      assert(typeof a.shouldTrigger === 'function', `${name}.shouldTrigger must be function`);
      assert(typeof a.run === 'function', `${name}.run must be function`);
    });
  }

  test('all activity names are unique and match STATIC_WEIGHTS from IdleMind', () => {
    const names = ACTIVITIES.map(a => loadActivity(a).name);
    const uniq = new Set(names);
    assertEqual(uniq.size, names.length, 'all activity names must be unique');

    // Reference static weights from IdleMind._pickActivity() STATIC_WEIGHTS
    const EXPECTED_WEIGHTS = {
      reflect: 1.5, plan: 1.0, explore: 1.2, ideate: 0.8,
      tidy: 0.6, journal: 0.5, 'mcp-explore': 1.0, dream: 2.0,
      consolidate: 1.3, calibrate: 1.5, improve: 1.8, research: 1.2,
      'self-define': 0.4, study: 0.9,
    };
    for (const a of ACTIVITIES) {
      const act = loadActivity(a);
      assertEqual(act.weight, EXPECTED_WEIGHTS[act.name],
        `${a} weight ${act.weight} must match legacy STATIC_WEIGHTS[${act.name}]=${EXPECTED_WEIGHTS[act.name]}`);
    }
  });
});

describe('v7.3.1 — shouldTrigger is pure (no mutation/throws) in neutral state', () => {
  for (const name of ACTIVITIES) {
    test(`${name}.shouldTrigger returns finite number`, () => {
      const a = loadActivity(name);
      const ctx = neutralContext();
      const boost = a.shouldTrigger(ctx);
      assert(typeof boost === 'number', `${name}.shouldTrigger must return number`);
      assert(Number.isFinite(boost), `${name}.shouldTrigger must return finite (got ${boost})`);
      assert(boost >= 0, `${name}.shouldTrigger must be >= 0 (got ${boost})`);
    });
  }
});

describe('v7.3.1 — Availability Gates (conditional activities return 0)', () => {
  test('MCPExplore returns 0 without MCP connections', () => {
    const act = loadActivity('MCPExplore');
    const ctx = neutralContext();
    assertEqual(act.shouldTrigger(ctx), 0, 'MCP-Explore gated on mcpConnected>0');
  });

  test('Dream returns 0 when age<30min or unprocessed<10', () => {
    const act = loadActivity('Dream');
    // Young dream → 0
    const young = neutralContext({
      dreamCycle: { getTimeSinceLastDream: () => 5 * 60 * 1000, getUnprocessedCount: () => 50 },
    });
    assertEqual(act.shouldTrigger(young), 0, 'young dream (age 5min) → 0');
    // Too few unprocessed → 0
    const few = neutralContext({
      dreamCycle: { getTimeSinceLastDream: () => 60 * 60 * 1000, getUnprocessedCount: () => 3 },
    });
    assertEqual(act.shouldTrigger(few), 0, 'few unprocessed (3) → 0');
    // Both conditions met → >0
    const ok = neutralContext({
      dreamCycle: { getTimeSinceLastDream: () => 60 * 60 * 1000, getUnprocessedCount: () => 50 },
    });
    assert(act.shouldTrigger(ok) > 0, 'conditions met → boost > 0');
  });

  test('Calibrate returns 0 without adaptiveStrategy service', () => {
    const act = loadActivity('Calibrate');
    assertEqual(act.shouldTrigger(neutralContext()), 0, 'no adaptiveStrategy → 0');

    const withStrategy = neutralContext({
      bus: { _container: { resolve: (name) => name === 'adaptiveStrategy' ? {} : null } },
    });
    assert(act.shouldTrigger(withStrategy) > 0, 'with adaptiveStrategy → >0');
  });

  test('Improve returns 0 without goalSynthesizer service', () => {
    const act = loadActivity('Improve');
    assertEqual(act.shouldTrigger(neutralContext()), 0, 'no goalSynthesizer → 0');

    const withSyn = neutralContext({
      bus: { _container: { resolve: (name) => name === 'goalSynthesizer' ? {} : null } },
    });
    assert(act.shouldTrigger(withSyn) > 0, 'with goalSynthesizer → >0');
  });

  test('Research returns 0 without webFetcher or network', () => {
    const act = loadActivity('Research');
    assertEqual(act.shouldTrigger(neutralContext()), 0, 'no webFetcher → 0');

    const withWeb = neutralContext({
      _webFetcher: {},
      _isNetworkAvailable: () => false,
    });
    assertEqual(act.shouldTrigger(withWeb), 0, 'webFetcher but no network → 0');

    const full = neutralContext({
      _webFetcher: {},
      _isNetworkAvailable: () => true,
      emotionalState: { getState: () => ({ energy: 0.7 }), getIdlePriorities: () => ({}) },
      _trustLevelSystem: { getLevel: () => 1 },
    });
    assert(act.shouldTrigger(full) > 0, 'webFetcher + network + energy + trust → >0');
  });

  test('SelfDefine returns 0 without cognitiveSelfModel or storage', () => {
    const act = loadActivity('SelfDefine');
    assertEqual(act.shouldTrigger(neutralContext()), 0, 'missing both → 0');

    const withBoth = neutralContext({
      _cognitiveSelfModel: {},
      storage: {},
    });
    assertEqual(act.shouldTrigger(withBoth), 1.0, 'both present → base 1.0');
  });

  test('Study returns 0 without model.activeModel or kg', () => {
    const act = loadActivity('Study');
    assertEqual(act.shouldTrigger(neutralContext()), 0, 'missing model+kg → 0');

    const withBoth = neutralContext({
      model: { activeModel: 'gpt-4' },
      kg: {},
    });
    assert(act.shouldTrigger(withBoth) > 0, 'model+kg present → >0');
  });
});

describe('v7.3.1 — Snapshot Boosts (regression guard for Phase A2)', () => {
  // These boost values must exactly match what the legacy _pickActivity()
  // would compute for the same inputs. Phase A2 (dispatcher rewrite) must
  // preserve these numbers — if the dispatcher's weighted-random result
  // changes, these snapshots will detect the regression.

  test('Reflect: frustrated state → boost includes idlePrio × 2', () => {
    const act = loadActivity('Reflect');
    const ctx = neutralContext({
      emotionalState: {
        getState: () => ({ frustration: 0.8 }),
        getIdlePriorities: () => ({ reflect: 0.9 }),
      },
    });
    // Formula: 1.0 + 0.9*2 = 2.8 (no other boosts)
    assertEqual(act.shouldTrigger(ctx), 2.8, 'frustrated → 1.0 + 0.9*2 = 2.8');
  });

  test('Explore: curiosity genome + weak area → compound boost', () => {
    const act = loadActivity('Explore');
    const ctx = neutralContext({
      _genome: { trait: (t) => t === 'curiosity' ? 1.0 : 0.5 },
      _cognitiveSelfModel: {
        getCapabilityProfile: () => ({
          'refactor': { isWeak: true, successRate: 0.3 },
          'analysis': { isWeak: true, successRate: 0.4 },
        }),
      },
    });
    // Formula: 1.0 * (0.5 + 1.0) * (1 + 2*0.5) = 1.0 * 1.5 * 2 = 3.0
    const boost = act.shouldTrigger(ctx);
    assert(Math.abs(boost - 3.0) < 0.001, `expected 3.0, got ${boost}`);
  });

  test('Improve: weak areas + high selfAwareness → strong compound', () => {
    const act = loadActivity('Improve');
    const ctx = neutralContext({
      _genome: { trait: (t) => t === 'selfAwareness' ? 1.0 : 0.5 },
      _cognitiveSelfModel: {
        getCapabilityProfile: () => ({
          'refactor': { isWeak: true, successRate: 0.3 },
        }),
      },
      bus: { _container: { resolve: (n) => n === 'goalSynthesizer' ? {} : null } },
    });
    // Formula: 1.0 * (1 + 1*0.8) * (0.5 + 1.0) = 1.0 * 1.8 * 1.5 = 2.7
    const boost = act.shouldTrigger(ctx);
    assert(Math.abs(boost - 2.7) < 0.001, `expected 2.7, got ${boost}`);
  });

  test('Dream: <15% memory pressure → 2.0x compound with genome', () => {
    const act = loadActivity('Dream');
    const ctx = neutralContext({
      _genome: { trait: (t) => t === 'consolidation' ? 1.0 : 0.5 },
      _homeostasis: { vitals: { memoryPressure: { value: 10 } } },
      dreamCycle: { getTimeSinceLastDream: () => 60 * 60 * 1000, getUnprocessedCount: () => 50 },
    });
    // Formula: 1.0 * (0.5 + 1.0) * 2.0 = 3.0 (genome=1.5x, memP<15=2.0x)
    const boost = act.shouldTrigger(ctx);
    assert(Math.abs(boost - 3.0) < 0.001, `expected 3.0, got ${boost}`);
  });

  test('Research: hits rate limit → 0', () => {
    const act = loadActivity('Research');
    const now = Date.now();
    const ctx = buildPickContext({
      activityLog: [
        { activity: 'research', timestamp: now - 10 * 60 * 1000 },
        { activity: 'research', timestamp: now - 20 * 60 * 1000 },
        { activity: 'research', timestamp: now - 30 * 60 * 1000 },
      ],
      _webFetcher: {},
      _isNetworkAvailable: () => true,
      emotionalState: { getState: () => ({ energy: 0.8 }), getIdlePriorities: () => ({}) },
      needsSystem: { getActivityRecommendations: () => [], getNeeds: () => ({}) },
      _genome: { trait: () => 0.5 },
      _trustLevelSystem: { getLevel: () => 1 },
      bus: { _container: { resolve: () => null } },
    });
    assertEqual(act.shouldTrigger(ctx), 0, 'rate limit (3/h) → 0');
  });

  test('v7.3.1: SelfDefine gets loneliness boost when idle>30min', () => {
    const act = loadActivity('SelfDefine');
    const now = Date.now();
    const ctx = buildPickContext({
      activityLog: [],
      emotionalState: {
        getState: () => ({ loneliness: 0.8, curiosity: 0.3, satisfaction: 0.3, frustration: 0.1, energy: 0.5 }),
        getIdlePriorities: () => ({ 'self-define': 0.58 }), // 0.1 + 0.8*0.6
      },
      needsSystem: { getActivityRecommendations: () => [], getNeeds: () => ({}) },
      _genome: { trait: () => 0.5 },
      _cognitiveSelfModel: {},
      storage: {},
      lastUserActivity: now - 45 * 60 * 1000,
      bus: { _container: { resolve: () => null } },
    });
    const boost = act.shouldTrigger(ctx);
    // Expected: 1.0 * 2.0 (loneliness multiplier) + (0.58 * 2) = 2.0 + 1.16 = 3.16
    assert(boost > 3.0 && boost < 3.3,
      `expected ~3.16 (loneliness×2 + idlePrio×2), got ${boost}`);
  });
});

run();
