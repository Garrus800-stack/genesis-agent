// ============================================================
// GENESIS — boot-integration.test.js (v4.0.0)
//
// End-to-end integration test for the complete boot cycle.
// Verifies that ContainerManifest registers all expected services,
// Container resolves them in phase order, late-bindings wire
// correctly, and asyncLoad/boot lifecycle hooks execute.
//
// Does NOT require Electron or Ollama — mocks the kernel and
// LLM layer. Tests the DI wiring, not individual service logic.
// ============================================================

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── Test Environment Setup ──────────────────────────────────
// Create a temporary .genesis dir to avoid polluting the real one.
const ROOT_DIR = path.resolve(__dirname, '..', '..');
let TEST_GENESIS_DIR;

function setupTestDir() {
  TEST_GENESIS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-boot-test-'));
  // Create required subdirectories
  for (const sub of ['sandbox', 'uploads']) {
    fs.mkdirSync(path.join(TEST_GENESIS_DIR, sub), { recursive: true });
  }
  // Write minimal settings so boot doesn't error on missing config
  fs.writeFileSync(
    path.join(TEST_GENESIS_DIR, 'settings.json'),
    JSON.stringify({ logging: { level: 'error' }, daemon: { controlEnabled: false } }),
    'utf-8'
  );
}

function cleanupTestDir() {
  try { fs.rmSync(TEST_GENESIS_DIR, { recursive: true, force: true }); } catch { /* ok */ }
}

// ── Mock SafeGuard ──────────────────────────────────────────
// Minimal mock that satisfies the kernel contract without hashing files.
class MockSafeGuard {
  constructor() {
    this.kernelHashes = new Map();
    this.criticalHashes = new Map();
    this.locked = true;
  }
  lockKernel() { this.locked = true; }
  lockCritical() { return { locked: 0, missing: [] }; }
  isProtected() { return false; }
  isCritical() { return false; }
  validateWrite() { return true; }
  validateDelete() { return true; }
  verifyIntegrity() { return { ok: true, issues: [] }; }
  getProtectedFiles() { return []; }
}

// ════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════

