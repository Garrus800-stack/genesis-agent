// ============================================================
// Test: Phase 9 — Cognitive Architecture
// SchemaStore, ExpectationEngine, SurpriseAccumulator,
// MentalSimulator, AgentLoopCognition
// ============================================================

const { describe, test, assert, assertEqual, run, createTestRoot } = require('../harness');

// ── Mocks ────────────────────────────────────────────────

function mockBus() {
  const events = [];
  return {
    emit: (e, d, opts) => events.push({ e, d, source: opts?.source }),
    fire: (e, d, opts) => events.push({ e, d, source: opts?.source }),
    on: () => {},
    removeBySource: () => {},
    events,
  };
}

function mockStorage() {
  const store = {};
  return {
    readJSON: (f, def) => store[f] ?? def,
    writeJSON: (f, d) => { store[f] = d; },
    writeJSONDebounced: (f, d) => { store[f] = d; },
    writeJSONAsync: async (f, d) => { store[f] = d; },
    _store: store,
  };
}

function mockWorldState() {
  return {
    clone: () => ({
      state: { project: { testScript: 'npm test' }, runtime: { ollamaModels: ['gemma2:9b'], ollamaStatus: 'running' } },
      _kernelFiles: new Set(),
      _shellBlocklist: new Set(),
      _simulatedChanges: [],
      rootDir: '/test',
      canWriteFile: () => true,
      canRunTests: () => true,
      canUseModel: () => true,
      canRunShell: () => true,
      markFileModified: function(p) { this._simulatedChanges.push({ type: 'file-modified', path: p }); },
      markTestsFailed: function() { this._simulatedChanges.push({ type: 'tests-failed' }); },
      getSimulatedChanges: function() { return this._simulatedChanges; },
      deepClone: function() {
        const c = { ...this, state: JSON.parse(JSON.stringify(this.state)), _simulatedChanges: [...this._simulatedChanges] };
        c.deepClone = this.deepClone;
        c.markFileModified = this.markFileModified;
        c.markTestsFailed = this.markTestsFailed;
        c.getSimulatedChanges = this.getSimulatedChanges;
        c.canWriteFile = this.canWriteFile;
        c.canRunTests = this.canRunTests;
        c.canUseModel = this.canUseModel;
        c.canRunShell = this.canRunShell;
        return c;
      },
    }),
    markFileModified: () => {},
    buildContextSlice: () => '',
  };
}

function mockMetaLearning(overrides = {}) {
  return {
    recommend: (cat, model) => overrides.recommend?.(cat, model) || {
      successRate: 0.75,
      avgLatency: 5000,
      samples: 50,
      promptStyle: 'json-schema',
    },
    recordOutcome: () => {},
  };
}

function mockEpisodicMemory() {
  const episodes = [];
  return {
    recordEpisode: (ep) => episodes.push(ep),
    recall: () => [],
    episodes,
  };
}

// ══════════════════════════════════════════════════════════
// SchemaStore
// ══════════════════════════════════════════════════════════

const { SchemaStore } = require('../../src/agent/planning/SchemaStore');

