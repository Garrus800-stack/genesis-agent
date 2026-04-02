// ============================================================
// GENESIS — storage-write-queue.test.js (v4.0.0)
// Tests for merge-aware debounced writes and writeJSONQueued.
// ============================================================

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { StorageService } = require('../../src/agent/foundation/StorageService');

let testDir;
let storage;

function setup() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-storage-test-'));
  storage = new StorageService(testDir);
}

function cleanup() {
  // Flush pending debounce timers to prevent hanging
  if (storage) {
    try { storage.flush(); } catch { /* ok */ }
    // Clear any remaining debounce timers
    if (storage._debounceTimers) {
      for (const [, timer] of storage._debounceTimers) clearTimeout(timer);
      storage._debounceTimers.clear();
    }
    if (storage._debouncePending) storage._debouncePending.clear();
  }
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ok */ }
}

// Force exit after all tests complete (node:test keeps process alive on open handles)
setTimeout(() => process.exit(0), 15000).unref();

describe('StorageService — writeJSONDebounced with merge', () => {
  beforeEach(setup);
  afterEach(cleanup);

  it('should work without mergeFn (last-write-wins)', async () => {
    storage.writeJSONDebounced('test.json', { a: 1 }, 50);
    storage.writeJSONDebounced('test.json', { b: 2 }, 50);
    // Wait for debounce + write
    await new Promise(r => setTimeout(r, 120));
    await storage.flush();
    const data = storage.readJSON('test.json');
    assert.deepEqual(data, { b: 2 });
  });

  it('should merge with mergeFn when provided', async () => {
    const merge = (existing, incoming) => ({ ...existing, ...incoming });

    storage.writeJSONDebounced('test.json', { a: 1 }, 50, merge);
    storage.writeJSONDebounced('test.json', { b: 2 }, 50, merge);
    storage.writeJSONDebounced('test.json', { c: 3 }, 50, merge);

    // Wait for debounce
    await new Promise(r => setTimeout(r, 120));
    await storage.flush();

    const data = storage.readJSON('test.json');
    assert.deepEqual(data, { a: 1, b: 2, c: 3 });
  });

  it('should count merges in stats', async () => {
    const merge = (a, b) => ({ ...a, ...b });

    storage.writeJSONDebounced('test.json', { x: 1 }, 100, merge);
    storage.writeJSONDebounced('test.json', { y: 2 }, 100, merge);

    const stats = storage.getWriteStats();
    assert.equal(stats.merges, 1); // One merge happened
  });

  it('should fall back to new data if mergeFn throws', async () => {
    const badMerge = () => { throw new Error('merge failed'); };

    storage.writeJSONDebounced('test.json', { old: true }, 50, badMerge);
    storage.writeJSONDebounced('test.json', { new: true }, 50, badMerge);

    await new Promise(r => setTimeout(r, 120));
    await storage.flush();

    const data = storage.readJSON('test.json');
    assert.deepEqual(data, { new: true });
  });

  it('should expose pending debounced count in getWriteStats', () => {
    storage.writeJSONDebounced('a.json', { a: 1 }, 60000); // Long delay
    storage.writeJSONDebounced('b.json', { b: 2 }, 60000);

    const stats = storage.getWriteStats();
    assert.equal(stats.pendingDebounced, 2);
  });

  it('flush should drain all pending debounced writes', async () => {
    storage.writeJSONDebounced('x.json', { x: 1 }, 60000);
    storage.writeJSONDebounced('y.json', { y: 2 }, 60000);

    await storage.flush();

    assert.deepEqual(storage.readJSON('x.json'), { x: 1 });
    assert.deepEqual(storage.readJSON('y.json'), { y: 2 });
    assert.equal(storage.getWriteStats().pendingDebounced, 0);
  });
});

describe('StorageService — writeJSONQueued', () => {
  beforeEach(setup);
  afterEach(cleanup);

  it('should serialize updates to same file', async () => {
    // Write initial data
    storage.writeJSON('counter.json', { count: 0 });

    // Queue 5 increments concurrently
    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(storage.writeJSONQueued('counter.json', (current) => ({
        count: (current?.count || 0) + 1,
      })));
    }
    await Promise.all(promises);

    const data = storage.readJSON('counter.json');
    assert.equal(data.count, 5, 'All 5 increments should be applied');
  });

  it('should handle null initial state', async () => {
    await storage.writeJSONQueued('new-file.json', (current) => ({
      items: [...(current?.items || []), 'first'],
    }));

    const data = storage.readJSON('new-file.json');
    assert.deepEqual(data, { items: ['first'] });
  });

  it('should maintain ordering (FIFO)', async () => {
    storage.writeJSON('log.json', { entries: [] });

    await storage.writeJSONQueued('log.json', (d) => ({
      entries: [...(d?.entries || []), 'A'],
    }));
    await storage.writeJSONQueued('log.json', (d) => ({
      entries: [...(d?.entries || []), 'B'],
    }));
    await storage.writeJSONQueued('log.json', (d) => ({
      entries: [...(d?.entries || []), 'C'],
    }));

    const data = storage.readJSON('log.json');
    assert.deepEqual(data.entries, ['A', 'B', 'C']);
  });

  it('should not block writes to different files', async () => {
    const p1 = storage.writeJSONQueued('a.json', () => ({ file: 'a' }));
    const p2 = storage.writeJSONQueued('b.json', () => ({ file: 'b' }));

    await Promise.all([p1, p2]);

    assert.deepEqual(storage.readJSON('a.json'), { file: 'a' });
    assert.deepEqual(storage.readJSON('b.json'), { file: 'b' });
  });
});

describe('StorageService — backward compatibility', () => {
  beforeEach(setup);
  afterEach(cleanup);

  it('writeJSONDebounced without mergeFn should match v4.0 behavior', async () => {
    storage.writeJSONDebounced('compat.json', { test: true }, 30);
    await new Promise(r => setTimeout(r, 80));
    await storage.flush();
    assert.deepEqual(storage.readJSON('compat.json'), { test: true });
  });

  it('sync writeJSON should still work with contention tracking', () => {
    storage.writeJSON('sync.json', { sync: true });
    assert.deepEqual(storage.readJSON('sync.json'), { sync: true });
  });

  it('async writeJSONAsync should still chain per-file', async () => {
    await storage.writeJSONAsync('async.json', { v: 1 });
    await storage.writeJSONAsync('async.json', { v: 2 });
    const data = storage.readJSON('async.json');
    assert.equal(data.v, 2);
  });
});
