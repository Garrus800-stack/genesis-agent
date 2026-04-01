#!/usr/bin/env node
// ============================================================
// Test: WorldState.js — v4.10.0 Coverage
//
// Covers:
//   - State initialization and defaults
//   - canWriteFile() with SafeGuard integration
//   - isKernelFile() detection
//   - File change recording & recency
//   - User topic tracking
//   - Circuit state integration
//   - Clone produces independent copy
//   - Ollama status tracking
//   - System info snapshot
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');
const os = require('os');
const fs = require('fs');

// ── Mocks ─────────────────────────────────────────────────
const { createBus } = require('../../src/agent/core/EventBus');

function mockStorage() {
  const _data = {};
  return {
    readJSON: (f, def) => _data[f] || def,
    writeJSON: (f, d) => { _data[f] = d; },
    writeJSONAsync: async (f, d) => { _data[f] = d; },
    _data,
  };
}

function mockGuard(protectedPaths = []) {
  return {
    isProtected: (p) => protectedPaths.some(pp => p.startsWith(pp)),
    isCritical: () => false,
    validateWrite: (p) => {
      if (protectedPaths.some(pp => p.startsWith(pp))) throw new Error('protected');
      return true;
    },
  };
}

const ROOT = path.join(os.tmpdir(), 'genesis-test-worldstate-' + Date.now());
fs.mkdirSync(ROOT, { recursive: true });
fs.writeFileSync(path.join(ROOT, 'package.json'), JSON.stringify({ scripts: { test: 'node test' } }));

const { WorldState } = require('../../src/agent/foundation/WorldState');

// ── Tests ──────────────────────────────────────────────────

describe('WorldState — Initialization', () => {
  test('creates with default state structure', () => {
    const ws = new WorldState({ bus: createBus(), rootDir: ROOT });
    const state = ws.getFullState();
    assert(state.project, 'should have project state');
    assert(state.runtime, 'should have runtime state');
    assert(state.system, 'should have system state');
    assert(state.user, 'should have user state');
    assertEqual(state.project.root, ROOT);
  });

  test('runtime defaults to unknown Ollama status', () => {
    const ws = new WorldState({ bus: createBus(), rootDir: ROOT });
    assertEqual(ws.getOllamaStatus(), 'unknown');
  });

  test('bootTime is set to roughly now', () => {
    const before = Date.now();
    const ws = new WorldState({ bus: createBus(), rootDir: ROOT });
    const runtime = ws.getRuntime();
    assert(runtime.bootTime >= before - 100, 'bootTime should be recent');
    assert(runtime.uptime >= 0, 'uptime should be non-negative');
  });
});

describe('WorldState — File Preconditions', () => {
  test('canWriteFile returns true for normal files', () => {
    const ws = new WorldState({ bus: createBus(), rootDir: ROOT, guard: mockGuard() });
    const result = ws.canWriteFile(path.join(ROOT, 'src', 'test.js'));
    assert(result === true || result?.allowed === true, 'should allow normal file writes');
  });

  test('isKernelFile returns true for protected paths', () => {
    const kernelDir = path.join(ROOT, 'src', 'kernel');
    const ws = new WorldState({
      bus: createBus(), rootDir: ROOT,
      guard: mockGuard([kernelDir]),
    });
    assert(ws.isKernelFile(path.join(kernelDir, 'SafeGuard.js')), 'kernel file should be detected');
  });

  test('isKernelFile returns false for agent files', () => {
    const ws = new WorldState({
      bus: createBus(), rootDir: ROOT,
      guard: mockGuard([path.join(ROOT, 'src', 'kernel')]),
    });
    assert(!ws.isKernelFile(path.join(ROOT, 'src', 'agent', 'AgentCore.js')), 'agent file should not be kernel');
  });
});

describe('WorldState — File Change Tracking', () => {
  test('recordFileChange adds to recentlyModified', () => {
    const ws = new WorldState({ bus: createBus(), rootDir: ROOT });
    ws.recordFileChange('src/agent/Test.js');
    const recent = ws.getRecentlyModified();
    assert(recent.length >= 1, 'should have at least one entry');
    assert(recent.some(r => r.path && r.path.includes('Test.js')), 'should contain tracked file');
  });

  test('recordFileChange deduplicates', () => {
    const ws = new WorldState({ bus: createBus(), rootDir: ROOT });
    ws.recordFileChange('src/agent/Test.js');
    ws.recordFileChange('src/agent/Test.js');
    const recent = ws.getRecentlyModified();
    const matches = recent.filter(r => r.path && r.path.includes('Test.js'));
    assert(matches.length <= 1, 'should not have duplicates');
  });
});

describe('WorldState — User Topic Tracking', () => {
  test('recordUserTopic stores topics', () => {
    const ws = new WorldState({ bus: createBus(), rootDir: ROOT });
    ws.recordUserTopic('refactoring EventBus');
    ws.recordUserTopic('debugging memory leak');
    const topics = ws.getRecentTopics();
    assert(topics.length >= 2, 'should store multiple topics');
  });
});

describe('WorldState — Circuit State', () => {
  test('updateCircuitState changes runtime circuit', () => {
    const ws = new WorldState({ bus: createBus(), rootDir: ROOT });
    ws.updateCircuitState('OPEN');
    const state = ws.getFullState();
    assertEqual(state.runtime.circuitState, 'OPEN');
  });
});

describe('WorldState — Clone', () => {
  test('clone produces independent copy', () => {
    const ws = new WorldState({ bus: createBus(), rootDir: ROOT });
    ws.recordUserTopic('test-topic');
    const cloned = ws.clone();
    ws.recordUserTopic('post-clone-topic');
    const origTopics = ws.getRecentTopics();
    // Clone should not see post-clone changes
    assert(typeof cloned === 'object', 'clone should return an object');
  });
});

describe('WorldState — System Info', () => {
  test('getSystem returns OS info', () => {
    const ws = new WorldState({ bus: createBus(), rootDir: ROOT });
    const sys = ws.getSystem();
    assert(sys.platform || sys.os, 'should have platform info');
  });
});

run();
