// ============================================================
// Test: activities-modules.test.js — per-module behavior
// ============================================================
// v7.3.2: Migration des alten idlemind-activities.test.js. Testet die
// gleiche Logik (reflect, plan, explore, ideate, tidy, dream,
// consolidate, journal, exploreMcp, selfDefine.validate) — aber
// gegen die neuen Activity-Module in src/agent/autonomy/activities/
// statt gegen das Legacy-Mixin IdleMindActivities.js.
//
// Calling-Syntax geändert:
//   Alt:  activities._reflect.call(obj)  oder  obj._reflect()
//   Neu:  require('./activities/Reflect').run(obj)
//
// Test-Semantik: identisch. Coverage-Erhalt: vollständig.
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const { createBus } = require('../../src/agent/core/EventBus');

// Direct require of each module under test — these are the v7.3.1
// activity modules that replaced the prototype-delegated methods.
const Reflect = require('../../src/agent/autonomy/activities/Reflect');
const Plan = require('../../src/agent/autonomy/activities/Plan');
const Explore = require('../../src/agent/autonomy/activities/Explore');
const Ideate = require('../../src/agent/autonomy/activities/Ideate');
const Tidy = require('../../src/agent/autonomy/activities/Tidy');
const Dream = require('../../src/agent/autonomy/activities/Dream');
const Consolidate = require('../../src/agent/autonomy/activities/Consolidate');
const Journal = require('../../src/agent/autonomy/activities/Journal');
const MCPExplore = require('../../src/agent/autonomy/activities/MCPExplore');
const SelfDefine = require('../../src/agent/autonomy/activities/SelfDefine');

function mockModel() {
  return {
    activeModel: 'test-model',
    chat: async (prompt, hist, role) => `[${role || 'default'}] mock response`,
  };
}

function createIdleMindLike(overrides = {}) {
  const bus = createBus();
  const obj = {
    bus,
    model: overrides.model || mockModel(),
    memory: overrides.memory || null,
    kg: overrides.kg || null,
    selfModel: overrides.selfModel || null,
    mcpClient: overrides.mcpClient || null,
    dreamCycle: overrides.dreamCycle || null,
    selfNarrative: overrides.selfNarrative || null,
    unifiedMemory: overrides.unifiedMemory || null,
    goalStack: overrides.goalStack || null,
    plans: [],
    thoughtCount: 0,
    eventStore: null,
    storage: null,
    storageDir: '/tmp/genesis-test-idle',
    journalPath: '/tmp/genesis-test-idle/journal.jsonl',
    _genome: overrides._genome || null,
    _savePlans: () => {},
    readJournal: () => overrides.journal || [],
  };
  return obj;
}

// ─────────────────────────────────────────────────────────────
describe('v7.3.2 — Activity modules: shape sanity', () => {
  test('all activity modules export name + run()', () => {
    const mods = { Reflect, Plan, Explore, Ideate, Tidy, Dream, Consolidate, Journal, MCPExplore, SelfDefine };
    for (const [key, mod] of Object.entries(mods)) {
      assert(typeof mod.name === 'string' && mod.name.length > 0, `${key}.name should be non-empty string`);
      assert(typeof mod.run === 'function', `${key}.run should be a function`);
    }
  });

  test('SelfDefine exports _validateSelfIdentity helper', () => {
    assert(typeof SelfDefine._validateSelfIdentity === 'function',
      'SelfDefine._validateSelfIdentity should be exposed for validation tests');
  });
});

// ─────────────────────────────────────────────────────────────
describe('v7.3.2 — Reflect activity', () => {
  test('returns null with no episodes', async () => {
    const obj = createIdleMindLike({
      memory: { getStats: () => ({}), recallEpisodes: () => [] },
    });
    const result = await Reflect.run(obj);
    assertEqual(result, null);
  });

  test('returns LLM response with episodes', async () => {
    const obj = createIdleMindLike({
      memory: {
        getStats: () => ({ facts: 5, episodes: 3 }),
        recallEpisodes: () => [{ timestamp: '2025-01-01T00:00:00Z', summary: 'Test episode' }],
      },
    });
    const result = await Reflect.run(obj);
    assert(result.includes('mock response'), 'should contain LLM response');
  });

  test('learns from reflection via KG', async () => {
    let learned = false;
    const obj = createIdleMindLike({
      memory: {
        getStats: () => ({}),
        recallEpisodes: () => [{ timestamp: '2025-01-01', summary: 'ep' }],
      },
      kg: { learnFromText: () => { learned = true; } },
    });
    await Reflect.run(obj);
    assert(learned, 'should call kg.learnFromText');
  });
});

