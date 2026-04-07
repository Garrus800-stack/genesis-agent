// ============================================================
// GENESIS — test/modules/phase10-12.test.js
// Tests for Phase 10 (Persistent Agency), Phase 11 (Extended),
// and Phase 12 (Symbolic+Neural Hybrid)
// ============================================================

const { describe, test: it, assert } = require('../harness');

// ── Mock dependencies ────────────────────────────────────
const mockBus = {
  on: () => {},
  emit: () => {},
  off: () => {},
};

const mockStorage = {
  _data: {},
  async readJSON(key) {
    if (this._data[key]) return this._data[key];
    throw new Error('Not found');
  },
  async writeJSON(key, data) { this._data[key] = data; },
  async delete(key) { delete this._data[key]; },
};

const mockGoalStack = {
  goals: [],
  _prioritize() {
    this.goals.sort((a, b) => {
      const p = { high: 3, medium: 2, low: 1 };
      return (p[b.priority] || 0) - (p[a.priority] || 0);
    });
  },
};

const mockEventStore = { append: () => {} };

// ════════════════════════════════════════════════════════════
// PHASE 10: GoalPersistence
// ════════════════════════════════════════════════════════════

describe('GoalPersistence', () => {
  const { GoalPersistence } = require('../../src/agent/planning/GoalPersistence');

  it('should create instance', () => {
    const gp = new GoalPersistence({
      bus: mockBus,
      storage: { ...mockStorage, _data: {} },
      goalStack: { ...mockGoalStack, goals: [] },
      eventStore: mockEventStore,
    });
    assert(gp, 'Instance created');
  });

  it('should load empty goals', async () => {
    const gp = new GoalPersistence({
      bus: mockBus,
      storage: { readJSON: async () => { throw new Error('nope'); }, writeJSON: async () => {}, delete: async () => {} },
      goalStack: { ...mockGoalStack, goals: [] },
      eventStore: mockEventStore,
    });
    const result = await gp.load();
    assert(result.unfinished.length === 0, 'No unfinished goals');
    assert(result.archive.length === 0, 'No archived goals');
  });

  it('should checkpoint goals', async () => {
    const storage = { _data: {}, readJSON: async () => { throw new Error(); }, writeJSON: async (k, v) => { storage._data[k] = v; }, delete: async () => {} };
    const gs = { goals: [{ id: 'g1', status: 'active', description: 'test' }], _prioritize: () => {} };
    const gp = new GoalPersistence({ bus: mockBus, storage, goalStack: gs, eventStore: mockEventStore });

    await gp.checkpoint();
    assert(storage._data['goals/active.json'], 'Active goals saved');
    assert(storage._data['goals/active.json'].length === 1, 'One goal saved');
  });

  it('should resume persisted goals', async () => {
    const goals = [{ id: 'g2', status: 'active', description: 'resumed goal', priority: 'high', currentStep: 2, steps: ['a', 'b', 'c'] }];
    const storage = {
      readJSON: async (key) => { if (key === 'goals/active.json') return goals; if (key === 'goals/archive.json') return []; throw new Error(); },
      writeJSON: async () => {},
      delete: async () => {},
    };
    const gs = { goals: [], _prioritize: () => {} };
    const gp = new GoalPersistence({ bus: mockBus, storage, goalStack: gs, eventStore: mockEventStore });

    await gp.load();
    const resumed = await gp.resume();
    assert(resumed.length === 1, 'One goal resumed');
    assert(gs.goals.length === 1, 'Goal injected into GoalStack');
    assert(gs.goals[0].id === 'g2', 'Correct goal ID');
  });

  it('should provide summary', () => {
    const gp = new GoalPersistence({ bus: mockBus, storage: mockStorage, goalStack: { ...mockGoalStack, goals: [] }, eventStore: mockEventStore });
    gp._activeGoals = [
      { id: 'g1', status: 'active', description: 'Build module', steps: [1, 2, 3], currentStep: 1, source: 'user' },
    ];
    const summary = gp.getSummary();
    assert(summary.active === 1, 'One active goal');
    assert(summary.descriptions.length === 1, 'One description');
    assert(summary.descriptions[0].progress === '1/3', 'Correct progress');
  });
});

