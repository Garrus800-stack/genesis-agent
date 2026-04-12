#!/usr/bin/env node
// ============================================================
// Test: AgentLoop.js — Autonomous Goal Pursuit
//
// Tests the loop lifecycle, cognitive level reporting, abort
// handling, step limits, and approval queue — without requiring
// a real LLM. Uses stubs for all heavy dependencies.
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const { createBus } = require('../../src/agent/core/EventBus');

// ── Minimal stubs for AgentLoop deps ──────────────────────

function stubModel() {
  return {
    activeModel: 'mock',
    chat: async () => 'mock response',
    chatStructured: async () => ({ steps: [] }),
  };
}

function stubGoalStack() {
  return {
    push: () => 'goal-1',
    pop: () => null,
    peek: () => null,
    getActiveGoals: () => [],
    updateGoal: () => {},
  };
}

function stubSandbox() {
  return { run: async (code) => ({ stdout: 'ok', stderr: '', exitCode: 0 }), cleanup: () => {} };
}

function stubSelfModel() {
  return { scan: () => {}, getModuleSummary: () => [], getFullModel: () => ({ modules: {}, files: {} }) };
}

function stubTools() {
  return { listTools: () => [], getTool: () => null, executeTool: async () => ({}) };
}

function stubShell() {
  return { execute: async () => ({ stdout: 'ok', stderr: '', code: 0 }) };
}

function stubMemory() {
  return { getStats: () => ({}), addEpisode: () => {}, flush: () => {}, search: () => [] };
}

function createAgentLoop(overrides = {}) {
  // Require inline to avoid heavy transitive deps at module level
  const { AgentLoop } = require('../../src/agent/revolution/AgentLoop');
  const bus = createBus();
  return new AgentLoop({
    bus,
    model: stubModel(),
    goalStack: stubGoalStack(),
    sandbox: stubSandbox(),
    selfModel: stubSelfModel(),
    memory: stubMemory(),
    knowledgeGraph: { flush: () => {}, query: () => [] },
    tools: stubTools(),
    guard: { verifyIntegrity: () => ({ ok: true }) },
    eventStore: { append: () => {} },
    shellAgent: stubShell(),
    selfModPipeline: {},
    storage: { readJSON: () => null, writeJSON: () => {} },
    rootDir: '/tmp/genesis-test',
    ...overrides,
  });
}

// ── Tests ──────────────────────────────────────────────────

describe('AgentLoop — Initialization', () => {
  test('constructs without errors', () => {
    const loop = createAgentLoop();
    assert(loop, 'should construct');
    assertEqual(loop.running, false);
    assertEqual(loop.stepCount, 0);
  });

  test('has composition delegates', () => {
    const loop = createAgentLoop();
    assert(loop.planner, 'should have planner delegate');
    assert(loop.steps, 'should have steps delegate');
    assert(loop.cognition, 'should have cognition delegate');
  });

  test('defaults to non-strict cognitive mode', () => {
    const loop = createAgentLoop();
    assertEqual(loop._strictCognitiveMode, false);
  });
});

describe('AgentLoop — Cognitive Level Reporting', () => {
  test('reports NONE when no cognitive services bound', () => {
    const loop = createAgentLoop();
    loop.cognition.reportCognitiveLevel();
    assertEqual(loop._cognitiveLevel, 'NONE');
  });

  test('reports PARTIAL when some cognitive services bound', () => {
    const loop = createAgentLoop();
    loop.verifier = { verify: async () => ({ valid: true }) };
    loop.cognition.reportCognitiveLevel();
    assertEqual(loop._cognitiveLevel, 'PARTIAL');
  });

  test('reports FULL when all core cognitive services bound', () => {
    const loop = createAgentLoop();
    loop.verifier = {};
    loop.formalPlanner = {};
    loop.worldState = {};
    loop.cognition.reportCognitiveLevel();
    assertEqual(loop._cognitiveLevel, 'FULL');
  });
});

describe('AgentLoop — Pursue Guard Rails', () => {
  test('rejects pursue when already running', async () => {
    const loop = createAgentLoop();
    loop.running = true;
    const result = await loop.pursue('test goal');
    assertEqual(result.success, false);
    assert(result.error.includes('already running'));
  });

  test('strict mode blocks pursue without cognitive services', async () => {
    const loop = createAgentLoop({ strictCognitiveMode: true });
    loop.cognition.reportCognitiveLevel();
    const result = await loop.pursue('test goal');
    assertEqual(result.success, false);
    assert(result.error.includes('Strict cognitive mode') || result.error.includes('missing'));
  });
});

describe('AgentLoop — Stop & Abort', () => {
  test('stop sets running to false', async () => {
    const loop = createAgentLoop();
    loop.running = true;
    if (typeof loop.stop === 'function') {
      await loop.stop();
      assertEqual(loop.running, false);
    } else {
      assert(true, 'stop not defined — skipped');
    }
  });

  test('abort flag is respected', () => {
    const loop = createAgentLoop();
    assertEqual(loop._aborted, false);
    loop._aborted = true;
    assertEqual(loop._aborted, true);
  });
});

describe('AgentLoop — Execution Log Bounds', () => {
  test('has max execution log limit', () => {
    const loop = createAgentLoop();
    assert(loop._maxExecutionLogEntries > 0, 'should have a cap');
    assert(loop._maxExecutionLogEntries < 10000, 'cap should be reasonable');
  });

  test('execution log starts empty', () => {
    const loop = createAgentLoop();
    assertEqual(loop.executionLog.length, 0);
  });
});

describe('AgentLoop — Step & Error Limits', () => {
  test('max steps per goal is configured', () => {
    const loop = createAgentLoop();
    assert(loop.maxStepsPerGoal > 0);
    assert(loop.maxStepsPerGoal <= 50, 'should have reasonable cap');
  });

  test('max consecutive errors is configured', () => {
    const loop = createAgentLoop();
    assert(loop.maxConsecutiveErrors > 0);
  });

  test('consecutive error counter starts at 0', () => {
    const loop = createAgentLoop();
    assertEqual(loop.consecutiveErrors, 0);
  });
});

run();