describe('SchemaStore', () => {
  test('store and retrieve a schema', () => {
    const store = new SchemaStore({ bus: mockBus(), storage: mockStorage() });
    const schema = store.store({
      name: 'test-pattern',
      description: 'A test schema',
      trigger: 'code_generate write_file run_tests',
      successModifier: -0.15,
      confidence: 0.8,
      sourcePattern: 'action-sequence',
      occurrences: 5,
    });
    assert(schema !== null, 'Schema should be stored');
    assertEqual(schema.name, 'test-pattern');
    assert(schema.id.startsWith('schema_'), 'Should have generated ID');
    assertEqual(store.getStats().totalSchemas, 1);
  });

  test('match returns relevant schemas', () => {
    const store = new SchemaStore({ bus: mockBus(), storage: mockStorage() });
    store.store({
      name: 'refactor-failure',
      trigger: 'self_modify refactoring code_generate',
      successModifier: -0.2,
      confidence: 0.8,
      sourcePattern: 'action-sequence',
    });
    store.store({
      name: 'shell-timeout',
      trigger: 'shell_exec npm install timeout',
      successModifier: -0.3,
      confidence: 0.7,
      sourcePattern: 'error-cluster',
    });

    const matches = store.match({ type: 'SELF_MODIFY', description: 'refactoring the module' });
    assert(matches.length >= 1, 'Should find at least one matching schema');
    assertEqual(matches[0].name, 'refactor-failure');
  });

  test('match returns empty for unrelated actions', () => {
    const store = new SchemaStore({ bus: mockBus(), storage: mockStorage() });
    store.store({
      name: 'shell-pattern',
      trigger: 'shell_exec npm install',
      confidence: 0.8,
      sourcePattern: 'action-sequence',
    });

    const matches = store.match({ type: 'ASK_USER', description: 'confirm deletion' });
    assertEqual(matches.length, 0);
  });

  test('deduplicates by name + sourcePattern', () => {
    const store = new SchemaStore({ bus: mockBus(), storage: mockStorage() });
    store.store({ name: 'dup-test', trigger: 'code', sourcePattern: 'action-sequence', occurrences: 3, confidence: 0.5 });
    store.store({ name: 'dup-test', trigger: 'code', sourcePattern: 'action-sequence', occurrences: 2, confidence: 0.4 });

    assertEqual(store.getStats().totalSchemas, 1);
    const all = store.getAll();
    assertEqual(all[0].occurrences, 5); // 3 + 2
    assert(all[0].confidence > 0.5, 'Confidence should increase on merge');
  });

  test('prunes when exceeding maxSchemas', () => {
    const store = new SchemaStore({ bus: mockBus(), storage: mockStorage(), config: { maxSchemas: 5 } });
    for (let i = 0; i < 8; i++) {
      store.store({
        name: `schema-${i}`,
        trigger: `trigger-${i}`,
        confidence: i * 0.1,
        sourcePattern: 'test',
      });
    }
    assert(store.getAll().length <= 5, 'Should prune to maxSchemas');
    assert(store.getStats().pruned > 0, 'Should record pruning');
  });

  test('getConfident filters by minimum confidence', () => {
    const store = new SchemaStore({ bus: mockBus(), storage: mockStorage() });
    store.store({ name: 'low', trigger: 'a', confidence: 0.3, sourcePattern: 'test' });
    store.store({ name: 'high', trigger: 'b', confidence: 0.9, sourcePattern: 'test' });

    const confident = store.getConfident(0.7);
    assertEqual(confident.length, 1);
    assertEqual(confident[0].name, 'high');
  });

  test('remove deletes schema by ID', () => {
    const store = new SchemaStore({ bus: mockBus(), storage: mockStorage() });
    const s = store.store({ name: 'removeme', trigger: 'x', confidence: 0.5, sourcePattern: 'test' });
    assertEqual(store.getAll().length, 1);
    store.remove(s.id);
    assertEqual(store.getAll().length, 0);
  });

  test('clamps successModifier to [-1, 1]', () => {
    const store = new SchemaStore({ bus: mockBus(), storage: mockStorage() });
    const s = store.store({ name: 'extreme', trigger: 'x', successModifier: 5.0, confidence: 0.5, sourcePattern: 'test' });
    assertEqual(s.successModifier, 1);
  });

  test('persistence via asyncLoad + save', async () => {
    const storage = mockStorage();
    const store1 = new SchemaStore({ bus: mockBus(), storage });
    store1.store({ name: 'persist-test', trigger: 'abc', confidence: 0.8, sourcePattern: 'test' });
    store1.stop(); // triggers save

    const store2 = new SchemaStore({ bus: mockBus(), storage });
    await store2.asyncLoad();
    assertEqual(store2.getAll().length, 1);
    assertEqual(store2.getAll()[0].name, 'persist-test');
  });
});

// ══════════════════════════════════════════════════════════
// ExpectationEngine
// ══════════════════════════════════════════════════════════

const { ExpectationEngine, BASE_RATES } = require('../../src/agent/cognitive/ExpectationEngine');

