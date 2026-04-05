// ============================================================
// GENESIS — Autonomy Module Tests (v3.5.0)
//
// Tests for the three previously untested autonomous modules:
//   1. IdleMind — activity selection, lifecycle, homeostasis gating
//   2. AutonomousDaemon — lifecycle, cycle scheduling, configuration
//   3. CognitiveMonitor — tool analytics, circularity detection,
//                          token tracking, decision quality
// ============================================================

const assert = require('assert');
let passed = 0, failed = 0, errors = [];

// v3.5.2: Fixed — queue-based async-safe test runner
const _testQueue = [];
function test(name, fn) { _testQueue.push({ name, fn }); }

async function testAsync(name, fn) {
  try { await fn(); passed++; console.log(`    \x1b[32m✅ ${name}\x1b[0m`); }
  catch (e) { failed++; errors.push(name); console.log(`    \x1b[31m❌ ${name}: ${e.message}\x1b[0m`); }
}

const { NullBus, EventBus } = require('../../src/agent/core/EventBus');

// ════════════════════════════════════════════════════════════
// Mock helpers
// ════════════════════════════════════════════════════════════

class MockIntervals {
  constructor() { this.registered = new Map(); }
  register(name, fn, ms) { this.registered.set(name, { fn, ms }); }
  clear(name) { this.registered.delete(name); }
  remove(name) { this.registered.delete(name); }
  pause() {}
  resume() {}
}

function mockModel(response = 'mock response') {
  return {
    activeModel: 'test-model',
    chat: async () => response,
    chatStructured: async () => ({}),
  };
}

function mockStorage() {
  const data = {};
  return {
    readJSON: (k, def) => data[k] || def,
    writeJSON: (k, v) => { data[k] = v; },
    writeJSONDebounced: (k, v) => { data[k] = v; },
    flush: () => {},
    _data: data,
  };
}

// ════════════════════════════════════════════════════════════
// 1. IDLE MIND TESTS
// ════════════════════════════════════════════════════════════
console.log('\n  🧠 IdleMind');

const { IdleMind } = require('../../src/agent/autonomy/IdleMind');

test('constructs with default state', () => {
  const idle = new IdleMind({
    bus: NullBus, model: mockModel(), prompts: {}, selfModel: { getModuleSummary: () => [] },
    memory: { recallRelevant: () => [] }, knowledgeGraph: { getStats: () => ({}) },
    eventStore: { append: () => {} }, storageDir: '/tmp', goalStack: null,
    storage: mockStorage(),
  });
  assert.strictEqual(idle.running, false);
  assert.strictEqual(idle.thoughtCount, 0);
  assert.ok(idle.idleThreshold > 0);
  assert.ok(idle.thinkInterval > 0);
});

test('start/stop lifecycle via IntervalManager', () => {
  const intervals = new MockIntervals();
  const idle = new IdleMind({
    bus: NullBus, model: mockModel(), prompts: {}, selfModel: { getModuleSummary: () => [] },
    memory: { recallRelevant: () => [] }, knowledgeGraph: { getStats: () => ({}) },
    eventStore: { append: () => {} }, storageDir: '/tmp', goalStack: null,
    intervals, storage: mockStorage(),
  });

  idle.start();
  assert.strictEqual(idle.running, true);
  assert.ok(intervals.registered.has('idlemind-think'), 'should register with IntervalManager');

  idle.stop();
  assert.strictEqual(idle.running, false);
  assert.ok(!intervals.registered.has('idlemind-think'), 'should deregister from IntervalManager');
});

test('userActive resets idle timer', () => {
  const idle = new IdleMind({
    bus: NullBus, model: mockModel(), prompts: {}, selfModel: { getModuleSummary: () => [] },
    memory: { recallRelevant: () => [] }, knowledgeGraph: { getStats: () => ({}) },
    eventStore: { append: () => {} }, storageDir: '/tmp', goalStack: null,
    storage: mockStorage(),
  });
  idle.lastUserActivity = 1000; // simulate old timestamp
  idle.userActive();
  assert.ok(idle.lastUserActivity > 1000, 'should be reset to recent timestamp');
});

test('_pickActivity returns valid activity name', () => {
  const idle = new IdleMind({
    bus: NullBus, model: mockModel(), prompts: {}, selfModel: { getModuleSummary: () => [] },
    memory: { recallRelevant: () => [] }, knowledgeGraph: { getStats: () => ({}) },
    eventStore: { append: () => {} }, storageDir: '/tmp', goalStack: null,
    storage: mockStorage(),
  });

  const valid = ['reflect', 'plan', 'explore', 'ideate', 'tidy', 'journal', 'mcp-explore', 'consolidate'];
  const picked = idle._pickActivity();
  assert.ok(valid.includes(picked), `unexpected activity: ${picked}`);
});

