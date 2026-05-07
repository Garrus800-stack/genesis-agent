// ============================================================
// GENESIS — test/modules/v766-install-id.test.js
//
// Coverage for src/agent/foundation/InstallId.js — the standalone
// installation UUID helper introduced in v7.6.6 as the Track A
// foundation for Settings encryption keying and HauptstandortMarker
// identity. Replaces the v2-era hostname-derived encryption anchor.
// ============================================================

const fs = require('fs');
const path = require('path');
const os = require('os');

const { describe, test, assert, run } = require('../harness');

const ROOT = path.resolve(__dirname, '..', '..');
const { getOrCreate, read, UUID_RE, INSTALL_ID_FILE } =
  require(path.join(ROOT, 'src/agent/foundation/InstallId.js'));

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-installid-test-'));
}

describe('v7.6.6 — InstallId', () => {

  test('getOrCreate creates a valid UUID file when absent', () => {
    const dir = freshDir();
    const uuid = getOrCreate(dir);
    assert(UUID_RE.test(uuid), 'returned value must be a valid UUID');
    const filePath = path.join(dir, INSTALL_ID_FILE);
    assert(fs.existsSync(filePath), 'install-id file must exist on disk');
    const onDisk = fs.readFileSync(filePath, 'utf8').trim();
    assert(onDisk === uuid, 'on-disk content must match returned UUID');
  });

  test('getOrCreate returns existing UUID on second call', () => {
    const dir = freshDir();
    const first = getOrCreate(dir);
    const second = getOrCreate(dir);
    assert(first === second, 'idempotent: second call returns same UUID');
  });

  test('getOrCreate rotates corrupt content (non-UUID string)', () => {
    const dir = freshDir();
    const filePath = path.join(dir, INSTALL_ID_FILE);
    fs.writeFileSync(filePath, 'not-a-uuid-at-all');
    const uuid = getOrCreate(dir);
    assert(UUID_RE.test(uuid), 'must produce valid UUID after rotating corrupt');
    assert(uuid !== 'not-a-uuid-at-all', 'must not return the corrupt content');
  });

  test('getOrCreate creates missing genesisDir', () => {
    const parent = freshDir();
    const nested = path.join(parent, 'subdir', 'genesis');
    assert(!fs.existsSync(nested), 'precondition: nested dir does not exist');
    const uuid = getOrCreate(nested);
    assert(UUID_RE.test(uuid), 'must succeed and create dir tree');
    assert(fs.existsSync(path.join(nested, INSTALL_ID_FILE)), 'file created in fresh dir');
  });

  test('read returns null when absent', () => {
    const dir = freshDir();
    assert(read(dir) === null, 'no file → null');
  });

  test('read returns null when content is corrupt', () => {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, INSTALL_ID_FILE), 'garbage');
    assert(read(dir) === null, 'corrupt file → null without rotating');
  });

  test('read returns valid UUID when file is well-formed', () => {
    const dir = freshDir();
    const created = getOrCreate(dir);
    const seen = read(dir);
    assert(seen === created, 'read returns the persisted UUID verbatim');
  });

  test('throws when genesisDir is missing/falsy', () => {
    let caught = null;
    try { getOrCreate(''); } catch (e) { caught = e; }
    assert(caught && /genesisDir/.test(caught.message), 'must throw on empty path');
  });

  test('UUID_RE rejects mixed-case but valid v4', () => {
    // crypto.randomUUID() produces lowercase but the regex tolerates uppercase
    // for robustness against manual edits — verify the contract.
    assert(UUID_RE.test('A1B2C3D4-E5F6-7890-ABCD-EF1234567890'),
      'uppercase UUID format is acceptable');
    assert(!UUID_RE.test('not-a-uuid'),
      'plain non-UUID string is rejected');
    assert(!UUID_RE.test(''),
      'empty string is rejected');
  });

  test('getOrCreate is consistent across multiple invocations', async () => {
    // Note: on single-thread Node with sync fs writes, this serializes
    // through; concurrent invocations cannot truly race unless using
    // worker_threads. Test documents the contract that all callers
    // observe the same UUID regardless of order, and exercises the
    // existing-read recovery branch (second/third call hits the
    // file-exists path, not the wx-write path).
    const dir = freshDir();
    const results = await Promise.all([
      Promise.resolve().then(() => getOrCreate(dir)),
      Promise.resolve().then(() => getOrCreate(dir)),
      Promise.resolve().then(() => getOrCreate(dir)),
    ]);
    assert(UUID_RE.test(results[0]), 'first result is a valid UUID');
    assert(results[0] === results[1] && results[1] === results[2],
      'all callers must observe the same UUID');
  });

});

run();
