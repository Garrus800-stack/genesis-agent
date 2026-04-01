// ============================================================
// Test: ModuleSigner — v4.0.0 Module Integrity
// HMAC-SHA256 signing and verification for self-modified modules.
// ============================================================

const { describe, test, assert, assertEqual, run, createTestRoot } = require('../harness');
const path = require('path');
const fs = require('fs');

// FIX: Use resolved paths so rootDir and file paths are consistent on Windows.
// Previously used raw '/test' which doesn't match path.resolve() output on Windows.
const TEST_ROOT = createTestRoot('modulesigner');
const R = (...segs) => path.join(TEST_ROOT, ...segs);

function mockBus() {
  const events = [];
  return {
    emit: (e, d, opts) => events.push({ e, d, source: opts?.source }),
    fire: (e, d, opts) => events.push({ e, d, source: opts?.source }),
    on: () => {}, removeBySource: () => {}, events,
  };
}
function mockStorage() {
  const store = {};
  return {
    readJSON: (f, def) => store[f] ?? def,
    writeJSON: (f, d) => { store[f] = d; },
    writeJSONDebounced: (f, d) => { store[f] = d; },
    writeJSONAsync: async (f, d) => { store[f] = d; },
    _store: store,
  };
}
function mockGuard() {
  const hashes = new Map();
  hashes.set(R('main.js'), 'abc123def456');
  hashes.set(R('preload.js'), '789ghi012jkl');
  return { kernelHashes: hashes, criticalHashes: new Map() };
}

const { ModuleSigner } = require('../../src/agent/foundation/ModuleSigner');

// ════════════════════════════════════════════════════════════
describe('ModuleSigner — Construction', () => {
  test('constructs with dependencies', () => {
    const signer = new ModuleSigner({
      bus: mockBus(), storage: mockStorage(),
      guard: mockGuard(), rootDir: TEST_ROOT,
    });
    assert(signer != null, 'Should construct');
    assert(typeof signer._secret === 'string' && signer._secret.length > 0, 'Should derive secret');
  });

  test('derives secret from kernel hashes', () => {
    const signer1 = new ModuleSigner({ bus: mockBus(), storage: mockStorage(), guard: mockGuard(), rootDir: TEST_ROOT });
    const signer2 = new ModuleSigner({ bus: mockBus(), storage: mockStorage(), guard: mockGuard(), rootDir: TEST_ROOT });
    assertEqual(signer1._secret, signer2._secret, 'Same kernel hashes should produce same secret');
  });

  test('derives different secret with different guard', () => {
    const guard2 = mockGuard();
    guard2.kernelHashes.set(R('main.js'), 'different-hash');
    const signer1 = new ModuleSigner({ bus: mockBus(), storage: mockStorage(), guard: mockGuard(), rootDir: TEST_ROOT });
    const signer2 = new ModuleSigner({ bus: mockBus(), storage: mockStorage(), guard: guard2, rootDir: TEST_ROOT });
    assert(signer1._secret !== signer2._secret, 'Different kernel hashes should produce different secrets');
  });

  test('falls back to random secret without guard', () => {
    const signer = new ModuleSigner({ bus: mockBus(), storage: mockStorage(), guard: null, rootDir: TEST_ROOT });
    assert(typeof signer._secret === 'string' && signer._secret.length === 64, 'Should have 64-char hex secret');
  });
});

describe('ModuleSigner — Sign & Verify', () => {
  test('sign returns hash and signature', () => {
    const signer = new ModuleSigner({ bus: mockBus(), storage: mockStorage(), guard: mockGuard(), rootDir: TEST_ROOT });
    const result = signer.sign(R('src', 'agent', 'MyModule.js'), 'const x = 1;', { reason: 'test' });
    assert(typeof result.hash === 'string' && result.hash.length === 64, 'Hash should be 64-char hex');
    assert(typeof result.signature === 'string' && result.signature.length === 64, 'Signature should be 64-char hex');
  });

  test('verify passes for correctly signed module', () => {
    const signer = new ModuleSigner({ bus: mockBus(), storage: mockStorage(), guard: mockGuard(), rootDir: TEST_ROOT });
    const code = 'module.exports = { hello: true };';
    signer.sign(R('src', 'agent', 'Hello.js'), code, { reason: 'test' });
    const result = signer.verify(R('src', 'agent', 'Hello.js'), code);
    assert(result.valid === true, 'Should verify correctly');
    assertEqual(result.reason, 'verified');
  });

  test('verify fails for tampered module', () => {
    const bus = mockBus();
    const signer = new ModuleSigner({ bus, storage: mockStorage(), guard: mockGuard(), rootDir: TEST_ROOT });
    signer.sign(R('src', 'agent', 'Hello.js'), 'original code', { reason: 'test' });
    const result = signer.verify(R('src', 'agent', 'Hello.js'), 'tampered code');
    assert(result.valid === false, 'Should detect tampering');
    assertEqual(result.reason, 'hash-mismatch');
    const tamperedEvents = bus.events.filter(e => e.e === 'module:tampered');
    assert(tamperedEvents.length === 1, 'Should emit module:tampered event');
  });

  test('verify passes for unsigned (original) modules', () => {
    const signer = new ModuleSigner({ bus: mockBus(), storage: mockStorage(), guard: mockGuard(), rootDir: TEST_ROOT });
    const result = signer.verify(R('src', 'agent', 'Original.js'), 'any code');
    assert(result.valid === true, 'Unsigned modules are considered original');
    assertEqual(result.reason, 'unsigned-original');
  });
});

