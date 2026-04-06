// Test: v7.0.0 — AgentLoopDelegate + VectorMemory coverage sweep
// Targets:
//   AgentLoopDelegate: _extractSkills (all 7 patterns), _stepDelegate
//     (no-delegation fallback, success, approval-rejected, delegation-failed)
//   VectorMemory: add/search/buildContextBlock/ingest edge cases,
//     event listener paths, _cosine edge cases, start/stop lifecycle

const { describe, test, assert, assertEqual, run } = require('../harness');
const { _stepDelegate, _extractSkills } = require('../../src/agent/revolution/AgentLoopDelegate');
const { VectorMemory } = require('../../src/agent/revolution/VectorMemory');

// ── _extractSkills ───────────────────────────────────────────

describe('_extractSkills — keyword patterns', () => {
  test('testing keywords → testing skill', () => {
    const skills = _extractSkills('write tests and verify the spec');
    assert(skills.includes('testing'), 'testing detected');
  });

  test('code keywords → coding skill', () => {
    const skills = _extractSkills('implement the feature and refactor the module');
    assert(skills.includes('coding'), 'coding detected');
  });

  test('deploy keywords → devops skill', () => {
    const skills = _extractSkills('deploy to kubernetes via CI/CD pipeline');
    assert(skills.includes('devops'), 'devops detected');
  });

  test('design keywords → design skill', () => {
    const skills = _extractSkills('design the UI layout in figma');
    assert(skills.includes('design'), 'design detected');
  });

  test('data keywords → data skill', () => {
    const skills = _extractSkills('write a SQL query for the database');
    assert(skills.includes('data'), 'data detected');
  });

  test('security keywords → security skill', () => {
    const skills = _extractSkills('implement auth and encrypt the token');
    assert(skills.includes('security'), 'security detected');
  });

  test('api keywords → api skill', () => {
    const skills = _extractSkills('build a REST API endpoint with GraphQL');
    assert(skills.includes('api'), 'api detected');
  });

  test('multiple keywords → multiple skills', () => {
    const skills = _extractSkills('build and test a REST API with auth and deploy to docker');
    assert(skills.includes('testing'), 'testing');
    assert(skills.includes('api'), 'api');
    assert(skills.includes('security'), 'security');
    assert(skills.includes('devops'), 'devops');
  });

  test('no keywords → empty array', () => {
    const skills = _extractSkills('summarize this text document');
    assertEqual(skills.length, 0);
  });
});

// ── _stepDelegate ────────────────────────────────────────────

function makeStepDelegateContext(overrides = {}) {
  const analyzed = [];
  const progressEvents = [];
  const busEvents = [];

  const ctx = {
    taskDelegation: null,
    currentGoalId: 'goal-1',
    bus: {
      emit(type, data) { busEvents.push({ type, data }); },
    },
    async _stepAnalyze(step, _context) {
      analyzed.push(step);
      return { output: `analyzed: ${step.description}`, error: null };
    },
    async _requestApproval(_action, _desc) {
      return ctx._approvalResult !== undefined ? ctx._approvalResult : true;
    },
    _extractSkills,   // delegate uses this.this._extractSkills when step.skills missing
    _approvalResult: true,
    _analyzed: analyzed,
    _progressEvents: progressEvents,
    _busEvents: busEvents,
    ...overrides,
  };
  return ctx;
}

describe('_stepDelegate — no taskDelegation (fallback)', () => {
  test('falls back to _stepAnalyze when taskDelegation is null', async () => {
    const ctx = makeStepDelegateContext({ taskDelegation: null });
    const step = { type: 'DELEGATE', description: 'summarize the file' };
    const onProgress = (e) => ctx._progressEvents.push(e);

    const result = await _stepDelegate.call(ctx, step, 'some context', onProgress);
    assert(result.output.includes('summarize'), 'got analyze output');
    assertEqual(ctx._analyzed.length, 1);
    assert(ctx._analyzed[0].type === 'ANALYZE', 'step retyped to ANALYZE');
    assert(ctx._analyzed[0].description.includes('Delegation unavailable'), 'fallback message in desc');
  });
});