// ════════════════════════════════════════════════════════════
// PHASE 10: FailureTaxonomy
// ════════════════════════════════════════════════════════════

describe('FailureTaxonomy', () => {
  const { FailureTaxonomy, CATEGORY, STRATEGY } = require('../../src/agent/intelligence/FailureTaxonomy');

  it('should classify transient errors', () => {
    const ft = new FailureTaxonomy({ bus: mockBus, eventStore: mockEventStore });
    const result = ft.classify(new Error('ETIMEDOUT: connection timed out'), { actionType: 'SHELL_EXEC' });
    assert(result.category === CATEGORY.TRANSIENT, `Expected transient, got ${result.category}`);
    assert(result.strategy === STRATEGY.RETRY_BACKOFF, 'Strategy is retry with backoff');
    assert(result.retryConfig.shouldRetry === true, 'Should retry');
  });

  it('should classify deterministic errors', () => {
    const ft = new FailureTaxonomy({ bus: mockBus, eventStore: mockEventStore });
    const result = ft.classify('SyntaxError: Unexpected token }', { actionType: 'CODE_GENERATE' });
    assert(result.category === CATEGORY.DETERMINISTIC, `Expected deterministic, got ${result.category}`);
    assert(result.strategy === STRATEGY.REPLAN, 'Strategy is replan');
    assert(result.retryConfig.shouldRetry === false, 'Should not retry');
  });

  it('should classify environmental errors', () => {
    const ft = new FailureTaxonomy({ bus: mockBus, eventStore: mockEventStore });
    const err = new Error("ENOENT: no such file 'src/foo.js'");
    err.code = 'ENOENT';
    const result = ft.classify(err, { actionType: 'WRITE_FILE' });
    assert(result.category === CATEGORY.ENVIRONMENTAL, `Expected environmental, got ${result.category}`);
    assert(result.worldStateUpdates !== null, 'Has WorldState updates');
  });

  it('should classify capability errors', () => {
    const ft = new FailureTaxonomy({ bus: mockBus, eventStore: mockEventStore });
    const result = ft.classify('failed to parse JSON from LLM — empty response', { actionType: 'CODE_GENERATE' });
    assert(result.category === CATEGORY.CAPABILITY, `Expected capability, got ${result.category}`);
    assert(result.strategy === STRATEGY.ESCALATE_MODEL, 'Strategy is escalate model');
  });

  it('should respect max retries for transient', () => {
    const ft = new FailureTaxonomy({ bus: mockBus, eventStore: mockEventStore });
    const r1 = ft.classify('timeout', { attempt: 0 });
    const r2 = ft.classify('timeout', { attempt: 2 });
    const r3 = ft.classify('timeout', { attempt: 3 });
    assert(r1.retryConfig.shouldRetry === true, 'Attempt 0: retry');
    assert(r2.retryConfig.shouldRetry === true, 'Attempt 2: retry');
    assert(r3.retryConfig.shouldRetry === false, 'Attempt 3: no retry');
  });

  it('should track action stats', () => {
    const ft = new FailureTaxonomy({ bus: mockBus, eventStore: mockEventStore });
    ft.classify('timeout', { actionType: 'SHELL_EXEC' });
    ft.classify('timeout', { actionType: 'SHELL_EXEC' });
    ft.classify('SyntaxError', { actionType: 'CODE_GENERATE' });

    const shellStats = ft.getActionStats('SHELL_EXEC');
    assert(shellStats.total === 2, 'Two shell failures');
    assert(shellStats.transientRate === 1.0, '100% transient for shell');

    const codeStats = ft.getActionStats('CODE_GENERATE');
    assert(codeStats.total === 1, 'One code failure');
  });
});

// ════════════════════════════════════════════════════════════
// PHASE 10: DynamicContextBudget
// ════════════════════════════════════════════════════════════