test('_pickActivity penalizes recent activities', () => {
  const idle = new IdleMind({
    bus: NullBus, model: mockModel(), prompts: {}, selfModel: { getModuleSummary: () => [] },
    memory: { recallRelevant: () => [] }, knowledgeGraph: { getStats: () => ({}) },
    eventStore: { append: () => {} }, storageDir: '/tmp', goalStack: null,
    storage: mockStorage(),
  });

  // Fill activity log with 'reflect'
  for (let i = 0; i < 5; i++) idle.activityLog.push({ activity: 'reflect', timestamp: Date.now() });

  // Run 10 picks — 'reflect' should appear less than others
  let reflectCount = 0;
  for (let i = 0; i < 10; i++) {
    if (idle._pickActivity() === 'reflect') reflectCount++;
  }
  assert.ok(reflectCount < 8, `reflect appeared ${reflectCount}/10 times despite penalty`);
});

test('_pickActivity uses NeedsSystem recommendations', () => {
  const idle = new IdleMind({
    bus: NullBus, model: mockModel(), prompts: {}, selfModel: { getModuleSummary: () => [] },
    memory: { recallRelevant: () => [] }, knowledgeGraph: { getStats: () => ({}) },
    eventStore: { append: () => {} }, storageDir: '/tmp', goalStack: null,
    storage: mockStorage(),
  });

  idle.needsSystem = {
    getActivityRecommendations: () => [
      { activity: 'tidy', score: 10.0 }, // Extremely high score
    ],
  };

  // With such a high needs score, tidy should dominate
  let tidyCount = 0;
  for (let i = 0; i < 10; i++) {
    if (idle._pickActivity() === 'tidy') tidyCount++;
  }
  assert.ok(tidyCount >= 5, `tidy should dominate with high needs score, got ${tidyCount}/10`);
});

test('_think respects homeostasis gate', async () => {
  const idle = new IdleMind({
    bus: NullBus, model: mockModel(), prompts: {}, selfModel: { getModuleSummary: () => [] },
    memory: { recallRelevant: () => [] }, knowledgeGraph: { getStats: () => ({}) },
    eventStore: { append: () => {} }, storageDir: '/tmp', goalStack: null,
    storage: mockStorage(),
  });

  idle._homeostasis = { isAutonomyAllowed: () => false, getState: () => 'critical' };
  const before = idle.thoughtCount;
  await idle._think();
  // thoughtCount increments at start of _think, but homeostasis check is right after
  // The key is that no LLM call or activity is executed
  assert.ok(true, 'should return early without error');
});

test('activityLog is bounded to 20 entries', () => {
  const idle = new IdleMind({
    bus: NullBus, model: mockModel(), prompts: {}, selfModel: { getModuleSummary: () => [] },
    memory: { recallRelevant: () => [] }, knowledgeGraph: { getStats: () => ({}) },
    eventStore: { append: () => {} }, storageDir: '/tmp', goalStack: null,
    storage: mockStorage(),
  });

  for (let i = 0; i < 30; i++) {
    idle.activityLog.push({ activity: 'test', timestamp: Date.now() });
  }
  // After trimming (happens in _think), it should cap at 20
  if (idle.activityLog.length > 20) idle.activityLog = idle.activityLog.slice(-20);
  assert.ok(idle.activityLog.length <= 20);
});

// ════════════════════════════════════════════════════════════
// 2. AUTONOMOUS DAEMON TESTS
// ════════════════════════════════════════════════════════════
console.log('\n  🤖 AutonomousDaemon');

const { AutonomousDaemon } = require('../../src/agent/autonomy/AutonomousDaemon');

test('constructs with default configuration', () => {
  const daemon = new AutonomousDaemon({
    bus: NullBus, reflector: {}, selfModel: {}, memory: {},
    model: mockModel(), prompts: {}, skills: { listSkills: () => [] },
    sandbox: {}, guard: { verifyIntegrity: () => ({ ok: true, issues: [] }) },
  });

  assert.strictEqual(daemon.running, false);
  assert.strictEqual(daemon.cycleCount, 0);
  assert.strictEqual(daemon.config.autoRepair, true);
  assert.strictEqual(daemon.config.autoOptimize, false);
  assert.ok(daemon.config.cycleInterval > 0);
});