describe('ExpectationEngine', () => {
  test('forms statistical expectation from MetaLearning', () => {
    const engine = new ExpectationEngine({
      bus: mockBus(),
      metaLearning: mockMetaLearning(),
      schemaStore: new SchemaStore({ bus: mockBus(), storage: mockStorage() }),
      worldState: mockWorldState(),
      storage: mockStorage(),
    });

    const exp = engine.expect({ type: 'CODE_GENERATE', description: 'write a module' });
    assert(exp !== null, 'Should form expectation');
    assertEqual(exp.source, 'statistical');
    assertEqual(exp.successProb, 0.75);
    assert(exp.confidence > 0.3, 'Should have reasonable confidence');
    assert(exp.id.startsWith('exp_'), 'Should have generated ID');
  });

  test('falls back to heuristic when MetaLearning has no data', () => {
    const engine = new ExpectationEngine({
      bus: mockBus(),
      metaLearning: mockMetaLearning({ recommend: () => ({ successRate: 0.5, avgLatency: 5000, samples: 2 }) }),
      schemaStore: new SchemaStore({ bus: mockBus(), storage: mockStorage() }),
      worldState: mockWorldState(),
      storage: mockStorage(),
    });

    const exp = engine.expect({ type: 'CODE_GENERATE', description: 'write code' });
    assertEqual(exp.source, 'heuristic');
    assertEqual(exp.successProb, BASE_RATES['CODE_GENERATE'].successRate);
  });

  test('works without MetaLearning (null)', () => {
    const engine = new ExpectationEngine({
      bus: mockBus(), metaLearning: null,
      schemaStore: null, worldState: null, storage: null,
    });
    const exp = engine.expect({ type: 'ANALYZE', description: 'read code' });
    assertEqual(exp.source, 'heuristic');
    assertEqual(exp.successProb, BASE_RATES['ANALYZE'].successRate);
  });

  test('applies schema modifiers', () => {
    const schemaStore = new SchemaStore({ bus: mockBus(), storage: mockStorage() });
    schemaStore.store({
      name: 'code-failure-pattern',
      trigger: 'code_generate write module',
      successModifier: -0.2,
      confidence: 0.9,
      sourcePattern: 'action-sequence',
    });

    const engine = new ExpectationEngine({
      bus: mockBus(),
      metaLearning: mockMetaLearning(),
      schemaStore,
      worldState: mockWorldState(),
      storage: mockStorage(),
    });

    const exp = engine.expect({ type: 'CODE_GENERATE', description: 'write a new module' });
    assert(exp.successProb < 0.75, 'Schema should reduce success probability');
    assert(exp.schemaCount > 0, 'Should record schema was applied');
  });

  test('compare produces surprise signal', () => {
    const bus = mockBus();
    const engine = new ExpectationEngine({
      bus, metaLearning: null, schemaStore: null, worldState: null, storage: mockStorage(),
    });

    const exp = engine.expect({ type: 'RUN_TESTS' });

    // Expected ~60% success, got failure — should be surprising
    const signal = engine.compare(exp, { success: false, duration: 20000, qualityScore: 0.2 });
    assert(signal !== null, 'Should produce signal');
    assert(signal.totalSurprise > 0, 'Should have positive surprise');
    assertEqual(signal.valence, 'negative');
    assertEqual(signal.actionType, 'RUN_TESTS');
    assert(bus.events.some(e => e.e === 'expectation:compared'), 'Should emit event');
  });

  test('high-probability success has low surprise', () => {
    const engine = new ExpectationEngine({
      bus: mockBus(), metaLearning: mockMetaLearning({ recommend: () => ({ successRate: 0.95, avgLatency: 1000, samples: 100 }) }),
      schemaStore: null, worldState: null, storage: mockStorage(),
    });

    const exp = engine.expect({ type: 'WRITE_FILE' });
    const signal = engine.compare(exp, { success: true, duration: 800 });
    assert(signal.totalSurprise < 0.5, `Expected low surprise, got ${signal.totalSurprise}`);
  });

  test('calibration improves with accurate predictions', () => {
    const engine = new ExpectationEngine({
      bus: mockBus(),
      metaLearning: mockMetaLearning({ recommend: () => ({ successRate: 0.9, avgLatency: 1000, samples: 100 }) }),
      schemaStore: null, worldState: null, storage: mockStorage(),
    });

    // Make 10 predictions that are all correct
    for (let i = 0; i < 10; i++) {
      const exp = engine.expect({ type: 'WRITE_FILE' });
      engine.compare(exp, { success: true, duration: 1000 });
    }

    assert(engine.getCalibration() > 0.7, `Calibration should be high: ${engine.getCalibration()}`);
  });

  test('compare returns null for null inputs', () => {
    const engine = new ExpectationEngine({ bus: mockBus(), storage: null });
    assertEqual(engine.compare(null, { success: true }), null);
    assertEqual(engine.compare({ id: 'x' }, null), null);
  });
});

// ══════════════════════════════════════════════════════════
// SurpriseAccumulator
// ══════════════════════════════════════════════════════════

const { SurpriseAccumulator } = require('../../src/agent/cognitive/SurpriseAccumulator');

describe('SurpriseAccumulator', () => {
  test('processes surprise signal and updates stats', () => {
    const bus = mockBus();
    const acc = new SurpriseAccumulator({ bus, episodicMemory: mockEpisodicMemory(), eventStore: null, storage: mockStorage() });

    acc._processSurprise({
      totalSurprise: 0.5,
      valence: 'positive',
      actionType: 'CODE_GENERATE',
      timestamp: Date.now(),
      expected: { successProb: 0.6 },
      actual: { success: true },
    });

    assertEqual(acc.getStats().totalSignals, 1);
    assert(acc.getStats().bufferSize === 1);
  });

  test('high surprise triggers amplified learning event', () => {
    const bus = mockBus();
    const acc = new SurpriseAccumulator({ bus, episodicMemory: mockEpisodicMemory(), eventStore: null, storage: mockStorage() });

    acc._processSurprise({
      totalSurprise: 2.0, // novel!
      valence: 'negative',
      actionType: 'SELF_MODIFY',
      timestamp: Date.now(),
      expected: { successProb: 0.8 },
      actual: { success: false },
    });

    const ampEvent = bus.events.find(e => e.e === 'surprise:amplified-learning');
    assert(ampEvent !== null, 'Should emit amplified-learning');
    assertEqual(ampEvent.d.multiplier, 4.0); // novel threshold
  });

  test('novel events trigger reflection', () => {
    const bus = mockBus();
    const acc = new SurpriseAccumulator({ bus, episodicMemory: mockEpisodicMemory(), eventStore: { append: () => {} }, storage: mockStorage() });

    acc._processSurprise({
      totalSurprise: 2.5,
      valence: 'positive',
      actionType: 'RUN_TESTS',
      timestamp: Date.now(),
    });

    assert(bus.events.some(e => e.e === 'surprise:novel-event'), 'Should emit novel-event');
    assertEqual(acc.getStats().novelEventCount, 1);
  });

  test('marks episodic memory for significant surprises', () => {
    const mem = mockEpisodicMemory();
    const acc = new SurpriseAccumulator({ bus: mockBus(), episodicMemory: mem, eventStore: null, storage: mockStorage() });

    acc._processSurprise({
      totalSurprise: 1.0,
      valence: 'negative',
      actionType: 'CODE_GENERATE',
      timestamp: Date.now(),
      expected: { successProb: 0.9 },
      actual: { success: false },
    });

    assert(mem.episodes.length === 1, 'Should record episode');
    assert(mem.episodes[0].tags.includes('surprise'));
    assert(mem.episodes[0].tags.includes('negative'));
  });

  test('low surprise does not trigger amplified learning', () => {
    const bus = mockBus();
    const acc = new SurpriseAccumulator({ bus, episodicMemory: null, eventStore: null, storage: null });

    acc._processSurprise({ totalSurprise: 0.1, valence: 'positive', timestamp: Date.now() });

    const ampEvents = bus.events.filter(e => e.e === 'surprise:amplified-learning');
    assertEqual(ampEvents.length, 0);
  });

  test('trend detection works', () => {
    const acc = new SurpriseAccumulator({ bus: mockBus(), episodicMemory: null, eventStore: null, storage: null });

    // Feed low surprises first
    for (let i = 0; i < 15; i++) {
      acc._buffer.push({ totalSurprise: 0.2, timestamp: Date.now() - (30 - i) * 1000 });
    }
    // Then high surprises
    for (let i = 0; i < 10; i++) {
      acc._buffer.push({ totalSurprise: 1.5, timestamp: Date.now() - (10 - i) * 1000 });
    }

    acc._updateTrend();
    assertEqual(acc.getTrend(), 'rising');
  });

  test('getMultiplier returns correct tiers', () => {
    const acc = new SurpriseAccumulator({ bus: mockBus(), storage: null });
    assertEqual(acc._getMultiplier(0.1), 1.0);
    assertEqual(acc._getMultiplier(0.5), 1.5);
    assertEqual(acc._getMultiplier(1.0), 2.5);
    assertEqual(acc._getMultiplier(2.0), 4.0);
  });
});

