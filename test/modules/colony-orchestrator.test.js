// ============================================================
// GENESIS — test/modules/colony-orchestrator.test.js (v5.9.2)
//
// Tests ColonyOrchestrator: decomposition, distribution,
// merge, conflict detection, local fallback, health.
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { ColonyOrchestrator } = require(path.join(ROOT, 'src/agent/revolution/ColonyOrchestrator'));

// ── Mock Dependencies ───────────────────────────────────────

function mockBus() {
  const handlers = {};
  return {
    on: (evt, fn) => { handlers[evt] = fn; },
    fire: () => {},
    emit: () => {},
    _handlers: handlers,
  };
}

function mockLLM(response) {
  // v7.5.0: ColonyOrchestrator now uses ModelBridge.chat positional API
  // (systemPrompt, messages, taskType, options). Tests mock 'chat' here
  // to match the production call site. Pre-v7.5.0 the mock was named
  // 'generate' but ModelBridge never had that method — the call failed
  // silently and Colony fell back to single-task mode every time.
  return {
    chat: async (_systemPrompt, _messages, _taskType, _options) => response || JSON.stringify([
      { description: 'Fix imports', files: ['a.js'] },
      { description: 'Add tests', files: ['b.test.js'] },
    ]),
  };
}

function mockPeers(peers = []) {
  return {
    getPeers: () => peers,
  };
}

function mockDelegation() {
  const results = new Map();
  return {
    delegate: async (desc, skills, opts) => {
      const id = opts?.metadata?.subtaskId;
      if (id) results.set(id, { done: true, modifiedFiles: [] });
    },
    getResult: (id) => results.get(id) || null,
    _results: results,
  };
}

function mockConsensus(accept = true) {
  return {
    propose: async () => ({ accepted: accept, votes: { yes: accept ? 1 : 0, total: 1 } }),
  };
}

function createOrchestrator(overrides = {}) {
  const bus = mockBus();
  return new ColonyOrchestrator({
    bus,
    peerNetwork: overrides.peers || mockPeers(),
    taskDelegation: overrides.delegation || mockDelegation(),
    peerConsensus: overrides.consensus || mockConsensus(),
    llm: overrides.llm || mockLLM(),
    config: overrides.config || {},
  });
}

// ── Tests ───────────────────────────────────────────────────

describe('ColonyOrchestrator — Construction', () => {
  test('creates with defaults', () => {
    const co = createOrchestrator();
    assertEqual(co.META.id, 'colonyOrchestrator');
    assertEqual(co.config.maxSubtasks, 10);
    assertEqual(co.config.requireConsensus, true);
  });

  test('accepts config overrides', () => {
    const co = createOrchestrator({ config: { maxSubtasks: 5, requireConsensus: false } });
    assertEqual(co.config.maxSubtasks, 5);
    assertEqual(co.config.requireConsensus, false);
  });
});

describe('ColonyOrchestrator — Health', () => {
  test('reports health with no peers', () => {
    const co = createOrchestrator();
    const h = co.getHealth();
    assertEqual(h.peers, 0);
    assertEqual(h.activeRuns, 0);
    assertEqual(h.totalRuns, 0);
  });

  test('reports health with peers', () => {
    const co = createOrchestrator({
      peers: mockPeers([{ id: 'p1', status: 'connected' }, { id: 'p2', status: 'disconnected' }]),
    });
    const h = co.getHealth();
    assertEqual(h.peers, 1); // Only connected
  });
});

describe('ColonyOrchestrator — Local Fallback', () => {
  test('executes locally when no peers (passthrough without selfSpawner)', async () => {
    const co = createOrchestrator();
    await co.boot();
    const run = await co.execute('Fix all bugs');
    assertEqual(run.status, 'done');
    assert(run.subtasks.length > 0, 'Should have subtasks');
    assert(run.subtasks.every(s => s.assignedTo === 'passthrough'), 'All should be passthrough');
    assert(run.completedAt > 0, 'Should have completedAt');
  });
});