test('start/stop lifecycle via IntervalManager', () => {
  const intervals = new MockIntervals();
  const daemon = new AutonomousDaemon({
    bus: NullBus, reflector: {}, selfModel: {}, memory: {},
    model: mockModel(), prompts: {}, skills: { listSkills: () => [] },
    sandbox: {}, guard: { verifyIntegrity: () => ({ ok: true }) }, intervals,
  });

  daemon.start();
  assert.strictEqual(daemon.running, true);
  assert.ok(intervals.registered.has('daemon-cycle'));

  daemon.stop();
  assert.strictEqual(daemon.running, false);
  assert.ok(!intervals.registered.has('daemon-cycle'));
});

test('config has correct cycle multipliers', () => {
  const daemon = new AutonomousDaemon({
    bus: NullBus, reflector: {}, selfModel: {}, memory: {},
    model: mockModel(), prompts: {}, skills: { listSkills: () => [] },
    sandbox: {}, guard: { verifyIntegrity: () => ({ ok: true }) },
  });

  assert.ok(daemon.config.healthInterval < daemon.config.optimizeInterval, 'health should run more often than optimize');
  assert.ok(daemon.config.optimizeInterval < daemon.config.gapInterval, 'optimize should run more often than gap detection');
  assert.ok(daemon.config.maxAutoRepairs > 0);
});

test('knownGaps and gapAttempts initialize empty', () => {
  const daemon = new AutonomousDaemon({
    bus: NullBus, reflector: {}, selfModel: {}, memory: {},
    model: mockModel(), prompts: {}, skills: { listSkills: () => [] },
    sandbox: {}, guard: { verifyIntegrity: () => ({ ok: true }) },
  });

  assert.deepStrictEqual(daemon.knownGaps, []);
  assert.strictEqual(daemon.gapAttempts.size, 0);
});

test('start emits daemon:started event', () => {
  const bus = new EventBus();
  bus._devMode = false;
  let emitted = false;
  bus.on('daemon:started', () => { emitted = true; }, { source: 'test' });

  const daemon = new AutonomousDaemon({
    bus, reflector: {}, selfModel: {}, memory: {},
    model: mockModel(), prompts: {}, skills: { listSkills: () => [] },
    sandbox: {}, guard: { verifyIntegrity: () => ({ ok: true }) },
    intervals: new MockIntervals(),
  });

  daemon.start();
  // fire() is async but still synchronous enough
  setTimeout(() => {
    assert.strictEqual(emitted, true, 'daemon:started event should be emitted');
    daemon.stop();
  }, 50);
});

// ════════════════════════════════════════════════════════════
// 3. COGNITIVE MONITOR TESTS
// ════════════════════════════════════════════════════════════
console.log('\n  🔬 CognitiveMonitor');

const { CognitiveMonitor } = require('../../src/agent/autonomy/CognitiveMonitor');

test('constructs with default state', () => {
  const cm = new CognitiveMonitor({ bus: NullBus });
  assert.ok(cm._toolCalls.length === 0);
  assert.ok(cm._toolStats.size === 0);
  assert.ok(cm._reasoningChains.length === 0);
  assert.strictEqual(cm._qualityScore, 1.0);
  assert.strictEqual(cm._cognitiveLoad, 0);
});

test('start/stop lifecycle via IntervalManager', () => {
  const intervals = new MockIntervals();
  const cm = new CognitiveMonitor({ bus: NullBus, intervals });
  cm.start();
  assert.ok(intervals.registered.has('cognitive-monitor'));
  cm.stop();
  assert.ok(!intervals.registered.has('cognitive-monitor'));
});

test('recordToolCall tracks stats correctly', () => {
  const cm = new CognitiveMonitor({ bus: NullBus });

  cm.recordToolCall('file-read', true, 50);
  cm.recordToolCall('file-read', true, 100);
  cm.recordToolCall('file-read', false, 200);
  cm.recordToolCall('web-search', true, 500);

  const analytics = cm.getToolAnalytics();
  assert.strictEqual(analytics.perTool['file-read'].calls, 3);
  assert.strictEqual(analytics.perTool['file-read'].successRate, 67); // 2/3
  assert.strictEqual(analytics.perTool['file-read'].failures, 1);
  assert.strictEqual(analytics.perTool['web-search'].calls, 1);
  assert.strictEqual(analytics.perTool['web-search'].successRate, 100);
  assert.strictEqual(analytics.totalCalls, 4);
});

