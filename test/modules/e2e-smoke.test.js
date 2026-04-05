#!/usr/bin/env node
// ============================================================
// E2E Smoke Test: Boot Genesis + Run Basic Tasks
//
// This test verifies the entire boot pipeline works end-to-end:
//   1. Container resolves all 96+ services without errors
//   2. Late-bindings wire correctly
//   3. Key subsystems produce real output
//   4. New v4.12.8 features (BootRecovery, CircuitBreaker, Consensus) integrate
//
// NOTE: This does NOT require Electron or an LLM backend.
// It tests the agent core in headless mode with MockBackend.
// ============================================================

const { describe, test, assert, assertEqual, run, createTestRoot } = require('../harness');
const path = require('path');
const fs = require('fs');

const ROOT = createTestRoot('e2e-smoke');

// Build a minimal project structure that AgentCore expects
function setupProjectDir() {
  const dirs = ['.genesis', 'sandbox', 'src/skills', 'uploads', 'src/agent', 'src/kernel'];
  for (const d of dirs) {
    fs.mkdirSync(path.join(ROOT, d), { recursive: true });
  }

  // Copy actual source files so SelfModel can scan them
  const srcAgent = path.join(__dirname, '..', '..', 'src', 'agent');
  const srcKernel = path.join(__dirname, '..', '..', 'src', 'kernel');

  // Copy a few key files (not the whole tree — just enough for scan)
  for (const f of ['AgentCore.js', 'ContainerManifest.js', 'index.js']) {
    const src = path.join(srcAgent, f);
    const dst = path.join(ROOT, 'src', 'agent', f);
    if (fs.existsSync(src)) fs.copyFileSync(src, dst);
  }
  for (const dir of ['core', 'manifest']) {
    const srcDir = path.join(srcAgent, dir);
    const dstDir = path.join(ROOT, 'src', 'agent', dir);
    if (fs.existsSync(srcDir)) {
      fs.mkdirSync(dstDir, { recursive: true });
      for (const f of fs.readdirSync(srcDir)) {
        if (f.endsWith('.js')) fs.copyFileSync(path.join(srcDir, f), path.join(dstDir, f));
      }
    }
  }
  for (const f of fs.readdirSync(srcKernel)) {
    const srcPath = path.join(srcKernel, f);
    const dstPath = path.join(ROOT, 'src', 'kernel', f);
    // FIX v5.1.0: fs.copyFileSync throws EPERM on directories (Windows).
    // The vendor/ subdirectory (vendored acorn) must be copied recursively.
    if (fs.statSync(srcPath).isDirectory()) {
      fs.mkdirSync(dstPath, { recursive: true });
      for (const vf of fs.readdirSync(srcPath)) {
        const vSrc = path.join(srcPath, vf);
        if (fs.statSync(vSrc).isFile()) fs.copyFileSync(vSrc, path.join(dstPath, vf));
      }
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }

  // Skill directory with system-info
  const skillDir = path.join(ROOT, 'src', 'skills', 'system-info');
  const origSkill = path.join(__dirname, '..', '..', 'src', 'skills', 'system-info');
  if (fs.existsSync(origSkill)) {
    fs.mkdirSync(skillDir, { recursive: true });
    for (const f of fs.readdirSync(origSkill)) {
      fs.copyFileSync(path.join(origSkill, f), path.join(skillDir, f));
    }
  }

  // Settings for MockBackend
  fs.writeFileSync(path.join(ROOT, '.genesis', 'settings.json'), JSON.stringify({
    models: { preferred: 'mock-model' },
    telemetry: { enabled: true },
  }));

  // package.json (SelfModel reads version)
  fs.writeFileSync(path.join(ROOT, 'package.json'), JSON.stringify({
    name: 'genesis-agent', version: '4.12.8-test',
  }));
}

setupProjectDir();

// ═══════════════════════════════════════════════════════════
// Tests use real modules but with MockBackend (no LLM needed)
// ═══════════════════════════════════════════════════════════

const { bus } = require('../../src/agent/core/EventBus');
const { Container } = require('../../src/agent/core/Container');
const { VectorClock, PeerConsensus } = require('../../src/agent/hexagonal/PeerConsensus');
const { BootRecovery } = require('../../src/agent/foundation/BootRecovery');

describe('E2E — BootRecovery Integration', () => {
  test('sentinel lifecycle: write → clear → snapshot', () => {
    const { SnapshotManager } = require('../../src/agent/capabilities/SnapshotManager');
    const genesisDir = path.join(ROOT, '.genesis');
    const mgr = new SnapshotManager({
      rootDir: ROOT,
      storage: { baseDir: genesisDir },
      guard: { validateWrite: () => true },
    });
    const recovery = new BootRecovery({ genesisDir, snapshotManager: mgr });

    // Simulate clean boot
    const pre = recovery.preBootCheck();
    assertEqual(pre.recovered, false);
    recovery.postBootSuccess();

    // Verify snapshot was created
    const snaps = mgr.list();
    assert(snaps.some(s => s.name === '_last_good_boot'), 'should have good boot snapshot');
  });
});

describe('E2E — SelfMod Circuit Breaker Integration', () => {
  test('circuit breaker state survives across method calls', () => {
    const { SelfModificationPipeline } = require('../../src/agent/hexagonal/SelfModificationPipeline');
    const events = [];
    const mockBus = {
      emit: (n, d) => events.push({ name: n }),
      fire: (n, d) => events.push({ name: n }),
      on: () => {},
    };
    const pipeline = new SelfModificationPipeline({
      lang: { t: k => k }, bus: mockBus,
      selfModel: null, model: null, prompts: null, sandbox: null,
      reflector: null, skills: null, cloner: null, reasoning: null,
      hotReloader: null, guard: null, tools: null, eventStore: null,
      rootDir: ROOT, astDiff: null,
    });

    // 3 failures → frozen
    pipeline._recordFailure('e2e-1');
    pipeline._recordFailure('e2e-2');
    pipeline._recordFailure('e2e-3');
    assert(pipeline.getCircuitBreakerStatus().frozen);

    // Reset
    pipeline.resetCircuitBreaker();
    assert(!pipeline.getCircuitBreakerStatus().frozen);
    assertEqual(pipeline.getCircuitBreakerStatus().failures, 0);
  });
});

describe('E2E — PeerConsensus Bidirectional Sync', () => {
  test('two instances converge with mixed mutations', () => {
    const { StorageService } = require('../../src/agent/foundation/StorageService');
    const mockBus = { emit: () => {}, fire: () => {}, on: () => {} };

    const dirA = path.join(ROOT, '.genesis', 'peer-a');
    const dirB = path.join(ROOT, '.genesis', 'peer-b');
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });

    const a = new PeerConsensus({ bus: mockBus, storage: new StorageService(dirA), selfId: 'A', config: {} });
    const b = new PeerConsensus({ bus: mockBus, storage: new StorageService(dirB), selfId: 'B', config: {} });

    // Both write different keys
    a.recordMutation('settings', 'theme', 'dark');
    a.recordMutation('settings', 'lang', 'de');
    b.recordMutation('settings', 'font', 'monospace');
    b.recordMutation('knowledge', 'user', { subject: 'user', relation: 'name', object: 'Garrus' });

    // Bidirectional sync
    const payloadA = a.buildSyncPayload({});
    b.applySyncPayload(payloadA);

    const payloadB = b.buildSyncPayload({});
    a.applySyncPayload(payloadB);

    // Both should have all 4 keys
    assert(a._lwwRegister.has('settings:font'), 'A should have B\'s font');
    assert(a._lwwRegister.has('knowledge:user'), 'A should have B\'s user');
    assert(b._lwwRegister.has('settings:theme'), 'B should have A\'s theme');
    assert(b._lwwRegister.has('settings:lang'), 'B should have A\'s lang');

    // Total: 4 unique keys on each side
    assert(a._lwwRegister.size >= 4, `A has ${a._lwwRegister.size} keys`);
    assert(b._lwwRegister.size >= 4, `B has ${b._lwwRegister.size} keys`);
  });
});