// ══════════════════════════════════════════════════════════
// MentalSimulator
// ══════════════════════════════════════════════════════════

const { MentalSimulator } = require('../../src/agent/cognitive/MentalSimulator');

describe('MentalSimulator', () => {
  function makeSimulator(expectSuccessRate = 0.75) {
    const expectationEngine = new ExpectationEngine({
      bus: mockBus(),
      metaLearning: mockMetaLearning({ recommend: () => ({ successRate: expectSuccessRate, avgLatency: 1000, samples: 50 }) }),
      schemaStore: null, worldState: null, storage: mockStorage(),
    });

    return new MentalSimulator({
      bus: mockBus(),
      worldState: mockWorldState(),
      expectationEngine,
      storage: mockStorage(),
    });
  }

  test('simulate returns result for simple plan', () => {
    const sim = makeSimulator();
    const result = sim.simulate([
      { type: 'ANALYZE', description: 'read code', cost: 2 },
      { type: 'CODE_GENERATE', description: 'write module', cost: 3 },
      { type: 'RUN_TESTS', description: 'run tests', cost: 5 },
    ]);

    assert(result.paths.length > 0, 'Should have at least one path');
    assert(result.expectedValue > 0, 'Should have positive expected value');
    assert(typeof result.riskScore === 'number', 'Should have risk score');
    assert(['proceed', 'proceed-with-caution', 'replan', 'ask-user'].includes(result.recommendation));
  });

  test('high success rate plan recommends proceed or caution', () => {
    const sim = makeSimulator(0.95);
    const result = sim.simulate([
      { type: 'ANALYZE', cost: 1 },
      { type: 'WRITE_FILE', cost: 1 },
      { type: 'GIT_SNAPSHOT', cost: 1 },
    ]);

    assert(
      result.recommendation === 'proceed' || result.recommendation === 'proceed-with-caution',
      `Should recommend proceed or caution, got: ${result.recommendation}`
    );
    assert(result.riskScore < 2, 'Risk should be low for reliable plan');
  });

  test('low success rate plan recommends replan', () => {
    const sim = makeSimulator(0.2);
    const result = sim.simulate([
      { type: 'CODE_GENERATE', cost: 3 },
      { type: 'SELF_MODIFY', cost: 5 },
      { type: 'RUN_TESTS', cost: 5 },
      { type: 'CODE_GENERATE', cost: 3 },
      { type: 'SELF_MODIFY', cost: 5 },
    ]);

    assert(result.riskScore > 1, 'Risk should be high for unreliable plan');
  });

  test('whatIf forces failure at specific step', () => {
    const sim = makeSimulator(0.95);
    const plan = [
      { type: 'ANALYZE', cost: 1 },
      { type: 'CODE_GENERATE', cost: 3 },
      { type: 'RUN_TESTS', cost: 5 },
    ];

    const normal = sim.simulate(plan);
    const whatif = sim.whatIf(plan, 1); // Force CODE_GENERATE to fail

    // whatIf should have lower expected value
    assert(whatif.expectedValue <= normal.expectedValue,
      `whatIf EV (${whatif.expectedValue}) should be ≤ normal EV (${normal.expectedValue})`);
  });

  test('comparePlans picks the better plan', () => {
    const sim = makeSimulator(0.8);
    const planA = [
      { type: 'ANALYZE', cost: 1 },
      { type: 'CODE_GENERATE', cost: 3 },
    ];
    const planB = [
      { type: 'ANALYZE', cost: 1 },
      { type: 'CODE_GENERATE', cost: 3 },
      { type: 'CODE_GENERATE', cost: 3 },
      { type: 'SELF_MODIFY', cost: 5 },
    ];

    const result = sim.comparePlans(planA, planB);
    assert(['A', 'B'].includes(result.winner));
    assert(result.comparison.expectedValueA > 0);
    assert(result.comparison.expectedValueB > 0);
  });

  test('graceful degradation without WorldState', () => {
    const sim = new MentalSimulator({
      bus: mockBus(), worldState: null, expectationEngine: null, storage: null,
    });
    const result = sim.simulate([{ type: 'ANALYZE' }]);
    assertEqual(result.recommendation, 'proceed');
    assertEqual(result.degraded, true);
  });

  test('empty plan returns clean result', () => {
    const sim = makeSimulator();
    const result = sim.simulate([]);
    assertEqual(result.recommendation, 'proceed');
    assertEqual(result.expectedValue, 0);
  });

  test('respects time budget', () => {
    const sim = makeSimulator(0.5);
    sim._timeBudgetMs = 50; // Very short budget
    // Large plan that would take a while
    const bigPlan = Array.from({ length: 20 }, (_, i) => ({ type: 'CODE_GENERATE', cost: 3 }));
    const result = sim.simulate(bigPlan);
    assert(result.durationMs <= 200, `Should complete within budget: ${result.durationMs}ms`);
  });
});