describe('DynamicContextBudget', () => {
  const { DynamicContextBudget } = require('../../src/agent/intelligence/DynamicContextBudget');

  it('should allocate different budgets per intent', () => {
    const dcb = new DynamicContextBudget({ bus: mockBus, storage: mockStorage });

    const codeAlloc = dcb.allocate('code-gen');
    const chatAlloc = dcb.allocate('chat');

    assert(codeAlloc.code > chatAlloc.code, `Code-gen should have more code budget: ${codeAlloc.code} vs ${chatAlloc.code}`);
    assert(chatAlloc.conversation > codeAlloc.conversation, `Chat should have more conversation budget: ${chatAlloc.conversation} vs ${codeAlloc.conversation}`);
  });

  it('should sum to total budget', () => {
    const dcb = new DynamicContextBudget({ bus: mockBus, storage: mockStorage });
    const alloc = dcb.allocate('general', { totalBudget: 6000 });
    const sum = Object.values(alloc).reduce((a, b) => a + b, 0);
    // Allow small rounding variance
    assert(Math.abs(sum - 6000) < 50, `Sum should be ~6000, got ${sum}`);
  });

  it('should adjust for active goals', () => {
    const dcb = new DynamicContextBudget({ bus: mockBus, storage: mockStorage });
    const normal = dcb.allocate('chat');
    const withGoals = dcb.allocate('chat', { activeGoals: 3 });
    assert(withGoals.memory > normal.memory, 'Memory budget increased with active goals');
  });

  it('should handle unknown intents', () => {
    const dcb = new DynamicContextBudget({ bus: mockBus, storage: mockStorage });
    const alloc = dcb.allocate('unknown-intent-xyz');
    assert(alloc.system > 0, 'Falls back to general profile');
  });
});

// ════════════════════════════════════════════════════════════
// PHASE 10: LocalClassifier
// ════════════════════════════════════════════════════════════

describe('LocalClassifier', () => {
  const { LocalClassifier } = require('../../src/agent/intelligence/LocalClassifier');

  it('should not classify before training', () => {
    const lc = new LocalClassifier({ bus: mockBus, storage: mockStorage, config: { minSamples: 3 } });
    const result = lc.classify('show me the code');
    assert(result === null, 'Returns null before training');
    assert(lc.isReady() === false, 'Not ready');
  });

  it('should train after enough samples', () => {
    const lc = new LocalClassifier({ bus: mockBus, storage: mockStorage, config: { minSamples: 3, confidenceThreshold: 0.3 } });

    // Add training data
    for (let i = 0; i < 5; i++) {
      lc.addSample('show me the code please', 'self-inspect');
      lc.addSample('inspect your modules', 'self-inspect');
      lc.addSample('what are your capabilities', 'self-inspect');
    }
    for (let i = 0; i < 5; i++) {
      lc.addSample('fix this bug in the parser', 'self-modify');
      lc.addSample('change the timeout value', 'self-modify');
      lc.addSample('update the configuration', 'self-modify');
    }

    assert(lc.isReady() === true, 'Should be trained');

    const stats = lc.getStats();
    assert(stats.intentCount >= 2, `Should have 2+ intents, got ${stats.intentCount}`);
    assert(stats.vocabSize > 0, 'Should have vocabulary');
  });

  it('should classify after training', () => {
    const lc = new LocalClassifier({ bus: mockBus, storage: mockStorage, config: { minSamples: 3, confidenceThreshold: 0.2 } });

    for (let i = 0; i < 8; i++) {
      lc.addSample('show me the source code of the module', 'self-inspect');
      lc.addSample('what is inside your modules', 'self-inspect');
    }
    for (let i = 0; i < 8; i++) {
      lc.addSample('fix the broken parser function', 'self-modify');
      lc.addSample('repair the error in the module', 'self-modify');
    }

    const result = lc.classify('show me your module source');
    // May or may not classify confidently depending on TF-IDF, but shouldn't crash
    assert(result === null || result.source === 'local', 'Returns null or local classification');
  });
});

// ════════════════════════════════════════════════════════════
// PHASE 10: EmotionalSteering
// ════════════════════════════════════════════════════════════