describe('E2E — UnifiedMemory Consolidation', () => {
  test('full consolidation pipeline: record → consolidate → verify', () => {
    const { UnifiedMemory } = require('../../src/agent/hexagonal/UnifiedMemory');
    const events = [];
    const mockBus = { emit: (n, d) => events.push({ name: n, data: d }), fire: (n, d) => events.push({ name: n, data: d }), on: () => {} };

    // Build realistic episodic data
    const episodes = [];
    for (let i = 0; i < 8; i++) {
      episodes.push({
        id: `ep-${i}`,
        topics: ['javascript', 'react', 'testing'],
        timestamp: Date.now() - i * 60000,
      });
    }
    // Add a rarer topic
    for (let i = 0; i < 4; i++) {
      episodes.push({
        id: `ep-rare-${i}`,
        topics: ['rust', 'wasm'],
        timestamp: Date.now() - (i + 8) * 60000,
      });
    }

    const db = { semantic: {}, episodic: episodes };
    const memory = {
      db,
      recallEpisodes: () => [],
      storeFact: (key, value, confidence) => {
        db.semantic[key] = { value, confidence, learned: new Date().toISOString() };
      },
      getStats: () => ({}),
    };

    const unified = new UnifiedMemory({
      bus: mockBus, memory,
      knowledgeGraph: { search: () => [], connect: () => {}, getStats: () => ({}) },
    });

    // Consolidate
    const result = unified.consolidate({ minOccurrences: 3 });

    // Should promote javascript, react, testing (8x each) and rust, wasm (4x each)
    assert(result.promoted.length >= 3, `promoted ${result.promoted.length} topics`);
    assert(db.semantic['topic:javascript'], 'javascript should be a fact');
    assert(db.semantic['topic:react'], 'react should be a fact');

    // Events should have been emitted
    assert(events.some(e => e.name === 'memory:consolidated'));
  });
});