describe('ModuleSigner — Registry', () => {
  test('persists signatures to storage', () => {
    const storage = mockStorage();
    const signer = new ModuleSigner({ bus: mockBus(), storage, guard: mockGuard(), rootDir: TEST_ROOT });
    signer.sign(R('src', 'agent', 'A.js'), 'code-a', { reason: 'test' });
    assert(storage._store['module-signatures.json'] != null, 'Should persist');
    const reg = storage._store['module-signatures.json'];
    assert(reg['src/agent/A.js'] != null, 'Should store relative path');
  });

  test('unsign removes entry', () => {
    const storage = mockStorage();
    const signer = new ModuleSigner({ bus: mockBus(), storage, guard: mockGuard(), rootDir: TEST_ROOT });
    signer.sign(R('src', 'agent', 'A.js'), 'code-a');
    signer.unsign(R('src', 'agent', 'A.js'));
    const result = signer.verify(R('src', 'agent', 'A.js'), 'code-a');
    assertEqual(result.reason, 'unsigned-original', 'Should be unsigned after unsign()');
  });

  test('getRegistry returns copy', () => {
    const signer = new ModuleSigner({ bus: mockBus(), storage: mockStorage(), guard: mockGuard(), rootDir: TEST_ROOT });
    signer.sign(R('src', 'agent', 'X.js'), 'x');
    const reg = signer.getRegistry();
    assert(Object.keys(reg).length === 1);
  });
});

describe('ModuleSigner — Stats', () => {
  test('tracks sign/verify/tampered counts', () => {
    const signer = new ModuleSigner({ bus: mockBus(), storage: mockStorage(), guard: mockGuard(), rootDir: TEST_ROOT });
    signer.sign(R('a.js'), 'code-a');
    signer.sign(R('b.js'), 'code-b');
    signer.verify(R('a.js'), 'code-a');
    signer.verify(R('b.js'), 'tampered!');
    const stats = signer.getStats();
    assertEqual(stats.signed, 2);
    assertEqual(stats.verified, 2);
    assertEqual(stats.tampered, 1);
    assertEqual(stats.registrySize, 2);
  });
});

describe('ModuleSigner — Meta', () => {
  test('stores metadata with signature', () => {
    const signer = new ModuleSigner({ bus: mockBus(), storage: mockStorage(), guard: mockGuard(), rootDir: TEST_ROOT });
    signer.sign(R('src', 'm.js'), 'code', {
      reason: 'self-repair', planStep: 3, model: 'gemma2:9b',
    });
    const reg = signer.getRegistry();
    const entry = reg['src/m.js'];
    assertEqual(entry.meta.reason, 'self-repair');
    assertEqual(entry.meta.planStep, 3);
    assertEqual(entry.meta.model, 'gemma2:9b');
    assert(entry.meta.timestamp != null);
  });
});

describe('ModuleSigner — asyncLoad', () => {
  test('loads registry from storage', async () => {
    const storage = mockStorage();
    storage._store['module-signatures.json'] = {
      'src/agent/Test.js': { hash: 'abc', signature: 'def', meta: {} },
    };
    const signer = new ModuleSigner({ bus: mockBus(), storage, guard: mockGuard(), rootDir: TEST_ROOT });
    await signer.asyncLoad();
    assert(Object.keys(signer._registry).length === 1);
  });

  test('handles missing storage gracefully', async () => {
    const signer = new ModuleSigner({ bus: mockBus(), storage: null, guard: mockGuard(), rootDir: TEST_ROOT });
    await signer.asyncLoad();
    assert(Object.keys(signer._registry).length === 0);
  });
});

run();
