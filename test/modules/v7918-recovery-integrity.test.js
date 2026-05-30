#!/usr/bin/env node
// ============================================================
// GENESIS — test/modules/v7918-recovery-integrity.test.js
// v7.9.18 Recovery-/Snapshot-Integrity fixes. These guard the
// failure CLASS that silently reverted v7.9.16/17 on the field
// machine — a crash-recovery restoring a pre-v7.9.16 code snapshot
// over the live deployment (version-mixed "Frankenstein" tree).
//
//   A1  — code snapshots live habitat-local (<rootDir>/snapshots),
//         NOT inside .genesis/ (identity); legacy folder migrated aside
//   A2  — restore() refuses a snapshot from a different codeVersion
//   A3  — postBootSuccess() does not freeze _last_good_boot after a
//         boot with service.start() failures
//   B1  — AgentCoreWire collects start() failures (startFailures getter)
//   C1  — IdleMindActivityStats persists via the synchronous writeJSON()
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run, createTestRoot } = require('../harness');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const { SnapshotManager } = require(path.join(ROOT, 'src/agent/capabilities/SnapshotManager'));
const { BootRecovery } = require(path.join(ROOT, 'src/agent/foundation/BootRecovery'));
const { AgentCoreWire } = require(path.join(ROOT, 'src/agent/AgentCoreWire'));
const { activityStatsMixin } = require(path.join(ROOT, 'src/agent/autonomy/IdleMindActivityStats'));

// ── Helpers ──────────────────────────────────────────────

function makeHabitat(label, version = '7.9.18') {
  const root = createTestRoot(label);
  fs.mkdirSync(path.join(root, 'src', 'agent'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'agent', 'X.js'), 'module.exports = 1;');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version }));
  fs.mkdirSync(path.join(root, '.genesis'), { recursive: true });
  return root;
}

function makeMgr(root) {
  return new SnapshotManager({
    rootDir: root,
    storage: { baseDir: path.join(root, '.genesis') },
    guard: { validateWrite: () => true },
  });
}

// ── A1: habitat-local snapshot location ──────────────────

describe('v7.9.18 A1 — snapshots live in the habitat, not the identity', () => {
  test('snapshot base is <rootDir>/snapshots, independent of storage.baseDir', () => {
    const root = makeHabitat('v7918-a1-base');
    const mgr = makeMgr(root);
    assertEqual(mgr._snapshotBase, path.join(root, 'snapshots'),
      'base must be rootDir-local');
    assert(!mgr._snapshotBase.includes(path.join('.genesis', 'snapshots')),
      'base must NOT be inside .genesis/');
  });

  test('created snapshots land under <rootDir>/snapshots', () => {
    const root = makeHabitat('v7918-a1-create');
    const mgr = makeMgr(root);
    mgr.create('_last_good_boot');
    assert(fs.existsSync(path.join(root, 'snapshots', '_last_good_boot')),
      'snapshot dir under rootDir/snapshots');
    assert(!fs.existsSync(path.join(root, '.genesis', 'snapshots', '_last_good_boot')),
      'nothing written into .genesis/snapshots');
  });
});

// ── A1 migration: move legacy folder aside ───────────────

describe('v7.9.18 A1 — legacy .genesis/snapshots migration', () => {
  test('moves a pre-v7.9.18 .genesis/snapshots aside to .deprecated.<ts>', () => {
    const root = makeHabitat('v7918-mig-move');
    // seed contamination
    fs.mkdirSync(path.join(root, '.genesis', 'snapshots', 'old'), { recursive: true });
    fs.writeFileSync(path.join(root, '.genesis', 'snapshots', 'old', 'm.txt'), 'legacy');
    const mgr = makeMgr(root);

    const res = mgr.migrateIfNeeded();
    assert(res.migrated === true, 'should report migration');
    assert(!fs.existsSync(path.join(root, '.genesis', 'snapshots')),
      'legacy folder gone from identity');
    assert(fs.existsSync(res.movedTo), 'deprecated folder exists');
    assert(path.basename(res.movedTo).startsWith('snapshots.deprecated.'),
      'deprecated naming');
    assert(fs.existsSync(path.join(res.movedTo, 'old', 'm.txt')),
      'legacy content preserved for forensics');
  });

  test('is idempotent — second call is a no-op', () => {
    const root = makeHabitat('v7918-mig-idem');
    fs.mkdirSync(path.join(root, '.genesis', 'snapshots'), { recursive: true });
    const mgr = makeMgr(root);
    assert(mgr.migrateIfNeeded().migrated === true, 'first migrates');
    assertEqual(mgr.migrateIfNeeded().migrated, false, 'second is no-op');
  });

  test('no legacy folder → no-op, no error', () => {
    const root = makeHabitat('v7918-mig-none');
    const mgr = makeMgr(root);
    assertEqual(mgr.migrateIfNeeded().migrated, false);
  });
});

// ── A2: version-aware restore ────────────────────────────