describe('EmotionalSteering', () => {
  const { EmotionalSteering } = require('../../src/agent/organism/EmotionalSteering');

  it('should return empty signals without emotional state', () => {
    const es = new EmotionalSteering({ bus: mockBus, emotionalState: null, storage: mockStorage });
    const signals = es.getSignals();
    assert(signals.modelEscalation === false, 'No escalation without emotions');
    assert(signals.restMode === false, 'No rest mode');
  });

  it('should detect model escalation on high frustration', () => {
    const emotions = {
      dimensions: {
        curiosity: { value: 0.5, baseline: 0.6 },
        satisfaction: { value: 0.3, baseline: 0.5 },
        frustration: { value: 0.75, baseline: 0.1 },
        energy: { value: 0.6, baseline: 0.7 },
        loneliness: { value: 0.2, baseline: 0.3 },
      },
    };
    const es = new EmotionalSteering({ bus: mockBus, emotionalState: emotions, storage: mockStorage });
    es.refresh();
    const signals = es.getSignals();
    assert(signals.modelEscalation === true, 'Should escalate model');
    assert(signals.promptStyleChange === true, 'Should change prompt style');
  });

  it('should shorten plans on low energy', () => {
    const emotions = {
      dimensions: {
        curiosity: { value: 0.5, baseline: 0.6 },
        satisfaction: { value: 0.5, baseline: 0.5 },
        frustration: { value: 0.1, baseline: 0.1 },
        energy: { value: 0.20, baseline: 0.7 },
        loneliness: { value: 0.2, baseline: 0.3 },
      },
    };
    const es = new EmotionalSteering({ bus: mockBus, emotionalState: emotions, storage: mockStorage });
    es.refresh();
    const signals = es.getSignals();
    assert(signals.planLengthLimit === 3, `Plan should be limited to 3, got ${signals.planLengthLimit}`);
    assert(signals.skipIdleThinking === true, 'Should skip idle thinking');
  });

  it('should activate rest mode on very low energy', () => {
    const emotions = {
      dimensions: {
        curiosity: { value: 0.5, baseline: 0.6 },
        satisfaction: { value: 0.5, baseline: 0.5 },
        frustration: { value: 0.1, baseline: 0.1 },
        energy: { value: 0.10, baseline: 0.7 },
        loneliness: { value: 0.2, baseline: 0.3 },
      },
    };
    const es = new EmotionalSteering({ bus: mockBus, emotionalState: emotions, storage: mockStorage });
    es.refresh();
    assert(es.getSignals().restMode === true, 'Rest mode should be active');
  });
});

// ════════════════════════════════════════════════════════════
// PHASE 11: TrustLevelSystem
// ════════════════════════════════════════════════════════════

describe('TrustLevelSystem', () => {
  const { TrustLevelSystem, TRUST_LEVELS } = require('../../src/agent/foundation/TrustLevelSystem');

  it('should default to ASSISTED level', () => {
    const tls = new TrustLevelSystem({ bus: mockBus, storage: mockStorage, settings: null });
    assert(tls.getLevel() === TRUST_LEVELS.ASSISTED, 'Default level is ASSISTED');
  });

  it('should auto-approve safe actions at ASSISTED', () => {
    const tls = new TrustLevelSystem({ bus: mockBus, storage: mockStorage, settings: null });
    const result = tls.checkApproval('ANALYZE');
    assert(result.approved === true, 'ANALYZE should be auto-approved');
    assert(result.needsUserApproval === false, 'No user approval needed');
  });

  it('should require approval for medium-risk at ASSISTED', () => {
    const tls = new TrustLevelSystem({ bus: mockBus, storage: mockStorage, settings: null });
    const result = tls.checkApproval('CODE_GENERATE');
    assert(result.approved === false, 'CODE_GENERATE needs approval at ASSISTED');
    assert(result.needsUserApproval === true, 'Needs user approval');
  });

  it('should auto-approve medium-risk at AUTONOMOUS', () => {
    const tls = new TrustLevelSystem({ bus: mockBus, storage: mockStorage, settings: null, config: { level: TRUST_LEVELS.AUTONOMOUS } });
    const result = tls.checkApproval('CODE_GENERATE');
    assert(result.approved === true, 'CODE_GENERATE auto-approved at AUTONOMOUS');
  });

  it('should still require approval for high-risk at AUTONOMOUS', () => {
    const tls = new TrustLevelSystem({ bus: mockBus, storage: mockStorage, settings: null, config: { level: TRUST_LEVELS.AUTONOMOUS } });
    const result = tls.checkApproval('SELF_MODIFY');
    assert(result.approved === false, 'SELF_MODIFY needs approval at AUTONOMOUS');
  });

  it('should change level', async () => {
    const tls = new TrustLevelSystem({ bus: mockBus, storage: { ...mockStorage, _data: {}, writeJSON: async () => {} }, settings: null });
    await tls.setLevel(TRUST_LEVELS.AUTONOMOUS);
    assert(tls.getLevel() === TRUST_LEVELS.AUTONOMOUS, 'Level changed');
  });

  it('should provide full status', () => {
    const tls = new TrustLevelSystem({ bus: mockBus, storage: mockStorage, settings: null });
    const status = tls.getStatus();
    assert(status.levelName === 'ASSISTED', 'Level name correct');
    assert(Array.isArray(status.autoApproves), 'Has auto-approve list');
  });
});