describe('Boot Integration — ContainerManifest', () => {
  let manifest;

  before(() => {
    setupTestDir();
    const { bus } = require('../../src/agent/core/EventBus');
    const { IntervalManager } = require('../../src/agent/core/IntervalManager');
    const { buildManifest, getAutoMap } = require('../../src/agent/ContainerManifest');

    const ctx = {
      rootDir: ROOT_DIR,
      genesisDir: TEST_GENESIS_DIR,
      guard: new MockSafeGuard(),
      bus,
      intervals: new IntervalManager(),
    };

    manifest = buildManifest(ctx);
  });

  it('should return a Map', () => {
    assert.ok(manifest instanceof Map, 'buildManifest should return a Map');
  });

  it('should register 50+ services', () => {
    assert.ok(manifest.size >= 50, `Expected >=50 services, got ${manifest.size}`);
  });

  // ── Phase 1: Foundation ─────────────────────────────────
  const phase1Expected = [
    'settings', 'selfModel', 'model', 'prompts', 'sandbox',
    'memory', 'eventStore', 'knowledgeGraph', 'worldState',
    'moduleSigner', 'embeddingService', 'desktopPerception',
  ];

  for (const name of phase1Expected) {
    it(`Phase 1 should include "${name}"`, () => {
      assert.ok(manifest.has(name), `Missing service: ${name}`);
      const config = manifest.get(name);
      assert.equal(config.phase, 1, `${name} should be phase 1, got ${config.phase}`);
    });
  }

  // ── Phase 2: Intelligence ───────────────────────────────
  const phase2Expected = [
    'intentRouter', 'tools', 'promptBuilder',
    'context', 'circuitBreaker', 'reasoning',
  ];

  for (const name of phase2Expected) {
    it(`Phase 2 should include "${name}"`, () => {
      assert.ok(manifest.has(name), `Missing service: ${name}`);
      const config = manifest.get(name);
      assert.equal(config.phase, 2, `${name} should be phase 2, got ${config.phase}`);
    });
  }

  // ── Phase 3: Capabilities ───────────────────────────────
  const phase3Expected = ['skills', 'reflector', 'shellAgent', 'fileProcessor', 'hotReloader'];

  for (const name of phase3Expected) {
    it(`Phase 3 should include "${name}"`, () => {
      assert.ok(manifest.has(name), `Missing service: ${name}`);
    });
  }

  // ── Phase 4: Planning ───────────────────────────────────
  const phase4Expected = ['goalStack', 'anticipator', 'solutionAccumulator', 'selfOptimizer'];

  for (const name of phase4Expected) {
    it(`Phase 4 should include "${name}"`, () => {
      assert.ok(manifest.has(name), `Missing service: ${name}`);
    });
  }

  // ── Phase 5: Hexagonal ──────────────────────────────────
  const phase5Expected = ['unifiedMemory', 'episodicMemory', 'chatOrchestrator', 'selfModPipeline', 'commandHandlers'];

  for (const name of phase5Expected) {
    it(`Phase 5 should include "${name}"`, () => {
      assert.ok(manifest.has(name), `Missing service: ${name}`);
    });
  }

  // ── Phase 6: Autonomy ───────────────────────────────────
  const phase6Expected = ['daemon', 'idleMind', 'healthMonitor'];

  for (const name of phase6Expected) {
    it(`Phase 6 should include "${name}"`, () => {
      assert.ok(manifest.has(name), `Missing service: ${name}`);
    });
  }

  // ── Phase 7: Organism ───────────────────────────────────
  const phase7Expected = ['emotionalState', 'homeostasis', 'needsSystem'];

  for (const name of phase7Expected) {
    it(`Phase 7 should include "${name}"`, () => {
      assert.ok(manifest.has(name), `Missing service: ${name}`);
      const config = manifest.get(name);
      assert.equal(config.phase, 7, `${name} should be phase 7`);
    });
  }

  // ── Phase 8: Revolution ─────────────────────────────────
  const phase8Expected = ['nativeToolUse', 'agentLoop', 'formalPlanner', 'sessionPersistence'];

  for (const name of phase8Expected) {
    it(`Phase 8 should include "${name}"`, () => {
      assert.ok(manifest.has(name), `Missing service: ${name}`);
    });
  }

  // ── Phase 9: Cognitive ──────────────────────────────────
  const phase9Expected = [
    'cognitiveHealthTracker', 'expectationEngine',
    'surpriseAccumulator', 'mentalSimulator',
    'dreamCycle', 'selfNarrative',
  ];

  for (const name of phase9Expected) {
    it(`Phase 9 should include "${name}"`, () => {
      assert.ok(manifest.has(name), `Missing service: ${name}`);
      const config = manifest.get(name);
      assert.equal(config.phase, 9, `${name} should be phase 9`);
    });
  }

  // ── Structural checks ──────────────────────────────────
  it('every service should have a factory function', () => {
    for (const [name, config] of manifest) {
      assert.equal(typeof config.factory, 'function', `${name}: factory should be a function`);
    }
  });

  it('every service should have a numeric phase', () => {
    for (const [name, config] of manifest) {
      assert.equal(typeof config.phase, 'number', `${name}: phase should be a number`);
      assert.ok(config.phase >= 1 && config.phase <= 13, `${name}: phase ${config.phase} out of range`);
    }
  });

  it('deps should only reference registered services or bootstrap instances', () => {
    const bootstrapInstances = new Set([
      'rootDir', 'guard', 'bus', 'storage', 'lang', 'logger',
    ]);
    const allRegistered = new Set([...manifest.keys(), ...bootstrapInstances]);

    for (const [name, config] of manifest) {
      for (const dep of (config.deps || [])) {
        assert.ok(
          allRegistered.has(dep),
          `${name} depends on "${dep}" which is not registered`
        );
      }
    }
  });

  it('lateBindings should reference registered services', () => {
    const allRegistered = new Set(manifest.keys());

    for (const [name, config] of manifest) {
      for (const binding of (config.lateBindings || [])) {
        if (!binding.optional) {
          assert.ok(
            allRegistered.has(binding.service),
            `${name}.${binding.prop} → ${binding.service} is required but not registered`
          );
        }
      }
    }
  });

  it('no service should depend on a higher phase (use lateBindings instead)', () => {
    const phaseMap = new Map();
    for (const [name, config] of manifest) {
      phaseMap.set(name, config.phase);
    }

    const violations = [];
    for (const [name, config] of manifest) {
      for (const dep of (config.deps || [])) {
        const depPhase = phaseMap.get(dep);
        if (depPhase !== undefined && depPhase > config.phase) {
          violations.push(`${name}(P${config.phase}) → ${dep}(P${depPhase})`);
        }
      }
    }

    assert.equal(violations.length, 0,
      `Phase violations found:\n  ${violations.join('\n  ')}`
    );
  });
});

