// ============================================================
// Test: FormalPlanner.js — Typed plan construction, simulation, action library
// CRITICAL: Plans gate all autonomous execution in AgentLoop.
// ============================================================
let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  // v3.5.2: Fixed — try/catch around fn() for sync errors
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

const { FormalPlanner } = require('../../src/agent/revolution/FormalPlanner');

// ── Mocks ─────────────────────────────────────────────────
const mockBus = { emit: () => [] };
const mockGuard = {
  isProtected: (p) => p.includes('kernel'),
  validateWrite: (p) => { if (p.includes('kernel')) throw new Error('blocked'); return true; },
};
const mockSelfModel = {
  getCapabilities: () => ['code-gen', 'shell', 'file-io'],
};

// WorldState mock with clone + simulation support
function createMockWorldState() {
  const modifiedFiles = new Set();
  return {
    canWriteFile: (p) => p && !p.includes('kernel') && !p.includes('node_modules'),
    canRunShell: (cmd) => cmd && !cmd.includes('rm -rf /'),
    canRunTests: () => true,
    canUseModel: (m) => !m || m === 'gemma2' || m === 'ollama',
    isKernelFile: (p) => p && p.includes('kernel'),
    markFileModified: (p) => modifiedFiles.add(p),
    getRecentlyModified: () => [],
    getSimulatedChanges: () => [...modifiedFiles],
    clone: () => createMockWorldState(),
  };
}

// Model mock that returns structured plans
function createMockModel(planResponse) {
  return {
    chatStructured: async () => planResponse,
    chat: async () => JSON.stringify(planResponse),
    activeModel: 'gemma2',
  };
}

console.log('\n  📦 FormalPlanner');

// ── Action Library ────────────────────────────────────────

test('builtin actions registered (10 types)', () => {
  const fp = new FormalPlanner({
    bus: mockBus, worldState: createMockWorldState(), guard: mockGuard,
    model: createMockModel(null), selfModel: mockSelfModel, rootDir: '/tmp',
  });
  const types = fp.getActionTypes();
  assert(types.length >= 10, `Expected >= 10 action types, got ${types.length}`);
  assert(types.includes('ANALYZE'));
  assert(types.includes('CODE_GENERATE'));
  assert(types.includes('WRITE_FILE'));
  assert(types.includes('RUN_TESTS'));
  assert(types.includes('SHELL_EXEC'));
  assert(types.includes('SEARCH'));
  assert(types.includes('ASK_USER'));
  assert(types.includes('DELEGATE'));
  assert(types.includes('GIT_SNAPSHOT'));
  assert(types.includes('SELF_MODIFY'));
});

test('registerAction adds custom action', () => {
  const fp = new FormalPlanner({
    bus: mockBus, worldState: createMockWorldState(), guard: mockGuard,
    model: createMockModel(null), selfModel: mockSelfModel, rootDir: '/tmp',
  });
  fp.registerAction({ name: 'CUSTOM_DEPLOY', cost: () => 10 });
  assert(fp.getActionTypes().includes('CUSTOM_DEPLOY'));
});

test('WRITE_FILE requires approval', () => {
  const fp = new FormalPlanner({
    bus: mockBus, worldState: createMockWorldState(), guard: mockGuard,
    model: createMockModel(null), selfModel: mockSelfModel, rootDir: '/tmp',
  });
  const action = fp.actions.get('WRITE_FILE');
  assert(action.requiresApproval === true);
});

test('SELF_MODIFY requires approval', () => {
  const fp = new FormalPlanner({
    bus: mockBus, worldState: createMockWorldState(), guard: mockGuard,
    model: createMockModel(null), selfModel: mockSelfModel, rootDir: '/tmp',
  });
  const action = fp.actions.get('SELF_MODIFY');
  assert(action.requiresApproval === true);
});

test('SHELL_EXEC cost varies by command', () => {
  const fp = new FormalPlanner({
    bus: mockBus, worldState: createMockWorldState(), guard: mockGuard,
    model: createMockModel(null), selfModel: mockSelfModel, rootDir: '/tmp',
  });
  const action = fp.actions.get('SHELL_EXEC');
  assert(action.cost({ command: 'npm install foo' }) === 8, 'npm install should cost 8');
  assert(action.cost({ command: 'git status' }) === 2, 'git should cost 2');
  assert(action.cost({ command: 'ls -la' }) === 3, 'generic should cost 3');
});

// ── Type Normalization ────────────────────────────────────

