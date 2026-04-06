#!/usr/bin/env node
// Test: PeerHealth + PeerCrypto — Colony IPC foundation
const { describe, test, assert, assertEqual, run } = require('../harness');
const { PeerHealth } = require('../../src/agent/hexagonal/PeerHealth');
const {
  encrypt, decrypt, deriveSessionKey, signChallenge,
  PeerRateLimiter, clearKeyCache, getKeyCacheStats,
} = require('../../src/agent/hexagonal/PeerCrypto');

// ── PeerHealth ──────────────────────────────────────────

describe('PeerHealth', () => {

  test('initial state is healthy', () => {
    const ph = new PeerHealth();
    assert(ph.isHealthy, 'should be healthy initially');
    assertEqual(ph.failures, 0);
    assertEqual(ph.successes, 0);
  });

  test('recordSuccess tracks latency', () => {
    const ph = new PeerHealth();
    ph.recordSuccess(50);
    ph.recordSuccess(100);
    assertEqual(ph.successes, 2);
    assertEqual(ph.avgLatency, 75);
  });

  test('recordSuccess caps at 10 samples', () => {
    const ph = new PeerHealth();
    for (let i = 0; i < 15; i++) ph.recordSuccess(100);
    assertEqual(ph.latencies.length, 10);
  });

  test('recordSuccess resets failures and backoff', () => {
    const ph = new PeerHealth();
    ph.recordFailure();
    ph.recordFailure();
    assertEqual(ph.failures, 2);
    ph.recordSuccess(50);
    assertEqual(ph.failures, 0);
    assertEqual(ph.backoffMs, 1000);
  });

  test('recordFailure increments failures', () => {
    const ph = new PeerHealth();
    ph.recordFailure();
    assertEqual(ph.failures, 1);
    assert(ph.lastFailure !== null);
  });

  test('backoff doubles with failures, caps at 60s', () => {
    const ph = new PeerHealth();
    ph.recordFailure(); assertEqual(ph.backoffMs, 2000);
    ph.recordFailure(); assertEqual(ph.backoffMs, 4000);
    ph.recordFailure(); assertEqual(ph.backoffMs, 8000);
    for (let i = 0; i < 10; i++) ph.recordFailure();
    assert(ph.backoffMs <= 60000, 'should cap at 60s');
  });

  test('isHealthy false after 3 failures', () => {
    const ph = new PeerHealth();
    ph.recordFailure();
    ph.recordFailure();
    ph.recordFailure();
    assert(!ph.isHealthy, 'should be unhealthy');
  });

  test('avgLatency is Infinity with no samples', () => {
    const ph = new PeerHealth();
    assertEqual(ph.avgLatency, Infinity);
  });

  test('score is lower for healthier peers', () => {
    const healthy = new PeerHealth();
    healthy.recordSuccess(10);
    const unhealthy = new PeerHealth();
    unhealthy.recordFailure();
    unhealthy.recordFailure();
    assert(healthy.score < unhealthy.score, 'healthy should score lower');
  });
});

// ── PeerCrypto ──────────────────────────────────────────

describe('PeerCrypto', () => {

  test('encrypt + decrypt roundtrip', () => {
    const key = require('crypto').randomBytes(32).toString('hex');
    const msg = 'Hello Genesis Colony!';
    const cipher = encrypt(msg, key);
    const plain = decrypt(cipher, key);
    assertEqual(plain, msg);
  });

  test('decrypt with wrong key throws', () => {
    const key1 = require('crypto').randomBytes(32).toString('hex');
    const key2 = require('crypto').randomBytes(32).toString('hex');
    const cipher = encrypt('secret', key1);
    let threw = false;
    try { decrypt(cipher, key2); } catch { threw = true; }
    assert(threw, 'should throw with wrong key');
  });

  test('encrypt produces different ciphertext each time (random IV)', () => {
    const key = require('crypto').randomBytes(32).toString('hex');
    const a = encrypt('same', key);
    const b = encrypt('same', key);
    assert(a !== b, 'should differ due to random IV');
  });

  test('deriveSessionKey is deterministic for same inputs', () => {
    clearKeyCache();
    const k1 = deriveSessionKey('secret', 'salt123');
    const k2 = deriveSessionKey('secret', 'salt123');
    assertEqual(k1, k2);
    assertEqual(k1.length, 64); // 32 bytes hex
  });

  test('deriveSessionKey differs for different salts', () => {
    clearKeyCache();
    const k1 = deriveSessionKey('secret', 'salt-a');
    const k2 = deriveSessionKey('secret', 'salt-b');
    assert(k1 !== k2, 'different salts should yield different keys');
  });

  test('key cache reports stats', () => {
    clearKeyCache();
    deriveSessionKey('s', 'salt1');
    deriveSessionKey('s', 'salt1'); // cache hit
    const stats = getKeyCacheStats();
    assertEqual(stats.size, 1);
    assertEqual(stats.totalHits, 1);
  });

  test('signChallenge produces HMAC', () => {
    const sig = signChallenge('my-token', 'nonce-123');
    assert(typeof sig === 'string');
    assertEqual(sig.length, 64); // SHA-256 hex
  });

  test('signChallenge returns empty for null token', () => {
    assertEqual(signChallenge(null, 'nonce'), '');
  });
});

// ── PeerRateLimiter ─────────────────────────────────────

describe('PeerRateLimiter', () => {

  test('allows requests under limit', () => {
    const rl = new PeerRateLimiter(5);
    assert(rl.check('1.2.3.4'));
    assert(rl.check('1.2.3.4'));
    assert(rl.check('1.2.3.4'));
  });

  test('blocks requests over limit', () => {
    const rl = new PeerRateLimiter(3);
    assert(rl.check('1.2.3.4'));
    assert(rl.check('1.2.3.4'));
    assert(rl.check('1.2.3.4'));
    assert(!rl.check('1.2.3.4'), 'should block 4th request');
  });

  test('different IPs have separate buckets', () => {
    const rl = new PeerRateLimiter(2);
    assert(rl.check('1.1.1.1'));
    assert(rl.check('1.1.1.1'));
    assert(!rl.check('1.1.1.1'));
    assert(rl.check('2.2.2.2'), 'different IP should have own bucket');
  });

  test('cleanup removes expired entries', () => {
    const rl = new PeerRateLimiter(5);
    rl._entries.set('old', { count: 10, resetAt: Date.now() - 1000 });
    rl.cleanup();
    assert(!rl._entries.has('old'));
  });
});

run();
