// @ts-checked-v5.8
// ============================================================
// GENESIS — PeerCrypto.js (v3.7.1 — OWASP PBKDF2 Compliance)
//
// Encryption, authentication, and rate limiting for peer comms.
// AES-256-GCM envelope encryption, HMAC challenge-response auth,
// PBKDF2 session key derivation.
//
// v3.7.1: PBKDF2 iterations increased from 100,000 to 600,000
// per OWASP 2023 minimum recommendation for SHA-256.
// See: https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
// Performance impact: ~480ms per derivation (runs once per
// peer handshake, not on every message). Acceptable for LAN peers.
// ============================================================

const crypto = require('crypto');
const { createLogger } = require('../core/Logger');
const _log = createLogger('PeerCrypto');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function encrypt(plaintext, key) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = /** @type {*} */ (crypto.createCipheriv(ALGO, Buffer.from(key, 'hex'), iv));
  const enc = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(payload, key) {
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = /** @type {*} */ (crypto.createDecipheriv(ALGO, Buffer.from(key, 'hex'), iv));
  decipher.setAuthTag(tag);
  return decipher.update(enc, null, 'utf-8') + decipher.final('utf-8');
}

// v3.7.1: OWASP-compliant iteration count (was 100,000)
const PBKDF2_ITERATIONS = 600000;

// v3.8.0: Session key cache — avoids re-deriving on reconnects.
// Keys are cached by (sharedSecret+salt) hash for up to 1 hour.
// On first connect: ~480ms derivation. On reconnect: <1ms cache hit.
const _keyCache = new Map();
const _KEY_CACHE_TTL = 60 * 60 * 1000; // 1 hour
const _KEY_CACHE_MAX = 50;

function _keyCacheKey(sharedSecret, salt) {
  return crypto.createHash('sha256').update(sharedSecret + ':' + salt).digest('hex').slice(0, 16);
}

function _evictExpiredKeys() {
  const now = Date.now();
  for (const [k, entry] of _keyCache) {
    if (now > entry.expiresAt) _keyCache.delete(k);
  }
  // LRU eviction if still over max
  if (_keyCache.size > _KEY_CACHE_MAX) {
    const oldest = [..._keyCache.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt);
    for (let i = 0; i < oldest.length - _KEY_CACHE_MAX; i++) {
      _keyCache.delete(oldest[i][0]);
    }
  }
}

function deriveSessionKey(sharedSecret, salt) {
  const cacheKey = _keyCacheKey(sharedSecret, salt);
  const cached = _keyCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    cached.usedAt = Date.now();
    cached.hits++;
    return cached.key;
  }

  const key = crypto.pbkdf2Sync(sharedSecret, salt, PBKDF2_ITERATIONS, 32, 'sha256').toString('hex');

  _evictExpiredKeys();
  _keyCache.set(cacheKey, {
    key,
    expiresAt: Date.now() + _KEY_CACHE_TTL,
    usedAt: Date.now(),
    hits: 0,
  });

  return key;
}

/** v3.8.0: Cache stats for diagnostics */
function getKeyCacheStats() {
  _evictExpiredKeys();
  let totalHits = 0;
  for (const entry of _keyCache.values()) totalHits += entry.hits;
  return { size: _keyCache.size, maxSize: _KEY_CACHE_MAX, totalHits, ttlMs: _KEY_CACHE_TTL };
}

/** v3.8.0: Clear cache (for testing / security rotation) */
function clearKeyCache() { _keyCache.clear(); }

function signChallenge(token, nonce) {
  if (!token) return '';
  return crypto.createHmac('sha256', token).update(nonce).digest('hex');
}

function verifyAuth(req, token) {
  const challengeResp = req.headers['x-genesis-challenge-response'];
  const nonce = req.headers['x-genesis-nonce'];
  const authHeader = req.headers['x-genesis-auth'];

  if (challengeResp && nonce) {
    const expected = signChallenge(token, nonce);
    try {
      return crypto.timingSafeEqual(
        Buffer.from(challengeResp, 'hex'),
        Buffer.from(expected, 'hex')
      );
    } catch (err) { _log.warn('[PEER-CRYPTO] Challenge verification failed:', err.message); return false; }
  }

  if (authHeader) {
    const expected = crypto.createHmac('sha256', token).update(req.url).digest('hex');
    try {
      return crypto.timingSafeEqual(Buffer.from(authHeader, 'hex'), Buffer.from(expected, 'hex'));
    } catch (err) { _log.warn('[PEER-CRYPTO] HMAC verification failed:', err.message); return false; }
  }

  return false;
}

// ── Rate Limiter ──────────────────────────────────────────

class PeerRateLimiter {
  constructor(maxPerMin = 30) {
    this._entries = new Map();
    this._maxPerMin = maxPerMin;
  }

  check(ip) {
    const now = Date.now();
    const entry = this._entries.get(ip);
    if (!entry || now > entry.resetAt) {
      this._entries.set(ip, { count: 1, resetAt: now + 60000 });
      return true;
    }
    entry.count++;
    return entry.count <= this._maxPerMin;
  }

  cleanup() {
    const now = Date.now();
    for (const [ip, entry] of this._entries) {
      if (now > entry.resetAt) this._entries.delete(ip);
    }
  }
}

module.exports = {
  encrypt, decrypt, deriveSessionKey,
  signChallenge, verifyAuth,
  PeerRateLimiter,
  PBKDF2_ITERATIONS,
  getKeyCacheStats, clearKeyCache,
};
