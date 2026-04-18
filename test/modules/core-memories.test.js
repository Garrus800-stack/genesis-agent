// ============================================================
// Test: v7.3.1 A4-F4 — CoreMemories Store
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const { CoreMemories } = require('../../src/agent/cognitive/CoreMemories');

function mockStorage() {
  const files = {};
  return {
    _files: files,
    readJSON: (key, def) => files[key] ? JSON.parse(files[key]) : def,
    writeJSON: (key, val) => { files[key] = JSON.stringify(val); },
    readText: (key) => files[key] || '',
    appendText: (key, s) => { files[key] = (files[key] || '') + s; },
  };
}

function mockBus() {
  const events = [];
  return {
    _events: events,
    emit: (event, data) => events.push({ event, data }),
    fire: (event, data) => events.push({ event, data }),
  };
}

const NOW = 1_700_000_000_000;
const MIN = 60 * 1000;

describe('v7.3.1 — CoreMemories: below-threshold logs candidate only', () => {
  test('logs candidate, does not create memory', async () => {
    const storage = mockStorage();
    const bus = mockBus();
    const cm = new CoreMemories({ storage, bus });

    const result = await cm.evaluate({
      emotionHistory: [],
      userMessages: [],
      subject: 'nothing-new',
      episodicSummaries: ['there is nothing-new here'], // fails novelty
      text: 'just chatting',
      summary: 'a random moment',
    });

    assertEqual(result, null, 'no memory created');
    const candidateEvent = bus._events.find(e => e.event === 'core-memory:candidate');
    assert(candidateEvent, 'candidate event fired');
    assertEqual(candidateEvent.data.signalCount < 4, true);

    const createdEvent = bus._events.find(e => e.event === 'core-memory:created');
    assertEqual(createdEvent, undefined, 'no created event');

    // Identity file was NOT touched (no coreMemories array)
    const identity = storage.readJSON('self-identity.json', null);
    assert(!identity || !identity.coreMemories || identity.coreMemories.length === 0);

    // Candidate was logged
    const candidates = storage.readText('coreMemoryCandidates.jsonl');
    assert(candidates.includes(candidateEvent.data.candidateId), 'candidate in log');
  });
});

describe('v7.3.1 — CoreMemories: above-threshold creates memory', () => {
  test('4+ signals triggers memory creation', async () => {
    const storage = mockStorage();
    const bus = mockBus();
    const cm = new CoreMemories({ storage, bus });

    const result = await cm.evaluate({
      emotionHistory: [
        { dim: 'satisfaction', value: 0.8, baseline: 0.5, ts: NOW - 20 * MIN },
        { dim: 'satisfaction', value: 0.8, baseline: 0.5, ts: NOW - 2 * MIN },
        { dim: 'frustration', value: 0.7, ts: NOW - 25 * MIN },
      ],
      now: NOW,
      userMessages: [
        { ts: NOW - 10 * MIN }, { ts: NOW - 5 * MIN }, { ts: NOW - 3 * MIN }, { ts: NOW - MIN },
      ],
      windowStartMs: NOW - 15 * MIN,
      windowEndMs: NOW,
      subject: 'Johnny',
      episodicSummaries: ['unrelated talk'],
      text: 'Ich nenne dich Johnny',
      summary: 'User named Genesis "Johnny"',
      participants: ['user', 'genesis'],
    });

    assert(result, 'memory created');
    assert(result.id.startsWith('cm_'), 'id format');
    assertEqual(result.type, 'named', 'fast-path to named for naming-event');
    assert(result.significance >= 4 / 6);
    assert(Array.isArray(result.evidence.signals));
    assertEqual(result.userConfirmed, null, 'pending user action');
    assertEqual(result.createdBy, 'genesis');

    const createdEvent = bus._events.find(e => e.event === 'core-memory:created');
    assert(createdEvent);
    assertEqual(createdEvent.data.type, 'named');

    // Identity file updated
    const identity = storage.readJSON('self-identity.json', null);
    assert(identity);
    assert(Array.isArray(identity.coreMemories));
    assertEqual(identity.coreMemories.length, 1);
    assertEqual(identity.coreMemories[0].id, result.id);
  });

  test('problem-to-solution signal gets "crisis-resolved" type', async () => {
    const storage = mockStorage();
    const bus = mockBus();
    const cm = new CoreMemories({ storage, bus });

    const result = await cm.evaluate({
      emotionHistory: [
        // Persistent: sustained satisfaction for >10min
        { dim: 'satisfaction', value: 0.8, baseline: 0.5, ts: NOW - 15 * MIN },
        { dim: 'satisfaction', value: 0.8, baseline: 0.5, ts: NOW - 2 * MIN },
        // Problem-to-solution: frustration → satisfaction
        { dim: 'frustration', value: 0.8, ts: NOW - 20 * MIN },
      ],
      now: NOW,
      userMessages: [
        { ts: NOW - 18 * MIN }, { ts: NOW - 10 * MIN }, { ts: NOW - 3 * MIN },
      ],
      windowStartMs: NOW - 25 * MIN,
      windowEndMs: NOW,
      subject: 'bug-fix-breakthrough',
      episodicSummaries: [],
      text: 'Remember this — finally figured out the race condition',
      summary: 'debugged the storage race condition',
    });

    assert(result, 'memory created');
    assertEqual(result.type, 'crisis-resolved', 'problem-to-solution → crisis-resolved');
  });

  test('without naming/problem-solution, falls back to "other" (no LLM)', async () => {
    const storage = mockStorage();
    const bus = mockBus();
    const cm = new CoreMemories({ storage, bus }); // no model

    const result = await cm.evaluate({
      emotionHistory: [
        { dim: 'curiosity', value: 0.9, baseline: 0.5, ts: NOW - 20 * MIN },
        { dim: 'curiosity', value: 0.9, baseline: 0.5, ts: NOW - 2 * MIN },
      ],
      now: NOW,
      userMessages: [
        { ts: NOW - 14 * MIN }, { ts: NOW - 10 * MIN }, { ts: NOW - 3 * MIN },
      ],
      windowStartMs: NOW - 15 * MIN,
      windowEndMs: NOW,
      subject: 'something-unique',
      episodicSummaries: [],
      text: 'please remember this fact',
      summary: 'an interesting learning',
    });

    assert(result, 'memory created');
    assertEqual(result.type, 'other', 'fallback when no LLM');
  });
});

