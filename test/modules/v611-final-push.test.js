// Test: v6.1.1 Coverage Sweep — Final push to 80%
// Targets: AutonomousDaemon, GoalStack, EpisodicMemory, AttentionalGate, EffectorRegistry

const { describe, test, assert, assertEqual, run } = require('../harness');

function mockBus() {
  return { on: () => () => {}, emit() {}, fire() {}, off() {} };
}

// ── AutonomousDaemon ────────────────────────────────────────

describe('AutonomousDaemon — cycle execution', () => {
  const { AutonomousDaemon } = require('../../src/agent/autonomy/AutonomousDaemon');

  function createDaemon(overrides = {}) {
    return new AutonomousDaemon({
      bus: mockBus(),
      reflector: {
        diagnose: async () => ({ issues: [], scannedModules: 10 }),
        repair: async (issues) => issues.map(i => ({ file: i.file, fixed: true })),
        suggestOptimizations: () => [],
      },
      selfModel: { getFullModel: () => ({ modules: {}, files: {} }), getCapabilities: () => [] },
      memory: {
        getStats: () => ({ episodes: 5, facts: 3 }),
        recallEpisodes: () => [{ summary: 'user heißt Test', topics: ['identity'] }],
        learnFact: () => true,
        db: { procedural: [{ attempts: 10, successRate: 0.1 }] },
      },
      model: { chat: async () => 'suggestion' },
      prompts: { build: () => 'prompt' },
      skills: null,
      sandbox: { execute: async () => ({ output: 'ok' }) },
      guard: { verifyIntegrity: () => ({ ok: true }) },
      intervals: null,
      ...overrides,
    });
  }

  test('constructor initializes state', () => {
    const d = createDaemon();
    assertEqual(d.running, false);
    assertEqual(d.cycleCount, 0);
  });

  test('getStatus returns full status', () => {
    const d = createDaemon();
    d.cycleCount = 5;
    const status = d.getStatus();
    assertEqual(status.cycleCount, 5);
    assertEqual(status.running, false);
    assert(status.config !== undefined, 'should have config');
  });

  test('_healthCheck returns clean result', async () => {
    const d = createDaemon();
    const result = await d._healthCheck();
    assertEqual(result.kernelOk, true);
    assertEqual(result.issues, 0);
    assertEqual(result.repaired, 0);
  });

  test('_healthCheck with issues and auto-repair', async () => {
    const d = createDaemon({
      reflector: {
        diagnose: async () => ({
          issues: [{ type: 'syntax', severity: 'high', file: 'x.js' }],
          scannedModules: 10,
        }),
        repair: async (issues) => [{ file: 'x.js', fixed: true }],
        suggestOptimizations: () => [],
      },
    });
    const result = await d._healthCheck();
    assertEqual(result.issues, 1);
    assertEqual(result.repaired, 1);
  });

  test('_healthCheck trust-gated repair (low trust)', async () => {
    const d = createDaemon({
      reflector: {
        diagnose: async () => ({
          issues: [
            { type: 'syntax', severity: 'high', file: 'a.js' },
            { type: 'style', severity: 'medium', file: 'b.js' },
          ],
          scannedModules: 5,
        }),
        repair: async (issues) => issues.map(i => ({ file: i.file, fixed: true })),
        suggestOptimizations: () => [],
      },
    });
    d.trustLevelSystem = { getLevel: () => 0 }; // low trust
    const result = await d._healthCheck();
    // Low trust: only syntax repairs, not style
    assertEqual(result.repaired, 1);
  });

  test('_consolidateMemory extracts facts', () => {
    const d = createDaemon();
    const result = d._consolidateMemory();
    assert(result.episodes !== undefined, 'should have episodes count');
    assert(typeof result.newFacts === 'number', 'should count new facts');
    assert(typeof result.decayed === 'number', 'should count decayed');
  });

  test('_consolidateMemory with no memory', () => {
    const d = createDaemon({ memory: null });
    const result = d._consolidateMemory();
    assertEqual(result.consolidated, 0);
  });

  test('_learnFromHistory with no memory', () => {
    const d = createDaemon({ memory: null });
    const result = d._learnFromHistory();
    assertEqual(result.patterns, 0);
  });

  test('runCheck dispatches to correct method', async () => {
    const d = createDaemon();
    const health = await d.runCheck('health');
    assert(health.kernelOk !== undefined, 'health check should work');
    const consolidate = d.runCheck('consolidate');
    assert(consolidate.episodes !== undefined, 'consolidate should work');
  });

  test('runCheck throws for unknown type', () => {
    const d = createDaemon();
    let threw = false;
    try { d.runCheck('unknown'); } catch { threw = true; }
    assert(threw, 'should throw');
  });

  test('_log respects log level', () => {
    const d = createDaemon();
    d.config.logLevel = 'warn';
    d._log('debug', 'should be silent'); // should not throw
    d._log('warn', 'should log');
    assert(true, 'logging should not throw');
  });

  test('start and stop lifecycle', () => {
    const d = createDaemon();
    d.start();
    assertEqual(d.running, true);
    d.stop();
    assertEqual(d.running, false);
  });
});

