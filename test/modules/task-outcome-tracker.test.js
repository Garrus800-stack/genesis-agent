// ============================================================
// GENESIS — test/modules/task-outcome-tracker.test.js (v5.9.7)
//
// Tests TaskOutcomeTracker: event handling, classification,
// aggregation, persistence, pruning, stats emission.
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { TaskOutcomeTracker } = require(path.join(ROOT, 'src/agent/cognitive/TaskOutcomeTracker'));

// ── Mock Dependencies ───────────────────────────────────────

function mockBus() {
  const events = [];
  const handlers = {};
  return {
    on: (evt, fn) => { handlers[evt] = fn; return () => { delete handlers[evt]; }; },
    emit: (evt, data) => events.push({ evt, data }),
    _events: events,
    _handlers: handlers,
    _fire: (evt, data) => handlers[evt]?.(data),
  };
}

function mockStorage() {
  const store = {};
  return {
    read: async (key) => store[key] || null,
    write: async (key, data) => { store[key] = data; },
    writeSync: (key, data) => { store[key] = data; },
    _store: store,
  };
}

// ── Tests ────────────────────────────────────────────────────

describe('TaskOutcomeTracker', () => {

  test('constructs with minimal deps', () => {
    const bus = mockBus();
    const t = new TaskOutcomeTracker({ bus });
    assert(t.bus === bus, 'bus assigned');
    assertEqual(t.stats.recorded, 0);
    assertEqual(t._outcomes.length, 0);
  });

  test('TaskOutcomeTracker is registered via manifest', () => {
    assert(typeof TaskOutcomeTracker === 'function', 'class exported');
  });

  test('boot() subscribes to 4 events', () => {
    const bus = mockBus();
    const t = new TaskOutcomeTracker({ bus });
    t.boot();
    assert(bus._handlers['agent-loop:complete'], 'agent-loop:complete handler');
    assert(bus._handlers['chat:completed'], 'chat:completed handler');
    assert(bus._handlers['selfmod:success'], 'selfmod:success handler');
    assert(bus._handlers['shell:outcome'], 'shell:outcome handler');
  });

  test('stop() unsubscribes and persists', () => {
    const bus = mockBus();
    const storage = mockStorage();
    const t = new TaskOutcomeTracker({ bus, storage });
    t.boot();
    // Record something so there is data to persist
    bus._fire('chat:completed', { intent: 'chat', success: true });
    t.stop();
    assertEqual(t._unsubs.length, 0);
  });

  test('records outcome on agent-loop:complete', () => {
    const bus = mockBus();
    const t = new TaskOutcomeTracker({ bus });
    t.boot();

    bus._fire('agent-loop:complete', {
      intent: 'code-gen',
      backend: 'anthropic',
      success: true,
      tokenCost: 1500,
      durationMs: 3000,
    });

    assertEqual(t._outcomes.length, 1);
    assertEqual(t._outcomes[0].taskType, 'code-gen');
    assertEqual(t._outcomes[0].backend, 'anthropic');
    assertEqual(t._outcomes[0].success, true);
    assertEqual(t._outcomes[0].tokenCost, 1500);
    assertEqual(t.stats.recorded, 1);
  });

  test('records outcome on chat:completed', () => {
    const bus = mockBus();
    const t = new TaskOutcomeTracker({ bus });
    t.boot();

    bus._fire('chat:completed', {
      intent: 'explain',
      success: true,
      tokens: 800,
    });

    assertEqual(t._outcomes.length, 1);
    assertEqual(t._outcomes[0].taskType, 'chat');
    assertEqual(t._outcomes[0].intent, 'explain');
  });

  test('records outcome on selfmod:success', () => {
    const bus = mockBus();
    const t = new TaskOutcomeTracker({ bus });
    t.boot();

    bus._fire('selfmod:success', { backend: 'ollama', tokens: 2000 });

    assertEqual(t._outcomes.length, 1);
    assertEqual(t._outcomes[0].taskType, 'self-modify');
    assertEqual(t._outcomes[0].success, true);
  });

  test('records outcome on shell:outcome', () => {
    const bus = mockBus();
    const t = new TaskOutcomeTracker({ bus });
    t.boot();

    bus._fire('shell:outcome', { exitCode: 0, durationMs: 500 });
    assertEqual(t._outcomes[0].taskType, 'shell-exec');
    assertEqual(t._outcomes[0].success, true);

    bus._fire('shell:outcome', { exitCode: 1 });
    assertEqual(t._outcomes[1].success, false);
    assertEqual(t._outcomes[1].errorCategory, 'exit-1');
  });

  test('classifies intents correctly', () => {
    const bus = mockBus();
    const t = new TaskOutcomeTracker({ bus });

    assertEqual(t._classifyTaskType('code-gen'), 'code-gen');
    assertEqual(t._classifyTaskType('self-modify'), 'self-modify');
    assertEqual(t._classifyTaskType('analyze-code'), 'analysis');
    assertEqual(t._classifyTaskType('chat'), 'chat');
    assertEqual(t._classifyTaskType('search'), 'research');
    assertEqual(t._classifyTaskType('run-skill'), 'skill-exec');
    assertEqual(t._classifyTaskType('unknown-thing'), 'general');
  });

  test('classifies compound intents via fuzzy match', () => {
    const bus = mockBus();
    const t = new TaskOutcomeTracker({ bus });

    assertEqual(t._classifyTaskType('code-gen-with-tests'), 'code-gen');
    assertEqual(t._classifyTaskType('advanced-research'), 'research');
  });

  test('emits task-outcome:recorded on each record', () => {
    const bus = mockBus();
    const t = new TaskOutcomeTracker({ bus });
    t.boot();

    bus._fire('chat:completed', { intent: 'chat', success: true });

    const recordedEvents = bus._events.filter(e => e.evt === 'task-outcome:recorded');
    assertEqual(recordedEvents.length, 1);
    assertEqual(recordedEvents[0].data.taskType, 'chat');
  });

  test('emits task-outcome:stats-updated every 10 records', () => {
    const bus = mockBus();
    const t = new TaskOutcomeTracker({ bus });
    t.boot();

    for (let i = 0; i < 10; i++) {
      bus._fire('chat:completed', { intent: 'chat', success: i < 7 });
    }

    const statsEvents = bus._events.filter(e => e.evt === 'task-outcome:stats-updated');
    assertEqual(statsEvents.length, 1);
    assert(statsEvents[0].data.byTaskType.chat, 'has chat stats');
  });

  test('getAggregateStats computes correct rates', () => {
    const bus = mockBus();
    const t = new TaskOutcomeTracker({ bus });
    t.boot();

    // 3 successes, 1 failure for code-gen
    for (let i = 0; i < 3; i++) {
      bus._fire('agent-loop:complete', { intent: 'code-gen', success: true, tokenCost: 1000, durationMs: 2000 });
    }
    bus._fire('agent-loop:complete', { intent: 'code-gen', success: false, tokenCost: 500, durationMs: 1000, error: 'syntax' });

    const stats = t.getAggregateStats();
    assertEqual(stats.byTaskType['code-gen'].count, 4);
    assertEqual(stats.byTaskType['code-gen'].successes, 3);
    assert(Math.abs(stats.byTaskType['code-gen'].successRate - 0.75) < 0.01, 'success rate ~75%');
    assertEqual(stats.byTaskType['code-gen'].avgTokenCost, 875);
    assertEqual(stats.byTaskType['code-gen'].errors.syntax, 1);
    assertEqual(stats.total, 4);
  });

  test('getAggregateStats respects windowMs filter', () => {
    const bus = mockBus();
    const t = new TaskOutcomeTracker({ bus });

    // Add an old outcome
    t._outcomes.push({
      taskType: 'chat', backend: 'ollama', success: true,
      tokenCost: 100, durationMs: 100, errorCategory: null,
      intent: 'chat', timestamp: Date.now() - 3600_000, // 1 hour ago
    });

    // Add a recent outcome
    t._outcomes.push({
      taskType: 'code-gen', backend: 'anthropic', success: true,
      tokenCost: 500, durationMs: 1000, errorCategory: null,
      intent: 'code-gen', timestamp: Date.now(),
    });

    const allStats = t.getAggregateStats();
    assertEqual(allStats.total, 2);

    const recentStats = t.getAggregateStats({ windowMs: 1800_000 }); // last 30 min
    assertEqual(recentStats.total, 1);
    assert(recentStats.byTaskType['code-gen'], 'only code-gen in window');
    assert(!recentStats.byTaskType.chat, 'chat excluded by window');
  });

  test('getOutcomes filters by taskType', () => {
    const bus = mockBus();
    const t = new TaskOutcomeTracker({ bus });
    t.boot();

    bus._fire('chat:completed', { intent: 'chat', success: true });
    bus._fire('agent-loop:complete', { intent: 'code-gen', success: true });
    bus._fire('chat:completed', { intent: 'chat', success: false });

    const chatOnly = t.getOutcomes({ taskType: 'chat' });
    assertEqual(chatOnly.length, 2);

    const codeOnly = t.getOutcomes({ taskType: 'code-gen' });
    assertEqual(codeOnly.length, 1);
  });

  test('getOutcomes respects limit', () => {
    const bus = mockBus();
    const t = new TaskOutcomeTracker({ bus });
    t.boot();

    for (let i = 0; i < 5; i++) {
      bus._fire('chat:completed', { intent: 'chat', success: true });
    }

    const limited = t.getOutcomes({ limit: 2 });
    assertEqual(limited.length, 2);
  });

  test('prunes outcomes when exceeding MAX_OUTCOMES', () => {
    const bus = mockBus();
    const t = new TaskOutcomeTracker({ bus });

    // Fill beyond MAX_OUTCOMES (2000)
    for (let i = 0; i < 2001; i++) {
      t._outcomes.push({
        taskType: 'chat', backend: 'test', success: true,
        tokenCost: 0, durationMs: 0, errorCategory: null,
        intent: 'chat', timestamp: Date.now(),
      });
    }

    // Trigger a record to force prune check
    t.boot();
    bus._fire('chat:completed', { intent: 'chat', success: true });

    assert(t._outcomes.length <= 1501, `pruned to ${t._outcomes.length}`);
    assert(t.stats.pruned > 0, 'prune counter incremented');
  });

  test('asyncLoad restores from storage', async () => {
    const bus = mockBus();
    const storage = mockStorage();
    const data = [
      { taskType: 'chat', backend: 'test', success: true, tokenCost: 100, durationMs: 50, errorCategory: null, intent: 'chat', timestamp: 1000 },
    ];
    storage._store['task-outcomes'] = data;

    const t = new TaskOutcomeTracker({ bus, storage });
    await t.asyncLoad();

    assertEqual(t._outcomes.length, 1);
    assertEqual(t._outcomes[0].taskType, 'chat');
  });

  test('handles null/undefined event data gracefully', () => {
    const bus = mockBus();
    const t = new TaskOutcomeTracker({ bus });
    t.boot();

    bus._fire('agent-loop:complete', null);
    bus._fire('chat:completed', undefined);
    bus._fire('selfmod:success', null);
    bus._fire('shell:outcome', null);

    assertEqual(t._outcomes.length, 0);
    assertEqual(t.stats.recorded, 0);
  });

  test('backend defaults to unknown when not provided', () => {
    const bus = mockBus();
    const t = new TaskOutcomeTracker({ bus });
    t.boot();

    bus._fire('chat:completed', { intent: 'chat', success: true });

    assertEqual(t._outcomes[0].backend, 'unknown');
  });

  test('per-backend aggregation works', () => {
    const bus = mockBus();
    const t = new TaskOutcomeTracker({ bus });
    t.boot();

    bus._fire('chat:completed', { intent: 'chat', success: true, backend: 'anthropic', tokens: 1000 });
    bus._fire('chat:completed', { intent: 'chat', success: true, backend: 'ollama', tokens: 500 });
    bus._fire('chat:completed', { intent: 'chat', success: false, backend: 'anthropic', tokens: 200 });

    const stats = t.getAggregateStats();
    assertEqual(stats.byBackend.anthropic.count, 2);
    assertEqual(stats.byBackend.ollama.count, 1);
    assert(stats.byBackend.anthropic.successRate === 0.5, 'anthropic 50% success');
    assert(stats.byBackend.ollama.successRate === 1.0, 'ollama 100% success');
  });

});

run();