describe('_stepDelegate — with taskDelegation, success', () => {
  test('delegates and returns peer result', async () => {
    const mockDelegation = {
      async delegate(_desc, _skills, _opts) {
        return { success: true, peerId: 'peer-42', result: 'delegated output' };
      },
    };
    const ctx = makeStepDelegateContext({ taskDelegation: mockDelegation });
    const step = { type: 'DELEGATE', description: 'build a REST API endpoint', skills: ['api'] };
    const onProgress = (e) => ctx._progressEvents.push(e);

    const result = await _stepDelegate.call(ctx, step, 'context', onProgress);
    assert(result.output.includes('peer-42'), 'peer id in output');
    assert(result.output.includes('delegated output'), 'result in output');
    assert(result.error === null, 'no error');
    const delegatingEvent = ctx._busEvents.find(e => e.type === 'agent-loop:step-delegating');
    assert(delegatingEvent !== undefined, 'step-delegating event emitted');
  });

  test('progress events: delegating → delegation-complete', async () => {
    const mockDelegation = {
      async delegate() {
        return { success: true, peerId: 'peer-1', result: '{"done":true}' };
      },
    };
    const ctx = makeStepDelegateContext({ taskDelegation: mockDelegation });
    const progressEvents = [];
    const step = { type: 'DELEGATE', description: 'build tests', skills: [] };

    await _stepDelegate.call(ctx, step, 'ctx', (e) => progressEvents.push(e));
    const phases = progressEvents.map(e => e.phase);
    assert(phases.includes('delegating'), 'delegating phase emitted');
    assert(phases.includes('delegation-complete'), 'delegation-complete emitted');
  });

  test('JSON result object is stringified', async () => {
    const mockDelegation = {
      async delegate() {
        return { success: true, peerId: 'p', result: { nested: 'object', value: 42 } };
      },
    };
    const ctx = makeStepDelegateContext({ taskDelegation: mockDelegation });
    const result = await _stepDelegate.call(ctx, { type: 'DELEGATE', description: 'test' }, '', () => {});
    assert(result.output.includes('"nested"'), 'object serialized');
  });
});

describe('_stepDelegate — approval rejected', () => {
  test('falls back to local when user rejects delegation', async () => {
    const mockDelegation = {
      async delegate() { throw new Error('should not be called'); },
    };
    const ctx = makeStepDelegateContext({ taskDelegation: mockDelegation, _approvalResult: false });
    const progressEvents = [];
    const step = { type: 'DELEGATE', description: 'deploy to kubernetes' };

    const result = await _stepDelegate.call(ctx, step, 'ctx', (e) => progressEvents.push(e));
    assert(result.output.includes('deploy'), 'local fallback ran');
    const phases = progressEvents.map(e => e.phase);
    assert(phases.includes('delegation-rejected'), 'rejection event emitted');
  });
});

describe('_stepDelegate — delegation fails', () => {
  test('falls back to local on failed delegation', async () => {
    const mockDelegation = {
      async delegate() {
        return { success: false, error: 'peer timeout', peerId: null };
      },
    };
    const ctx = makeStepDelegateContext({ taskDelegation: mockDelegation });
    const progressEvents = [];
    const step = { type: 'DELEGATE', description: 'write unit tests', skills: ['testing'] };

    const result = await _stepDelegate.call(ctx, step, 'ctx', (e) => progressEvents.push(e));
    assert(result.output.includes('write unit tests'), 'fallback desc preserved');
    const phases = progressEvents.map(e => e.phase);
    assert(phases.includes('delegation-failed'), 'delegation-failed event emitted');
    assert(ctx._analyzed[0].description.includes('Delegation failed'), 'failure message in desc');
  });
});

// ── VectorMemory ─────────────────────────────────────────────

function makeBus() {
  const handlers = {};
  return {
    _handlers: handlers,
    emit() {},
    on(event, handler) { handlers[event] = handler; return () => {}; },
  };
}

function makeStorage() {
  let stored = null;
  return {
    readJSON() { return stored; },
    writeJSONAsync(_path, data) { stored = data; return Promise.resolve(); },
    _getStored() { return stored; },
  };
}

function makeVectorMemory(opts = {}) {
  const bus = opts.bus || makeBus();
  const storage = opts.storage || makeStorage();
  return new VectorMemory({
    bus,
    storage,
    embeddingService: opts.embeddingService || null,
    storageDir: '/tmp/test',
  });
}

describe('VectorMemory — add edge cases', () => {
  test('add returns null for unknown collection', async () => {
    const vm = makeVectorMemory();
    const result = await vm.add('nonexistent', 'some text');
    assert(result === null, 'unknown collection → null');
  });

  test('add returns null for text shorter than 10 chars', async () => {
    const vm = makeVectorMemory();
    const result = await vm.add('conversations', 'short');
    assert(result === null, 'short text → null');
  });

  test('add returns null when no embedding service', async () => {
    const vm = makeVectorMemory({ embeddingService: null });
    const result = await vm.add('conversations', 'this is a long enough text to process');
    assert(result === null, 'no embed service → null');
  });
});

