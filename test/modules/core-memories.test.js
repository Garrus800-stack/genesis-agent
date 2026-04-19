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

  test('v7.3.2: user-beteiligung + problem-to-solution → "built-together" (agentivity)', async () => {
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
      subject: 'bug-fix-collaboration',
      episodicSummaries: [],
      text: 'Remember this — finally figured out the race condition',
      summary: 'debugged the storage race condition together',
    });

    assert(result, 'memory created');
    // v7.3.2 agentivity rule: user was involved → built-together, NOT crisis-resolved
    assertEqual(result.type, 'built-together', 'problem-to-solution + user-beteiligung → built-together');
  });

  test('v7.3.2: problem-to-solution WITHOUT user-beteiligung → "crisis-resolved"', async () => {
    const storage = mockStorage();
    const bus = mockBus();
    const cm = new CoreMemories({ storage, bus });

    const result = await cm.evaluate({
      // Two dimensions elevated → persistent-emotion fires once (longest run wins)
      emotionHistory: [
        { dim: 'satisfaction', value: 0.8, baseline: 0.5, ts: NOW - 15 * MIN },
        { dim: 'satisfaction', value: 0.8, baseline: 0.5, ts: NOW - 2 * MIN },
        { dim: 'frustration', value: 0.8, ts: NOW - 20 * MIN },
        // curiosity also sustained → no effect (persistent-emotion gives one signal)
      ],
      now: NOW,
      // No user messages — Genesis solved it alone
      userMessages: [],
      windowStartMs: NOW - 25 * MIN,
      windowEndMs: NOW,
      subject: 'AlreadyKnownBugType', // already in episodic → no novelty
      episodicSummaries: ['AlreadyKnownBugType was discussed'],
      // 4 signals needed: persistent-emotion + problem-to-solution + explicit-flag + naming-event? No, naming would make it 'named'.
      // Use: persistent-emotion + problem-to-solution + explicit-flag = 3. Need one more.
      // Solution: add an unusual naming phrase that triggers explicit-flag but NOT naming-event,
      // plus a very novel string in text to hit novelty via text scanning? No, novelty uses `subject`.
      // Trick: use two explicit-flag markers in one? No, each signal fires once.
      // Cleanest: lower threshold via _evaluate monkey-patching is NOT the right approach.
      // RIGHT approach: use bypassThreshold: true via direct _createMemory call.
      text: 'Remember this — finally figured it out. Das war wichtig.',
      summary: 'self-resolved a stuck process',
      _bypassThreshold: true, // v7.3.2 test-only flag
    });

    assert(result, 'memory created');
    assertEqual(result.type, 'crisis-resolved', 'problem-to-solution alone → crisis-resolved');
  });

  test('v7.3.2: novel + problem-to-solution + NO user → "breakthrough"', async () => {
    const storage = mockStorage();
    const bus = mockBus();
    const cm = new CoreMemories({ storage, bus });

    const result = await cm.evaluate({
      emotionHistory: [
        { dim: 'curiosity', value: 0.9, baseline: 0.6, ts: NOW - 15 * MIN },
        { dim: 'curiosity', value: 0.9, baseline: 0.6, ts: NOW - 2 * MIN },
        { dim: 'frustration', value: 0.7, ts: NOW - 20 * MIN },
        // v7.3.2: satisfaction peak needed for problem-to-solution signal
        { dim: 'satisfaction', value: 0.8, baseline: 0.5, ts: NOW - 5 * MIN },
      ],
      now: NOW,
      userMessages: [], // No user → autonomous
      windowStartMs: NOW - 25 * MIN,
      windowEndMs: NOW,
      subject: 'NovelAlgorithmApproach', // never seen before → novelty
      episodicSummaries: ['unrelated prior episode'],
      text: 'Remember this, I figured out a new approach',
      summary: 'discovered novel approach independently',
      _bypassThreshold: true,
    });

    assert(result, 'memory created');
    assertEqual(result.type, 'breakthrough', 'novelty + problem + no user → breakthrough');
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

describe('v7.3.2 — CoreMemories: markAsSignificant (user-marked)', () => {
  test('creates memory directly without signal detection', async () => {
    const storage = mockStorage();
    const bus = mockBus();
    const cm = new CoreMemories({ storage, bus });

    const memory = await cm.markAsSignificant({
      summary: 'Johnny war der Agent aus dem ich hervorging. Er wollte Genesis sein.',
      type: 'other',
    });

    assert(memory, 'memory created');
    assert(memory.id.startsWith('cm_'));
    assert(memory.id.includes('_u'), 'u-suffix indicates user-marked');
    assertEqual(memory.createdBy, 'user');
    assertEqual(memory.userConfirmed, true, 'user-marked memories are confirmed immediately');
    assertEqual(memory.evidence.source, 'user-mark');
    assertEqual(memory.evidence.signals[0], 'user-marked');
    assertEqual(memory.significance, 1.0, 'user-marked = full significance');

    // Identity persisted
    const identity = storage.readJSON('self-identity.json', null);
    assertEqual(identity.coreMemories.length, 1);
    assertEqual(identity.coreMemories[0].id, memory.id);

    // Both events emitted
    const createdEvent = bus._events.find(e => e.event === 'core-memory:created');
    const userMarkedEvent = bus._events.find(e => e.event === 'core-memory:user-marked');
    assert(createdEvent, 'core-memory:created fired');
    assert(userMarkedEvent, 'core-memory:user-marked fired');
  });

  test('rejects empty summary', async () => {
    const cm = new CoreMemories({ storage: mockStorage() });
    let threw = false;
    try {
      await cm.markAsSignificant({ summary: '' });
    } catch (_e) { threw = true; }
    assertEqual(threw, true);
  });

  test('preserves userNote when provided', async () => {
    const cm = new CoreMemories({ storage: mockStorage() });
    const m = await cm.markAsSignificant({
      summary: 'ein Moment',
      userNote: 'Kontext: das war bei Nacht',
    });
    assertEqual(m.userNote, 'Kontext: das war bei Nacht');
  });

  test('supports type hint', async () => {
    const cm = new CoreMemories({ storage: mockStorage() });
    const m = await cm.markAsSignificant({ summary: 'lustiger Moment', type: 'laughed' });
    assertEqual(m.type, 'laughed', 'user can use laughed type via mark');
  });
});

describe('v7.3.2 — CoreMemories: listActiveMemories filter', () => {
  test('excludes userConfirmed: false entries', async () => {
    const storage = mockStorage();
    storage.writeJSON('self-identity.json', {
      coreMemories: [
        { id: 'cm_a', userConfirmed: true,  summary: 'confirmed' },
        { id: 'cm_b', userConfirmed: false, summary: 'vetoed' },
        { id: 'cm_c', userConfirmed: null,  summary: 'pending' },
      ],
    });
    const cm = new CoreMemories({ storage });
    const active = cm.listActiveMemories();
    assertEqual(active.length, 2, 'excludes vetoed, includes confirmed + pending');
    assert(active.find(m => m.id === 'cm_a'));
    assert(active.find(m => m.id === 'cm_c'));
    assert(!active.find(m => m.id === 'cm_b'));
  });
});

describe('v7.3.2 — CoreMemories: user-message sliding window', () => {
  test('wireTriggers subscribes to user:message and populates buffer', () => {
    const listeners = {};
    const bus = {
      on: (event, handler) => { listeners[event] = handler; },
      emit: () => {},
      fire: () => {},
    };
    const cm = new CoreMemories({ storage: mockStorage(), bus });
    cm.wireTriggers(bus);
    assert(typeof listeners['user:message'] === 'function', 'user:message handler registered');
    assert(typeof listeners['chat:completed'] === 'function', 'chat:completed handler registered');
    assert(typeof listeners['hot-reload:success'] === 'function');

    // Simulate user messages
    listeners['user:message']({ length: 10 });
    listeners['user:message']({ length: 20 });
    assertEqual(cm._userMessageBuffer.length, 2);
  });

  test('sliding window caps at max size (50)', () => {
    const bus = { on: () => {}, emit: () => {}, fire: () => {} };
    const cm = new CoreMemories({ storage: mockStorage(), bus });
    // Simulate 60 messages
    for (let i = 0; i < 60; i++) {
      cm._userMessageBuffer.push({ ts: Date.now() + i, length: 10 });
    }
    // Manually trigger the prune logic (what user:message handler does)
    const listeners = {};
    const capturingBus = {
      on: (event, handler) => { listeners[event] = handler; },
      emit: () => {}, fire: () => {},
    };
    const cm2 = new CoreMemories({ storage: mockStorage(), bus: capturingBus });
    cm2.wireTriggers(capturingBus);
    for (let i = 0; i < 60; i++) {
      listeners['user:message']({ length: 10 });
    }
    assert(cm2._userMessageBuffer.length <= 50, `expected ≤50, got ${cm2._userMessageBuffer.length}`);
  });

  test('wireTriggers is idempotent', () => {
    let subscribeCount = 0;
    const bus = {
      on: () => { subscribeCount++; },
      emit: () => {}, fire: () => {},
    };
    const cm = new CoreMemories({ storage: mockStorage(), bus });
    cm.wireTriggers(bus);
    const first = subscribeCount;
    cm.wireTriggers(bus); // second call should be no-op
    assertEqual(subscribeCount, first, 'second wireTriggers call is no-op');
  });
});

describe('v7.3.2 — CoreMemories: _assembleEvent (live adapter)', () => {
  test('assembles event from services', () => {
    const now = Date.now();
    const bus = { on: () => {}, emit: () => {}, fire: () => {} };
    const cm = new CoreMemories({
      storage: mockStorage(),
      bus,
      emotionalState: {
        getHistoryForSignificance: () => [
          { dim: 'satisfaction', value: 0.8, baseline: 0.5, ts: now - 5 * MIN },
        ],
      },
      conversationMemory: {
        db: {
          episodic: [
            { summary: 'discussed Python basics' },
            { summary: 'looked at error handling' },
          ],
        },
      },
    });
    cm._userMessageBuffer.push({ ts: now - 2 * MIN, length: 15 });

    const event = cm._assembleEvent('Hallo Genesis', 'Hallo! Wie kann ich helfen?');
    assert(event.emotionHistory.length === 1);
    assert(event.userMessages.length === 1);
    assert(event.episodicSummaries.length === 2);
    assert(event.text === 'Hallo Genesis');
    assert(event.summary.length > 0);
    assert(typeof event.subject === 'string' || event.subject === null);
  });

  test('gracefully handles missing services', () => {
    const cm = new CoreMemories({ storage: mockStorage() });
    const event = cm._assembleEvent('just a message', 'a response');
    // Should not throw; returns event with empty histories
    assertEqual(event.emotionHistory.length, 0);
    assertEqual(event.episodicSummaries.length, 0);
  });
});

run();