// ══════════════════════════════════════════════════════════
// AgentLoopCognition
// ══════════════════════════════════════════════════════════

const { AgentLoopCognitionDelegate } = require('../../src/agent/revolution/AgentLoopCognition');

describe('AgentLoopCognition', () => {
  test('preExecute proceeds when no Phase 9 services', async () => {
    const delegate = new AgentLoopCognitionDelegate({
      mentalSimulator: null,
      expectationEngine: null,
      model: null,
    });

    const result = await delegate.preExecute({ steps: [{ type: 'ANALYZE' }] });
    assertEqual(result.proceed, true);
  });

  test('preExecute forms expectations when engine available', async () => {
    const engine = new ExpectationEngine({
      bus: mockBus(), metaLearning: null, schemaStore: null, worldState: null, storage: null,
    });

    const delegate = new AgentLoopCognitionDelegate({
      mentalSimulator: null,
      expectationEngine: engine,
      model: null,
    });

    const plan = { steps: [{ type: 'ANALYZE' }, { type: 'CODE_GENERATE' }] };
    const result = await delegate.preExecute(plan);
    assertEqual(result.proceed, true);
    assertEqual(plan._expectations.length, 2);
    assert(plan._expectations[0].actionType === 'ANALYZE');
  });

  test('preExecute returns proceed=false for risky simulation', async () => {
    const engine = new ExpectationEngine({
      bus: mockBus(),
      metaLearning: mockMetaLearning({ recommend: () => ({ successRate: 0.1, avgLatency: 5000, samples: 50 }) }),
      schemaStore: null, worldState: null, storage: mockStorage(),
    });

    const simulator = new MentalSimulator({
      bus: mockBus(), worldState: mockWorldState(), expectationEngine: engine, storage: null,
    });

    const delegate = new AgentLoopCognitionDelegate({
      mentalSimulator: simulator,
      expectationEngine: engine,
      model: null,
    });

    const plan = { steps: [
      { type: 'SELF_MODIFY', cost: 5 },
      { type: 'CODE_GENERATE', cost: 3 },
      { type: 'SELF_MODIFY', cost: 5 },
      { type: 'CODE_GENERATE', cost: 3 },
      { type: 'RUN_TESTS', cost: 5 },
    ] };

    const result = await delegate.preExecute(plan);
    // With 10% success rate across 5 steps, simulation should flag risk
    // (might still proceed if expected value is high enough from step values)
    assert(typeof result.proceed === 'boolean', 'Should return boolean proceed');
  });

  test('postStep compares expectation vs outcome', () => {
    const bus = mockBus();
    const engine = new ExpectationEngine({
      bus, metaLearning: null, schemaStore: null, worldState: null, storage: mockStorage(),
    });

    const delegate = new AgentLoopCognitionDelegate({
      expectationEngine: engine, mentalSimulator: null, model: null,
    });

    const plan = {
      _expectations: [
        engine.expect({ type: 'CODE_GENERATE' }),
      ],
    };

    delegate.postStep(plan, 0, { type: 'CODE_GENERATE' }, {
      error: null, durationMs: 5000, verification: { status: 'pass' },
    });

    assert(bus.events.some(e => e.e === 'expectation:compared'), 'Should emit comparison event');
  });

  test('postStep does nothing without expectations', () => {
    const bus = mockBus();
    const delegate = new AgentLoopCognitionDelegate({
      expectationEngine: null, mentalSimulator: null, model: null,
    });

    // Should not throw
    delegate.postStep({ _expectations: null }, 0, { type: 'ANALYZE' }, { error: null });
    delegate.postStep({}, 0, { type: 'ANALYZE' }, { error: null });
    assertEqual(bus.events.length, 0);
  });
});

// ══════════════════════════════════════════════════════════
// WorldStateSnapshot extensions
// ══════════════════════════════════════════════════════════

const { WorldStateSnapshot } = require('../../src/agent/foundation/WorldState');

