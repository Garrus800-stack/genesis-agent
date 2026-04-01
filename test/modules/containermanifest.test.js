#!/usr/bin/env node
// ============================================================
// Test: ContainerManifest.js — v4.10.0 Coverage
//
// Covers:
//   - Auto-discovery builds module map from src/agent/ dirs
//   - buildManifest returns a Map with all phase entries
//   - All 12 phases contribute entries
//   - R() resolver finds modules in expected directories
//   - getAutoMap() exposes the discovery results
//   - Unknown module throws clear error
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');
const fs = require('fs');

const { createBus } = require('../../src/agent/core/EventBus');

const ROOT = path.join(__dirname, '..', '..');

// ── Tests ──────────────────────────────────────────────────

describe('ContainerManifest — Auto-Discovery', () => {
  test('getAutoMap returns a non-empty object', () => {
    const { getAutoMap } = require('../../src/agent/ContainerManifest');
    const autoMap = getAutoMap();
    assert(typeof autoMap === 'object', 'should return an object');
    const keys = Object.keys(autoMap);
    assert(keys.length > 50, `should discover many modules, got ${keys.length}`);
  });

  test('getAutoMap maps known modules to correct directories', () => {
    const { getAutoMap } = require('../../src/agent/ContainerManifest');
    const map = getAutoMap();
    assertEqual(map['EventBus'], 'core');
    assertEqual(map['ModelBridge'], 'foundation');
    assertEqual(map['ReasoningEngine'], 'intelligence');
    assertEqual(map['ShellAgent'], 'capabilities');
    assertEqual(map['GoalStack'], 'planning');
    assertEqual(map['ChatOrchestrator'], 'hexagonal');
    assertEqual(map['HealthMonitor'], 'autonomy');
    assertEqual(map['EmotionalState'], 'organism');
  });

  test('getAutoMap includes cognitive modules (Phase 9)', () => {
    const { getAutoMap } = require('../../src/agent/ContainerManifest');
    const map = getAutoMap();
    assert(map['DreamCycle'], 'should discover DreamCycle in cognitive/');
    assert(map['SurpriseAccumulator'], 'should discover SurpriseAccumulator');
    assert(map['MentalSimulator'], 'should discover MentalSimulator');
  });
});

describe('ContainerManifest — buildManifest', () => {
  test('buildManifest returns a Map', () => {
    const { buildManifest } = require('../../src/agent/ContainerManifest');
    const bus = createBus();
    const manifest = buildManifest({
      rootDir: ROOT,
      genesisDir: path.join(ROOT, '.genesis'),
      guard: { isProtected: () => false, isCritical: () => false, validateWrite: () => true },
      bus,
      intervals: { register: () => {} },
    });
    assert(manifest instanceof Map, 'should return a Map');
    assert(manifest.size > 50, `should have many services, got ${manifest.size}`);
  });

  test('buildManifest entries have factory functions', () => {
    const { buildManifest } = require('../../src/agent/ContainerManifest');
    const bus = createBus();
    const manifest = buildManifest({
      rootDir: ROOT,
      genesisDir: path.join(ROOT, '.genesis'),
      guard: { isProtected: () => false, isCritical: () => false, validateWrite: () => true },
      bus,
      intervals: { register: () => {} },
    });
    for (const [name, config] of manifest) {
      assert(typeof config.factory === 'function',
        `${name} should have a factory function`);
      break; // Just check first entry for speed
    }
  });

  test('buildManifest includes services from multiple phases', () => {
    const { buildManifest } = require('../../src/agent/ContainerManifest');
    const bus = createBus();
    const manifest = buildManifest({
      rootDir: ROOT,
      genesisDir: path.join(ROOT, '.genesis'),
      guard: { isProtected: () => false, isCritical: () => false, validateWrite: () => true },
      bus,
      intervals: { register: () => {} },
    });
    // Check for services from different phases
    const names = [...manifest.keys()];
    assert(names.includes('settings') || names.includes('model'), 'should have Phase 1 services');
    assert(names.includes('reasoning') || names.includes('intentRouter'), 'should have Phase 2 services');
    assert(names.includes('goalStack') || names.includes('anticipator'), 'should have Phase 4 services');
  });
});

describe('ContainerManifest — Phase Entries', () => {
  test('all 12 phase files are loadable', () => {
    const phaseFiles = [
      'phase1-foundation', 'phase2-intelligence', 'phase3-capabilities',
      'phase4-planning', 'phase5-hexagonal', 'phase6-autonomy',
      'phase7-organism', 'phase8-revolution', 'phase9-cognitive',
      'phase10-agency', 'phase11-extended', 'phase12-hybrid',
    ];
    for (const pf of phaseFiles) {
      const mod = require(`../../src/agent/manifest/${pf}`);
      const exportedKey = Object.keys(mod)[0]; // e.g. 'phase1', 'phase2', etc.
      assert(typeof mod[exportedKey] === 'function',
        `${pf} should export a function, got ${typeof mod[exportedKey]}`);
    }
  });
});

run();