describe('ColonyOrchestrator — Decomposition', () => {
  test('decomposes via LLM', async () => {
    const co = createOrchestrator({
      llm: mockLLM(JSON.stringify([
        { description: 'Task A' },
        { description: 'Task B' },
        { description: 'Task C' },
      ])),
    });
    await co.boot();
    const run = await co.execute('Build feature X');
    assert(run.subtasks.length === 3, `Expected 3 subtasks, got ${run.subtasks.length}`);
  });

  test('falls back to single task on LLM failure', async () => {
    const co = createOrchestrator({
      llm: { chat: async () => 'not json' },
    });
    await co.boot();
    const run = await co.execute('Fix bug');
    assertEqual(run.subtasks.length, 1);
    assert(run.subtasks[0].description.includes('Fix bug'));
  });

  test('respects maxSubtasks limit', async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ description: `Task ${i}` }));
    const co = createOrchestrator({
      llm: mockLLM(JSON.stringify(many)),
      config: { maxSubtasks: 5 },
    });
    await co.boot();
    const run = await co.execute('Big goal');
    assert(run.subtasks.length <= 5, `Expected ≤5, got ${run.subtasks.length}`);
  });
});

describe('ColonyOrchestrator — Run Status', () => {
  test('getRunStatus returns null for unknown', () => {
    const co = createOrchestrator();
    assertEqual(co.getRunStatus('nonexistent'), null);
  });

  test('getAllRuns returns all runs', async () => {
    const co = createOrchestrator();
    await co.boot();
    await co.execute('Goal 1');
    await co.execute('Goal 2');
    assertEqual(co.getAllRuns().length, 2);
  });
});

describe('ColonyOrchestrator — Stop', () => {
  test('stop cancels in-flight runs', async () => {
    const co = createOrchestrator();
    await co.boot();
    // Start a run then immediately stop
    const promise = co.execute('Long task');
    await co.stop();
    const run = await promise;
    // Should complete (local fallback) or be marked failed
    assert(run.status === 'done' || run.status === 'failed');
  });
});

describe('ColonyOrchestrator — Event Handling', () => {
  test('responds to colony:run-request event', async () => {
    const bus = mockBus();
    const co = new ColonyOrchestrator({
      bus, peerNetwork: mockPeers(), taskDelegation: mockDelegation(),
      peerConsensus: mockConsensus(), llm: mockLLM(),
    });
    await co.boot();
    assert(typeof bus._handlers['colony:run-request'] === 'function');
  });
});

// ── V7-1: IPC Worker Tests ─────────────────────────────────