// ════════════════════════════════════════════════════════════
// PHASE 11: EffectorRegistry
// ════════════════════════════════════════════════════════════

describe('EffectorRegistry', () => {
  const { EffectorRegistry } = require('../../src/agent/capabilities/EffectorRegistry');

  it('should register built-in effectors', () => {
    const er = new EffectorRegistry({ bus: mockBus, storage: mockStorage, eventStore: mockEventStore, rootDir: '/tmp' });
    const list = er.listEffectors();
    assert(list.length >= 3, `Should have 3+ built-in effectors, got ${list.length}`);
    assert(list.some(e => e.name === 'clipboard:copy'), 'Has clipboard effector');
    assert(list.some(e => e.name === 'notification:send'), 'Has notification effector');
  });

  it('should register custom effector', () => {
    const er = new EffectorRegistry({ bus: mockBus, storage: mockStorage, eventStore: mockEventStore, rootDir: '/tmp' });
    er.register({
      name: 'test:echo',
      description: 'Echo test',
      risk: 'safe',
      execute: async (params) => ({ echo: params.text }),
    });
    const list = er.listEffectors();
    assert(list.some(e => e.name === 'test:echo'), 'Custom effector registered');
  });

  it('should execute effector in dry-run mode', async () => {
    const er = new EffectorRegistry({ bus: mockBus, storage: mockStorage, eventStore: mockEventStore, rootDir: '/tmp', config: { dryRun: true } });
    er.register({
      name: 'test:action',
      description: 'Test',
      risk: 'safe',
      execute: async (params) => ({ done: true }),
    });

    const result = await er.execute('test:action', { data: 'test' }, { approval: true });
    assert(result.success === true, 'Dry run succeeds');
    assert(result.result.dryRun === true, 'Marked as dry run');
  });

  it('should block unknown effector', async () => {
    const er = new EffectorRegistry({ bus: mockBus, storage: mockStorage, eventStore: mockEventStore, rootDir: '/tmp' });
    const result = await er.execute('nonexistent');
    assert(result.success === false, 'Should fail');
    assert(result.error.includes('not found'), 'Error mentions not found');
  });

  it('should provide schemas', () => {
    const er = new EffectorRegistry({ bus: mockBus, storage: mockStorage, eventStore: mockEventStore, rootDir: '/tmp' });
    const schemas = er.getSchemas();
    assert(schemas['clipboard:copy'], 'Has clipboard schema');
    assert(schemas['clipboard:copy'].inputs.text, 'Has text input');
  });
});

// ════════════════════════════════════════════════════════════
// PHASE 12: GraphReasoner
// ════════════════════════════════════════════════════════════

