// ============================================================
// Test: StorageService — centralized persistence
// ============================================================
const path = require('path');
const fs = require('fs');
const os = require('os');
let passed = 0, failed = 0;
const failures = [];
// v3.5.2: Fixed — queue-based async-safe test runner
const _testQueue = [];
function test(name, fn) { _testQueue.push({ name, fn }); }
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }
const { StorageService } = require('../../src/agent/foundation/StorageService');

const tmpDir = path.join(os.tmpdir(), 'genesis-test-storage-' + Date.now());
console.log('\n  💾 StorageService');

test('creates base directory', () => {
  const s = new StorageService(tmpDir);
  assert(fs.existsSync(tmpDir));
});
test('writeJSON + readJSON roundtrip', () => {
  const s = new StorageService(tmpDir);
  s.writeJSON('test1.json', { hello: 'world', n: 42 });
  const data = s.readJSON('test1.json');
  assert(data.hello === 'world' && data.n === 42);
});
test('readJSON returns default for missing file', () => {
  const s = new StorageService(tmpDir);
  assert(s.readJSON('nope.json', 'fallback') === 'fallback');
});
test('writeText + readText roundtrip', () => {
  const s = new StorageService(tmpDir);
  s.writeText('test.txt', 'hello 123');
  assert(s.readText('test.txt') === 'hello 123');
});
test('readText returns default for missing', () => {
  const s = new StorageService(tmpDir);
  assert(s.readText('nope.txt', 'default') === 'default');
});
test('exists returns true/false', () => {
  const s = new StorageService(tmpDir);
  s.writeJSON('exists.json', {});
  assert(s.exists('exists.json'));
  assert(!s.exists('nope.json'));
});
test('delete removes file', () => {
  const s = new StorageService(tmpDir);
  s.writeJSON('del.json', { x: 1 });
  assert(s.exists('del.json'));
  s.delete('del.json');
  assert(!s.exists('del.json'));
});
test('list returns files with prefix', () => {
  const s = new StorageService(tmpDir);
  s.writeJSON('prefix-a.json', {}); s.writeJSON('prefix-b.json', {}); s.writeJSON('other.json', {});
  const list = s.list('prefix-');
  assert(list.length === 2);
});
test('getPath returns resolved path', () => {
  const s = new StorageService(tmpDir);
  const p = s.getPath('foo.json');
  assert(p.startsWith(tmpDir));
});
test('blocks path traversal', () => {
  const s = new StorageService(tmpDir);
  let threw = false;
  try { s.readJSON('../../etc/passwd'); } catch { threw = true; }
  assert(threw, 'Should throw on path traversal');
});
test('getStats returns correct info', () => {
  const s = new StorageService(tmpDir);
  s.writeJSON('stats.json', { data: true });
  const stats = s.getStats();
  assert(stats.fileCount > 0);
  assert(stats.totalSizeKB >= 0);
  assert(stats.baseDir === tmpDir);
});
test('cache returns cached data within TTL', () => {
  const s = new StorageService(tmpDir);
  s.writeJSON('cached.json', { v: 1 });
  s.readJSON('cached.json'); // populate cache
  // Overwrite file directly (bypass cache)
  fs.writeFileSync(path.join(tmpDir, 'cached.json'), '{"v":2}');
  // Should still return cached v:1
  const data = s.readJSON('cached.json');
  assert(data.v === 1, 'Should return cached value');
});
test('clearCache forces re-read', () => {
  const s = new StorageService(tmpDir);
  s.writeJSON('cc.json', { v: 1 });
  s.readJSON('cc.json');
  fs.writeFileSync(path.join(tmpDir, 'cc.json'), '{"v":99}');
  s.clearCache();
  const data = s.readJSON('cc.json');
  assert(data.v === 99, `Expected 99, got ${data.v}`);
});

// Cleanup
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

// v3.5.2: Async-safe runner — properly awaits all tests
(async () => {
  for (const t of _testQueue) {
    try {
      const r = t.fn(); if (r && r.then) await r;
      passed++; console.log(`    ✅ ${t.name}`);
    } catch (err) {
      failed++; console.log(`    ❌ ${t.name}: ${err.message}`);
    }
  }
  console.log(`\n    ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
