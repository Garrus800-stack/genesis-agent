// ============================================================
// Test: PeerCrypto.js — PBKDF2 session key cache
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const { deriveSessionKey, getKeyCacheStats, clearKeyCache, PBKDF2_ITERATIONS,
        encrypt, decrypt } = require('../../src/agent/hexagonal/PeerCrypto');

describe('PeerCrypto: PBKDF2 Cache', () => {

  test('first derivation returns 64-char hex key', () => {
    clearKeyCache();
    const key = deriveSessionKey('secret', 'salt123');
    assertEqual(key.length, 64);
    assert(/^[0-9a-f]+$/.test(key), 'Key should be hex');
  });

  test('second call with same inputs returns cached key (fast)', () => {
    clearKeyCache();
    const key1 = deriveSessionKey('shared', 'saltyA');
    const start = Date.now();
    const key2 = deriveSessionKey('shared', 'saltyA');
    const elapsed = Date.now() - start;
    assertEqual(key1, key2, 'Cached key should match');
    assert(elapsed < 50, `Cache hit should be < 50ms, was ${elapsed}ms`);
  });

  test('different inputs produce different keys', () => {
    clearKeyCache();
    const k1 = deriveSessionKey('secret1', 'salt1');
    const k2 = deriveSessionKey('secret2', 'salt2');
    assert(k1 !== k2, 'Different inputs should produce different keys');
  });

  test('getKeyCacheStats reports cache size', () => {
    clearKeyCache();
    deriveSessionKey('a', 'b');
    deriveSessionKey('c', 'd');
    const stats = getKeyCacheStats();
    assertEqual(stats.size, 2);
    assert(stats.maxSize > 0);
    assert(stats.ttlMs > 0);
  });

  test('cache hit increments hit counter', () => {
    clearKeyCache();
    deriveSessionKey('hitme', 'salt');
    deriveSessionKey('hitme', 'salt'); // hit
    deriveSessionKey('hitme', 'salt'); // hit
    const stats = getKeyCacheStats();
    assertEqual(stats.totalHits, 2, 'Should count 2 cache hits');
  });

  test('clearKeyCache empties cache', () => {
    deriveSessionKey('temp', 'salt');
    clearKeyCache();
    const stats = getKeyCacheStats();
    assertEqual(stats.size, 0);
  });

  test('PBKDF2_ITERATIONS is OWASP-compliant (600000)', () => {
    assertEqual(PBKDF2_ITERATIONS, 600000);
  });
});

describe('PeerCrypto: Encrypt/Decrypt roundtrip', () => {

  test('encrypt + decrypt returns original plaintext', () => {
    const key = deriveSessionKey('roundtrip', 'salt');
    const plaintext = 'Hello Genesis! 🧬';
    const ciphertext = encrypt(plaintext, key);
    const decrypted = decrypt(ciphertext, key);
    assertEqual(decrypted, plaintext);
  });

  test('different IVs produce different ciphertexts', () => {
    const key = deriveSessionKey('iv-test', 'salt');
    const c1 = encrypt('same text', key);
    const c2 = encrypt('same text', key);
    assert(c1 !== c2, 'Should use random IV each time');
  });

  test('wrong key fails to decrypt', () => {
    const key1 = deriveSessionKey('key1', 'salt');
    const key2 = deriveSessionKey('key2', 'salt');
    const ciphertext = encrypt('secret', key1);
    let threw = false;
    try { decrypt(ciphertext, key2); } catch { threw = true; }
    assert(threw, 'Decryption with wrong key should fail');
  });
});

run();