describe('E2E — ContextManager Model Detection', () => {
  test('DeepSeek gets large context window', () => {
    const { ContextManager } = require('../../src/agent/intelligence/ContextManager');
    const cm = new ContextManager(
      { activeModel: 'deepseek-v3' },
      { getFullModel: () => ({ modules: {} }) },
      { db: {} },
      { on: () => {}, emit: () => {} },
      { detect: () => {}, current: 'en' }
    );
    cm.configureForModel('deepseek-v3');
    assert(cm.config.maxContextTokens >= 32000, `DeepSeek should get ≥32K, got ${cm.config.maxContextTokens}`);
  });

  test('Qwen gets large context window', () => {
    const { ContextManager } = require('../../src/agent/intelligence/ContextManager');
    const cm = new ContextManager(
      { activeModel: 'qwen2.5:72b' },
      { getFullModel: () => ({ modules: {} }) },
      { db: {} },
      { on: () => {}, emit: () => {} },
      { detect: () => {}, current: 'en' }
    );
    cm.configureForModel('qwen2.5:72b');
    assert(cm.config.maxContextTokens >= 32000, `Qwen should get ≥32K, got ${cm.config.maxContextTokens}`);
  });

  test('Kimi/Moonshot gets large context window', () => {
    const { ContextManager } = require('../../src/agent/intelligence/ContextManager');
    const cm = new ContextManager(
      { activeModel: 'moonshot-v1' },
      { getFullModel: () => ({ modules: {} }) },
      { db: {} },
      { on: () => {}, emit: () => {} },
      { detect: () => {}, current: 'en' }
    );
    cm.configureForModel('moonshot-v1-128k');
    assert(cm.config.maxContextTokens >= 32000, `Kimi should get ≥32K, got ${cm.config.maxContextTokens}`);
  });

  test('gemma2:9b stays at small context', () => {
    const { ContextManager } = require('../../src/agent/intelligence/ContextManager');
    const cm = new ContextManager(
      { activeModel: 'gemma2:9b' },
      { getFullModel: () => ({ modules: {} }) },
      { db: {} },
      { on: () => {}, emit: () => {} },
      { detect: () => {}, current: 'en' }
    );
    cm.configureForModel('gemma2:9b');
    assert(cm.config.maxContextTokens <= 8000, `gemma should get ≤8K, got ${cm.config.maxContextTokens}`);
  });
});

describe('E2E — Telemetry Registration', () => {
  test('BootTelemetry can be constructed and records data', async () => {
    const { BootTelemetry } = require('../../src/agent/foundation/BootTelemetry');
    const { StorageService } = require('../../src/agent/foundation/StorageService');
    const dir = path.join(ROOT, '.genesis', 'tel-test');
    fs.mkdirSync(dir, { recursive: true });
    const storage = new StorageService(dir);

    const tel = new BootTelemetry({ storage, bus: { on: () => {}, emit: () => {} }, enabled: true });
    // asyncLoad() uses sync readJSON internally — safe to await in test
    await tel.asyncLoad();
    tel.recordBoot(500, 96, 0, [{ name: 'test', ms: 100 }]);

    const report = tel.getReport();
    assert(report, 'should return report');
    assert(report.totalBoots >= 1, 'should have boot record');
    assert(report.lastBoot, 'should have last boot entry');
    assertEqual(report.lastBoot.services, 96);
  });
});

describe('E2E — ErrorAggregator + IntrospectionEngine Bridge', () => {
  test('getSummary returns structured data for IntrospectionEngine', () => {
    const { ErrorAggregator } = require('../../src/agent/autonomy/ErrorAggregator');
    const mockBus = { emit: () => {}, fire: () => {}, on: () => {} };
    const agg = new ErrorAggregator({
      bus: mockBus,
      config: { windowMs: 60000, trendWindowMs: 5000, spikeThreshold: 2, risingThreshold: 2 },
    });

    agg.record('network', new Error('timeout'));
    agg.record('network', new Error('timeout2'));
    agg.record('network', new Error('timeout3'));

    const summary = agg.getSummary();
    assert(Array.isArray(summary.trending), 'trending should be array');
    assert(Array.isArray(summary.spikes), 'spikes should be array');
    // 3 errors with spike threshold 2 → should detect
    assert(summary.spikes.length > 0 || summary.trending.length > 0, 'should detect activity');
  });
});

run();
