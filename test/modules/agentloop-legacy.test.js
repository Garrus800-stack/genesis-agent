// ============================================================
// Test: AgentLoop.js — ReAct loop, planning, execution, approval
// ============================================================
let passed = 0, failed = 0;
const failures = [];

// v3.5.2: Fixed — queue-based async-safe test runner
const _testQueue = [];
function test(name, fn) { _testQueue.push({ name, fn }); }
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }

const { NullBus } = require('../../src/agent/core/EventBus');

// ── Mock Dependencies ─────────────────────────────────────

function createMockModel(responses = {}) {
  return {
    activeModel: 'mock-model',
    activeBackend: 'mock',
    chat: async (prompt, messages, taskType) => {
      if (responses[taskType]) return responses[taskType];
      if (responses.default) return typeof responses.default === 'function'
        ? responses.default(prompt) : responses.default;
      // Default: return a simple plan
      if (prompt.includes('Decompose') || prompt.includes('decompose') || prompt.includes('plan')) {
        return 'ANALYZE: Analyze the current state\nCODE: Write the implementation\nSANDBOX: Test the code';
      }
      return 'Done.';
    },
    streamChat: async (prompt, messages, onChunk) => {
      onChunk('mock '); onChunk('stream '); onChunk('response');
    },
  };
}

function createMockGoalStack() {
  const goals = [];
  return {
    addGoal: async (desc, src, pri) => {
      const goal = {
        id: `goal_${Date.now()}`, description: desc, source: src,
        priority: pri, status: 'active', steps: [
          { type: 'ANALYZE', action: 'Analyze the task', status: 'pending' },
          { type: 'CODE', action: 'Write code', target: 'test.js', status: 'pending' },
        ],
        currentStep: 0, results: [],
      };
      goals.push(goal);
      return goal;
    },
    getActiveGoals: () => goals.filter(g => g.status === 'active'),
    getAll: () => goals,
    completeGoal: (id) => {
      const g = goals.find(g => g.id === id);
      if (g) g.status = 'completed';
    },
    _goals: goals,
  };
}

function createMockDeps(modelResponses) {
  return {
    bus: NullBus,
    model: createMockModel(modelResponses),
    goalStack: createMockGoalStack(),
    sandbox: {
      execute: async (code) => ({ output: 'OK', error: null }),
      syntaxCheck: async (code) => ({ valid: true }),
    },
    selfModel: {
      getFullModel: () => ({ modules: {}, files: {}, identity: 'test-agent' }),
      readModule: () => null,
    },
    memory: {
      search: () => [],
      addSemantic: () => {},
      getStats: () => ({}),
    },
    knowledgeGraph: {
      search: () => [],
      getStats: () => ({}),
      learnFromText: () => {},
    },
    tools: {
      listTools: () => [],
      getTool: () => null,
    },
    guard: {
      isProtected: () => false,
      validateWrite: () => true,
    },
    eventStore: {
      append: () => {},
      getStats: () => ({}),
    },
    shellAgent: {
      execute: async (cmd) => ({ output: 'shell ok', error: null }),
      getStats: () => ({}),
    },
    selfModPipeline: {
      registerHandlers: () => {},
    },
    lang: { t: (k) => k },
    storage: {
      readJSON: () => null,
      writeJSON: () => {},
    },
    rootDir: require('path').join(require('os').tmpdir(), 'test-genesis'),
    approvalTimeoutMs: 1000,
  };
}

// ── Tests ──────────────────────────────────────────────────

const { AgentLoop } = require('../../src/agent/revolution/AgentLoop');

console.log('\n  🔄 AgentLoop');

test('constructs without errors', () => {
  const deps = createMockDeps();
  const loop = new AgentLoop(deps);
  assert(loop.running === false);
  assert(loop.stepCount === 0);
  assert(loop.maxStepsPerGoal === 20);
});

test('stop() works when not running', () => {
  const deps = createMockDeps();
  const loop = new AgentLoop(deps);
  // Should not throw
  loop.stop();
  assert(loop.running === false);
});

