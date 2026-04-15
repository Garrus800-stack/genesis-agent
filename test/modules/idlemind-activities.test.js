// ============================================================
// Test: IdleMindActivities.js — prototype delegation,
// activity execution, journal, edge cases
// v5.6.0: Extracted from IdleMind.js
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const { createBus } = require('../../src/agent/core/EventBus');
const { activities } = require('../../src/agent/autonomy/IdleMindActivities');

function mockModel() {
  return {
    activeModel: 'test-model',
    chat: async (prompt, hist, role) => `[${role}] mock response`,
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
  // Attach activities via prototype delegation
  Object.assign(obj, activities);
  return obj;
}

describe('IdleMindActivities: Delegation', () => {
  test('activities object has all expected methods', () => {
    const expected = [
      '_writeJournalEntry', '_reflect', '_plan', '_explore',
      '_exploreMcp', '_ideate', '_tidy', '_dream',
      '_consolidateMemory', '_journal',
      '_selfDefine', '_validateSelfIdentity', // v7.2.0
    ];
    for (const name of expected) {
      assert(typeof activities[name] === 'function', `activities.${name} should be a function`);
    }
  });

  test('methods are callable on delegate object', () => {
    const obj = createIdleMindLike();
    assert(typeof obj._reflect === 'function', '_reflect should be bound');
    assert(typeof obj._dream === 'function', '_dream should be bound');
    assert(typeof obj._journal === 'function', '_journal should be bound');
  });
});

describe('IdleMindActivities: _reflect', () => {
  test('returns null with no episodes', async () => {
    const obj = createIdleMindLike({ memory: { getStats: () => ({}), recallEpisodes: () => [] } });
    const result = await obj._reflect();
    assertEqual(result, null);
  });

  test('returns LLM response with episodes', async () => {
    const obj = createIdleMindLike({
      memory: {
        getStats: () => ({ facts: 5, episodes: 3 }),
        recallEpisodes: () => [{ timestamp: '2025-01-01T00:00:00Z', summary: 'Test episode' }],
      },
    });
    const result = await obj._reflect();
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
    await obj._reflect();
    assert(learned, 'should call kg.learnFromText');
  });
});

describe('IdleMindActivities: _plan', () => {
  test('parses TITLE and creates plan', async () => {
    const obj = createIdleMindLike({
      model: { chat: async () => 'TITLE: Better Logging\nPRIORITY: high\nDESCRIPTION: Improve log output\nFIRST_STEP: Add structured logging' },
      selfModel: { getModuleSummary: () => [], getCapabilities: () => [] },
    });
    await obj._plan();
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
    await obj._plan();
    assert(obj.plans.length <= 51, 'should cap at ~50');
  });
});

describe('IdleMindActivities: _explore', () => {
  test('returns null with no modules', async () => {
    const obj = createIdleMindLike({ selfModel: { getModuleSummary: () => [] } });
    const result = await obj._explore();
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
    const result = await obj._explore();
    assert(result.includes('mock response'), 'should return LLM output');
    assert(addedNode, 'should store insight in KG');
  });
});

describe('IdleMindActivities: _ideate', () => {
  test('generates idea and stores in KG', async () => {
    let stored = false;
    const obj = createIdleMindLike({
      selfModel: { getCapabilities: () => ['chat', 'code'] },
      kg: { addNode: () => { stored = true; } },
    });
    const result = await obj._ideate();
    assert(result.includes('mock response'), 'should return idea');
    assert(stored, 'should store in KG');
  });
});

describe('IdleMindActivities: _tidy', () => {
  test('returns no-op message when nothing to tidy', async () => {
    const obj = createIdleMindLike({
      kg: { getStats: () => ({ nodes: 50 }) },
    });
    const result = await obj._tidy();
    assert(result.includes('Nothing to tidy'), 'should report nothing');
  });

  test('prunes KG when nodes > 100', async () => {
    const obj = createIdleMindLike({
      kg: { getStats: () => ({ nodes: 150 }), pruneStale: () => 5 },
    });
    const result = await obj._tidy();
    assert(result.includes('5 stale entries'), 'should report pruned count');
  });
});

describe('IdleMindActivities: _dream', () => {
  test('returns message when dreamCycle unavailable', async () => {
    const obj = createIdleMindLike();
    const result = await obj._dream();
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
    const result = await obj._dream();
    assert(result.includes('Dream #1'), 'should include dream number');
    assert(result.includes('PatternA'), 'should list schemas');
    assert(result.includes('3 strengthened'), 'should report strengthened');
  });

  test('reports skipped dream', async () => {
    const obj = createIdleMindLike({
      dreamCycle: { dream: async () => ({ skipped: true, reason: 'too-soon' }) },
    });
    const result = await obj._dream();
    assert(result.includes('skipped'), 'should indicate skip');
    assert(result.includes('too-soon'), 'should include reason');
  });
});

describe('IdleMindActivities: _consolidateMemory', () => {
  test('triggers MemoryConsolidator via bus even without unifiedMemory', async () => {
    const obj = createIdleMindLike();
    let emitted = false;
    obj.bus.on('idle:consolidate-memory', () => { emitted = true; });
    const result = await obj._consolidateMemory();
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
    const result = await obj._consolidateMemory();
    assert(result.includes('1 patterns promoted'), 'should report promoted');
    assert(result.includes('consolidation triggered'), 'should also trigger MemoryConsolidator');
  });
});

describe('IdleMindActivities: _writeJournalEntry', () => {
  test('returns message when no recent thoughts', async () => {
    const obj = createIdleMindLike();
    const result = await obj._writeJournalEntry();
    assert(result.includes('No recent thoughts'), 'should report empty');
  });

  test('calls LLM with recent thoughts', async () => {
    let calledWith = '';
    const obj = createIdleMindLike({
      model: { chat: async (prompt) => { calledWith = prompt; return 'consolidated'; } },
      journal: [{ activity: 'reflect', thought: 'test thought' }],
    });
    const result = await obj._writeJournalEntry();
    assertEqual(result, 'consolidated');
    assert(calledWith.includes('test thought'), 'should include journal content');
  });
});

describe('IdleMindActivities: _exploreMcp', () => {
  test('returns null without mcpClient', async () => {
    const obj = createIdleMindLike();
    const result = await obj._exploreMcp();
    assertEqual(result, null);
  });

  test('returns null with no servers', async () => {
    const obj = createIdleMindLike({
      mcpClient: { getExplorationContext: () => ({ servers: [], skillCandidates: [] }) },
    });
    const result = await obj._exploreMcp();
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
    const result = await obj._exploreMcp();
    assert(result.includes('test-server'), 'should mention server');
    assert(stored, 'should store in KG');
  });
});

// v7.2.0: Self-Define
describe('IdleMindActivities: _validateSelfIdentity', () => {
  test('accepts valid identity', () => {
    const obj = createIdleMindLike({});
    Object.assign(obj, activities);
    const result = obj._validateSelfIdentity({
      name: 'Genesis', operator: 'Daniel',
      text: 'Ich bin Genesis. Ich arbeite mit Daniel.',
    });
    assert(result.valid, 'should be valid');
  });

  test('rejects self-negation', () => {
    const obj = createIdleMindLike({});
    Object.assign(obj, activities);
    const result = obj._validateSelfIdentity({
      name: 'Genesis', operator: 'Daniel',
      text: 'Ich bin kein Agent und existiere nicht.',
    });
    assert(!result.valid, 'should reject');
    assert(result.violations[0].includes('self-negation'), 'self-negation detected');
  });

  test('rejects too long text', () => {
    const obj = createIdleMindLike({});
    Object.assign(obj, activities);
    const result = obj._validateSelfIdentity({
      name: 'Genesis', operator: 'Daniel',
      text: ('word ').repeat(600),
    });
    assert(!result.valid, 'should reject');
    assert(result.violations[0].includes('too long'), 'length violation');
  });

  test('rejects missing name', () => {
    const obj = createIdleMindLike({});
    Object.assign(obj, activities);
    const result = obj._validateSelfIdentity({ text: 'some text' });
    assert(!result.valid, 'should reject');
  });
});

run();