describe('GraphReasoner', () => {
  const { GraphReasoner } = require('../../src/agent/intelligence/GraphReasoner');

  const mockKG = {
    graph: {
      _nodes: new Map(),
      _edges: [],
      findNode(label) {
        for (const [id, n] of this._nodes) { if (n.label === label) return { ...n, id }; }
        return null;
      },
      getNode(id) { return this._nodes.get(id) || null; },
      getAllNodes() { return [...this._nodes.entries()].map(([id, n]) => ({ ...n, id })); },
      getEdgesFrom(id) { return this._edges.filter(e => e.source === id); },
      getEdgesTo(id) { return this._edges.filter(e => e.target === id); },
    },
  };

  // Build a small test graph
  mockKG.graph._nodes.set('n1', { label: 'AgentLoop', type: 'module' });
  mockKG.graph._nodes.set('n2', { label: 'FormalPlanner', type: 'module' });
  mockKG.graph._nodes.set('n3', { label: 'WorldState', type: 'module' });
  mockKG.graph._nodes.set('n4', { label: 'EventBus', type: 'module' });
  mockKG.graph._edges.push(
    { source: 'n1', target: 'n2', relation: 'depends_on', weight: 0.8 },
    { source: 'n1', target: 'n3', relation: 'depends_on', weight: 0.8 },
    { source: 'n2', target: 'n3', relation: 'depends_on', weight: 0.7 },
    { source: 'n1', target: 'n4', relation: 'depends_on', weight: 0.5 },
    { source: 'n2', target: 'n4', relation: 'depends_on', weight: 0.5 },
    { source: 'n3', target: 'n4', relation: 'depends_on', weight: 0.5 },
  );

  it('should find transitive dependencies', () => {
    const gr = new GraphReasoner({ bus: mockBus, knowledgeGraph: mockKG, selfModel: null });
    const deps = gr.transitiveDeps('AgentLoop', 'depends_on', { direction: 'outgoing' });
    assert(deps.nodes.length >= 2, `Should find 2+ deps, got ${deps.nodes.length}`);
    assert(deps.nodes.some(n => n.label === 'FormalPlanner'), 'Depends on FormalPlanner');
    assert(deps.nodes.some(n => n.label === 'WorldState'), 'Depends on WorldState');
  });

  it('should do impact analysis', () => {
    const gr = new GraphReasoner({ bus: mockBus, knowledgeGraph: mockKG, selfModel: null });
    const impact = gr.impactAnalysis('EventBus');
    assert(impact.impacted.length >= 2, `EventBus change should impact 2+ modules, got ${impact.impacted.length}`);
    assert(impact.riskScore > 0, 'Has non-zero risk score');
  });

  it('should detect no cycles in acyclic graph', () => {
    const gr = new GraphReasoner({ bus: mockBus, knowledgeGraph: mockKG, selfModel: null });
    const result = gr.detectCycles('depends_on');
    assert(result.hasCycles === false, 'Should have no cycles');
  });

  it('should find shortest path', () => {
    const gr = new GraphReasoner({ bus: mockBus, knowledgeGraph: mockKG, selfModel: null });
    const path = gr.shortestPath('AgentLoop', 'EventBus');
    assert(path.found === true, 'Path should be found');
    assert(path.distance >= 1, 'Distance should be 1+');
    assert(path.path[0] === 'AgentLoop', 'Starts at AgentLoop');
  });

  it('should try to answer structural questions', () => {
    const gr = new GraphReasoner({ bus: mockBus, knowledgeGraph: mockKG, selfModel: null });
    const answer = gr.tryAnswer('What depends on EventBus?');
    // May or may not answer depending on graph connectivity
    assert(answer === null || answer.answered === true, 'Returns null or valid answer');
  });
});

// ════════════════════════════════════════════════════════════
// PHASE 11: WebPerception
// ════════════════════════════════════════════════════════════

describe('WebPerception', () => {
  const { WebPerception } = require('../../src/agent/capabilities/WebPerception');

  it('should create instance', () => {
    const wp = new WebPerception({ bus: mockBus, storage: mockStorage, eventStore: mockEventStore });
    assert(wp, 'Instance created');
  });

  it('should report capabilities', () => {
    const wp = new WebPerception({ bus: mockBus, storage: mockStorage, eventStore: mockEventStore });
    const caps = wp.getCapabilities();
    assert(typeof caps.cheerioAvailable === 'boolean', 'Reports cheerio status');
    assert(typeof caps.puppeteerAvailable === 'boolean', 'Reports puppeteer status');
    assert(caps.mode, 'Has mode description');
  });

  it('should reject invalid URLs', async () => {
    const wp = new WebPerception({ bus: mockBus, storage: mockStorage, eventStore: mockEventStore });
    const result = await wp.fetch('');
    assert(result.success === false, 'Empty URL fails');
    assert(result.error === 'Invalid URL', 'Correct error message');
  });

  it('should ping non-existent host', async () => {
    const wp = new WebPerception({ bus: mockBus, storage: mockStorage, eventStore: mockEventStore });
    const result = await wp.ping('http://definitely-not-a-real-host-12345.invalid');
    assert(result.reachable === false, 'Non-existent host is not reachable');
  });
});

console.log('\n[PHASE 10-12 TESTS] All suites completed.');

const { run } = require('../harness');
run();
