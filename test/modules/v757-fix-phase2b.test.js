// ============================================================
// GENESIS — test/modules/v757-fix-phase2b.test.js
//
// Tests for v7.5.7-fix Phase 2 round 2:
//  - Settings: workerPool.maxWorkers, eventStore.maxFileSizeMB,
//    eventStore.maxRotations, idleMind.journalMaxFileSizeMB,
//    idleMind.journalMaxRotations
//  - _self-worker: routes LLM via IPC (not direct HTTP)
//  - SelfSpawner: handles llm-request from worker via model.chat
//  - EventStore: _rotateIfNeeded rotates files when over cap
//  - IdleMind: _rotateJournalIfNeeded rotates journal files
// ============================================================

'use strict';

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

// ── Settings new defaults ──────────────────────────────────

test('Settings: workerPool.maxWorkers default 0 (auto)', () => {
  const { Settings } = require(path.join(ROOT, 'src/agent/foundation/Settings'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-p2b-'));
  const s = new Settings(dir);
  assert.strictEqual(s.get('workerPool.maxWorkers'), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Settings: eventStore.maxFileSizeMB default 50', () => {
  const { Settings } = require(path.join(ROOT, 'src/agent/foundation/Settings'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-p2b-'));
  const s = new Settings(dir);
  assert.strictEqual(s.get('eventStore.maxFileSizeMB'), 50);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Settings: eventStore.maxRotations default 3', () => {
  const { Settings } = require(path.join(ROOT, 'src/agent/foundation/Settings'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-p2b-'));
  const s = new Settings(dir);
  assert.strictEqual(s.get('eventStore.maxRotations'), 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Settings: idleMind.journalMaxFileSizeMB default 10', () => {
  const { Settings } = require(path.join(ROOT, 'src/agent/foundation/Settings'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-p2b-'));
  const s = new Settings(dir);
  assert.strictEqual(s.get('idleMind.journalMaxFileSizeMB'), 10);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── _self-worker IPC ───────────────────────────────────────

test('_self-worker: source contains llm-request IPC, not direct HTTP', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/capabilities/_self-worker.js'), 'utf8');
  // Should NOT have http.request to /api/chat anymore
  assert.ok(!/http\.request[\s\S]*?\/api\/chat/.test(src),
    "_self-worker must NOT call /api/chat directly via http.request anymore");
  // Should have IPC delegation
  assert.ok(/llm-request/.test(src), "must send llm-request to parent");
  assert.ok(/llm-response/.test(src), "must handle llm-response from parent");
  assert.ok(/process\.send/.test(src), "must use process.send");
});

test('SelfSpawner: source handles llm-request msg and calls model.chat', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/capabilities/SelfSpawner.js'), 'utf8');
  assert.ok(/msg\.type === ['"]llm-request['"]/.test(src),
    'SelfSpawner must branch on llm-request msg type');
  assert.ok(/this\.model\.chat/.test(src),
    'SelfSpawner must invoke this.model.chat for worker LLM requests');
  assert.ok(/llm-response/.test(src),
    'SelfSpawner must respond with llm-response');
});

// ── EventStore rotation ────────────────────────────────────

test('EventStore: _rotateIfNeeded method exists', () => {
  const { EventStore } = require(path.join(ROOT, 'src/agent/foundation/EventStore'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-es-rot-'));
  const es = new EventStore(dir, null, null);
  assert.strictEqual(typeof es._rotateIfNeeded, 'function');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('EventStore: _rotateIfNeeded no-op when file is small', () => {
  const { EventStore } = require(path.join(ROOT, 'src/agent/foundation/EventStore'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-es-rot-'));
  const es = new EventStore(dir, null, null, { maxFileSizeMB: 100 });
  // Write a small file
  fs.writeFileSync(path.join(dir, 'events.jsonl'), 'small content\n');
  es._rotateIfNeeded();
  assert.ok(fs.existsSync(path.join(dir, 'events.jsonl')), 'file should still exist');
  assert.ok(!fs.existsSync(path.join(dir, 'events.jsonl.1')), 'should not have rotated');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('EventStore: _rotateIfNeeded rotates when over cap', () => {
  const { EventStore } = require(path.join(ROOT, 'src/agent/foundation/EventStore'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-es-rot-'));
  const es = new EventStore(dir, null, null, { maxFileSizeMB: 0.001 }); // 1KB cap
  // Write a "large" file (> 1KB)
  fs.writeFileSync(path.join(dir, 'events.jsonl'), 'x'.repeat(2000));
  es._rotateIfNeeded();
  assert.ok(!fs.existsSync(path.join(dir, 'events.jsonl')), 'original should be rotated away');
  assert.ok(fs.existsSync(path.join(dir, 'events.jsonl.1')), '.1 rotation should exist');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('EventStore: rotation respects maxRotations (drops oldest)', () => {
  const { EventStore } = require(path.join(ROOT, 'src/agent/foundation/EventStore'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-es-rot-'));
  const es = new EventStore(dir, null, null, { maxFileSizeMB: 0.001, maxRotations: 2 });
  // Pre-create rotations and current
  fs.writeFileSync(path.join(dir, 'events.jsonl'), 'x'.repeat(2000));
  fs.writeFileSync(path.join(dir, 'events.jsonl.1'), 'old1');
  fs.writeFileSync(path.join(dir, 'events.jsonl.2'), 'oldest');
  es._rotateIfNeeded();
  // .2 (oldest) should be gone; .1 → .2; current → .1
  assert.ok(fs.existsSync(path.join(dir, 'events.jsonl.1')), '.1 should exist');
  assert.ok(fs.existsSync(path.join(dir, 'events.jsonl.2')), '.2 should exist');
  // The original 'oldest' content should be gone
  const content2 = fs.readFileSync(path.join(dir, 'events.jsonl.2'), 'utf8');
  assert.notStrictEqual(content2, 'oldest', '.2 should now contain what was .1');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('EventStore: maxFileSizeMB=0 disables rotation', () => {
  const { EventStore } = require(path.join(ROOT, 'src/agent/foundation/EventStore'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-es-rot-'));
  const es = new EventStore(dir, null, null, { maxFileSizeMB: 0 });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), 'x'.repeat(10 * 1024 * 1024)); // 10MB
  es._rotateIfNeeded();
  assert.ok(fs.existsSync(path.join(dir, 'events.jsonl')), '0 cap = no rotation');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── IdleMind journal rotation ──────────────────────────────

test('IdleMind: _rotateJournalIfNeeded method exists', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/autonomy/IdleMindJournal.js'), 'utf8');
  assert.ok(/_rotateJournalIfNeeded/.test(src),
    'IdleMindJournal must declare _rotateJournalIfNeeded');
});

test('IdleMind: rotation thresholds in constructor', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/autonomy/IdleMind.js'), 'utf8');
  assert.ok(/_journalMaxFileSizeMB/.test(src), 'must define _journalMaxFileSizeMB');
  assert.ok(/_journalMaxRotations/.test(src), 'must define _journalMaxRotations');
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