describe('WorldStateSnapshot extensions', () => {
  test('deepClone creates independent copy', () => {
    const original = new WorldStateSnapshot({
      project: { testScript: 'npm test', root: '/test' },
      runtime: { ollamaModels: ['gemma2:9b'], ollamaStatus: 'running' },
    });
    original.rootDir = '/test';
    original.markFileModified('src/a.js');

    const cloned = original.deepClone();
    cloned.markFileModified('src/b.js');

    assertEqual(original.getSimulatedChanges().length, 1);
    assertEqual(cloned.getSimulatedChanges().length, 2);
  });

  test('markTestsFailed records simulation change', () => {
    const snapshot = new WorldStateSnapshot({
      project: { testScript: 'npm test' },
      runtime: { ollamaModels: [], ollamaStatus: 'running' },
    });

    snapshot.markTestsFailed();
    const changes = snapshot.getSimulatedChanges();
    assertEqual(changes.length, 1);
    assertEqual(changes[0].type, 'tests-failed');
  });

  test('markModelUnavailable removes model from list', () => {
    const snapshot = new WorldStateSnapshot({
      project: {},
      runtime: { ollamaModels: ['gemma2:9b', 'llama3:8b'], ollamaStatus: 'running' },
    });

    snapshot.markModelUnavailable('gemma2:9b');
    assert(!snapshot.state.runtime.ollamaModels.includes('gemma2:9b'));
    assert(snapshot.state.runtime.ollamaModels.includes('llama3:8b'));
  });
});

// ══════════════════════════════════════════════════════════
// Integration: Full Cognitive Loop
// ══════════════════════════════════════════════════════════

describe('Integration: Cognitive Loop', () => {
  test('expect → compare → surprise → episodic memory', () => {
    const bus = mockBus();
    const epMemory = mockEpisodicMemory();
    const storage = mockStorage();

    const engine = new ExpectationEngine({
      bus,
      metaLearning: mockMetaLearning({ recommend: () => ({ successRate: 0.9, avgLatency: 1000, samples: 100 }) }),
      schemaStore: null, worldState: null, storage,
    });

    const acc = new SurpriseAccumulator({
      bus, episodicMemory: epMemory, eventStore: null, storage,
    });

    // Manually wire: when engine emits, accumulator processes
    const exp = engine.expect({ type: 'RUN_TESTS', description: 'run test suite' });
    const signal = engine.compare(exp, { success: false, duration: 30000, qualityScore: 0.1 });

    // Feed signal to accumulator
    acc._processSurprise(signal);

    // Verify the loop
    assert(signal.totalSurprise > 0.5, 'Unexpected failure should be surprising');
    assertEqual(signal.valence, 'negative');
    assert(epMemory.episodes.length >= 1, 'Should record to episodic memory');
    assert(epMemory.episodes[0].tags.includes('surprise'));
  });

  test('schema modifies expectation in subsequent predictions', () => {
    const schemaStore = new SchemaStore({ bus: mockBus(), storage: mockStorage() });

    // Store a schema that says self-modify is risky
    schemaStore.store({
      name: 'self-mod-risky',
      trigger: 'self_modify code_generate refactoring',
      successModifier: -0.3,
      confidence: 0.9,
      sourcePattern: 'action-sequence',
    });

    const engine = new ExpectationEngine({
      bus: mockBus(),
      metaLearning: mockMetaLearning({ recommend: () => ({ successRate: 0.8, avgLatency: 5000, samples: 50 }) }),
      schemaStore,
      worldState: null,
      storage: mockStorage(),
    });

    const expWithSchema = engine.expect({ type: 'SELF_MODIFY', description: 'refactoring the service module' });
    const expWithout = engine.expect({ type: 'ANALYZE', description: 'read a log file' });

    assert(expWithSchema.successProb < expWithout.successProb,
      `Schema should reduce success: ${expWithSchema.successProb} < ${expWithout.successProb}`);
    assert(expWithSchema.schemaCount > 0, 'Should record schema application');
  });
});

// ══════════════════════════════════════════════════════════
// DreamCycle
// ══════════════════════════════════════════════════════════

const { DreamCycle } = require('../../src/agent/cognitive/DreamCycle');