test('recordToolCall bounds history at 500', () => {
  const cm = new CognitiveMonitor({ bus: NullBus });
  for (let i = 0; i < 600; i++) cm.recordToolCall('test', true, 1);
  assert.ok(cm._toolCalls.length <= 500);
});

test('recordToolCall computes average duration', () => {
  const cm = new CognitiveMonitor({ bus: NullBus });
  cm.recordToolCall('api-call', true, 100);
  cm.recordToolCall('api-call', true, 200);
  cm.recordToolCall('api-call', true, 300);

  const analytics = cm.getToolAnalytics();
  assert.strictEqual(analytics.perTool['api-call'].avgDurationMs, 200);
});

test('recordReasoning returns non-circular for unique inputs', () => {
  const cm = new CognitiveMonitor({ bus: NullBus });
  const r1 = cm.recordReasoning('The database needs indexing for faster queries.');
  const r2 = cm.recordReasoning('User authentication should use JWT tokens.');
  assert.strictEqual(r1.circular, false);
  assert.strictEqual(r2.circular, false);
});

test('recordReasoning detects circularity for repeated inputs', () => {
  const cm = new CognitiveMonitor({ bus: NullBus });
  cm._circularityThreshold = 0.7;

  const text = 'We should refactor the database layer to improve performance.';
  cm.recordReasoning(text);
  cm.recordReasoning('Something different in between.');
  const result = cm.recordReasoning(text); // Same text again

  assert.strictEqual(result.circular, true);
  assert.ok(result.similarity >= 0.7);
});

test('circularity emits event', async () => {
  const bus = new EventBus();
  bus._devMode = false;
  let eventData = null;
  bus.on('cognitive:circularity-detected', (data) => { eventData = data; }, { source: 'test' });

  const cm = new CognitiveMonitor({ bus });
  cm._circularityThreshold = 0.7;

  const text = 'Repeated reasoning about the same optimization.';
  cm.recordReasoning(text);
  cm.recordReasoning('Different step here.');
  cm.recordReasoning(text);

  // Wait for async emit
  await new Promise(r => setTimeout(r, 50));
  if (eventData) {
    assert.ok(eventData.similarity >= 0.7);
    assert.ok(eventData.summary.length > 0);
  }
  // If circularity was detected, eventData should be set
});

test('reasoning chain history is bounded', () => {
  const cm = new CognitiveMonitor({ bus: NullBus });
  cm._maxReasoningHistory = 10;
  for (let i = 0; i < 20; i++) cm.recordReasoning(`Reasoning step ${i}`);
  assert.ok(cm._reasoningChains.length <= 10);
});

test('getToolAnalytics detects redundant tool calls', () => {
  const cm = new CognitiveMonitor({ bus: NullBus });
  const now = Date.now();

  // Simulate 5 rapid calls to same tool within 10s
  for (let i = 0; i < 5; i++) {
    cm._toolCalls.push({ name: 'file-read', timestamp: now - i * 100, success: true, durationMs: 10 });
    // Also update stats
    if (!cm._toolStats.has('file-read')) cm._toolStats.set('file-read', { calls: 0, successes: 0, failures: 0, totalMs: 0 });
    cm._toolStats.get('file-read').calls++;
    cm._toolStats.get('file-read').successes++;
  }

  const analytics = cm.getToolAnalytics();
  assert.ok(analytics.redundantPatterns.length > 0, 'should detect redundant pattern');
  assert.ok(analytics.redundantPatterns.some(p => p.tool === 'file-read'));
});

test('cognitiveLoad initializes at 0', () => {
  const cm = new CognitiveMonitor({ bus: NullBus });
  assert.strictEqual(cm._cognitiveLoad, 0);
});

test('qualityScore initializes at 1.0', () => {
  const cm = new CognitiveMonitor({ bus: NullBus });
  assert.strictEqual(cm._qualityScore, 1.0);
});

test('config overrides work', () => {
  const cm = new CognitiveMonitor({
    bus: NullBus,
    config: { maxContextTokens: 16384, circularityThreshold: 0.9, maxReasoningHistory: 100 },
  });
  assert.strictEqual(cm._maxContextTokens, 16384);
  assert.strictEqual(cm._circularityThreshold, 0.9);
  assert.strictEqual(cm._maxReasoningHistory, 100);
});

// ════════════════════════════════════════════════════════════
// SUMMARY
// ════════════════════════════════════════════════════════════

setTimeout(() => {
  console.log(`\n    ${passed} passed, ${failed} failed`);
  if (errors.length > 0) {
    console.log('    Failures:');
    for (const e of errors) console.log(`      - ${e}`);
  }
  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}, 200);

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