describe('ColonyOrchestrator — V7-1 IPC Workers', () => {

  test('selfSpawner is null by default', () => {
    const co = createOrchestrator();
    assertEqual(co.selfSpawner, null);
  });

  test('selfSpawner wired when provided', () => {
    const spawner = { spawnParallel: async () => [], getStats: () => ({}) };
    const co = new ColonyOrchestrator({
      bus: mockBus(), llm: mockLLM(),
      peerNetwork: mockPeers(), taskDelegation: mockDelegation(),
      peerConsensus: mockConsensus(), selfSpawner: spawner,
    });
    assert(co.selfSpawner === spawner);
  });

  test('version is 7.1.0', () => {
    const co = createOrchestrator();
    assertEqual(co.META.version, '7.1.0');
  });

  test('getHealth includes ipcWorkers:false without spawner', () => {
    const co = createOrchestrator();
    const h = co.getHealth();
    assertEqual(h.ipcWorkers, false);
  });

  test('getHealth includes ipcWorkers truthy with spawner', () => {
    const spawner = { spawnParallel: async () => [], getStats: () => ({ active: 0 }) };
    const co = new ColonyOrchestrator({
      bus: mockBus(), llm: mockLLM(),
      peerNetwork: mockPeers(), taskDelegation: mockDelegation(),
      peerConsensus: mockConsensus(), selfSpawner: spawner,
    });
    // ipcWorkers is truthy (getStats().active or true)
    assert(co.getHealth().ipcWorkers !== false);
  });

  test('_executeLocally uses selfSpawner.spawnParallel when available', async () => {
    let spawnedTasks = null;
    const spawner = {
      spawnParallel: async (tasks) => {
        spawnedTasks = tasks;
        return tasks.map(t => ({ success: true, result: { output: `done: ${t.description}` } }));
      },
    };
    const co = new ColonyOrchestrator({
      bus: mockBus(), llm: mockLLM(),
      peerNetwork: mockPeers(), taskDelegation: mockDelegation(),
      peerConsensus: mockConsensus(), selfSpawner: spawner,
    });
    await co.boot();
    const run = await co.execute('Parallel refactor');

    assert(spawnedTasks !== null, 'spawnParallel should have been called');
    assertEqual(run.status, 'done');
    assert(run.subtasks.every(s => s.assignedTo === 'local-ipc'), 'all should be local-ipc');
    assert(run.subtasks.every(s => s.status === 'done'), 'all should succeed');
  });

  test('_executeLocally marks subtask failed when worker returns error', async () => {
    const spawner = {
      spawnParallel: async (tasks) =>
        tasks.map(() => ({ success: false, error: 'worker crash' })),
    };
    const co = new ColonyOrchestrator({
      bus: mockBus(), llm: mockLLM(),
      peerNetwork: mockPeers(), taskDelegation: mockDelegation(),
      peerConsensus: mockConsensus(), selfSpawner: spawner,
    });
    await co.boot();
    const run = await co.execute('Failing task');

    assertEqual(run.status, 'done'); // run itself completes
    assert(run.subtasks.every(s => s.status === 'failed'), 'all subtasks should be failed');
    assert(run.subtasks.every(s => s.result?.error === 'worker crash'));
  });

  test('_executeLocally mixes success and failure results', async () => {
    const spawner = {
      spawnParallel: async (tasks) =>
        tasks.map((_, i) =>
          i % 2 === 0
            ? { success: true, result: { output: 'ok' } }
            : { success: false, error: 'partial fail' }
        ),
    };
    const co = new ColonyOrchestrator({
      bus: mockBus(),
      llm: { chat: async () => JSON.stringify([
        { description: 'Task A' }, { description: 'Task B' },
        { description: 'Task C' }, { description: 'Task D' },
      ])},
      peerNetwork: mockPeers(), taskDelegation: mockDelegation(),
      peerConsensus: mockConsensus(), selfSpawner: spawner,
    });
    await co.boot();
    const run = await co.execute('Mixed results');

    const done = run.subtasks.filter(s => s.status === 'done');
    const failed = run.subtasks.filter(s => s.status === 'failed');
    assertEqual(done.length, 2);
    assertEqual(failed.length, 2);
  });

  test('_executeLocally passthrough when no selfSpawner', async () => {
    const co = createOrchestrator(); // no selfSpawner
    await co.boot();
    const run = await co.execute('No spawner task');

    assertEqual(run.status, 'done');
    assert(run.subtasks.every(s => s.assignedTo === 'passthrough'), 'should be passthrough');
    assert(run.subtasks.every(s => s.result?.passthrough === true));
  });

  test('fires colony:ipc-spawn event when using selfSpawner', async () => {
    const fired = [];
    const bus = {
      on: (e, fn) => {},
      fire: (e, d) => fired.push(e),
      emit: () => {},
    };
    const spawner = {
      spawnParallel: async (tasks) =>
        tasks.map(() => ({ success: true, result: {} })),
    };
    const co = new ColonyOrchestrator({
      bus, llm: mockLLM(),
      peerNetwork: mockPeers(), taskDelegation: mockDelegation(),
      peerConsensus: mockConsensus(), selfSpawner: spawner,
    });
    await co.boot();
    await co.execute('IPC event test');
    assert(fired.includes('colony:ipc-spawn'), 'should fire colony:ipc-spawn');
  });

  test('spawnParallel receives correct task format', async () => {
    let receivedTasks = null;
    const spawner = {
      spawnParallel: async (tasks) => {
        receivedTasks = tasks;
        return tasks.map(() => ({ success: true, result: {} }));
      },
    };
    const co = new ColonyOrchestrator({
      bus: mockBus(),
      llm: { chat: async () => JSON.stringify([{ description: 'Subtask Alpha' }]) },
      peerNetwork: mockPeers(), taskDelegation: mockDelegation(),
      peerConsensus: mockConsensus(), selfSpawner: spawner,
    });
    await co.boot();
    await co.execute('Format check');

    assert(Array.isArray(receivedTasks));
    assertEqual(receivedTasks[0].description, 'Subtask Alpha');
    assertEqual(receivedTasks[0].type, 'generic');
    assert('context' in receivedTasks[0], 'should include context');
    assert('timeoutMs' in receivedTasks[0], 'should include timeoutMs');
  });
});

run();