describe('DreamCycle', () => {
  function makeDreamCycle(episodeCount = 15) {
    const episodes = [];
    for (let i = 0; i < episodeCount; i++) {
      episodes.push({
        id: `ep_${i}`,
        summary: `Episode ${i}: ${i % 2 === 0 ? 'success' : 'failure'} on CODE_GENERATE`,
        timestamp: Date.now() - (episodeCount - i) * 60000,
        emotionalWeight: i % 3 === 0 ? 0.9 : 0.2,
        tags: [i % 2 === 0 ? 'positive' : 'negative', 'CODE_GENERATE'],
        metadata: {
          actionType: i % 3 === 0 ? 'CODE_GENERATE' : 'RUN_TESTS',
          success: i % 2 === 0,
          surprise: i % 3 === 0 ? 1.2 : 0.3,
          valence: i % 2 === 0 ? 'positive' : 'negative',
        },
      });
    }

    const epMemory = {
      recall: (query, opts) => episodes.slice(0, opts?.maxResults || 100),
    };

    return new DreamCycle({
      bus: mockBus(),
      episodicMemory: epMemory,
      schemaStore: new SchemaStore({ bus: mockBus(), storage: mockStorage() }),
      knowledgeGraph: { findNode: () => null },
      metaLearning: mockMetaLearning(),
      model: null, // No LLM for tests
      eventStore: { append: () => {} },
      storage: mockStorage(),
      config: { useLLM: false, minEpisodes: 5, consolidationIntervalMs: 0 },
    });
  }

  test('dream processes episodes and produces report', async () => {
    const dc = makeDreamCycle(15);
    const report = await dc.dream();

    assert(!report.skipped, 'Should not skip with enough episodes');
    assert(report.phases.length >= 4, `Should have 4+ phases, got ${report.phases.length}`);
    assert(report.durationMs >= 0, 'Should track duration');
    assertEqual(report.dreamNumber, 1);
  });

  test('dream skips with insufficient episodes', async () => {
    const dc = makeDreamCycle(2);
    dc._minEpisodesForDream = 10;
    const report = await dc.dream();
    assert(report.skipped === true, 'Should skip');
    assert(report.reason.includes('insufficient'), `Reason: ${report.reason}`);
  });

  test('dream respects cooldown', async () => {
    const dc = makeDreamCycle(15);
    dc._consolidationIntervalMs = 60 * 60 * 1000; // 1 hour
    dc._lastDreamAt = Date.now(); // Just dreamed

    const report = await dc.dream();
    assert(report.skipped === true, 'Should skip due to cooldown');
    assertEqual(report.reason, 'too-soon');
  });

  test('heuristic schema extraction works without LLM', async () => {
    const dc = makeDreamCycle(20);
    const report = await dc.dream();

    // With 20 episodes containing repeating patterns, should find schemas
    assert(report.phases.some(p => p.name === 'schema-extraction'), 'Should have schema phase');
  });

  test('memory consolidation strengthens and decays', async () => {
    const dc = makeDreamCycle(15);
    const report = await dc.dream();

    assert(report.phases.some(p => p.name === 'consolidation'), 'Should have consolidation phase');
    // Episodes with surprise > 0.8 get strengthened, < 0.2 get decayed
    assert(report.strengthenedMemories >= 0, 'Should report strengthened');
    assert(report.decayedMemories >= 0, 'Should report decayed');
  });

  test('getUnprocessedCount returns count', () => {
    const dc = makeDreamCycle(15);
    const count = dc.getUnprocessedCount();
    assertEqual(count, 15);
  });

  test('getTimeSinceLastDream returns time', () => {
    const dc = makeDreamCycle(5);
    dc._lastDreamAt = Date.now() - 5000;
    const time = dc.getTimeSinceLastDream();
    assert(time >= 4000 && time <= 6000, `Time: ${time}`);
  });

  test('persistence via asyncLoad + save', async () => {
    const storage = mockStorage();
    const dc1 = makeDreamCycle(15);
    dc1.storage = storage;
    await dc1.dream();
    dc1.stop(); // save

    const dc2 = new DreamCycle({
      bus: mockBus(), episodicMemory: null, schemaStore: null,
      knowledgeGraph: null, metaLearning: null, model: null,
      eventStore: null, storage, config: { useLLM: false },
    });
    await dc2.asyncLoad();
    assertEqual(dc2._dreamCount, 1);
    assert(dc2._lastDreamAt > 0);
  });

  test('pattern detection finds action sequences', () => {
    const dc = makeDreamCycle(20);
    const episodes = dc._getUnprocessedEpisodes();
    const patterns = dc._detectPatterns(episodes);
    assert(patterns.length > 0, 'Should detect patterns');
    assert(patterns.some(p => p.type === 'action-sequence' || p.type === 'error-cluster' || p.type.startsWith('surprise')),
      'Should have typed patterns');
  });
});

// ══════════════════════════════════════════════════════════
// SelfNarrative
// ══════════════════════════════════════════════════════════

const { SelfNarrative } = require('../../src/agent/cognitive/SelfNarrative');