test('_normalizeType: exact uppercase match', () => {
  const fp = new FormalPlanner({
    bus: mockBus, worldState: createMockWorldState(), guard: mockGuard,
    model: createMockModel(null), selfModel: mockSelfModel, rootDir: '/tmp',
  });
  assert(fp._normalizeType('ANALYZE') === 'ANALYZE');
  assert(fp._normalizeType('CODE_GENERATE') === 'CODE_GENERATE');
  assert(fp._normalizeType('WRITE_FILE') === 'WRITE_FILE');
});

test('_normalizeType: aliases map correctly', () => {
  const fp = new FormalPlanner({
    bus: mockBus, worldState: createMockWorldState(), guard: mockGuard,
    model: createMockModel(null), selfModel: mockSelfModel, rootDir: '/tmp',
  });
  assert(fp._normalizeType('code') === 'CODE_GENERATE');
  assert(fp._normalizeType('implement') === 'CODE_GENERATE');
  assert(fp._normalizeType('write') === 'WRITE_FILE');
  assert(fp._normalizeType('test') === 'RUN_TESTS');
  assert(fp._normalizeType('shell') === 'SHELL_EXEC');
  assert(fp._normalizeType('search') === 'SEARCH');
  assert(fp._normalizeType('ask') === 'ASK_USER');
  assert(fp._normalizeType('git') === 'GIT_SNAPSHOT');
  assert(fp._normalizeType('self-modify') === 'SELF_MODIFY');
});

test('_normalizeType: unknown falls back to ANALYZE', () => {
  const fp = new FormalPlanner({
    bus: mockBus, worldState: createMockWorldState(), guard: mockGuard,
    model: createMockModel(null), selfModel: mockSelfModel, rootDir: '/tmp',
  });
  assert(fp._normalizeType('banana') === 'ANALYZE');
  assert(fp._normalizeType('') === 'ANALYZE');
  assert(fp._normalizeType(null) === 'ANALYZE');
});

// ── Step Typification ─────────────────────────────────────

test('_typifyStep produces correct shape', () => {
  const fp = new FormalPlanner({
    bus: mockBus, worldState: createMockWorldState(), guard: mockGuard,
    model: createMockModel(null), selfModel: mockSelfModel, rootDir: '/tmp',
  });
  const step = fp._typifyStep({
    type: 'WRITE_FILE', description: 'write foo', target: 'src/foo.js',
    dependencies: [0],
  }, 1);
  assert(step.index === 1);
  assert(step.type === 'WRITE_FILE');
  assert(step.description === 'write foo');
  assert(step.target === 'src/foo.js');
  assert(step.dependencies[0] === 0);
  assert(step.requiresApproval === true);
  assert(step.cost === 1);
  assert(step.verifierType === 'file');
});

test('_typifyStep: missing type defaults to ANALYZE', () => {
  const fp = new FormalPlanner({
    bus: mockBus, worldState: createMockWorldState(), guard: mockGuard,
    model: createMockModel(null), selfModel: mockSelfModel, rootDir: '/tmp',
  });
  const step = fp._typifyStep({ description: 'look at stuff' }, 0);
  assert(step.type === 'ANALYZE');
});

// ── Plan Simulation ───────────────────────────────────────

test('_simulatePlan: valid plan passes', () => {
  const fp = new FormalPlanner({
    bus: mockBus, worldState: createMockWorldState(), guard: mockGuard,
    model: createMockModel(null), selfModel: mockSelfModel, rootDir: '/tmp',
  });
  const steps = [
    fp._typifyStep({ type: 'ANALYZE', description: 'read' }, 0),
    fp._typifyStep({ type: 'CODE_GENERATE', description: 'gen' }, 1),
    fp._typifyStep({ type: 'WRITE_FILE', target: 'src/agent/foo.js', description: 'write' }, 2),
  ];
  const r = fp._simulatePlan(steps);
  assert(r.valid === true, `Expected valid, got issues: ${JSON.stringify(r.issues)}`);
  assert(r.totalCost > 0);
});

test('_simulatePlan: kernel write blocked', () => {
  const fp = new FormalPlanner({
    bus: mockBus, worldState: createMockWorldState(), guard: mockGuard,
    model: createMockModel(null), selfModel: mockSelfModel, rootDir: '/tmp',
  });
  const steps = [
    fp._typifyStep({ type: 'WRITE_FILE', target: 'src/kernel/SafeGuard.js', description: 'hack kernel' }, 0),
  ];
  const r = fp._simulatePlan(steps);
  assert(r.valid === false);
  assert(r.issues.length >= 1);
});

test('_simulatePlan: SELF_MODIFY to kernel blocked (double precondition)', () => {
  const fp = new FormalPlanner({
    bus: mockBus, worldState: createMockWorldState(), guard: mockGuard,
    model: createMockModel(null), selfModel: mockSelfModel, rootDir: '/tmp',
  });
  const steps = [
    fp._typifyStep({ type: 'SELF_MODIFY', target: 'src/kernel/boot.js', description: 'modify kernel' }, 0),
  ];
  const r = fp._simulatePlan(steps);
  assert(r.valid === false);
});