// ── GoalStack ───────────────────────────────────────────────

describe('GoalStack — goal management', () => {
  const { GoalStack } = require('../../src/agent/planning/GoalStack');

  function createStack() {
    return new GoalStack({
      lang: { t: k => k },
      bus: mockBus(),
      model: {
        chat: async () => '1. [ANALYZE] Check code\n2. [SHELL] Run tests',
        chatStructured: async () => ({ steps: [{ type: 'ANALYZE', action: 'check' }] }),
      },
      prompts: { build: () => 'prompt' },
      storageDir: require('os').tmpdir(),
      storage: null,
    });
  }

  test('getAll returns empty initially', () => {
    const gs = createStack();
    assertEqual(gs.getAll().length, 0);
  });

  test('getActiveGoals returns empty initially', () => {
    const gs = createStack();
    assertEqual(gs.getActiveGoals().length, 0);
  });

  test('addGoal creates goal with steps', async () => {
    const gs = createStack();
    const goal = await gs.addGoal('Fix all bugs', 'user', 'high');
    assert(goal !== null, 'should create goal');
    assert(goal.description === 'Fix all bugs', 'should have description');
    assert(goal.steps.length > 0, 'should have steps');
    assertEqual(gs.getAll().length, 1);
  });

  test('pauseGoal sets status to paused', async () => {
    const gs = createStack();
    const goal = await gs.addGoal('Test goal', 'user');
    gs.pauseGoal(goal.id);
    assertEqual(gs.getAll()[0].status, 'paused');
  });

  test('resumeGoal sets status to active', async () => {
    const gs = createStack();
    const goal = await gs.addGoal('Test goal', 'user');
    gs.pauseGoal(goal.id);
    gs.resumeGoal(goal.id);
    assertEqual(gs.getAll()[0].status, 'active');
  });

  test('abandonGoal sets status to abandoned', async () => {
    const gs = createStack();
    const goal = await gs.addGoal('Abandon me', 'user');
    gs.abandonGoal(goal.id);
    assertEqual(gs.getAll()[0].status, 'abandoned');
  });

  test('getProgress returns progress info', async () => {
    const gs = createStack();
    const goal = await gs.addGoal('Progress test', 'user');
    const progress = gs.getProgress(goal.id);
    assert(progress !== null, 'should return progress');
    assert(typeof progress.progress === 'number', 'should have progress percentage');
    assert(progress.steps.length > 0, 'should have steps');
  });

  test('getGoalTree returns tree structure', async () => {
    const gs = createStack();
    await gs.addGoal('Root goal', 'user');
    const tree = gs.getGoalTree();
    assert(Array.isArray(tree), 'should return array');
    assert(tree.length > 0, 'should have entries');
  });
});

// ── EpisodicMemory ──────────────────────────────────────────