describe('v7.9.18 A2 — restore() is version-aware', () => {
  test('create() stores the current codeVersion in metadata', () => {
    const root = makeHabitat('v7918-a2-store', '7.9.18');
    const mgr = makeMgr(root);
    const meta = mgr.create('snap');
    assertEqual(meta.codeVersion, '7.9.18', 'codeVersion recorded');
  });

  test('restore() SKIPS a snapshot whose codeVersion differs (soft, no copy)', () => {
    const root = makeHabitat('v7918-a2-skip', '7.9.18');
    const mgr = makeMgr(root);
    mgr.create('snap');
    // tamper the stored version to simulate a foreign-habitat snapshot
    const metaPath = path.join(root, 'snapshots', 'snap', '_snapshot.json');
    const j = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    j.codeVersion = '7.9.10';
    fs.writeFileSync(metaPath, JSON.stringify(j));

    const res = mgr.restore('snap');
    assert(res.skipped === true, 'restore reports skip');
    assertEqual(res.reason, 'version-mismatch');
    assertEqual(res.restored, 0, 'no files copied on mismatch');
  });

  test('restore() PROCEEDS when codeVersion matches', () => {
    const root = makeHabitat('v7918-a2-match', '7.9.18');
    const mgr = makeMgr(root);
    mgr.create('snap');
    const res = mgr.restore('snap');
    assert(res.skipped === undefined, 'no skip on match');
    assert(res.restored >= 1, 'files restored on match');
  });

  test('restore() proceeds when snapshot has no codeVersion (unverifiable, A1 covers main case)', () => {
    const root = makeHabitat('v7918-a2-legacy', '7.9.18');
    const mgr = makeMgr(root);
    mgr.create('snap');
    const metaPath = path.join(root, 'snapshots', 'snap', '_snapshot.json');
    const j = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    delete j.codeVersion;
    fs.writeFileSync(metaPath, JSON.stringify(j));
    const res = mgr.restore('snap');
    assert(res.skipped === undefined, 'missing version does not hard-skip');
    assert(res.restored >= 1);
  });
});

// ── A3: do not freeze a degraded boot ────────────────────

describe('v7.9.18 A3 — _last_good_boot only after a clean boot', () => {
  function makeRecovery(root, recordCreate) {
    const genesisDir = path.join(root, '.genesis');
    const snapshotManager = {
      created: [],
      create(name) { this.created.push(name); recordCreate && recordCreate(name); },
      list() { return []; },
    };
    return { rec: new BootRecovery({ genesisDir, snapshotManager, rootDir: root }), snapshotManager };
  }

  test('skips _last_good_boot when start failures are present', () => {
    const root = makeHabitat('v7918-a3-skip');
    const { rec, snapshotManager } = makeRecovery(root);
    rec.postBootSuccess(['trajectoryCalibration']);
    assert(!snapshotManager.created.includes('_last_good_boot'),
      'must NOT freeze a degraded boot');
  });

  test('creates _last_good_boot when there are no start failures', () => {
    const root = makeHabitat('v7918-a3-clean');
    const { rec, snapshotManager } = makeRecovery(root);
    rec.postBootSuccess([]);
    assert(snapshotManager.created.includes('_last_good_boot'),
      'clean boot freezes last-good');
  });

  test('defaults to clean when called with no argument (back-compat)', () => {
    const root = makeHabitat('v7918-a3-default');
    const { rec, snapshotManager } = makeRecovery(root);
    rec.postBootSuccess();
    assert(snapshotManager.created.includes('_last_good_boot'),
      'no-arg call treated as clean');
  });
});

// ── B1: AgentCoreWire collects start() failures ──────────

describe('v7.9.18 B1 — AgentCoreWire start-failure tally', () => {
  test('startFailures is an empty array on a fresh wire', () => {
    const wire = new AgentCoreWire({});
    assert(Array.isArray(wire.startFailures), 'is an array');
    assertEqual(wire.startFailures.length, 0, 'empty before any start');
  });
});

// ── C1: synchronous, crash-safe idle-stats persistence ───

describe('v7.9.18 C1 — idle activity-stats persist synchronously', () => {
  function makeStatObj(storage) {
    const obj = Object.assign({}, activityStatsMixin);
    obj.storage = storage;
    obj.thoughtCount = 0;
    obj._activityCounts = new Map();
    obj.activityLog = [];
    obj._log = { debug() {} };
    return obj;
  }

  test('_saveActivityStats uses synchronous writeJSON, not writeJSONDebounced', () => {
    const calls = { writeJSON: 0, writeJSONDebounced: 0 };
    const storage = {
      writeJSON() { calls.writeJSON++; },
      writeJSONDebounced() { calls.writeJSONDebounced++; },
    };
    const obj = makeStatObj(storage);
    obj.thoughtCount = 3;
    obj._activityCounts.set('ideate', 2);
    obj._saveActivityStats();
    assertEqual(calls.writeJSON, 1, 'synchronous write used');
    assertEqual(calls.writeJSONDebounced, 0, 'debounced write NOT used');
  });

  test('save→load round-trips thoughtCount and activityCounts', () => {
    const files = new Map();
    const storage = {
      writeJSON(name, payload) { files.set(name, JSON.parse(JSON.stringify(payload))); },
      readJSON(name, fallback) { return files.has(name) ? files.get(name) : fallback; },
    };
    const a = makeStatObj(storage);
    a.thoughtCount = 7;
    a._activityCounts.set('explore', 4);
    a._saveActivityStats();

    const b = makeStatObj(storage);
    b._loadActivityStats();
    assertEqual(b.thoughtCount, 7, 'thoughtCount restored');
    assertEqual(b._activityCounts.get('explore'), 4, 'activityCounts restored');
  });
});

run();
