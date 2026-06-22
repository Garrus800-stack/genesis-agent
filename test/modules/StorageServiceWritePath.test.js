#!/usr/bin/env node
// Test: StorageService write-path resilience — P1 (v7.9.25)
// - sync writeJSON retries transient rename locks ONLY inside the shutdown window
// - outside the window it makes a single attempt and rethrows
// - a non-transient error is never retried
// - a throwing fsync still closes the descriptor (no fd leak)
// - the async rename retry clears a transient lock without blocking
const { describe, test, assert, assertEqual, run } = require('../harness');
const { StorageService } = require('../../src/agent/foundation/StorageService');
const fs = require('fs');
const os = require('os');
const path = require('path');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-p1-')); }
function expectThrow(fn, msg) {
  let threw = false;
  try { fn(); } catch (_e) { threw = true; }
  assert(threw, msg);
}

const realRenameSync = fs.renameSync;
const realRenameAsync = fs.promises.rename;

// fs.renameSync that throws `code` for the first `failCount` calls, then delegates.
function flakyRenameSync(failCount, code) {
  let calls = 0;
  fs.renameSync = (...a) => {
    calls++;
    if (calls <= failCount) { const e = new Error('simulated lock'); e.code = code; throw e; }
    return realRenameSync(...a);
  };
  return () => calls;
}

describe('StorageService P1 — write-path resilience', () => {

  test('sync write does NOT retry a transient lock outside the shutdown window', () => {
    const s = new StorageService(tmpDir());
    const calls = flakyRenameSync(3, 'EPERM');
    try {
      expectThrow(() => s.writeJSON('genome.json', { a: 1 }), 'rethrows outside the window');
      assertEqual(calls(), 1, 'exactly one rename attempt — no blocking retry outside the window');
    } finally { fs.renameSync = realRenameSync; }
  });

  test('sync write retries a transient lock inside the shutdown window', () => {
    const dir = tmpDir();
    const s = new StorageService(dir);
    s.beginShutdownWindow();
    const calls = flakyRenameSync(3, 'EPERM');
    try {
      s.writeJSON('genome.json', { a: 2 }); // 3 × EPERM, then success
      assertEqual(calls(), 4, 'retried until success (3 fails + 1 ok)');
      assertEqual(JSON.parse(fs.readFileSync(path.join(dir, 'genome.json'), 'utf8')).a, 2,
        'file actually written after the retries');
    } finally { fs.renameSync = realRenameSync; s.endShutdownWindow(); }
  });

  test('sync write does NOT retry a non-transient error even inside the window', () => {
    const s = new StorageService(tmpDir());
    s.beginShutdownWindow();
    const calls = flakyRenameSync(3, 'ENOENT'); // not a transient lock code
    try {
      expectThrow(() => s.writeJSON('genome.json', { a: 3 }), 'rethrows a non-transient error');
      assertEqual(calls(), 1, 'no retry for a non-transient error');
    } finally { fs.renameSync = realRenameSync; s.endShutdownWindow(); }
  });

  test('a throwing fsync still closes the fd (no descriptor leak)', () => {
    const s = new StorageService(tmpDir());
    const realOpen = fs.openSync, realFsync = fs.fsyncSync, realClose = fs.closeSync;
    const closed = [];
    fs.openSync = () => 4242;
    fs.fsyncSync = () => { throw Object.assign(new Error('fsync boom'), { code: 'EIO' }); };
    fs.closeSync = (fd) => { closed.push(fd); };
    try {
      expectThrow(() => s.writeJSON('genome.json', { a: 4 }), 'write fails when fsync throws');
      assert(closed.includes(4242), 'fd was closed despite the fsync throw');
    } finally { fs.openSync = realOpen; fs.fsyncSync = realFsync; fs.closeSync = realClose; }
  });

  test('async rename retry clears a transient lock (non-blocking)', async () => {
    const dir = tmpDir();
    const s = new StorageService(dir);
    let calls = 0;
    fs.promises.rename = async (...a) => {
      calls++;
      if (calls <= 2) { const e = new Error('simulated lock'); e.code = 'EBUSY'; throw e; }
      return realRenameAsync(...a);
    };
    try {
      const tmp = path.join(dir, 'x.tmp'); const full = path.join(dir, 'x.json');
      fs.writeFileSync(tmp, '{"a":5}', 'utf8');
      await s._renameWithRetryAsync(tmp, full); // 2 × EBUSY, then success
      assertEqual(calls, 3, 'async retried until success (2 fails + 1 ok)');
      assert(fs.existsSync(full), 'target present after the async retry');
    } finally { fs.promises.rename = realRenameAsync; }
  });
});

run();
