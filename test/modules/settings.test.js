// Test: Settings.js — API key encryption
const path = require('path');
const fs = require('fs');
const os = require('os');

let passed = 0, failed = 0;
// v3.5.2: Fixed — queue-based async-safe test runner
const _testQueue = [];
function test(name, fn) { _testQueue.push({ name, fn }); }
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }

const tmpDir = path.join(os.tmpdir(), 'genesis-test-settings-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });

const { Settings } = require('../../src/agent/foundation/Settings');
const { StorageService } = require('../../src/agent/foundation/StorageService');
const storage = new StorageService(tmpDir);

console.log('\n  📦 Settings Encryption');

test('stores and retrieves API key encrypted', () => {
  const s = new Settings(tmpDir, storage);
  s.set('models.anthropicApiKey', 'sk-ant-test123456789');
  const retrieved = s.get('models.anthropicApiKey');
  assert(retrieved === 'sk-ant-test123456789', `Expected original key, got: ${retrieved}`);
});

test('key is encrypted on disk', async () => {
  // Flush debounced writes to disk
  await storage.flush();
  const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf-8'));
  const stored = raw.models.anthropicApiKey;
  assert(stored.startsWith('enc:') || stored.startsWith('enc2:'), `Expected enc: or enc2: prefix, got: ${stored.slice(0, 20)}`);
  assert(!stored.includes('sk-ant-test'), 'Key should not appear in plaintext');
});

test('hasAnthropic() works with encrypted key', () => {
  const s = new Settings(tmpDir, storage);
  s.set('models.anthropicApiKey', 'sk-ant-test123456789');
  assert(s.hasAnthropic() === true, 'Should detect configured Anthropic');
});

test('getAll() masks keys', () => {
  const s = new Settings(tmpDir, storage);
  s.set('models.anthropicApiKey', 'sk-ant-test123456789');
  const all = s.getAll();
  assert(all.models.anthropicApiKey.includes('...'), 'Should be masked');
  assert(!all.models.anthropicApiKey.includes('sk-ant-test12'), 'Should not show full key');
});

test('migrates plaintext keys on load', async () => {
  // Write plaintext key directly
  const tmpDir2 = path.join(os.tmpdir(), 'genesis-test-settings2-' + Date.now());
  fs.mkdirSync(tmpDir2, { recursive: true });
  fs.writeFileSync(path.join(tmpDir2, 'settings.json'), JSON.stringify({
    models: { anthropicApiKey: 'sk-ant-plaintext999999' },
  }));
  const storage2 = new StorageService(tmpDir2);
  const s = new Settings(tmpDir2, storage2);
  await s.asyncLoad(); // v3.8.0: Must call asyncLoad to read from disk
  // After load, key should be encrypted on disk
  await storage2.flush();
  const raw = JSON.parse(fs.readFileSync(path.join(tmpDir2, 'settings.json'), 'utf-8'));
  assert(
    raw.models.anthropicApiKey.startsWith('enc:') || raw.models.anthropicApiKey.startsWith('enc2:'),
    'Should auto-encrypt on load'
  );
  // But still readable
  assert(s.get('models.anthropicApiKey') === 'sk-ant-plaintext999999', 'Should decrypt correctly');
  fs.rmSync(tmpDir2, { recursive: true, force: true });
});

// Cleanup
fs.rmSync(tmpDir, { recursive: true, force: true });

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
