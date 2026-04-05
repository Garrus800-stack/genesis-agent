#!/usr/bin/env node
// ============================================================
// Test: AgentCore.js — Boot Orchestrator
//
// Tests construction, boot phases, shutdown lifecycle, health
// checks, and rollback — without Electron or real LLM.
// Uses a minimal stub environment.
// ============================================================

const { describe, test, assert, assertEqual, assertRejects, run, createTestRoot } = require('../harness');
const path = require('path');
const fs = require('fs');

const ROOT = createTestRoot('agentcore');
// Create minimal directory structure AgentCore expects
for (const d of ['.genesis', 'sandbox', 'src/skills', 'uploads', 'src/agent', 'src/kernel']) {
  fs.mkdirSync(path.join(ROOT, d), { recursive: true });
}

function mockGuard() {
  return {
    isProtected: () => false,
    isCritical: () => false,
    validateWrite: () => true,
    validateDelete: () => true,
    verifyIntegrity: () => ({ ok: true, issues: [] }),
    lockKernel: () => {},
    lockCritical: () => ({ locked: 0, missing: [] }),
    kernelHashes: new Map(),
    criticalHashes: new Map(),
    protectedPaths: [],
    rootDir: ROOT,
    getProtectedFiles: () => [],
  };
}

function mockWindow() {
  return {
    isDestroyed: () => false,
    webContents: { send: () => {} },
  };
}

// ── Tests ──────────────────────────────────────────────────

describe('AgentCore — Construction', () => {
  test('constructs with required params', () => {
    const { AgentCore } = require('../../src/agent/AgentCore');
    const core = new AgentCore({ rootDir: ROOT, guard: mockGuard(), window: mockWindow() });
    assert(core, 'should construct');
    assertEqual(core.booted, false);
    assertEqual(core._shutdownCalled, false);
  });

  test('has container instance', () => {
    const { AgentCore } = require('../../src/agent/AgentCore');
    const core = new AgentCore({ rootDir: ROOT, guard: mockGuard(), window: mockWindow() });
    assert(core.container, 'should have DI container');
    assert(typeof core.container.register === 'function');
    assert(typeof core.container.resolve === 'function');
  });

  test('has IntervalManager', () => {
    const { AgentCore } = require('../../src/agent/AgentCore');
    const core = new AgentCore({ rootDir: ROOT, guard: mockGuard(), window: mockWindow() });
    assert(core.intervals, 'should have interval manager');
  });
});

describe('AgentCore — _bootstrapInstances (via _boot delegate)', () => {
  test('registers rootDir, guard, bus, storage, lang, logger', () => {
    const { AgentCore } = require('../../src/agent/AgentCore');
    const core = new AgentCore({ rootDir: ROOT, guard: mockGuard(), window: mockWindow() });
    core.genesisDir = path.join(ROOT, ".genesis");
    core._boot._bootstrapInstances();
    const c = core.container;
    assert(c.has('rootDir'), 'should register rootDir');
    assert(c.has('guard'), 'should register guard');
    assert(c.has('bus'), 'should register bus');
    assert(c.has('storage'), 'should register storage');
    assert(c.has('lang'), 'should register lang');
    assert(c.has('logger'), 'should register logger');
  });

  test('resolving rootDir returns actual path', () => {
    const { AgentCore } = require('../../src/agent/AgentCore');
    const core = new AgentCore({ rootDir: ROOT, guard: mockGuard(), window: mockWindow() });
    core.genesisDir = path.join(ROOT, ".genesis");
    core._boot._bootstrapInstances();
    assertEqual(core.container.resolve('rootDir'), ROOT);
  });
});

describe('AgentCore — _registerFromManifest', () => {
  test('registers services from manifest', () => {
    const { AgentCore } = require('../../src/agent/AgentCore');
    const core = new AgentCore({ rootDir: ROOT, guard: mockGuard(), window: mockWindow() });
    core.genesisDir = path.join(ROOT, ".genesis");
    core._boot._bootstrapInstances();
    core._boot._registerFromManifest();
    // Should have many services now
    const graph = core.container.getDependencyGraph();
    const serviceCount = Object.keys(graph).length;
    assert(serviceCount > 30, `should have >30 services, got ${serviceCount}`);
    // Check a few key services exist
    assert(core.container.has('model'), 'should have model');
    assert(core.container.has('sandbox'), 'should have sandbox');
    assert(core.container.has('chatOrchestrator'), 'should have chatOrchestrator');
    assert(core.container.has('agentLoop'), 'should have agentLoop');
    assert(core.container.has('moduleRegistry'), 'should have moduleRegistry');
  });
});

describe('AgentCore — Shutdown', () => {
  test('shutdown is idempotent (double call safe)', async () => {
    const { AgentCore } = require('../../src/agent/AgentCore');
    const core = new AgentCore({ rootDir: ROOT, guard: mockGuard(), window: mockWindow() });
    core._shutdownCalled = true; // simulate already shut down
    await core.shutdown(); // should be no-op
    assert(true, 'no error on double shutdown');
  });

  test('shutdown sets _shutdownCalled flag', async () => {
    const { AgentCore } = require('../../src/agent/AgentCore');
    const core = new AgentCore({ rootDir: ROOT, guard: mockGuard(), window: mockWindow() });
    core.genesisDir = path.join(ROOT, ".genesis");
    core._boot._bootstrapInstances();
    await core.shutdown();
    assertEqual(core._shutdownCalled, true);
  });
});

describe('AgentCore — _rollbackBoot', () => {
  test('rollback is safe when services not resolved', async () => {
    const { AgentCore } = require('../../src/agent/AgentCore');
    const core = new AgentCore({ rootDir: ROOT, guard: mockGuard(), window: mockWindow() });
    core.genesisDir = path.join(ROOT, ".genesis");
    core._boot._bootstrapInstances();
    await core._health._rollbackBoot(); // should not throw
    assert(true, 'rollback safe with empty container');
  });
});

describe('AgentCore — _pushStatus', () => {
  test('sends status to window', () => {
    let lastStatus = null;
    const win = {
      isDestroyed: () => false,
      webContents: { send: (ch, data) => { lastStatus = data; } },
    };
    const { AgentCore } = require('../../src/agent/AgentCore');
    const core = new AgentCore({ rootDir: ROOT, guard: mockGuard(), window: win });
    core._pushStatus({ state: 'ready', detail: 'test' });
    assert(lastStatus, 'should send status');
    assertEqual(lastStatus.state, 'ready');
  });

  test('handles destroyed window gracefully', () => {
    const win = { isDestroyed: () => true, webContents: { send: () => { throw new Error('destroyed'); } } };
    const { AgentCore } = require('../../src/agent/AgentCore');
    const core = new AgentCore({ rootDir: ROOT, guard: mockGuard(), window: win });
    core._pushStatus({ state: 'error' }); // should not throw
    assert(true);
  });
});

run();
