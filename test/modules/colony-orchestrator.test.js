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
  return {
    generate: async () => response || JSON.stringify([
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
  test('executes locally when no peers', async () => {
    const co = createOrchestrator();
    await co.boot();
    const run = await co.execute('Fix all bugs');
    assertEqual(run.status, 'done');
    assert(run.subtasks.length > 0, 'Should have subtasks');
    assert(run.subtasks.every(s => s.assignedTo === 'local'), 'All should be local');
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
      llm: { generate: async () => 'not json' },
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

run();