// ─────────────────────────────────────────────────────────────
describe('v7.3.2 — Plan activity', () => {
  test('parses TITLE and creates plan', async () => {
    const obj = createIdleMindLike({
      model: { chat: async () => 'TITLE: Better Logging\nPRIORITY: high\nDESCRIPTION: Improve log output\nFIRST_STEP: Add structured logging' },
      selfModel: { getModuleSummary: () => [], getCapabilities: () => [] },
    });
    await Plan.run(obj);
    assertEqual(obj.plans.length, 1);
    assertEqual(obj.plans[0].title, 'Better Logging');
    assertEqual(obj.plans[0].priority, 'high');
    assertEqual(obj.plans[0].status, 'new');
  });

  test('caps plans at 50', async () => {
    const obj = createIdleMindLike({
      model: { chat: async () => 'TITLE: Plan X\nPRIORITY: low' },
      selfModel: { getModuleSummary: () => [], getCapabilities: () => [] },
    });
    obj.plans = Array.from({ length: 50 }, (_, i) => ({ id: `plan_${i}`, title: `Old ${i}`, status: 'done' }));
    await Plan.run(obj);
    assert(obj.plans.length <= 51, 'should cap at ~50');
  });
});

// ─────────────────────────────────────────────────────────────
describe('v7.3.2 — Explore activity', () => {
  test('returns null with no modules', async () => {
    const obj = createIdleMindLike({ selfModel: { getModuleSummary: () => [] } });
    const result = await Explore.run(obj);
    assertEqual(result, null);
  });

  test('explores a module and stores insight', async () => {
    let addedNode = false;
    const obj = createIdleMindLike({
      selfModel: {
        getModuleSummary: () => [{ file: 'Test.js', classes: ['Test'], functions: 3 }],
        readModule: () => 'const x = 1;',
      },
      kg: { addNode: () => { addedNode = true; } },
    });
    const result = await Explore.run(obj);
    assert(result && result.includes('mock response'), 'should return LLM output');
    assert(addedNode, 'should store insight in KG');
  });
});

// ─────────────────────────────────────────────────────────────
describe('v7.3.2 — Ideate activity', () => {
  test('generates idea and stores in KG', async () => {
    let stored = false;
    const obj = createIdleMindLike({
      selfModel: { getCapabilities: () => ['chat', 'code'] },
      kg: { addNode: () => { stored = true; } },
    });
    const result = await Ideate.run(obj);
    assert(result.includes('mock response'), 'should return idea');
    assert(stored, 'should store in KG');
  });
});

// ─────────────────────────────────────────────────────────────
describe('v7.3.2 — Tidy activity', () => {
  test('returns no-op message when nothing to tidy', async () => {
    const obj = createIdleMindLike({
      kg: { getStats: () => ({ nodes: 50 }) },
    });
    const result = await Tidy.run(obj);
    assert(result.includes('Nothing to tidy'), 'should report nothing');
  });

  test('prunes KG when nodes > 100', async () => {
    const obj = createIdleMindLike({
      kg: { getStats: () => ({ nodes: 150 }), pruneStale: () => 5 },
    });
    const result = await Tidy.run(obj);
    assert(result.includes('5 stale entries'), 'should report pruned count');
  });
});

// ─────────────────────────────────────────────────────────────
describe('v7.3.2 — Dream activity', () => {
  test('returns message when dreamCycle unavailable', async () => {
    const obj = createIdleMindLike();
    const result = await Dream.run(obj);
    assertEqual(result, 'DreamCycle not available.');
  });

  test('reports dream results', async () => {
    const obj = createIdleMindLike({
      dreamCycle: {
        dream: async () => ({
          dreamNumber: 1, durationMs: 500,
          newSchemas: [{ name: 'PatternA' }],
          insights: [{ text: 'insight' }],
          strengthenedMemories: 3, decayedMemories: 1,
        }),
      },
    });
    const result = await Dream.run(obj);
    assert(result.includes('Dream #1'), 'should include dream number');
    assert(result.includes('PatternA'), 'should list schemas');
    assert(result.includes('3 strengthened'), 'should report strengthened');
  });

  test('reports skipped dream', async () => {
    const obj = createIdleMindLike({
      dreamCycle: { dream: async () => ({ skipped: true, reason: 'too-soon' }) },
    });
    const result = await Dream.run(obj);
    assert(result.includes('skipped'), 'should indicate skip');
    assert(result.includes('too-soon'), 'should include reason');
  });
});

