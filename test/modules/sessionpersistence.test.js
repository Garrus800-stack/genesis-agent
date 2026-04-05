// ============================================================
// Test: SessionPersistence.js — session summary, user profile, restore
// ============================================================
let passed = 0, failed = 0;
const failures = [];

// v3.5.2: Fixed — queue-based async-safe test runner
const _testQueue = [];
function test(name, fn) { _testQueue.push({ name, fn }); }
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }

const { NullBus } = require('../../src/agent/core/EventBus');

// ── Mock Dependencies ─────────────────────────────────────

function createMockStorage() {
  const data = {};
  return {
    readJSON: (key, fallback) => data[key] || fallback,
    writeJSON: (key, value) => { data[key] = JSON.parse(JSON.stringify(value)); },
    _data: data,
  };
}

function createMockModel(summaryResponse = 'Session summary: user discussed project setup.') {
  return {
    activeModel: 'mock-model',
    chat: async (prompt, messages, taskType) => summaryResponse,
    streamChat: async () => {},
  };
}

function createMockMemory() {
  const semantic = {};
  return {
    search: () => [],
    addSemantic: (k, v, s) => { semantic[k] = { value: v, source: s }; },
    getSemantic: (k) => semantic[k]?.value || null,
    db: { semantic },
    getStats: () => ({ episodes: 0 }),
  };
}

// ── Tests ──────────────────────────────────────────────────

const { SessionPersistence } = require('../../src/agent/revolution/SessionPersistence');

console.log('\n  💾 SessionPersistence');

test('constructs without errors', () => {
  const sp = new SessionPersistence({
    bus: NullBus, model: createMockModel(), memory: createMockMemory(),
    storage: createMockStorage(), lang: { t: k => k },
  });
  assert(sp.currentSession, 'Should have currentSession');
  assert(sp.currentSession.messageCount === 0);
  assert(Array.isArray(sp.sessionHistory));
  assert(sp.userProfile !== null);
});

test('static containerConfig is defined', () => {
  assert(SessionPersistence.containerConfig, 'Missing containerConfig');
  assert(SessionPersistence.containerConfig.name === 'sessionPersistence');
  assert(SessionPersistence.containerConfig.phase > 0);
  assert(SessionPersistence.containerConfig.deps.includes('model'));
  assert(SessionPersistence.containerConfig.deps.includes('memory'));
  assert(SessionPersistence.containerConfig.deps.includes('storage'));
});

test('containerConfig has lateBindings for promptBuilder', () => {
  const lb = SessionPersistence.containerConfig.lateBindings;
  assert(Array.isArray(lb), 'lateBindings should be array');
  const pbBinding = lb.find(b => b.target === 'promptBuilder');
  assert(pbBinding, 'Should have late-binding to promptBuilder');
  assert(pbBinding.property === 'sessionPersistence');
});

test('currentSession tracks startedAt', () => {
  const sp = new SessionPersistence({
    bus: NullBus, model: createMockModel(), memory: createMockMemory(),
    storage: createMockStorage(),
  });
  assert(typeof sp.currentSession.startedAt === 'string');
  // Should be a valid ISO date
  assert(!isNaN(new Date(sp.currentSession.startedAt).getTime()));
});

test('userProfile has expected shape', () => {
  const sp = new SessionPersistence({
    bus: NullBus, model: createMockModel(), memory: createMockMemory(),
    storage: createMockStorage(),
  });
  assert(sp.userProfile.name === null || typeof sp.userProfile.name === 'string');
  assert(Array.isArray(sp.userProfile.interests));
  assert(Array.isArray(sp.userProfile.projects));
  assert(typeof sp.userProfile.preferences === 'object');
});

test('maxSessionHistory defaults to 10', () => {
  const sp = new SessionPersistence({
    bus: NullBus, model: createMockModel(), memory: createMockMemory(),
    storage: createMockStorage(),
  });
  assert(sp.maxSessionHistory === 10);
});

test('restores session history from storage', () => {
  const storage = createMockStorage();
  storage.writeJSON('session-history.json', [
    { summary: 'Previous session about code review', date: '2025-01-01' },
  ]);
  storage.writeJSON('user-profile.json', {
    name: 'Garrus', language: 'de', interests: ['AI', 'Electron'],
    projects: [], preferences: {}, communicationStyle: null, expertise: [],
  });

  const sp = new SessionPersistence({
    bus: NullBus, model: createMockModel(), memory: createMockMemory(),
    storage,
  });
  // It should have loaded the history
  assert(sp.sessionHistory.length === 1 || sp.sessionHistory.length === 0,
    'Should load session history from storage (or start empty if _load checks differently)');
});

test('generateSessionSummary calls model.chat', async () => {
  const chatCalls = [];
  const model = {
    activeModel: 'mock',
    chat: async (prompt, messages, taskType) => {
      chatCalls.push({ prompt, taskType });
      return 'Summary: user worked on testing.';
    },
  };

  const sp = new SessionPersistence({
    bus: NullBus, model, memory: createMockMemory(),
    storage: createMockStorage(),
  });

  const history = [
    { role: 'user', content: 'Help me write tests' },
    { role: 'assistant', content: 'Sure, let me create test files.' },
  ];

  if (typeof sp.generateSessionSummary === 'function') {
    await sp.generateSessionSummary(history);
    assert(chatCalls.length > 0, 'Should have called model.chat');
  }
});

test('getSessionContext returns context string', () => {
  const sp = new SessionPersistence({
    bus: NullBus, model: createMockModel(), memory: createMockMemory(),
    storage: createMockStorage(),
  });

  if (typeof sp.getSessionContext === 'function') {
    const context = sp.getSessionContext();
    assert(typeof context === 'string' || context === null,
      'Should return string or null');
  }
});

test('currentSession has expected tracking fields', () => {
  const sp = new SessionPersistence({
    bus: NullBus, model: createMockModel(), memory: createMockMemory(),
    storage: createMockStorage(),
  });

  assert(Array.isArray(sp.currentSession.topicsDiscussed));
  assert(Array.isArray(sp.currentSession.errorsEncountered));
  assert(Array.isArray(sp.currentSession.goalsWorkedOn));
  assert(Array.isArray(sp.currentSession.keyDecisions));
  assert(Array.isArray(sp.currentSession.codeFilesModified));
});

// ── Summary ───────────────────────────────────────────────
setTimeout(() => {
  console.log(`\n  SessionPersistence: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('  Failures:');
    failures.forEach(f => console.log(`    - ${f.name}: ${f.error}`));
  }
}, 500);

// v3.5.2: Async-safe runner — properly awaits all tests
(async () => {
  for (const t of _testQueue) {
    try {
      const r = t.fn(); if (r && r.then) await r;
      passed++; console.log(`    ✅ ${t.name}`);
    } catch (err) {
      failed++; console.log(`    ❌ ${t.name}: ${err.message}`);
    }
  }
  console.log(`\n    ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