describe('v7.3.1 — CoreMemories: veto + confirm', () => {
  test('veto sets userConfirmed=false, emits core-memory:veto', async () => {
    const storage = mockStorage();
    const bus = mockBus();
    const cm = new CoreMemories({ storage, bus });

    // Seed a memory directly
    storage.writeJSON('self-identity.json', {
      coreMemories: [
        { id: 'cm_test_1', type: 'other', userConfirmed: null },
      ],
    });

    const ok = cm.veto('cm_test_1', 'Nicht wichtig für mich');
    assertEqual(ok, true);

    const identity = storage.readJSON('self-identity.json', {});
    const mem = identity.coreMemories.find(m => m.id === 'cm_test_1');
    assertEqual(mem.userConfirmed, false);
    assertEqual(mem.userNote, 'Nicht wichtig für mich');

    const vetoEvent = bus._events.find(e => e.event === 'core-memory:veto');
    assert(vetoEvent, 'veto event fired');
    assertEqual(vetoEvent.data.id, 'cm_test_1');
    assertEqual(vetoEvent.data.userNote, 'Nicht wichtig für mich');
  });

  test('veto returns false for unknown id', async () => {
    const storage = mockStorage();
    const bus = mockBus();
    const cm = new CoreMemories({ storage, bus });
    assertEqual(cm.veto('cm_nonexistent'), false);
  });

  test('confirm sets userConfirmed=true', async () => {
    const storage = mockStorage();
    const cm = new CoreMemories({ storage });
    storage.writeJSON('self-identity.json', {
      coreMemories: [{ id: 'cm_test_2', userConfirmed: null }],
    });

    assertEqual(cm.confirm('cm_test_2'), true);
    const identity = storage.readJSON('self-identity.json', {});
    assertEqual(identity.coreMemories[0].userConfirmed, true);
  });
});

describe('v7.3.1 — CoreMemories: list + listCandidates', () => {
  test('list returns all memories', async () => {
    const storage = mockStorage();
    storage.writeJSON('self-identity.json', {
      coreMemories: [
        { id: 'cm_1', type: 'named' },
        { id: 'cm_2', type: 'crisis-resolved' },
      ],
    });
    const cm = new CoreMemories({ storage });
    const list = cm.list();
    assertEqual(list.length, 2);
  });

  test('list returns [] when no memories exist', async () => {
    const cm = new CoreMemories({ storage: mockStorage() });
    assertEqual(cm.list().length, 0);
  });

  test('listCandidates parses jsonl log', async () => {
    const storage = mockStorage();
    storage.appendText('coreMemoryCandidates.jsonl',
      JSON.stringify({ candidateId: 'c1', signalCount: 2 }) + '\n' +
      JSON.stringify({ candidateId: 'c2', signalCount: 3 }) + '\n');
    const cm = new CoreMemories({ storage });
    const cands = cm.listCandidates();
    assertEqual(cands.length, 2);
    assertEqual(cands[0].candidateId, 'c1');
  });
});

describe('v7.3.1 — CoreMemories: sourceContext', () => {
  test('falls back to version-only when git unavailable', async () => {
    const storage = mockStorage();
    const cm = new CoreMemories({
      storage,
      selfModel: { manifest: { version: '7.3.1' }, gitAvailable: false },
    });
    // Access private method via direct call
    const ctx = cm._getSourceContext();
    assertEqual(ctx, 'v7.3.1', 'no git → just version');
  });

  test('handles missing selfModel', async () => {
    const cm = new CoreMemories({ storage: mockStorage() });
    const ctx = cm._getSourceContext();
    assertEqual(ctx, 'vunknown');
  });
});

run();