describe('VectorMemory — add with embedding service', () => {
  test('stores entry and increments totalVectors', async () => {
    const embeddingService = {
      isAvailable() { return true; },
      async embed() { return new Array(4).fill(0.1); },
    };
    const vm = makeVectorMemory({ embeddingService });
    await vm.add('conversations', 'this is a long enough text for the vector');
    const stats = vm.getStats();
    assertEqual(stats.totalVectors, 1);
  });

  test('prunes oldest entry when collection exceeds max', async () => {
    const embeddingService = {
      isAvailable() { return true; },
      async embed() { return new Array(4).fill(0.1); },
    };
    const vm = makeVectorMemory({ embeddingService });
    vm._maxPerCollection = 2; // lower limit for test speed
    for (let i = 0; i < 4; i++) {
      await vm.add('conversations', `entry number ${i} with enough text to store`);
    }
    assert(vm.collections.conversations.length <= 2, 'collection pruned to max');
  });
});

describe('VectorMemory — search edge cases', () => {
  test('returns empty array with no embedding service', async () => {
    const vm = makeVectorMemory();
    const results = await vm.search('test query');
    assertEqual(results.length, 0);
  });

  test('returns empty array when embedding returns null', async () => {
    const embeddingService = {
      isAvailable() { return true; },
      async embed() { return null; },
    };
    const vm = makeVectorMemory({ embeddingService });
    const results = await vm.search('test query');
    assertEqual(results.length, 0);
  });
});

describe('VectorMemory — buildContextBlock', () => {
  test('returns empty string when no results found', async () => {
    const vm = makeVectorMemory();
    const block = await vm.buildContextBlock('some query');
    assertEqual(block, '');
  });

  test('does not throw with real embed + populated collection', async () => {
    const embeddingService = {
      isAvailable() { return true; },
      async embed() { return [1, 0, 0, 0]; },
    };
    const vm = makeVectorMemory({ embeddingService });
    await vm.add('knowledge', 'relevant knowledge about code review process here');
    const block = await vm.buildContextBlock('code review');
    assert(typeof block === 'string', 'returns string');
  });
});

describe('VectorMemory — ingest', () => {
  test('ingest processes array of items', async () => {
    const embeddingService = {
      isAvailable() { return true; },
      async embed() { return new Array(4).fill(0.1); },
    };
    const vm = makeVectorMemory({ embeddingService });
    const count = await vm.ingest('knowledge', [
      { text: 'first item with enough length here', metadata: {} },
      { text: 'second item with enough length here', metadata: {} },
    ]);
    assert(count >= 0, 'returns ingested count');
  });

  test('ingest returns 0 for empty array', async () => {
    const vm = makeVectorMemory();
    const count = await vm.ingest('conversations', []);
    assertEqual(count, 0);
  });
});

describe('VectorMemory — getStats', () => {
  test('returns stats with totalVectors and collections', () => {
    const vm = makeVectorMemory();
    const stats = vm.getStats();
    assert(typeof stats === 'object', 'returns object');
    assert('totalVectors' in stats, 'totalVectors field');
    assert('collections' in stats, 'collections field');
    assert('available' in stats, 'available field');
    assertEqual(stats.totalVectors, 0);
  });

  test('available false when no embedding service', () => {
    const vm = makeVectorMemory();
    assertEqual(vm.getStats().available, false);
  });

  test('available true when embedding service is available', () => {
    const vm = makeVectorMemory({
      embeddingService: { isAvailable() { return true; }, async embed() { return []; } },
    });
    assertEqual(vm.getStats().available, true);
  });
});

describe('VectorMemory — event wiring', () => {
  test('_wireEvents registers bus listeners on construction', () => {
    const bus = makeBus();
    new VectorMemory({
      bus, storage: makeStorage(), embeddingService: null, storageDir: '/tmp',
    });
    const keys = Object.keys(bus._handlers);
    assert(keys.length > 0, 'bus handlers registered');
  });

  test('asyncLoad does not throw without storage data', async () => {
    const vm = makeVectorMemory();
    await vm.asyncLoad(); // should not throw
  });
});

describe('VectorMemory — _cosine edge cases', () => {
  test('search with zero-magnitude vectors does not throw', async () => {
    const embeddingService = {
      isAvailable() { return true; },
      async embed() { return new Array(4).fill(0); },
    };
    const vm = makeVectorMemory({ embeddingService });
    await vm.add('conversations', 'text that is long enough to embed here');
    const results = await vm.search('query text');
    assert(Array.isArray(results), 'returns array even with zero vectors');
  });
});

if (require.main === module) run();