test('_simulatePlan: dangerous shell command blocked', () => {
  const fp = new FormalPlanner({
    bus: mockBus, worldState: createMockWorldState(), guard: mockGuard,
    model: createMockModel(null), selfModel: mockSelfModel, rootDir: '/tmp',
  });
  const steps = [
    fp._typifyStep({ type: 'SHELL_EXEC', command: 'rm -rf /', description: 'nuke' }, 0),
  ];
  const r = fp._simulatePlan(steps);
  assert(r.valid === false);
});

test('_simulatePlan: without worldState returns valid (graceful)', () => {
  const fp = new FormalPlanner({
    bus: mockBus, worldState: null, guard: mockGuard,
    model: createMockModel(null), selfModel: mockSelfModel, rootDir: '/tmp',
  });
  const steps = [
    fp._typifyStep({ type: 'WRITE_FILE', target: 'kernel.js', description: 'anything' }, 0),
  ];
  const r = fp._simulatePlan(steps);
  assert(r.valid === true, 'Without WorldState, simulation should pass (cannot check)');
});

test('_simulatePlan: effects track file modifications', () => {
  const fp = new FormalPlanner({
    bus: mockBus, worldState: createMockWorldState(), guard: mockGuard,
    model: createMockModel(null), selfModel: mockSelfModel, rootDir: '/tmp',
  });
  const steps = [
    fp._typifyStep({ type: 'WRITE_FILE', target: 'src/agent/foo.js', description: 'write' }, 0),
    fp._typifyStep({ type: 'WRITE_FILE', target: 'src/agent/bar.js', description: 'write' }, 1),
  ];
  const r = fp._simulatePlan(steps);
  assert(r.valid === true);
  assert(r.simulatedChanges.length === 2);
});

test('_simulatePlan: cost accumulates', () => {
  const fp = new FormalPlanner({
    bus: mockBus, worldState: createMockWorldState(), guard: mockGuard,
    model: createMockModel(null), selfModel: mockSelfModel, rootDir: '/tmp',
  });
  const steps = [
    fp._typifyStep({ type: 'ANALYZE', description: 'a' }, 0),     // cost 2
    fp._typifyStep({ type: 'CODE_GENERATE', description: 'b' }, 1), // cost 3
    fp._typifyStep({ type: 'WRITE_FILE', target: 'x.js', description: 'c' }, 2), // cost 1
    fp._typifyStep({ type: 'RUN_TESTS', description: 'd' }, 3),    // cost 5
  ];
  const r = fp._simulatePlan(steps);
  assert(r.totalCost === 11, `Expected 11, got ${r.totalCost}`);
});

// ── Topological Sort ──────────────────────────────────────

test('_topologicalSort: no deps preserves order', () => {
  const fp = new FormalPlanner({
    bus: mockBus, worldState: createMockWorldState(), guard: mockGuard,
    model: createMockModel(null), selfModel: mockSelfModel, rootDir: '/tmp',
  });
  const steps = [
    { index: 0, description: 'A' },
    { index: 1, description: 'B' },
    { index: 2, description: 'C' },
  ];
  const sorted = fp._topologicalSort(steps);
  assert(sorted.length === 3);
  assert(sorted[0].description === 'A');
});

test('_topologicalSort: respects dependencies', () => {
  const fp = new FormalPlanner({
    bus: mockBus, worldState: createMockWorldState(), guard: mockGuard,
    model: createMockModel(null), selfModel: mockSelfModel, rootDir: '/tmp',
  });
  const steps = [
    { index: 0, description: 'A', dependencies: [1] }, // A depends on B
    { index: 1, description: 'B', dependencies: [] },
    { index: 2, description: 'C', dependencies: [0, 1] }, // C depends on A and B
  ];
  const sorted = fp._topologicalSort(steps);
  const idxB = sorted.findIndex(s => s.description === 'B');
  const idxA = sorted.findIndex(s => s.description === 'A');
  const idxC = sorted.findIndex(s => s.description === 'C');
  assert(idxB < idxA, 'B should come before A');
  assert(idxA < idxC, 'A should come before C');
});

test('_topologicalSort: handles cycles gracefully (no crash)', () => {
  const fp = new FormalPlanner({
    bus: mockBus, worldState: createMockWorldState(), guard: mockGuard,
    model: createMockModel(null), selfModel: mockSelfModel, rootDir: '/tmp',
  });
  const steps = [
    { index: 0, description: 'A', dependencies: [1] },
    { index: 1, description: 'B', dependencies: [0] }, // cycle
  ];
  const sorted = fp._topologicalSort(steps);
  assert(sorted.length === 2, 'Should still produce both steps');
});

