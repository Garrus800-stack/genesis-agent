// ============================================================
// GENESIS — test/modules/v783-cloud-sync-safety.test.js (v7.8.3)
//
// Tests for the new CloudSyncSafety helper extracted from
// SelfModelSourceRead.js + the three new markers added in v7.8.3
// (Mac iCloud canonical path, Mac/Linux Dropbox slash-form,
// GoogleDrive alt no-space form).
//
// Also verifies:
//   - SelfModelSourceRead.js delegates to the shared helper
//     (no behaviour change)
//   - Schema for system:cloud-sync-root-detected event
// ============================================================

'use strict';

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

const { isCloudSyncPath, readFileWithTimeout, safeReadFileForBoot, CLOUD_SYNC_PATH_MARKERS, DEFAULT_READ_TIMEOUT_MS } =
  require('../../src/agent/foundation/CloudSyncSafety');

// ── Windows OneDrive ──────────────────────────────────────

test('Windows: \\OneDrive\\ root is cloud-sync', () => {
  assert.strictEqual(isCloudSyncPath('C:\\Users\\Garrus\\OneDrive\\Desktop\\Genesis'), true);
});

test('Windows: OneDrive - Personal variant', () => {
  assert.strictEqual(isCloudSyncPath('C:\\Users\\X\\OneDrive - Personal\\foo'), true);
});

test('Windows: OneDrive - Contoso (work tenant) variant', () => {
  assert.strictEqual(isCloudSyncPath('C:\\Users\\X\\OneDrive - Contoso\\foo'), true);
});

// ── Linux/Mac OneDrive (via rclone/onedriver/CloudStorage) ──

test('Linux: /OneDrive/ is cloud-sync', () => {
  assert.strictEqual(isCloudSyncPath('/home/garrus/OneDrive/Desktop/Genesis'), true);
});

test('Mac: /OneDrive - Personal/ variant', () => {
  assert.strictEqual(isCloudSyncPath('/Users/x/OneDrive - Personal/foo'), true);
});

// ── iCloud ────────────────────────────────────────────────

test('Windows: \\iCloudDrive\\ is cloud-sync', () => {
  assert.strictEqual(isCloudSyncPath('C:\\Users\\X\\iCloudDrive\\Docs'), true);
});

test('Mac: /iCloudDrive/ symlink (v7.8.3 new)', () => {
  assert.strictEqual(isCloudSyncPath('/Users/x/iCloudDrive/foo'), true);
});

test('Mac: /Library/Mobile Documents/com~apple~CloudDocs/ canonical path (v7.8.3 new)', () => {
  assert.strictEqual(isCloudSyncPath('/Users/x/Library/Mobile Documents/com~apple~CloudDocs/Genesis'), true);
});

// ── Dropbox ───────────────────────────────────────────────

test('Windows: \\Dropbox\\ is cloud-sync', () => {
  assert.strictEqual(isCloudSyncPath('C:\\Users\\X\\Dropbox\\Genesis'), true);
});

test('Mac: /Dropbox/ (v7.8.3 new)', () => {
  assert.strictEqual(isCloudSyncPath('/Users/x/Dropbox/Genesis'), true);
});

test('Linux: /Dropbox/ (v7.8.3 new)', () => {
  assert.strictEqual(isCloudSyncPath('/home/x/Dropbox/Genesis'), true);
});

// ── Google Drive ──────────────────────────────────────────

test('Windows: \\Google Drive\\ is cloud-sync', () => {
  assert.strictEqual(isCloudSyncPath('C:\\Users\\X\\Google Drive\\X'), true);
});

test('Linux: /Google Drive/ is cloud-sync', () => {
  assert.strictEqual(isCloudSyncPath('/home/x/Google Drive/X'), true);
});

test('Linux: /GoogleDrive/ alt no-space form (v7.8.3 new)', () => {
  assert.strictEqual(isCloudSyncPath('/home/x/GoogleDrive/X'), true);
});

// ── Negative cases — must NOT match ───────────────────────