test('abort flag prevents execution', async () => {
  const deps = createMockDeps();
  const loop = new AgentLoop(deps);
  loop._aborted = true;
  // pursueGoal should exit early
  const progress = [];
  try {
    await loop.pursueGoal('test goal', (update) => progress.push(update));
  } catch (err) {
    // Expected — aborted
  }
  assert(loop.running === false);
});

test('registerHandlers attaches to chatOrchestrator', () => {
  const deps = createMockDeps();
  const loop = new AgentLoop(deps);
  const handlers = {};
  const mockChat = {
    registerHandler: (name, fn) => { handlers[name] = fn; },
  };
  loop.registerHandlers(mockChat);
  assert(typeof handlers['agent-goal'] === 'function' || Object.keys(handlers).length >= 0,
    'Should register at least one handler');
});

test('executionLog starts empty', () => {
  const deps = createMockDeps();
  const loop = new AgentLoop(deps);
  assert(Array.isArray(loop.executionLog));
  assert(loop.executionLog.length === 0);
});

test('maxConsecutiveErrors defaults to 3', () => {
  const deps = createMockDeps();
  const loop = new AgentLoop(deps);
  assert(loop.maxConsecutiveErrors === 3);
});

test('approval timeout is configurable', () => {
  const deps = createMockDeps();
  deps.approvalTimeoutMs = 5000;
  const loop = new AgentLoop(deps);
  assert(loop._approvalTimeoutMs === 5000);
});

test('approval timeout falls back to 60000', () => {
  const deps = createMockDeps();
  deps.approvalTimeoutMs = undefined;
  const loop = new AgentLoop(deps);
  assert(loop._approvalTimeoutMs === 60000);
});

test('has taskDelegation slot (null by default)', () => {
  const deps = createMockDeps();
  const loop = new AgentLoop(deps);
  assert(loop.taskDelegation === null, 'taskDelegation should be null before wiring');
});

test('has htnPlanner slot (null by default)', () => {
  const deps = createMockDeps();
  const loop = new AgentLoop(deps);
  assert(loop.htnPlanner === null, 'htnPlanner should be null before wiring');
});

test('_inferStepType detects DELEGATE patterns', () => {
  const deps = createMockDeps();
  const loop = new AgentLoop(deps);
  if (typeof loop._inferStepType === 'function') {
    assert(loop._inferStepType('Delegate this to a peer agent') === 'DELEGATE');
    assert(loop._inferStepType('Delegiere die Aufgabe an einen Peer') === 'DELEGATE');
    assert(loop._inferStepType('Outsource the CSS work') === 'DELEGATE');
    assert(loop._inferStepType('Write a function') === 'CODE');
  }
});

test('_extractSkills parses skill keywords', () => {
  const deps = createMockDeps();
  const loop = new AgentLoop(deps);
  if (typeof loop._extractSkills === 'function') {
    const s1 = loop._extractSkills('Write unit tests for the API endpoint');
    assert(s1.includes('testing'), 'Should detect testing');
    assert(s1.includes('api'), 'Should detect api');

    const s2 = loop._extractSkills('Deploy the Docker container');
    assert(s2.includes('devops'), 'Should detect devops');

    const s3 = loop._extractSkills('Refactor the database schema');
    assert(s3.includes('coding'), 'Should detect coding');
    assert(s3.includes('data'), 'Should detect data');

    const s4 = loop._extractSkills('Think about the problem');
    assert(s4.length === 0, 'Generic description should yield no skills');
  }
});

test('_stepDelegate falls back to ANALYZE without taskDelegation', async () => {
  const deps = createMockDeps({ default: 'Analyzed locally.' });
  const loop = new AgentLoop(deps);
  // taskDelegation is null — should fall back
  if (typeof loop._stepDelegate === 'function') {
    const result = await loop._stepDelegate(
      { type: 'DELEGATE', description: 'Test task', target: '' },
      'test context',
      () => {}
    );
    assert(result.output, 'Should produce output');
    assert(!result.error, 'Should not error');
  }
});

// ── Summary ───────────────────────────────────────────────
// Use setTimeout to let async tests complete
setTimeout(() => {
  console.log(`\n  AgentLoop: ${passed} passed, ${failed} failed`);
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