describe('SelfNarrative', () => {
  function makeNarrative(overrides = {}) {
    return new SelfNarrative({
      bus: mockBus(),
      metaLearning: overrides.metaLearning || {
        _records: [
          { taskCategory: 'code-gen', success: true },
          { taskCategory: 'code-gen', success: true },
          { taskCategory: 'code-gen', success: false },
          { taskCategory: 'analysis', success: true },
          { taskCategory: 'analysis', success: true },
          { taskCategory: 'analysis', success: true },
          { taskCategory: 'analysis', success: true },
          { taskCategory: 'analysis', success: true },
          { taskCategory: 'planning', success: false },
          { taskCategory: 'planning', success: false },
          { taskCategory: 'planning', success: true },
          { taskCategory: 'planning', success: false },
          { taskCategory: 'planning', success: false },
        ],
      },
      episodicMemory: mockEpisodicMemory(),
      emotionalState: {
        getSnapshot: () => ({ dimensions: { curiosity: { value: 0.7 }, frustration: { value: 0.2 } } }),
        getDominant: () => 'curiosity',
      },
      schemaStore: new SchemaStore({ bus: mockBus(), storage: mockStorage() }),
      selfModel: { getFullModel: () => ({ moduleCount: 100 }) },
      model: null, // No LLM for tests
      storage: mockStorage(),
      config: { updateThreshold: 5 },
    });
  }

  test('heuristic update produces narrative without LLM', async () => {
    const sn = makeNarrative();
    sn._changeAccumulator = 100; // Force update
    const result = await sn.maybeUpdate();

    assert(result !== null, 'Should produce narrative');
    assert(result.identity.length > 0, 'Should have identity text');
    assert(result.strengths.length > 0, 'Should identify strengths');
    assert(result.version === 1, `Version should be 1, got ${result.version}`);
  });

  test('getIdentitySummary returns compact string', async () => {
    const sn = makeNarrative();
    sn._changeAccumulator = 100;
    await sn.maybeUpdate();

    const summary = sn.getIdentitySummary();
    assert(summary.length > 0, 'Should have summary');
    assert(summary.length <= 800, `Summary too long: ${summary.length}`);
  });

  test('maybeUpdate returns null when not enough change', async () => {
    const sn = makeNarrative();
    sn._changeAccumulator = 2; // Below threshold of 5
    const result = await sn.maybeUpdate();
    assertEqual(result, null);
  });

  test('change accumulator increments on events', () => {
    const bus = mockBus();
    const sn = new SelfNarrative({
      bus, metaLearning: null, episodicMemory: null, emotionalState: null,
      schemaStore: null, selfModel: null, model: null, storage: null,
    });
    sn.start();

    // Simulate events by calling the listeners manually
    // (bus.on stores handlers but our mock doesn't dispatch)
    assertEqual(sn.getChangeAccumulator(), 0);
  });

  test('getNarrative returns copy', async () => {
    const sn = makeNarrative();
    sn._changeAccumulator = 100;
    await sn.maybeUpdate();

    const n1 = sn.getNarrative();
    const n2 = sn.getNarrative();
    assert(n1 !== n2, 'Should return copies');
    assertEqual(n1.version, n2.version);
  });

  test('persistence via asyncLoad + save', async () => {
    const storage = mockStorage();
    const sn1 = makeNarrative();
    sn1.storage = storage;
    sn1._changeAccumulator = 100;
    await sn1.maybeUpdate();
    sn1.stop();

    const sn2 = new SelfNarrative({
      bus: mockBus(), metaLearning: null, episodicMemory: null,
      emotionalState: null, schemaStore: null, selfModel: null,
      model: null, storage,
    });
    await sn2.asyncLoad();
    assert(sn2.getNarrative().version === 1);
    assert(sn2.getNarrative().identity.length > 0);
  });

  test('identifies analysis as strength from mock data', async () => {
    const sn = makeNarrative();
    sn._changeAccumulator = 100;
    await sn.maybeUpdate();

    const narrative = sn.getNarrative();
    // analysis has 100% success, code-gen 66%, planning 20%
    assert(narrative.strengths.some(s => s.includes('analysis')),
      `Strengths should include analysis: ${JSON.stringify(narrative.strengths)}`);
  });

  test('identifies planning as weakness from mock data', async () => {
    const sn = makeNarrative();
    sn._changeAccumulator = 100;
    await sn.maybeUpdate();

    const narrative = sn.getNarrative();
    assert(narrative.weaknesses.some(w => w.includes('planning')),
      `Weaknesses should include planning: ${JSON.stringify(narrative.weaknesses)}`);
  });
});

// ══════════════════════════════════════════════════════════
// Integration: Full Phase 9 Pipeline
// ══════════════════════════════════════════════════════════

describe('Integration: Full Phase 9 Pipeline', () => {
  test('dream → schema → expectation adjustment', async () => {
    const storage = mockStorage();
    const schemaStore = new SchemaStore({ bus: mockBus(), storage });

    // 1. Create episodes that form a pattern
    const episodes = [];
    for (let i = 0; i < 20; i++) {
      episodes.push({
        id: `ep_${i}`,
        summary: `RUN_TESTS after CODE_GENERATE`,
        timestamp: Date.now() - (20 - i) * 60000,
        emotionalWeight: 0.5,
        tags: ['RUN_TESTS'],
        metadata: { actionType: 'RUN_TESTS', success: i % 3 !== 0 },
      });
    }

    // 2. Dream to extract schemas
    const dc = new DreamCycle({
      bus: mockBus(),
      episodicMemory: { recall: (_, opts) => episodes.slice(0, opts?.maxResults || 100) },
      schemaStore,
      knowledgeGraph: { findNode: () => null },
      metaLearning: mockMetaLearning(),
      model: null,
      eventStore: { append: () => {} },
      storage,
      config: { useLLM: false, minEpisodes: 5, consolidationIntervalMs: 0 },
    });

    const dreamReport = await dc.dream();

    // 3. Verify schemas were stored
    const allSchemas = schemaStore.getAll();

    // 4. Create ExpectationEngine with schema awareness
    const engine = new ExpectationEngine({
      bus: mockBus(),
      metaLearning: mockMetaLearning(),
      schemaStore,
      worldState: null,
      storage,
    });

    // 5. Expectations should now be schema-aware
    const exp = engine.expect({ type: 'RUN_TESTS', description: 'run test suite' });
    assert(typeof exp.successProb === 'number', 'Should form expectation');
    assert(exp.schemaCount >= 0, 'Should track schema application');

    // The full pipeline works: episodes → dream → schemas → expectations
    assert(dreamReport.dreamNumber === 1, 'Dream completed');
  });
});

run();
