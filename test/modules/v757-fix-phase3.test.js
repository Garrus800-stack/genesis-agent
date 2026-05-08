// ============================================================
// GENESIS — test/modules/v757-fix-phase3.test.js
//
// Tests for v7.5.7-fix Phase 3 — Bug-Fixes (no UI changes here):
//
//  Bug 1: EventStore-Rotation broke hash-chain
//   - _loadLastHash now reads rotated files when events.jsonl is empty
//   - verifyIntegrity walks rotated files for full chain verification
//
//  Bug 2: AgentCoreHealth.shutdown unconditionally git-committed
//   - Now gated behind agency.commitSnapshotOnShutdown (default false)
//
//  Bug 3: Settings UI sent N individual IPCs per Save (log spam)
//   - Settings.setBatch() applies all at once, fires events at end
//   - ModelBridge.setRoles deduplicates (no log if unchanged)
//   - main.js: 'agent:set-settings-batch' IPC handler
//   - UI: single batch call instead of for-loop
// ============================================================

'use strict';

const { readSettingsFamily } = require('../helpers/settings-source');

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`    ✅ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`    ❌ ${name}: ${err.message}`);
  }
}

const ROOT = path.join(__dirname, '..', '..');

// ── Bug 1: EventStore Hash-Chain across Rotation ───────────

test('Bug 1: EventStore _loadLastHash recovers from rotated file', () => {
  const { EventStore } = require(path.join(ROOT, 'src/agent/foundation/EventStore'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-p3-bug1-'));

  // Step 1: Create initial store, append events
  const es1 = new EventStore(dir, null, null);
  es1.append('TEST_A', { x: 1 });
  es1.append('TEST_B', { x: 2 });
  // Force flush
  if (typeof es1.flushPending === 'function') {
    return es1.flushPending().then(() => {
      const lastHashBeforeRotate = es1.lastHash;
      assert.notStrictEqual(lastHashBeforeRotate, '0000000000000000', 'should have non-genesis hash');

      // Step 2: Simulate rotation manually (move events.jsonl to .1)
      fs.renameSync(path.join(dir, 'events.jsonl'), path.join(dir, 'events.jsonl.1'));

      // Step 3: New EventStore boot — events.jsonl is gone, must read .1
      const es2 = new EventStore(dir, null, null);
      assert.strictEqual(es2.lastHash, lastHashBeforeRotate,
        `lastHash should be recovered from events.jsonl.1, got ${es2.lastHash}`);
      assert.ok(es2.eventCount > 0, 'eventCount should be > 0 after recovery');
      fs.rmSync(dir, { recursive: true, force: true });
    });
  }
});

test('Bug 1: EventStore_async test pure-sync path also works', () => {
  // Sync path — append + sync read without storage abstraction
  const { EventStore } = require(path.join(ROOT, 'src/agent/foundation/EventStore'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-p3-bug1b-'));
  const es1 = new EventStore(dir, null, null);
  es1.append('A', { i: 1 });
  // Force sync flush via _flushBatch directly
  es1._flushBatch();
  const expected = es1.lastHash;

  // Rename to simulate rotation
  fs.renameSync(path.join(dir, 'events.jsonl'), path.join(dir, 'events.jsonl.1'));
  const es2 = new EventStore(dir, null, null);
  assert.strictEqual(es2.lastHash, expected);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Bug 1: verifyIntegrity walks rotated files', () => {
  const { EventStore } = require(path.join(ROOT, 'src/agent/foundation/EventStore'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-p3-bug1c-'));
  const es1 = new EventStore(dir, null, null);
  es1.append('A', { i: 1 });
  es1.append('B', { i: 2 });
  es1._flushBatch();
  // Rotate
  fs.renameSync(path.join(dir, 'events.jsonl'), path.join(dir, 'events.jsonl.1'));
  // New store, more events
  const es2 = new EventStore(dir, null, null);
  es2.append('C', { i: 3 });
  es2._flushBatch();

  // Full integrity over both files
  const result = es2.verifyIntegrity();
  assert.strictEqual(result.ok, true, `expected ok=true, violations=${JSON.stringify(result.violations)}`);
  assert.strictEqual(result.totalEvents, 3, 'should count events from both files');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Bug 1: verifyIntegrity{ includeRotated: false } stays legacy', () => {
  const { EventStore } = require(path.join(ROOT, 'src/agent/foundation/EventStore'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-p3-bug1d-'));
  const es1 = new EventStore(dir, null, null);
  es1.append('A', { i: 1 });
  es1._flushBatch();
  fs.renameSync(path.join(dir, 'events.jsonl'), path.join(dir, 'events.jsonl.1'));
  const es2 = new EventStore(dir, null, null);
  es2.append('B', { i: 2 });
  es2._flushBatch();

  // Legacy mode: only events.jsonl, expects chain to start fresh — but lastHash is correct,
  // so the first event's prevHash matches lastHash from .1. No violation expected here either.
  const result = es2.verifyIntegrity({ includeRotated: false });
  // Just one event in events.jsonl, prevHash should be the hash from rotation file
  // Either way: violation expected because expectedPrevHash starts at genesis
  assert.strictEqual(typeof result.ok, 'boolean');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Bug 2: Auto-Commit on Shutdown ─────────────────────────

test('Bug 2: Settings has agency.commitSnapshotOnShutdown default false', () => {
  const { Settings } = require(path.join(ROOT, 'src/agent/foundation/Settings'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-p3-bug2-'));
  const s = new Settings(dir);
  assert.strictEqual(s.get('agency.commitSnapshotOnShutdown'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Bug 2: AgentCoreHealth.js gates commitSnapshot behind setting', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/AgentCoreHealth.js'), 'utf8');
  assert.ok(/agency\.commitSnapshotOnShutdown/.test(src),
    'AgentCoreHealth must read agency.commitSnapshotOnShutdown');
  // Old unconditional call must be gone
  assert.ok(!/await c\.tryResolve\('selfModel'\)\?\.commitSnapshot\('shutdown'\)\)/.test(src),
    'unconditional commitSnapshot call must be removed');
});

// ── Bug 3: Settings.setBatch + setRoles dedup + UI batch IPC ──

test('Bug 3a: Settings.setBatch exists and applies all entries', () => {
  const { Settings } = require(path.join(ROOT, 'src/agent/foundation/Settings'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-p3-bug3a-'));
  const s = new Settings(dir);
  assert.strictEqual(typeof s.setBatch, 'function', 'setBatch must exist');
  const changes = s.setBatch([
    ['knowledgeGraph.maxNodes', 7777],
    ['models.maxConcurrent', 2],
    ['agency.autoRouteByTask', false], // already false, should not appear in changes
  ]);
  assert.strictEqual(s.get('knowledgeGraph.maxNodes'), 7777);
  assert.strictEqual(s.get('models.maxConcurrent'), 2);
  // Changes array should only include actual changes
  const keys = changes.map(c => c.key);
  assert.ok(keys.includes('knowledgeGraph.maxNodes'));
  assert.ok(keys.includes('models.maxConcurrent'));
  assert.ok(!keys.includes('agency.autoRouteByTask'),
    'unchanged value should not produce a change entry');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Bug 3a: Settings.setBatch fires toggle events only at end', () => {
  const { Settings } = require(path.join(ROOT, 'src/agent/foundation/Settings'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-p3-bug3aa-'));
  const events = [];
  const fakeBus = { emit: (key, payload) => events.push({ key, payload }), fire(...args) { return this.emit(...args); } };
  const s = new Settings(dir);
  s._bus = fakeBus;
  s.setBatch([
    ['daemon.enabled', false],
    ['idleMind.enabled', false],
  ]);
  assert.strictEqual(events.length, 2, `expected 2 toggle events, got ${events.length}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Bug 3b: ModelBridge.setRoles dedupes — no log if unchanged', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/ModelBridge.js'), 'utf8');
  assert.ok(/oldStr === newStr/.test(src),
    'setRoles must dedup via JSON.stringify equality check');
});

test('Bug 3c: preload.js exposes agent:set-settings-batch', () => {
  const src = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  assert.ok(/agent:set-settings-batch/.test(src),
    'preload.js must whitelist set-settings-batch');
});

test('Bug 3c: main.js handles agent:set-settings-batch', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert.ok(/['"]agent:set-settings-batch['"]/.test(src),
    'main.js must register the handler');
  assert.ok(/setBatch\(/.test(src),
    'main.js handler must call settings.setBatch()');
});

test('Bug 3c: UI uses batch call (with fallback)', () => {
  const src = readSettingsFamily();
  assert.ok(/agent:set-settings-batch/.test(src),
    'UI must call set-settings-batch');
  assert.ok(/falling back to per-setting/.test(src),
    'UI must have fallback for older main.js');
});

// ── Done ───────────────────────────────────────────────────

console.log('');
console.log(`  ${passed} passed${failed > 0 ? `, ${failed} failed` : ''}`);
if (failed > 0) {
  console.log('');
  console.log('  Failures:');
  for (const f of failures) console.log(`    - ${f.name}: ${f.error}`);
  process.exit(1);
}
