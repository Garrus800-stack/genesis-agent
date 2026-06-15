'use strict';
// v7.9.23 (Point 1) — single-instance lock in BootRecovery. The lock lives as a sibling of .genesis/
// (never inside it, so a GenesisBackup cannot capture it). A second acquire against a live lock throws
// GENESIS_LOCK_HELD; a stale lock (old heartbeat) is reclaimed before any pid probe; a fresh lock from
// a different host is treated as alive; release clears the heartbeat and removes the file.
const { describe, test, run, assert } = require('../harness');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BootRecovery } = require('../../src/agent/foundation/BootRecovery');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-lock-'));
  const genesisDir = path.join(root, '.genesis');
  fs.mkdirSync(genesisDir, { recursive: true });
  return { root, genesisDir, lockPath: path.join(root, '.genesis.lock') };
}
function mk(genesisDir, root) {
  return new BootRecovery({ genesisDir, snapshotManager: null, rootDir: root });
}

describe('v7923 single-instance lock', () => {
  test('lock file is a sibling of .genesis/, holding pid/ts/host', () => {
    const { root, genesisDir, lockPath } = setup();
    const br = mk(genesisDir, root);
    br.acquireLock();
    assert(fs.existsSync(lockPath), 'lock file created beside .genesis/');
    assert(!fs.existsSync(path.join(genesisDir, '.genesis.lock')), 'lock is NOT inside .genesis/');
    const rec = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert(rec.pid === process.pid && typeof rec.ts === 'number' && rec.host === os.hostname(), 'lock holds pid/ts/host');
    br.releaseLock();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('second acquire against a live lock throws GENESIS_LOCK_HELD', () => {
    const { root, genesisDir } = setup();
    const a = mk(genesisDir, root);
    a.acquireLock();
    const b = mk(genesisDir, root);
    let code = null;
    try { b.acquireLock(); } catch (e) { code = e.code; }
    assert(code === 'GENESIS_LOCK_HELD', 'second boot refused with GENESIS_LOCK_HELD — got: ' + code);
    a.releaseLock();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('release removes the lock; a subsequent acquire succeeds', () => {
    const { root, genesisDir, lockPath } = setup();
    const a = mk(genesisDir, root);
    a.acquireLock();
    a.releaseLock();
    assert(!fs.existsSync(lockPath), 'lock file removed on release');
    const b = mk(genesisDir, root);
    let threw = false;
    try { b.acquireLock(); } catch (_e) { threw = true; }
    assert(!threw, 'acquire after release succeeds');
    b.releaseLock();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('a stale lock (old heartbeat) is reclaimed before any pid probe — guards pid reuse', () => {
    const { root, genesisDir, lockPath } = setup();
    // Same (live) pid but a stale ts: the stale check must short-circuit to reclaimable, so a reused
    // pid that now belongs to an unrelated live process cannot wedge the lock forever.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() - 5 * 60 * 1000, host: os.hostname() }), 'utf8');
    const a = mk(genesisDir, root);
    let threw = false;
    try { a.acquireLock(); } catch (_e) { threw = true; }
    assert(!threw, 'stale lock reclaimed without refusal');
    const rec = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert(Date.now() - rec.ts < 30 * 1000, 'lock ts refreshed after reclaim');
    a.releaseLock();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('a fresh lock from a different host is treated as alive (refused)', () => {
    const { root, genesisDir, lockPath } = setup();
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 12345, ts: Date.now(), host: 'some-other-host-xyz' }), 'utf8');
    const a = mk(genesisDir, root);
    let code = null;
    try { a.acquireLock(); } catch (e) { code = e.code; }
    assert(code === 'GENESIS_LOCK_HELD', 'fresh remote-host lock refused — got: ' + code);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

if (require.main === module) run();