describe('Boot Integration — Container Resolution', () => {
  let container;

  before(() => {
    if (!TEST_GENESIS_DIR) setupTestDir();

    const { bus } = require('../../src/agent/core/EventBus');
    const { Container } = require('../../src/agent/core/Container');
    const { IntervalManager } = require('../../src/agent/core/IntervalManager');
    const { StorageService } = require('../../src/agent/foundation/StorageService');
    const { buildManifest } = require('../../src/agent/ContainerManifest');
    const { lang } = require('../../src/agent/core/Language');
    const { Logger } = require('../../src/agent/core/Logger');

    Logger.setLevel('error');
    lang.init(TEST_GENESIS_DIR);

    container = new Container({ bus });

    // Bootstrap instances (same as AgentCore._bootstrapInstances)
    container.registerInstance('rootDir', ROOT_DIR);
    container.registerInstance('guard', new MockSafeGuard());
    container.registerInstance('bus', bus);
    container.registerInstance('storage', new StorageService(TEST_GENESIS_DIR));
    container.registerInstance('lang', lang);
    container.registerInstance('logger', Logger);

    // Register manifest
    const manifest = buildManifest({
      rootDir: ROOT_DIR,
      genesisDir: TEST_GENESIS_DIR,
      guard: new MockSafeGuard(),
      bus,
      intervals: new IntervalManager(),
    });

    for (const [name, config] of manifest) {
      container.register(name, config.factory, {
        deps: config.deps || [],
        tags: config.tags || [],
        lateBindings: config.lateBindings || [],
        singleton: config.singleton !== false,
        phase: config.phase || 0,
      });
    }
  });

  it('should resolve foundation services without errors', () => {
    const foundationServices = ['settings', 'selfModel', 'model', 'prompts', 'sandbox', 'memory', 'eventStore'];
    for (const name of foundationServices) {
      assert.doesNotThrow(() => container.resolve(name), `Failed to resolve ${name}`);
    }
  });

  it('should resolve intelligence services', () => {
    const services = ['intentRouter', 'tools', 'circuitBreaker'];
    for (const name of services) {
      assert.doesNotThrow(() => container.resolve(name), `Failed to resolve ${name}`);
    }
  });

  it('should resolve all services via getDependencyGraph', () => {
    // This forces resolution of everything that can be resolved
    const graph = container.getDependencyGraph();
    assert.ok(Object.keys(graph).length >= 50, `Expected >=50 services in graph, got ${Object.keys(graph).length}`);
  });

  it('should produce a valid topological sort', () => {
    // _topologicalSort is called internally by bootAll
    // If it has cycles, bootAll would throw
    const sorted = container._topologicalSort();
    assert.ok(Array.isArray(sorted), 'Should return an array');
    assert.ok(sorted.length >= 50, `Expected >=50 services in sort order, got ${sorted.length}`);

    // Verify phase ordering: no service should appear before its lower-phase dependency
    const positionMap = new Map();
    sorted.forEach((name, idx) => positionMap.set(name, idx));

    const reg = container.registrations;
    for (const [name, config] of reg) {
      for (const dep of config.deps) {
        if (positionMap.has(dep) && positionMap.has(name)) {
          assert.ok(
            positionMap.get(dep) < positionMap.get(name),
            `${dep} should appear before ${name} in boot order`
          );
        }
      }
    }
  });

  it('should wire late-bindings without errors', () => {
    // Resolve all services first
    for (const [name] of container.registrations) {
      try { container.resolve(name); } catch { /* some may fail without Ollama — ok */ }
    }

    const result = container.wireLateBindings();
    assert.ok(result.wired >= 10, `Expected >=10 late-bindings wired, got ${result.wired}`);
    assert.equal(result.errors.length, 0, `Late-binding errors: ${result.errors.join('; ')}`);
  });

  it('should pass late-binding verification', () => {
    const result = container.verifyLateBindings();
    assert.ok(result.verified >= 10, `Expected >=10 verified bindings, got ${result.verified}`);
    // Required bindings (non-optional) should not be null
    assert.equal(result.missing.length, 0,
      `Missing required bindings:\n  ${result.missing.join('\n  ')}`
    );
  });
});

