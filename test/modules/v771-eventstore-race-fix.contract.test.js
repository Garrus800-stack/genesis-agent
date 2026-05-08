'use strict';

// ============================================================
// v7.7.1-hotfix — EventStore <-> GenesisBackup race-condition fix
//
// Pins the second v7.7.1 hotfix (data-loss bug):
//   Before fix: EventStore._flushBatch() did splice(0) before async
//   appendTextAsync; on Windows EBUSY (parallel GenesisBackup copy),
//   the batch was silently dropped — events lost forever.
//
//   After fix:
//   - EventStore retries transient errors (EBUSY/EAGAIN/EPERM) up to
//     3 times; on retry, the lines are restored to the buffer front
//     via concat (call-stack-safe). On retry exhaustion, the failure
//     is logged with explicit event-loss count.
//   - GenesisBackup awaits eventStore.flushPending() before _copyDir,
//     eliminating the race window structurally.
//
// Both layers must be in place — H1 alone misses the window during
// a long copy, H2 alone misses any append that happens during the
// copy itself.
// ============================================================

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..', '..');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`    ✅ ${name}`); passed++; }
  catch (e) { console.log(`    ❌ ${name}: ${e.message}`); failed++; }
}

// ── EventStore retry logic ───────────────────────────────────

test('EventStore: constructor initializes _flushRetries counter', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/EventStore.js'), 'utf-8');
  assert.match(src, /this\._flushRetries\s*=\s*0/,
    '_flushRetries must be initialized to 0 in constructor');
  assert.match(src, /this\._maxFlushRetries\s*=\s*3/,
    '_maxFlushRetries must be set to 3 in constructor');
});

test('EventStore: _flushBatch detects transient errors (EBUSY/EAGAIN/EPERM)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/EventStore.js'), 'utf-8');
  const flushMatch = src.match(/_flushBatch\(\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(flushMatch, '_flushBatch method must exist');
  const body = flushMatch[0];
  assert.match(body, /EBUSY/, 'must check for EBUSY');
  assert.match(body, /EAGAIN/, 'must check for EAGAIN');
  assert.match(body, /EPERM/, 'must check for EPERM');
});

test('EventStore: _flushBatch restores buffer on transient error (call-stack-safe)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/EventStore.js'), 'utf-8');
  const flushMatch = src.match(/_flushBatch\(\)\s*\{[\s\S]*?\n  \}/);
  const body = flushMatch[0];
  // Lines must be put back in front of buffer on transient error.
  // Must use concat (call-stack-safe) rather than unshift(...lines) (limited to ~65k args).
  assert.match(body, /lines\.concat\(this\._writeBatch\)/,
    'must restore lines via concat (call-stack-safe), not unshift(...lines)');
});

test('EventStore: _flushBatch limits retries to _maxFlushRetries', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/EventStore.js'), 'utf-8');
  const flushMatch = src.match(/_flushBatch\(\)\s*\{[\s\S]*?\n  \}/);
  const body = flushMatch[0];
  assert.match(body, /_flushRetries\s*<\s*this\._maxFlushRetries/,
    'must check retry counter against limit before scheduling retry');
});

test('EventStore: _flushBatch resets retries on success', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/EventStore.js'), 'utf-8');
  const flushMatch = src.match(/_flushBatch\(\)\s*\{[\s\S]*?\n  \}/);
  const body = flushMatch[0];
  // The .then() success-path must reset retries to 0
  assert.match(body, /\.then\([^)]*\)\s*=>\s*\{?\s*[\s\S]{0,80}_flushRetries\s*=\s*0/,
    'success path (.then) must reset _flushRetries to 0');
});

test('EventStore: _flushBatch logs explicit event-loss count on hard failure', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/EventStore.js'), 'utf-8');
  const flushMatch = src.match(/_flushBatch\(\)\s*\{[\s\S]*?\n  \}/);
  const body = flushMatch[0];
  assert.match(body, /events lost/,
    'hard-failure log must mention "events lost" so the user sees data loss explicitly');
});

// ── GenesisBackup quiescence wait ────────────────────────────

test('GenesisBackup: constructor accepts eventStore parameter', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/GenesisBackup.js'), 'utf-8');
  assert.match(src, /this\._eventStore\s*=\s*opts\.eventStore/,
    'constructor must store opts.eventStore as this._eventStore');
});

test('GenesisBackup: _doBackup awaits flushPending before _copyDir', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/GenesisBackup.js'), 'utf-8');
  const doBackupMatch = src.match(/async _doBackup\([\s\S]*?\n  \}/);
  assert.ok(doBackupMatch, '_doBackup method must exist');
  const body = doBackupMatch[0];

  const flushIdx = body.indexOf('flushPending');
  const copyIdx = body.indexOf('_copyDir');
  assert.ok(flushIdx > 0, 'flushPending must be referenced in _doBackup');
  assert.ok(copyIdx > 0, '_copyDir must be referenced in _doBackup');
  assert.ok(flushIdx < copyIdx, 'flushPending must be called BEFORE _copyDir');
});

test('GenesisBackup: flushPending failure is non-fatal (best-effort)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/GenesisBackup.js'), 'utf-8');
  const doBackupMatch = src.match(/async _doBackup\([\s\S]*?\n  \}/);
  const body = doBackupMatch[0];
  // The flushPending call must be in try/catch, not allowed to crash the backup.
  assert.match(body, /try\s*\{[\s\S]{0,200}flushPending[\s\S]{0,400}\}\s*catch/,
    'flushPending must be wrapped in try/catch (best-effort, non-fatal)');
});

// ── Manifest wiring ──────────────────────────────────────────

test('phase1-foundation.js: genesisBackup deps include eventStore', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/manifest/phase1-foundation.js'), 'utf-8');
  // Find the genesisBackup entry
  const entryMatch = src.match(/'genesisBackup',\s*\{[\s\S]*?\}\],/);
  assert.ok(entryMatch, 'genesisBackup manifest entry must exist');
  const entry = entryMatch[0];
  assert.match(entry, /deps:\s*\[\s*'eventStore'\s*\]/,
    'genesisBackup must declare eventStore as a dependency');
});

test('phase1-foundation.js: genesisBackup factory passes eventStore', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/manifest/phase1-foundation.js'), 'utf-8');
  const entryMatch = src.match(/'genesisBackup',\s*\{[\s\S]*?\}\],/);
  const entry = entryMatch[0];
  assert.match(entry, /eventStore:\s*c\.resolve\(['"]eventStore['"]\)/,
    'genesisBackup factory must pass eventStore: c.resolve(\'eventStore\')');
});

console.log(`\n    ${passed} passed · ${failed} failed · v7.7.1 eventstore-race-fix`);
process.exit(failed > 0 ? 1 : 0);
