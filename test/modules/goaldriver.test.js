// Test: GoalDriver.js — boot pickup, pursuit selection, queue mgmt
const path = require('path');
const fs = require('fs');
const os = require('os');

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => {
        passed++; console.log(`    ✅ ${name}`);
      }).catch(err => {
        failed++; failures.push({ name, error: err.message });
        console.log(`    ❌ ${name}: ${err.message}`);
      });
    }
    passed++; console.log(`    ✅ ${name}`);
  } catch (err) {
    failed++; failures.push({ name, error: err.message });
    console.log(`    ❌ ${name}: ${err.message}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }

const tmpDir = path.join(os.tmpdir(), 'genesis-test-driver-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });

const { GoalDriver } = require('../../src/agent/agency/GoalDriver');
const { EventBus } = require('../../src/agent/core/EventBus');

console.log('\n  🚦 GoalDriver');

// ────────────────────────────────────────────────────────────
// Mocks
// ────────────────────────────────────────────────────────────
function makeStack(initialGoals = []) {
  const goals = [...initialGoals];
  let _id = 1;
  return {
    goals,
    getById(id) { return goals.find(g => g.id === id); },
    addGoal: async (description, source, priority, opts = {}) => {
      const goal = {
        id: `g_${_id++}`,
        description, source, priority,
        status: 'active',
        currentStep: 0,
        steps: [],
        results: [],
        blockedBy: [],
        childIds: [],
        parentId: null,
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        ...opts,
      };
      goals.push(goal);
      return goal;
    },
    updateGoal: async (id, patch) => {
      const g = goals.find(x => x.id === id);
      if (g) Object.assign(g, patch);
    },
    completeGoal: (id) => {
      const g = goals.find(x => x.id === id);
      if (!g || g.status === 'completed' || g.status === 'failed' || g.status === 'abandoned') return false;
      g.status = 'completed';
      g.completedAt = new Date().toISOString();
      return true;
    },
  };
}

function makeSettings(values = {}) {
  return {
    get: (k) => values[k],
    set: async (k, v) => { values[k] = v; },
  };
}

function makeAgentLoop() {
  const calls = [];
  return {
    pursue: async (input, _onProgress) => {
      calls.push(input);
      return { success: true };
    },
    stop: () => {},
    _calls: calls,
  };
}

// ────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────
async function runTests() {
  // ── Boot Pickup ───────────────────────────────────────────
  await test('boot pickup: regular user-goal mid-pursuit emits ui:resume-prompt in ask mode', async () => {
    const bus = new EventBus({ verbose: false });
    const stack = makeStack([{
      id: 'g1', description: 'Test', source: 'user', priority: 'high',
      status: 'active', currentStep: 3, steps: [{}, {}, {}, {}, {}],
      blockedBy: [], created: new Date(Date.now() - 10000).toISOString(),
      updated: new Date().toISOString(),
    }]);
    const settings = makeSettings({ 'agency.autoResumeGoals': 'ask' });
    const driver = new GoalDriver({
      bus, goalStack: stack, goalPersistence: {}, eventStore: {}, settings,
    });
    driver.agentLoop = makeAgentLoop();

    let promptSeen = null;
    bus.on('ui:resume-prompt', (data) => { promptSeen = data; });

    await driver.asyncLoad();
    bus.emit('boot:complete', {});
    await new Promise(r => setTimeout(r, 10));

    assert(promptSeen, 'Resume prompt was not emitted');
    assert(promptSeen.goalId === 'g1', 'Wrong goalId in prompt');
    assert(promptSeen.reason === 'mid-pursuit', 'Wrong reason');
    driver.stop();
  });

  await test('boot pickup: blocked user-goal with sub-goals → reason=blocked-with-subgoals', async () => {
    const bus = new EventBus({ verbose: false });
    const stack = makeStack([
      { id: 'g_user', description: 'User goal', source: 'user', priority: 'high',
        status: 'blocked', currentStep: 1, steps: [{}, {}],
        blockedBy: ['g_sub'], created: new Date(Date.now() - 20000).toISOString() },
      { id: 'g_sub', description: 'Sub goal', source: 'subplan', priority: 'high',
        status: 'active', currentStep: 1, steps: [{}, {}],
        blockedBy: [], created: new Date(Date.now() - 5000).toISOString() },
    ]);
    const settings = makeSettings({ 'agency.autoResumeGoals': 'ask' });
    const driver = new GoalDriver({
      bus, goalStack: stack, goalPersistence: {}, eventStore: {}, settings,
    });
    driver.agentLoop = makeAgentLoop();

    let promptSeen = null;
    bus.on('ui:resume-prompt', (data) => { promptSeen = data; });

    await driver.asyncLoad();
    bus.emit('boot:complete', {});
    await new Promise(r => setTimeout(r, 10));

    assert(promptSeen, 'Resume prompt was not emitted for blocked goal');
    assert(promptSeen.goalId === 'g_user', 'Should prompt for user-goal, not sub-goal');
    assert(promptSeen.reason === 'blocked-with-subgoals', 'Wrong reason');
    driver.stop();
  });

  await test('boot pickup: autonomous goals (idle-mind, synthesizer) NOT resumed', async () => {
    const bus = new EventBus({ verbose: false });
    const stack = makeStack([
      { id: 'g_auto', description: 'Idle work', source: 'autonomous',
        priority: 'medium', status: 'active', currentStep: 2, steps: [{}, {}, {}],
        blockedBy: [], created: new Date().toISOString() },
    ]);
    const settings = makeSettings({ 'agency.autoResumeGoals': 'ask' });
    const driver = new GoalDriver({
      bus, goalStack: stack, goalPersistence: {}, eventStore: {}, settings,
    });
    driver.agentLoop = makeAgentLoop();

    let promptSeen = false;
    bus.on('ui:resume-prompt', () => { promptSeen = true; });

    await driver.asyncLoad();
    bus.emit('boot:complete', {});
    await new Promise(r => setTimeout(r, 10));

    assert(!promptSeen, 'Should not prompt for autonomous goals');
    driver.stop();
  });

  // v7.4.5.1: Fresh user-goal that crashed before its first step still
  // gets surfaced — Garrus's live-test scenario.
  await test('boot pickup: fresh user-goal at currentStep=0 still gets prompted (24h window)', async () => {
    const bus = new EventBus({ verbose: false });
    const stack = makeStack([
      { id: 'g_fresh', description: 'Fresh goal, never started',
        source: 'user', priority: 'high', status: 'active',
        currentStep: 0, steps: [{}, {}, {}, {}],
        blockedBy: [], created: new Date(Date.now() - 60_000).toISOString() },  // 1min ago
    ]);
    const settings = makeSettings({ 'agency.autoResumeGoals': 'ask' });
    const driver = new GoalDriver({
      bus, goalStack: stack, goalPersistence: {}, eventStore: {}, settings,
    });
    driver.agentLoop = makeAgentLoop();

    let promptSeen = null;
    bus.on('ui:resume-prompt', (data) => { promptSeen = data; });

    await driver.asyncLoad();
    bus.emit('boot:complete', {});
    await new Promise(r => setTimeout(r, 10));

    assert(promptSeen, 'Fresh user-goal at step 0 should prompt');
    assert(promptSeen.goalId === 'g_fresh', 'Wrong goalId in prompt');
    assert(promptSeen.reason === 'fresh-not-started',
      `Reason should be 'fresh-not-started', got '${promptSeen.reason}'`);
    driver.stop();
  });

  // v7.4.5.1: Old user-goal that has been sitting at step 0 for days
  // is NOT zombie-resumed (zombie protection).
  await test('boot pickup: old user-goal at currentStep=0 (>24h) is NOT prompted', async () => {
    const bus = new EventBus({ verbose: false });
    const stack = makeStack([
      { id: 'g_old', description: 'Forgotten goal',
        source: 'user', priority: 'high', status: 'active',
        currentStep: 0, steps: [{}, {}, {}],
        blockedBy: [], created: new Date(Date.now() - 48 * 60 * 60_000).toISOString() },  // 48h ago
    ]);
    const settings = makeSettings({ 'agency.autoResumeGoals': 'ask' });
    const driver = new GoalDriver({
      bus, goalStack: stack, goalPersistence: {}, eventStore: {}, settings,
    });
    driver.agentLoop = makeAgentLoop();

    let promptSeen = false;
    bus.on('ui:resume-prompt', () => { promptSeen = true; });

    await driver.asyncLoad();
    bus.emit('boot:complete', {});
    await new Promise(r => setTimeout(r, 10));

    assert(!promptSeen, 'Old never-started user-goal should not prompt (zombie protection)');
    driver.stop();
  });

  await test('autoResumeGoals=always: emits goal:resumed-auto, no UI prompt', async () => {
    const bus = new EventBus({ verbose: false });
    const stack = makeStack([
      { id: 'g1', description: 'Auto-resume', source: 'user', priority: 'high',
        status: 'active', currentStep: 2, steps: [{}, {}, {}],
        blockedBy: [], created: new Date().toISOString() },
    ]);
    const settings = makeSettings({ 'agency.autoResumeGoals': 'always' });
    const driver = new GoalDriver({
      bus, goalStack: stack, goalPersistence: {}, eventStore: {}, settings,
    });
    driver.agentLoop = makeAgentLoop();

    let autoResumed = null;
    let prompted = false;
    bus.on('goal:resumed-auto', (data) => { autoResumed = data; });
    bus.on('ui:resume-prompt', () => { prompted = true; });

    await driver.asyncLoad();
    bus.emit('boot:complete', {});
    await new Promise(r => setTimeout(r, 10));

    assert(autoResumed, 'goal:resumed-auto not emitted');
    assert(autoResumed.goalIds.includes('g1'), 'Wrong goalId in auto-resume');
    assert(!prompted, 'Should not prompt in always-mode');
    driver.stop();
  });

  // ── Selection logic ──────────────────────────────────────
  await test('_selectNext: high priority chosen over medium', async () => {
    const bus = new EventBus({ verbose: false });
    const stack = makeStack([
      { id: 'g_med', description: 'Medium', source: 'user', priority: 'medium',
        status: 'active', currentStep: 0, blockedBy: [],
        created: new Date(Date.now() - 10000).toISOString() },
      { id: 'g_high', description: 'High', source: 'user', priority: 'high',
        status: 'active', currentStep: 0, blockedBy: [],
        created: new Date().toISOString() },
    ]);
    const settings = makeSettings({});
    const driver = new GoalDriver({
      bus, goalStack: stack, goalPersistence: {}, eventStore: {}, settings,
    });
    const next = driver._selectNext();
    assert(next === 'g_high', `Should pick high-priority, got ${next}`);
  });

  await test('_selectNext: same priority → older first (age asc)', async () => {
    const bus = new EventBus({ verbose: false });
    const stack = makeStack([
      { id: 'g_new', description: 'New', source: 'user', priority: 'high',
        status: 'active', currentStep: 0, blockedBy: [],
        created: new Date().toISOString() },
      { id: 'g_old', description: 'Old', source: 'user', priority: 'high',
        status: 'active', currentStep: 0, blockedBy: [],
        created: new Date(Date.now() - 60000).toISOString() },
    ]);
    const settings = makeSettings({});
    const driver = new GoalDriver({
      bus, goalStack: stack, goalPersistence: {}, eventStore: {}, settings,
    });
    const next = driver._selectNext();
    assert(next === 'g_old', `Should pick older, got ${next}`);
  });

  await test('_selectNext: blocked goals not picked', async () => {
    const bus = new EventBus({ verbose: false });
    const stack = makeStack([
      { id: 'g_b', description: 'Blocked', source: 'user', priority: 'high',
        status: 'blocked', currentStep: 1, blockedBy: ['x'],
        created: new Date().toISOString() },
    ]);
    const settings = makeSettings({});
    const driver = new GoalDriver({
      bus, goalStack: stack, goalPersistence: {}, eventStore: {}, settings,
    });
    const next = driver._selectNext();
    assert(next === null, 'Blocked goal should not be selected');
  });

  // ── Pursuit + concurrency ────────────────────────────────
  await test('pursuit calls agentLoop.pursue with goal object (not string)', async () => {
    const bus = new EventBus({ verbose: false });
    const stack = makeStack([
      { id: 'g1', description: 'Pursue me', source: 'user', priority: 'high',
        status: 'active', currentStep: 0, blockedBy: [],
        created: new Date().toISOString() },
    ]);
    const settings = makeSettings({ 'agency.autoResumeGoals': 'always' });
    const driver = new GoalDriver({
      bus, goalStack: stack, goalPersistence: {}, eventStore: {}, settings,
    });
    const al = makeAgentLoop();
    driver.agentLoop = al;

    await driver.asyncLoad();
    bus.fire('boot:complete', {});
    await new Promise(r => setTimeout(r, 10));
    driver._scanAndMaybePursue();
    await new Promise(r => setTimeout(r, 10));

    assert(al._calls.length === 1, `Should call pursue once, got ${al._calls.length}`);
    assert(typeof al._calls[0] === 'object', 'Should pass goal object, not string');
    assert(al._calls[0].id === 'g1', 'Wrong goal passed');
    driver.stop();
  });

  await test('concurrency: never two pursuits for same goal', async () => {
    const bus = new EventBus({ verbose: false });
    const stack = makeStack([
      { id: 'g1', description: 'Race', source: 'user', priority: 'high',
        status: 'active', currentStep: 0, blockedBy: [],
        created: new Date().toISOString() },
    ]);
    const settings = makeSettings({ 'agency.autoResumeGoals': 'always' });
    const driver = new GoalDriver({
      bus, goalStack: stack, goalPersistence: {}, eventStore: {}, settings,
    });
    // AgentLoop pursue resolves slowly so concurrent attempt overlap
    let pursueResolve;
    const al = {
      pursue: () => new Promise(r => { pursueResolve = r; }),
      stop: () => {},
    };
    driver.agentLoop = al;

    await driver.asyncLoad();
    bus.fire('boot:complete', {});
    await new Promise(r => setTimeout(r, 10));
    driver._scanAndMaybePursue();
    driver._scanAndMaybePursue();
    driver._scanAndMaybePursue();
    await new Promise(r => setTimeout(r, 5));

    assert(driver._currentlyPursuing.size === 1,
      `Should track exactly one active pursuit, got ${driver._currentlyPursuing.size}`);
    pursueResolve({ success: true });
    driver.stop();
  });

  // ── isResponding (for HealthMonitor probe) ───────────────
  await test('isResponding: true when queue empty', () => {
    const bus = new EventBus({ verbose: false });
    const stack = makeStack([]);
    const settings = makeSettings({});
    const driver = new GoalDriver({
      bus, goalStack: stack, goalPersistence: {}, eventStore: {}, settings,
    });
    driver._running = true;
    assert(driver.isResponding(), 'Empty queue should be responsive');
  });

  await test('isResponding: false when pursueable goals + idle past warn threshold', () => {
    const bus = new EventBus({ verbose: false });
    const stack = makeStack([
      { id: 'g1', description: 'Stuck', source: 'user', priority: 'high',
        status: 'active', currentStep: 0, blockedBy: [],
        created: new Date().toISOString() },
    ]);
    const settings = makeSettings({});
    const driver = new GoalDriver({
      bus, goalStack: stack, goalPersistence: {}, eventStore: {}, settings,
      config: { inactivityWarnMs: 100 },
    });
    driver._running = true;
    driver.lastActivityAt = Date.now() - 500;
    assert(!driver.isResponding(), 'Stuck driver should report non-responsive');
  });

  // ── Resume decision ──────────────────────────────────────
  await test('ui:resume-decision discard cascades to sub-goals', async () => {
    const bus = new EventBus({ verbose: false });
    const stack = makeStack([
      { id: 'g_user', description: 'User', source: 'user', priority: 'high',
        status: 'blocked', currentStep: 1, blockedBy: ['g_sub'],
        created: new Date().toISOString() },
      { id: 'g_sub', description: 'Sub', source: 'subplan', priority: 'high',
        status: 'active', currentStep: 1, blockedBy: [],
        created: new Date().toISOString() },
    ]);
    const settings = makeSettings({ 'agency.autoResumeGoals': 'ask' });
    const driver = new GoalDriver({
      bus, goalStack: stack, goalPersistence: {}, eventStore: {}, settings,
    });
    driver.agentLoop = makeAgentLoop();

    await driver.asyncLoad();
    bus.emit('boot:complete', {});
    await new Promise(r => setTimeout(r, 10));

    let discardedSeen = null;
    bus.on('goal:discarded', (data) => { discardedSeen = data; });

    bus.emit('ui:resume-decision', { goalId: 'g_user', decision: 'discard' });
    await new Promise(r => setTimeout(r, 10));

    assert(discardedSeen, 'goal:discarded not emitted');
    assert(discardedSeen.ids.includes('g_user') && discardedSeen.ids.includes('g_sub'),
      'Discard should cascade to sub-goal');
    const userGoal = stack.goals.find(g => g.id === 'g_user');
    const subGoal = stack.goals.find(g => g.id === 'g_sub');
    assert(userGoal.status === 'abandoned', 'User goal should be abandoned');
    assert(subGoal.status === 'abandoned', 'Sub goal should be abandoned');
    driver.stop();
  });

  await test('ui:resume-decision rememberAs persists to settings', async () => {
    const bus = new EventBus({ verbose: false });
    const stack = makeStack([
      { id: 'g1', description: 'X', source: 'user', priority: 'high',
        status: 'active', currentStep: 1, blockedBy: [],
        created: new Date().toISOString() },
    ]);
    const settingsValues = { 'agency.autoResumeGoals': 'ask' };
    const settings = makeSettings(settingsValues);
    const driver = new GoalDriver({
      bus, goalStack: stack, goalPersistence: {}, eventStore: {}, settings,
    });
    driver.agentLoop = makeAgentLoop();

    await driver.asyncLoad();
    bus.emit('boot:complete', {});
    await new Promise(r => setTimeout(r, 10));

    bus.emit('ui:resume-decision', {
      goalId: 'g1', decision: 'continue', rememberAs: 'always',
    });
    await new Promise(r => setTimeout(r, 10));

    assert(settingsValues['agency.autoResumeGoals'] === 'always',
      `Setting should be 'always', got '${settingsValues['agency.autoResumeGoals']}'`);
    driver.stop();
  });

  // ── requestPursuit API ───────────────────────────────────
  await test('requestPursuit: rejects unknown goal', async () => {
    const bus = new EventBus({ verbose: false });
    const stack = makeStack([]);
    const settings = makeSettings({});
    const driver = new GoalDriver({
      bus, goalStack: stack, goalPersistence: {}, eventStore: {}, settings,
    });
    await driver.asyncLoad();
    const r = await driver.requestPursuit('nonexistent');
    assert(!r.accepted && r.reason === 'goal-not-found', `Got ${JSON.stringify(r)}`);
    driver.stop();
  });

  await test('requestPursuit: rejects already-pursuing', async () => {
    const bus = new EventBus({ verbose: false });
    const stack = makeStack([
      { id: 'g1', description: 'X', source: 'user', priority: 'high',
        status: 'active', currentStep: 0, blockedBy: [],
        created: new Date().toISOString() },
    ]);
    const settings = makeSettings({});
    const driver = new GoalDriver({
      bus, goalStack: stack, goalPersistence: {}, eventStore: {}, settings,
    });
    driver.agentLoop = { pursue: () => new Promise(() => {}), stop: () => {} };
    await driver.asyncLoad();
    driver._currentlyPursuing.add('g1');
    const r = await driver.requestPursuit('g1');
    assert(!r.accepted && r.reason === 'already-pursuing', `Got ${JSON.stringify(r)}`);
    driver.stop();
  });
}

runTests().then(() => {
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('  Failures:', JSON.stringify(failures, null, 2));
    process.exit(1);
  }
}).catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