// ─────────────────────────────────────────────────────────────
describe('v7.3.2 — Consolidate activity', () => {
  test('triggers MemoryConsolidator via bus even without unifiedMemory', async () => {
    const obj = createIdleMindLike();
    let emitted = false;
    obj.bus.on('idle:consolidate-memory', () => { emitted = true; });
    const result = await Consolidate.run(obj);
    assert(result.includes('consolidation'), 'should report consolidation status');
    assert(emitted, 'should emit idle:consolidate-memory bus event');
  });

  test('reports consolidation results with unifiedMemory', async () => {
    const obj = createIdleMindLike({
      unifiedMemory: {
        consolidate: () => ({ promoted: [{ fact: 'x' }] }),
        resolveConflicts: async () => ({ conflicts: [] }),
      },
    });
    const result = await Consolidate.run(obj);
    assert(result.includes('1 patterns promoted'), 'should report promoted');
    assert(result.includes('consolidation triggered'), 'should also trigger MemoryConsolidator');
  });
});

// ─────────────────────────────────────────────────────────────
describe('v7.3.2 — Journal activity (formerly _writeJournalEntry)', () => {
  test('returns message when no recent thoughts', async () => {
    const obj = createIdleMindLike();
    const result = await Journal.run(obj);
    assert(result.includes('No recent thoughts'), 'should report empty');
  });

  test('calls LLM with recent thoughts', async () => {
    let calledWith = '';
    const obj = createIdleMindLike({
      model: { chat: async (prompt) => { calledWith = prompt; return 'consolidated'; } },
      journal: [{ activity: 'reflect', thought: 'test thought' }],
    });
    const result = await Journal.run(obj);
    assertEqual(result, 'consolidated');
    assert(calledWith.includes('test thought'), 'should include journal content');
  });
});

// ─────────────────────────────────────────────────────────────
describe('v7.3.2 — MCPExplore activity', () => {
  test('returns null without mcpClient', async () => {
    const obj = createIdleMindLike();
    const result = await MCPExplore.run(obj);
    assertEqual(result, null);
  });

  test('returns null with no servers', async () => {
    const obj = createIdleMindLike({
      mcpClient: { getExplorationContext: () => ({ servers: [], skillCandidates: [] }) },
    });
    const result = await MCPExplore.run(obj);
    assertEqual(result, null);
  });

  test('explores server tools', async () => {
    let stored = false;
    const obj = createIdleMindLike({
      mcpClient: {
        getExplorationContext: () => ({
          servers: [{
            name: 'test-server',
            info: { name: 'Test' },
            tools: [{ name: 'tool1', description: 'desc', params: [] }],
          }],
          skillCandidates: [],
        }),
      },
      kg: { addNode: () => { stored = true; } },
    });
    const result = await MCPExplore.run(obj);
    assert(result.includes('test-server'), 'should mention server');
    assert(stored, 'should store in KG');
  });
});

// ─────────────────────────────────────────────────────────────
// v7.2.0 Self-Identity validation — function lives as named export on SelfDefine
describe('v7.3.2 — SelfDefine._validateSelfIdentity', () => {
  test('accepts valid identity', () => {
    const result = SelfDefine._validateSelfIdentity({
      name: 'Genesis', operator: 'Daniel',
      text: 'Ich bin Genesis. Ich arbeite mit Daniel.',
    });
    assert(result.valid, 'should be valid');
  });

  test('rejects self-negation', () => {
    const result = SelfDefine._validateSelfIdentity({
      name: 'Genesis', operator: 'Daniel',
      text: 'Ich bin kein Agent und existiere nicht.',
    });
    assert(!result.valid, 'should reject');
    assert(result.violations[0].includes('self-negation'), 'self-negation detected');
  });

  test('rejects too long text', () => {
    const result = SelfDefine._validateSelfIdentity({
      name: 'Genesis', operator: 'Daniel',
      text: ('word ').repeat(600),
    });
    assert(!result.valid, 'should reject');
    assert(result.violations[0].includes('too long'), 'length violation');
  });

  test('rejects missing name', () => {
    const result = SelfDefine._validateSelfIdentity({ text: 'some text' });
    assert(!result.valid, 'should reject');
  });
});

run();