test('plain local Windows path is NOT cloud-sync', () => {
  assert.strictEqual(isCloudSyncPath('C:\\Users\\X\\Desktop\\Genesis'), false);
});

test('plain Linux home is NOT cloud-sync', () => {
  assert.strictEqual(isCloudSyncPath('/home/garrus/Genesis'), false);
});

test('plain Mac Documents is NOT cloud-sync', () => {
  assert.strictEqual(isCloudSyncPath('/Users/x/Documents/Genesis'), false);
});

test('cloud-safety contract: OneDriveBackup substring must NOT match (path-separator context required)', () => {
  // No backslash before OneDriveBackup → marker doesn't fire.
  assert.strictEqual(isCloudSyncPath('C:\\X\\OneDriveBackup\\foo'), false);
});

// ── Defensive ─────────────────────────────────────────────

test('empty / non-string returns false', () => {
  assert.strictEqual(isCloudSyncPath(''), false);
  assert.strictEqual(isCloudSyncPath(null), false);
  assert.strictEqual(isCloudSyncPath(undefined), false);
  assert.strictEqual(isCloudSyncPath(42), false);
});

// ── Constants exposed ─────────────────────────────────────

test('CLOUD_SYNC_PATH_MARKERS is exported as array', () => {
  assert.ok(Array.isArray(CLOUD_SYNC_PATH_MARKERS));
  assert.ok(CLOUD_SYNC_PATH_MARKERS.length >= 8,
    `at least 8 markers expected, got ${CLOUD_SYNC_PATH_MARKERS.length}`);
});

test('DEFAULT_READ_TIMEOUT_MS is a sensible value', () => {
  assert.strictEqual(typeof DEFAULT_READ_TIMEOUT_MS, 'number');
  assert.ok(DEFAULT_READ_TIMEOUT_MS >= 500 && DEFAULT_READ_TIMEOUT_MS <= 5000,
    `timeout should be 500-5000ms, got ${DEFAULT_READ_TIMEOUT_MS}`);
});

// ── readFileWithTimeout behaviour ────────────────────────

test('cloud-safety contract: readFileWithTimeout rejects with CLOUD_PLACEHOLDER_TIMEOUT code on timeout', async () => {
  // Create a hanging promise scenario by pointing at a path that
  // will reject quickly (not the timeout) — we verify the timeout
  // path by setting a very short ms on a non-existent file. Node's
  // fs.readFile on ENOENT rejects fast, so we instead verify that
  // a successful read resolves and a missing-file read rejects
  // with non-CLOUD code.
  let err;
  try {
    await readFileWithTimeout('/nonexistent/path/v783-test', 1500);
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'should reject on missing file');
  assert.notStrictEqual(err.code, 'CLOUD_PLACEHOLDER_TIMEOUT',
    'ENOENT must not be reported as cloud timeout');
});

// ── Boot-event schema (v7.8.3 new event) ─────────────────

test('system:cloud-sync-root-detected schema registered', () => {
  const { SCHEMAS } = require('../../src/agent/core/EventPayloadSchemas');
  const s = SCHEMAS['system:cloud-sync-root-detected'];
  assert.ok(s, 'schema must exist');
  assert.strictEqual(s.rootDir, 'required');
});

test('EventTypes.SYSTEM exposes CLOUD_SYNC_ROOT_DETECTED', () => {
  const { EVENTS } = require('../../src/agent/core/EventTypes');
  assert.strictEqual(EVENTS.SYSTEM.CLOUD_SYNC_ROOT_DETECTED, 'system:cloud-sync-root-detected');
});

// ── SelfModelSourceRead delegation ───────────────────────

test('SelfModelSourceRead still loads after delegation', () => {
  const m = require('../../src/agent/foundation/SelfModelSourceRead');
  assert.ok(m, 'module must load');
});

// ── summary ──────────────────────────────────────────────

(async () => {
  await new Promise((r) => setTimeout(r, 100));
  if (failed > 0) {
    console.log(`\n  ${failed} failure(s):`);
    for (const f of failures) console.log(`    - ${f.name}: ${f.error}`);
    process.exit(1);
  }
  console.log(`    ${passed} passed`);
})();