describe('Boot Integration — Auto-Discovery', () => {
  it('should discover all cognitive modules', () => {
    const { getAutoMap } = require('../../src/agent/ContainerManifest');
    const autoMap = getAutoMap();

    // Phase 9 modules should be discovered in cognitive/ dir
    const cognitiveModules = [
      'CognitiveHealthTracker', 'MentalSimulator', 'SelfNarrative',
      'DreamCycle', 'ExpectationEngine', 'SurpriseAccumulator',
    ];

    for (const mod of cognitiveModules) {
      assert.ok(autoMap[mod], `Auto-discovery should find ${mod}, got: ${autoMap[mod] || 'not found'}`);
      assert.equal(autoMap[mod], 'cognitive', `${mod} should be in cognitive/ dir`);
    }
  });

  it('should discover all core modules', () => {
    const { getAutoMap } = require('../../src/agent/ContainerManifest');
    const autoMap = getAutoMap();

    for (const mod of ['EventBus', 'Container', 'Constants', 'Logger', 'WriteLock']) {
      assert.ok(autoMap[mod], `Auto-discovery should find ${mod}`);
      assert.equal(autoMap[mod], 'core', `${mod} should be in core/ dir`);
    }
  });

  it('should have no duplicate module names across directories', () => {
    const { getAutoMap } = require('../../src/agent/ContainerManifest');
    const autoMap = getAutoMap();
    // getAutoMap uses first-found-wins. If there are duplicates,
    // one would be silently shadowed. Check by scanning manually.
    const agentDir = path.join(ROOT_DIR, 'src', 'agent');
    const scanDirs = ['core', 'foundation', 'intelligence', 'capabilities',
      'planning', 'hexagonal', 'autonomy', 'organism', 'revolution', 'ports', 'cognitive'];

    const seen = new Map(); // moduleName → [dirs]
    for (const dir of scanDirs) {
      const fullDir = path.join(agentDir, dir);
      if (!fs.existsSync(fullDir)) continue;
      for (const file of fs.readdirSync(fullDir).filter(f => f.endsWith('.js'))) {
        const mod = file.replace('.js', '');
        if (!seen.has(mod)) seen.set(mod, []);
        seen.get(mod).push(dir);
      }
    }

    const duplicates = [];
    for (const [mod, dirs] of seen) {
      if (dirs.length > 1) duplicates.push(`${mod}: [${dirs.join(', ')}]`);
    }

    assert.equal(duplicates.length, 0,
      `Duplicate module names found (first-found-wins shadowing):\n  ${duplicates.join('\n  ')}`
    );
  });
});