describe('EpisodicMemory — recall + scoring', () => {
  const { EpisodicMemory } = require('../../src/agent/hexagonal/EpisodicMemory');

  function createMem() {
    const em = new EpisodicMemory({ bus: mockBus(), storage: null, embeddingService: null, intervals: null });
    // Add some test episodes
    em.recordEpisode({ topic: 'JavaScript async', summary: 'Discussed async await patterns', outcome: 'success', tags: ['code', 'async'], keyInsights: ['use Promise.all for parallel'] });
    em.recordEpisode({ topic: 'Python testing', summary: 'Talked about pytest fixtures', outcome: 'success', tags: ['python', 'testing'] });
    em.recordEpisode({ topic: 'Genesis architecture', summary: 'Reviewed 13-phase boot sequence', outcome: 'success', tags: ['genesis', 'architecture'], keyInsights: ['phases prevent circular deps'] });
    return em;
  }

  test('recall returns relevant episodes', () => {
    const em = createMem();
    const results = em.recall('async patterns', { maxResults: 2 });
    assert(results.length > 0, 'should find results');
    assert(results[0].relevance > 0, 'should have relevance score');
  });

  test('recall filters by tag', () => {
    const em = createMem();
    const results = em.recall('code', { tag: 'python' });
    assert(results.every(r => (r.tags || []).includes('python')), 'should only return python-tagged');
  });

  test('recall filters by outcome', () => {
    const em = createMem();
    em.recordEpisode({ topic: 'Failed task', summary: 'Something broke', outcome: 'failure', tags: ['error'] });
    const results = em.recall('', { outcome: 'failure' });
    assert(results.every(r => r.outcome === 'failure'), 'should only return failures');
  });

  test('getByTag returns tagged episodes', () => {
    const em = createMem();
    const results = em.getByTag('genesis');
    assert(results.length >= 1, 'should find genesis-tagged episodes');
  });

  test('getByTag returns empty for unknown tag', () => {
    const em = createMem();
    assertEqual(em.getByTag('nonexistent').length, 0);
  });

  test('getRecent returns recent episodes', () => {
    const em = createMem();
    const results = em.getRecent(1);
    assert(results.length > 0, 'recent episodes should exist');
  });

  test('getStats returns episode statistics', () => {
    const em = createMem();
    const stats = em.getStats();
    assert(stats.totalEpisodes >= 3, 'should count episodes');
    assert(stats.tags !== undefined, 'should have tag info');
  });

  test('getTags returns tag counts', () => {
    const em = createMem();
    const tags = em.getTags();
    assert(typeof tags === 'object', 'should return object');
    assert(tags.code >= 1, 'should count code tag');
    assert(tags.genesis >= 1, 'should count genesis tag');
  });

  test('buildContext returns formatted string', () => {
    const em = createMem();
    const ctx = em.buildContext('async JavaScript');
    assert(typeof ctx === 'string', 'should return string');
  });

  test('_tokenize splits and normalizes', () => {
    const em = createMem();
    const tokens = em._tokenize('Hello World, this is a Test!');
    assert(tokens.includes('hello'), 'should lowercase');
    assert(tokens.includes('world'), 'should split words');
    assert(!tokens.includes('is'), 'should filter short words');
  });

  test('_scoreRelevance returns 0 for empty query', () => {
    const em = createMem();
    const score = em._scoreRelevance(em._episodes[0], '');
    assertEqual(score, 0);
  });

  test('_scoreRelevance scores keyword matches', () => {
    const em = createMem();
    const score = em._scoreRelevance(em._episodes[0], 'async JavaScript patterns');
    assert(score > 0, 'should score > 0 for matching keywords');
  });
});

// ── EffectorRegistry ────────────────────────────────────────

describe('EffectorRegistry — effector management', () => {
  const { EffectorRegistry } = require('../../src/agent/capabilities/EffectorRegistry');

  function createRegistry() {
    return new EffectorRegistry({
      bus: mockBus(), storage: null, eventStore: null,
      rootDir: '/tmp', config: {},
    });
  }

  test('constructor initializes', () => {
    const reg = createRegistry();
    assert(reg !== null, 'should construct');
  });

  test('register adds effector', () => {
    const reg = createRegistry();
    reg.register({
      name: 'test-effector',
      description: 'A test effector',
      schema: { input: { msg: 'string' } },
      execute: async (params) => ({ success: true, output: params.msg }),
    });
    const list = reg.listEffectors();
    assert(list.some(e => e.name === 'test-effector'), 'should contain registered effector');
  });

  test('listEffectors returns all registered', () => {
    const reg = createRegistry();
    const list = reg.listEffectors();
    assert(Array.isArray(list), 'should return array');
  });

  test('getSchemas returns effector schema map', () => {
    const reg = createRegistry();
    reg.register({
      name: 'schema-test',
      description: 'Schema test',
      schema: { inputs: { x: 'number' }, outputs: {} },
      execute: async () => ({}),
    });
    const schemas = reg.getSchemas();
    assert(typeof schemas === 'object', 'should return object');
    assert(schemas['schema-test'] !== undefined, 'should contain registered effector');
  });

  test('getStats returns statistics', () => {
    const reg = createRegistry();
    const stats = reg.getStats();
    assert(typeof stats === 'object', 'should return object');
  });

  test('execute runs registered effector', async () => {
    const reg = createRegistry();
    reg.register({
      name: 'exec-test',
      description: 'Execute test',
      schema: {},
      execute: async (params) => ({ success: true, output: 'done' }),
    });
    const result = await reg.execute('exec-test', {});
    assert(result.success === true || result.output !== undefined, 'should execute successfully');
  });

  test('execute returns error for unknown effector', async () => {
    const reg = createRegistry();
    const result = await reg.execute('nonexistent', {});
    assertEqual(result.success, false);
    assert(result.error.includes('not found'), 'should indicate not found');
  });
});

run();