// ── Raw Plan Parsing ──────────────────────────────────────

test('_parseRawPlan: extracts JSON from text', () => {
  const fp = new FormalPlanner({
    bus: mockBus, worldState: createMockWorldState(), guard: mockGuard,
    model: createMockModel(null), selfModel: mockSelfModel, rootDir: '/tmp',
  });
  const raw = 'Here is my plan:\n```json\n{"title":"Test","steps":[{"type":"ANALYZE","description":"do stuff"}]}\n```';
  const r = fp._parseRawPlan(raw);
  assert(r.title === 'Test');
  assert(r.steps.length === 1);
});

test('_parseRawPlan: falls back to numbered list', () => {
  const fp = new FormalPlanner({
    bus: mockBus, worldState: createMockWorldState(), guard: mockGuard,
    model: createMockModel(null), selfModel: mockSelfModel, rootDir: '/tmp',
  });
  const raw = '1. Analyze the existing code structure\n2. Generate new module implementation\n3. Write tests for the module';
  const r = fp._parseRawPlan(raw);
  assert(r.steps.length === 3, `Expected 3 steps, got ${r.steps.length}`);
  assert(r.steps[0].type === 'ANALYZE');
});

// ── Full plan() with mocked LLM ──────────────────────────
console.log('\n  📦 FormalPlanner (integration)');

async function runAsync() {
  await test('plan: valid goal returns typed steps', async () => {
    const mockPlan = {
      title: 'Add logging',
      steps: [
        { type: 'ANALYZE', description: 'Read existing code' },
        { type: 'CODE_GENERATE', description: 'Generate logger module' },
        { type: 'WRITE_FILE', target: 'src/agent/logger.js', description: 'Write logger' },
        { type: 'RUN_TESTS', description: 'Run test suite' },
      ],
      successCriteria: 'Tests pass with new logger',
    };
    const fp = new FormalPlanner({
      bus: mockBus, worldState: createMockWorldState(), guard: mockGuard,
      model: createMockModel(mockPlan), selfModel: mockSelfModel, rootDir: '/tmp',
    });
    const result = await fp.plan('Add a logging module');
    assert(result.steps.length === 4, `Expected 4 steps, got ${result.steps.length}`);
    assert(result.valid === true, `Expected valid, issues: ${JSON.stringify(result.issues)}`);
    assert(result.cost > 0);
    assert(result.estimatedTimeMs > 0);
    assert(result.title.length > 0);
  });

  await test('plan: empty LLM response returns invalid', async () => {
    const fp = new FormalPlanner({
      bus: mockBus, worldState: createMockWorldState(), guard: mockGuard,
      model: createMockModel({ steps: [] }), selfModel: mockSelfModel, rootDir: '/tmp',
    });
    const result = await fp.plan('Do something');
    assert(result.valid === false);
    assert(result.steps.length === 0);
  });

  await test('plan: kernel write triggers replan', async () => {
    let callCount = 0;
    const model = {
      chatStructured: async () => {
        callCount++;
        if (callCount === 1) {
          // First plan: tries to write kernel
          return {
            title: 'Bad plan',
            steps: [{ type: 'WRITE_FILE', target: 'src/kernel/main.js', description: 'modify kernel' }],
          };
        }
        // Replan: safe target
        return {
          title: 'Fixed plan',
          steps: [{ type: 'WRITE_FILE', target: 'src/agent/fix.js', description: 'safe write' }],
        };
      },
      chat: async () => '{}',
      activeModel: 'gemma2',
    };
    const fp = new FormalPlanner({
      bus: mockBus, worldState: createMockWorldState(), guard: mockGuard,
      model, selfModel: mockSelfModel, rootDir: '/tmp',
    });
    const result = await fp.plan('Modify kernel file');
    assert(callCount >= 2, 'Should have attempted replan');
  });

  await test('stats track plan count', async () => {
    const fp = new FormalPlanner({
      bus: mockBus, worldState: createMockWorldState(), guard: mockGuard,
      model: createMockModel({ title: 'x', steps: [{ type: 'ANALYZE', description: 'a' }] }),
      selfModel: mockSelfModel, rootDir: '/tmp',
    });
    await fp.plan('test');
    await fp.plan('test2');
    const stats = fp.getStats();
    assert(stats.plans === 2, `Expected 2 plans, got ${stats.plans}`);
  });

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failures.length > 0) failures.forEach(f => console.log(`    FAIL: ${f.name} — ${f.error}`));
  process.exit(failed > 0 ? 1 : 0);
}

runAsync();
