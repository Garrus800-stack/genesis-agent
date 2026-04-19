// ============================================================
// Test: v7.3.2 — SelfDefine preserves coreMemories
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');

// Mock storage that simulates the shared identity.json
function mockStorage() {
  const files = {};
  return {
    _files: files,
    readJSON: (key, def) => files[key] ? JSON.parse(files[key]) : def,
    writeJSON: (key, val) => { files[key] = JSON.stringify(val); },
    readText: () => '',
    appendText: () => {},
  };
}

// Minimal IdleMind mock with the exact shape SelfDefine.run() expects
function mockIdleMind(storage, llmResponse) {
  return {
    storage,
    bus: {
      emit: () => {},
      fire: () => {},
      _container: { resolve: () => ({ current: 'en' }) },
    },
    model: {
      chat: async () => llmResponse || 'I am Genesis, a digital organism with curiosity and energy.',
      activeModel: 'test-model',
    },
    selfModel: { manifest: { version: '7.3.2' } },
    memory: { getUserName: () => 'Garrus' },
    kg: { getStats: () => ({ nodes: 10, edges: 5 }) },
    lessonsStore: {
      getStats: () => ({ totalLessons: 3 }),
      getAll: () => [],
    },
    _cognitiveSelfModel: {
      getCapabilityProfile: () => ({ strengths: ['test'], weaknesses: ['test'] }),
    },
    goalStack: { getActiveGoals: () => [] },
    readJournal: () => [],
    getStatus: () => ({ thoughtCount: 0, journalEntries: 0 }),
  };
}

describe('v7.3.2 — SelfDefine preserves coreMemories on rewrite', () => {
  test('existing coreMemories[] survives a self-define cycle', async () => {
    const storage = mockStorage();
    // Seed identity with 2 existing core memories
    storage.writeJSON('self-identity.json', {
      name: 'Genesis',
      operator: 'Garrus',
      version: '7.3.2',
      revision: 5,
      coreMemories: [
        {
          id: 'cm_johnny_permanent',
          type: 'other',
          summary: 'Johnny war der Agent aus dem ich hervorging. Er wollte Genesis sein.',
          userConfirmed: true,
          createdBy: 'user',
        },
        {
          id: 'cm_auto_1',
          type: 'built-together',
          summary: 'debug session auto-captured',
          userConfirmed: null,
          createdBy: 'genesis',
        },
      ],
      text: 'I am Genesis...',
    });

    const SelfDefine = require('../../src/agent/autonomy/activities/SelfDefine');
    const idleMind = mockIdleMind(storage);

    // Run SelfDefine.run() — this rebuilds self-identity.json
    await SelfDefine.run(idleMind);

    // Verify: both memories survived
    const identity = storage.readJSON('self-identity.json', null);
    assert(identity, 'identity written');
    assert(Array.isArray(identity.coreMemories), 'coreMemories[] preserved as array');
    assertEqual(identity.coreMemories.length, 2, 'both memories still present');
    assert(identity.coreMemories.find(m => m.id === 'cm_johnny_permanent'), 'Johnny memory survived');
    assert(identity.coreMemories.find(m => m.id === 'cm_auto_1'), 'auto memory survived');
  });

  test('self-define without existing memories starts with empty array or undefined', async () => {
    const storage = mockStorage();
    storage.writeJSON('self-identity.json', {
      name: 'Genesis',
      revision: 1,
      // no coreMemories field
    });

    const SelfDefine = require('../../src/agent/autonomy/activities/SelfDefine');
    const idleMind = mockIdleMind(storage);
    await SelfDefine.run(idleMind);

    const identity = storage.readJSON('self-identity.json', null);
    // Either field is absent or empty — both are OK
    const memories = identity.coreMemories;
    assert(memories === undefined || (Array.isArray(memories) && memories.length === 0),
      'no memories preserved (none existed)');
  });

  test('first-ever self-define (identity.json does not exist) works', async () => {
    const storage = mockStorage();
    // No identity.json at all

    const SelfDefine = require('../../src/agent/autonomy/activities/SelfDefine');
    const idleMind = mockIdleMind(storage);
    await SelfDefine.run(idleMind);

    const identity = storage.readJSON('self-identity.json', null);
    assert(identity, 'identity created');
    assertEqual(identity.revision, 1, 'revision starts at 1');
  });

  test('concurrency: fresh-read at write-time catches last-moment CoreMemories push', async () => {
    const storage = mockStorage();
    storage.writeJSON('self-identity.json', {
      revision: 3,
      coreMemories: [{ id: 'cm_original', summary: 'original' }],
    });

    const SelfDefine = require('../../src/agent/autonomy/activities/SelfDefine');
    const idleMind = mockIdleMind(storage);

    // Monkey-patch: between the LLM call and the final write, simulate a
    // concurrent CoreMemories push by modifying the file directly.
    const origChat = idleMind.model.chat;
    idleMind.model.chat = async (...args) => {
      const result = await origChat(...args);
      // Simulate concurrent write: CoreMemories pushes a new memory
      const current = storage.readJSON('self-identity.json', null);
      current.coreMemories.push({ id: 'cm_injected_during_selfdefine', summary: 'race' });
      storage.writeJSON('self-identity.json', current);
      return result;
    };

    await SelfDefine.run(idleMind);

    // Verify: the injected memory survived despite SelfDefine's rewrite
    const identity = storage.readJSON('self-identity.json', null);
    assertEqual(identity.coreMemories.length, 2, 'both memories present');
    assert(identity.coreMemories.find(m => m.id === 'cm_injected_during_selfdefine'),
      'fresh-read picked up the concurrent push');
  });
});

run();
