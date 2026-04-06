// Test: v6.1.1 Coverage Sweep — Infrastructure modules
// Targets: HealthServer, SkillManager, HomeostasisEffectors

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');
const fs = require('fs');
const os = require('os');

function mockBus() {
  const subs = {};
  return {
    on(evt, fn) { (subs[evt] = subs[evt] || []).push(fn); return () => {}; },
    emit(evt, data) { (subs[evt] || []).forEach(fn => fn(data)); },
    fire(evt, data) { this.emit(evt, data); },
    off() {},
  };
}

function tmpDir() {
  const d = path.join(os.tmpdir(), `genesis-test-${Date.now()}-${Math.random().toString(36).slice(2,8)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// ── HealthServer ────────────────────────────────────────────

describe('HealthServer — HTTP endpoint', () => {
  const { HealthServer } = require('../../src/agent/autonomy/HealthServer');

  test('constructor sets port and container', () => {
    const hs = new HealthServer({ port: 0, container: {}, bus: mockBus() });
    assert(hs.port === 0 || hs.port > 0, 'should set port');
    assert(hs.container !== null, 'should set container');
  });

  test('_basicHealth returns status object', () => {
    const hs = new HealthServer({
      port: 0,
      container: {
        has: (n) => n === 'model',
        resolve: () => ({ activeModel: 'test-model', activeBackend: 'ollama' }),
      },
      bus: mockBus(),
    });
    const health = hs._basicHealth();
    assertEqual(health.status, 'ok');
    assertEqual(health.model, 'test-model');
    assertEqual(health.backend, 'ollama');
    assert(typeof health.uptime === 'number', 'should have uptime');
    assert(health.memory.rss > 0, 'should have memory.rss');
    assert(health.memory.heap > 0, 'should have memory.heap');
    assert(health.timestamp, 'should have timestamp');
  });

  test('_basicHealth with no model', () => {
    const hs = new HealthServer({
      port: 0,
      container: { has: () => false, resolve: () => null },
      bus: mockBus(),
    });
    const health = hs._basicHealth();
    assertEqual(health.model, 'none');
    assertEqual(health.backend, 'none');
  });

  test('_fullHealth returns extended diagnostics', () => {
    const hs = new HealthServer({
      port: 0,
      container: {
        has: (n) => n === 'model' || n === 'guard',
        resolve: (n) => {
          if (n === 'model') return { activeModel: 'm', activeBackend: 'b' };
          if (n === 'guard') return { verifyIntegrity: () => ({ ok: true }) };
          return {};
        },
        getDependencyGraph: () => ({
          svc1: { resolved: true },
          svc2: { resolved: true },
          svc3: { resolved: false },
        }),
      },
      bus: mockBus(),
    });
    const health = hs._fullHealth();
    assertEqual(health.status, 'ok');
    assertEqual(health.services.total, 3);
    assertEqual(health.services.resolved, 2);
    assertEqual(health.kernelIntegrity, 'ok');
    assert(health.node.startsWith('v'), 'should have node version');
  });

  test('_fullHealth with compromised kernel', () => {
    const hs = new HealthServer({
      port: 0,
      container: {
        has: (n) => n === 'guard',
        resolve: () => ({ verifyIntegrity: () => ({ ok: false }), activeModel: null, activeBackend: null }),
        getDependencyGraph: () => ({}),
      },
      bus: mockBus(),
    });
    const health = hs._fullHealth();
    assertEqual(health.kernelIntegrity, 'COMPROMISED');
  });

  test('start and stop lifecycle', (done) => {
    const hs = new HealthServer({
      port: 0, // random port
      container: { has: () => false, resolve: () => null, getDependencyGraph: () => ({}) },
      bus: mockBus(),
    });
    hs.start();
    assert(hs._server !== null, 'server should be running');
    hs.stop();
    assert(hs._server === null, 'server should be stopped');
  });

  test('stop before start is safe', () => {
    const hs = new HealthServer({ port: 0, container: {}, bus: mockBus() });
    hs.stop(); // should not throw
    assert(true, 'stop before start should not throw');
  });
});

// ── SkillManager ────────────────────────────────────────────

describe('SkillManager — skill lifecycle', () => {
  const { SkillManager } = require('../../src/agent/capabilities/SkillManager');

  test('constructor creates skills directory', () => {
    const dir = path.join(tmpDir(), 'skills');
    const sm = new SkillManager(dir, {}, {}, {}, {});
    assert(fs.existsSync(dir), 'should create skills dir');
  });

  test('loadSkills with empty directory', () => {
    const dir = tmpDir();
    const sm = new SkillManager(dir, {}, {}, {}, {});
    sm.loadSkills();
    assertEqual(sm.loadedSkills.size, 0);
  });

  test('loadSkills loads valid skill', () => {
    const dir = tmpDir();
    const skillDir = path.join(dir, 'test-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'skill-manifest.json'), JSON.stringify({
      name: 'test-skill', version: '1.0.0', description: 'A test skill',
      entry: 'index.js', interface: { input: {}, output: {} },
    }));
    fs.writeFileSync(path.join(skillDir, 'index.js'), 'module.exports = {};');

    const sm = new SkillManager(dir, {}, {}, {}, {});
    sm.loadSkills();
    assertEqual(sm.loadedSkills.size, 1);
    assert(sm.loadedSkills.has('test-skill'), 'should load test-skill');
  });

  test('loadSkills skips invalid manifest', () => {
    const dir = tmpDir();
    const skillDir = path.join(dir, 'bad-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'skill-manifest.json'), 'not json');

    const sm = new SkillManager(dir, {}, {}, {}, {});
    sm.loadSkills();
    assertEqual(sm.loadedSkills.size, 0);
  });

  test('listSkills returns formatted list', () => {
    const dir = tmpDir();
    const skillDir = path.join(dir, 'my-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'skill-manifest.json'), JSON.stringify({
      name: 'my-skill', version: '2.0.0', description: 'My skill', entry: 'index.js',
    }));

    const sm = new SkillManager(dir, {}, {}, {}, {});
    sm.loadSkills();
    const list = sm.listSkills();
    assertEqual(list.length, 1);
    assertEqual(list[0].name, 'my-skill');
    assertEqual(list[0].version, '2.0.0');
  });

  test('executeSkill throws for unknown skill', async () => {
    const dir = tmpDir();
    const sm = new SkillManager(dir, {}, {}, {}, {});
    let threw = false;
    try { await sm.executeSkill('nonexistent', {}); } catch (e) { threw = true; }
    assert(threw, 'should throw for unknown skill');
  });

  test('removeSkill deletes skill directory', () => {
    const dir = tmpDir();
    const skillDir = path.join(dir, 'del-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'skill-manifest.json'), JSON.stringify({
      name: 'del-skill', version: '1.0.0', description: 'Delete me', entry: 'index.js',
    }));
    fs.writeFileSync(path.join(skillDir, 'index.js'), '');

    const sm = new SkillManager(dir, {}, {}, {}, {});
    sm.loadSkills();
    assert(sm.loadedSkills.has('del-skill'), 'should be loaded');
    sm.removeSkill('del-skill');
    assert(!sm.loadedSkills.has('del-skill'), 'should be removed from map');
  });
});

// ── HomeostasisEffectors ────────────────────────────────────

describe('HomeostasisEffectors — handler dispatch', () => {
  const { HomeostasisEffectors } = require('../../src/agent/organism/HomeostasisEffectors');

  function createEffectors(overrides = {}) {
    const bus = mockBus();
    const eff = new HomeostasisEffectors({ bus, storage: null, config: {} });
    eff.llmCache = overrides.llmCache || { _cache: new Map([['a', 1], ['b', 2]]), clear: function() { this._cache.clear(); } };
    eff.vectorMemory = overrides.vectorMemory || { trimOldest: (n) => n };
    eff.knowledgeGraph = overrides.knowledgeGraph || { pruneStale: (days) => 5 };
    eff.contextManager = overrides.contextManager || { setBudgetMultiplier: () => {} };
    eff.homeostasis = overrides.homeostasis || { vitals: {} };
    return eff;
  }

  test('constructor initializes stats', () => {
    const eff = createEffectors();
    assertEqual(eff._stats.cachePrunes, 0);
    assertEqual(eff._stats.knowledgePrunes, 0);
    assertEqual(eff._stats.contextReductions, 0);
  });

  test('_handlePruneCaches clears LLM cache', () => {
    const eff = createEffectors();
    eff._handlePruneCaches({ memoryPressure: 80 });
    assertEqual(eff._stats.cachePrunes, 1);
    assertEqual(eff.llmCache._cache.size, 0);
    assert(eff._stats.totalCacheCleared >= 2, 'should count cleared entries');
  });

  test('_handlePruneCaches trims vector memory at high pressure', () => {
    let trimmed = 0;
    const eff = createEffectors({
      vectorMemory: { trimOldest: (n) => { trimmed = n; return n; } },
    });
    eff._handlePruneCaches({ memoryPressure: 90 });
    assertEqual(trimmed, 50, 'should trim 50 entries at >85% pressure');
  });

  test('_handlePruneCaches skips vector memory at low pressure', () => {
    let trimCalled = false;
    const eff = createEffectors({
      vectorMemory: { trimOldest: () => { trimCalled = true; return 0; } },
    });
    eff._handlePruneCaches({ memoryPressure: 70 });
    assert(!trimCalled, 'should not trim at low pressure');
  });

  test('_handlePruneKnowledge prunes stale nodes', () => {
    const eff = createEffectors();
    eff._handlePruneKnowledge({ nodeCount: 2000 });
    assertEqual(eff._stats.knowledgePrunes, 1);
    assertEqual(eff._stats.totalNodesRemoved, 5);
  });

  test('_handlePruneKnowledge handles missing KG', () => {
    const eff = createEffectors();
    eff.knowledgeGraph = null;
    eff._handlePruneKnowledge({ nodeCount: 100 }); // should not throw
    assertEqual(eff._stats.knowledgePrunes, 1);
  });

  test('_handleReduceContext increments stat', () => {
    const eff = createEffectors();
    eff._handleReduceContext({ latencyMs: 5000 });
    assertEqual(eff._stats.contextReductions, 1);
  });

  test('getReport returns stats', () => {
    const eff = createEffectors();
    eff._handlePruneCaches({ memoryPressure: 80 });
    const report = eff.getReport();
    assert(report.stats.cachePrunes >= 1, 'should report cache prunes');
  });

  test('start and stop lifecycle', () => {
    const eff = createEffectors();
    eff.start();
    eff.stop();
    assert(true, 'start/stop should not throw');
  });
});

run();
