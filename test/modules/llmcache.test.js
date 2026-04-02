// ============================================================
// GENESIS — test/modules/llmcache.test.js (v3.8.0)
// Tests for LLMCache: LRU eviction, TTL, stats, noCacheTaskTypes
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const { LLMCache } = require('../../src/agent/foundation/LLMCache');

describe('LLMCache — Basic Get/Set', () => {
  test('set and get returns cached value', () => {
    const cache = new LLMCache();
    const key = cache.buildKey('system', [{ role: 'user', content: 'hello' }], 'analysis');
    cache.set(key, 'cached-response');
    assertEqual(cache.get(key), 'cached-response');
  });

  test('get returns null for unknown key', () => {
    const cache = new LLMCache();
    assertEqual(cache.get('nonexistent'), null);
  });

  test('get returns null for null key', () => {
    const cache = new LLMCache();
    assertEqual(cache.get(null), null);
  });

  test('set ignores null key', () => {
    const cache = new LLMCache();
    cache.set(null, 'value');
    assertEqual(cache.getStats().sets, 0);
  });

  test('set ignores null value', () => {
    const cache = new LLMCache();
    cache.set('key', null);
    assertEqual(cache.getStats().sets, 0);
  });

  test('clear removes all entries', () => {
    const cache = new LLMCache();
    cache.set('a', 'val-a');
    cache.set('b', 'val-b');
    cache.clear();
    assertEqual(cache.get('a'), null);
    assertEqual(cache.get('b'), null);
    assertEqual(cache.getStats().size, 0);
  });
});

describe('LLMCache — buildKey', () => {
  test('returns consistent key for same inputs', () => {
    const cache = new LLMCache();
    const msgs = [{ role: 'user', content: 'test' }];
    const k1 = cache.buildKey('sys', msgs, 'analysis');
    const k2 = cache.buildKey('sys', msgs, 'analysis');
    assertEqual(k1, k2);
  });

  test('returns different keys for different inputs', () => {
    const cache = new LLMCache();
    const k1 = cache.buildKey('sys', [{ role: 'user', content: 'a' }], 'analysis');
    const k2 = cache.buildKey('sys', [{ role: 'user', content: 'b' }], 'analysis');
    assert(k1 !== k2, 'keys should differ');
  });

  test('returns null for noCacheTaskTypes', () => {
    const cache = new LLMCache({ noCacheTaskTypes: ['chat', 'creative'] });
    const key = cache.buildKey('sys', [], 'chat');
    assertEqual(key, null);
  });

  test('allows non-blocked task types', () => {
    const cache = new LLMCache({ noCacheTaskTypes: ['chat'] });
    const key = cache.buildKey('sys', [], 'analysis');
    assert(key !== null, 'analysis should be cacheable');
  });

  test('only hashes last 3 messages', () => {
    const cache = new LLMCache();
    const msgs4 = [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
      { role: 'user', content: 'three' },
      { role: 'assistant', content: 'four' },
    ];
    const msgs4b = [
      { role: 'user', content: 'DIFFERENT' },
      { role: 'assistant', content: 'two' },
      { role: 'user', content: 'three' },
      { role: 'assistant', content: 'four' },
    ];
    // First message differs but only last 3 are hashed → same key
    const k1 = cache.buildKey('sys', msgs4, 'analysis');
    const k2 = cache.buildKey('sys', msgs4b, 'analysis');
    assertEqual(k1, k2);
  });

  test('handles empty messages array', () => {
    const cache = new LLMCache();
    const key = cache.buildKey('sys', [], 'analysis');
    assert(key !== null && key.length === 24);
  });

  test('handles null systemPrompt and messages', () => {
    const cache = new LLMCache();
    const key = cache.buildKey(null, null, 'analysis');
    assert(key !== null && key.length === 24);
  });
});

describe('LLMCache — TTL Expiry', () => {
  test('expired entries return null', async () => {
    const cache = new LLMCache({ ttlMs: 30 });
    cache.set('key', 'value');
    assertEqual(cache.get('key'), 'value');
    await new Promise(r => setTimeout(r, 50));
    assertEqual(cache.get('key'), null);
  });

  test('non-expired entries remain', async () => {
    const cache = new LLMCache({ ttlMs: 5000 });
    cache.set('key', 'value');
    await new Promise(r => setTimeout(r, 10));
    assertEqual(cache.get('key'), 'value');
  });
});

describe('LLMCache — LRU Eviction', () => {
  test('evicts least recently used when full', () => {
    const cache = new LLMCache({ maxSize: 3 });
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('c', '3');
    // Cache full. 'a' is LRU.
    cache.set('d', '4');
    assertEqual(cache.get('a'), null, 'a should be evicted');
    assertEqual(cache.get('d'), '4', 'd should exist');
    assertEqual(cache.getStats().evictions, 1);
  });

  test('accessing an entry updates its access order', () => {
    const cache = new LLMCache({ maxSize: 3 });
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('c', '3');
    // Access 'a' to make it recent
    cache.get('a');
    // Now 'b' is LRU
    cache.set('d', '4');
    assertEqual(cache.get('b'), null, 'b should be evicted');
    assertEqual(cache.get('a'), '1', 'a should survive');
  });

  test('overwriting existing key does not evict', () => {
    const cache = new LLMCache({ maxSize: 2 });
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('a', 'updated'); // Overwrite, not new entry
    assertEqual(cache.getStats().evictions, 0);
    assertEqual(cache.get('a'), 'updated');
    assertEqual(cache.get('b'), '2');
  });
});

describe('LLMCache — Stats', () => {
  test('tracks hits and misses', () => {
    const cache = new LLMCache();
    cache.set('a', '1');
    cache.get('a');       // hit
    cache.get('a');       // hit
    cache.get('missing'); // miss

    const stats = cache.getStats();
    assertEqual(stats.hits, 2);
    assertEqual(stats.misses, 1);
    assertEqual(stats.sets, 1);
    assertEqual(stats.hitRate, '66.7%');
  });

  test('hitRate is 0% with no gets', () => {
    const cache = new LLMCache();
    assertEqual(cache.getStats().hitRate, '0%');
  });

  test('size reflects current entries', () => {
    const cache = new LLMCache();
    cache.set('a', '1');
    cache.set('b', '2');
    assertEqual(cache.getStats().size, 2);
    cache.clear();
    assertEqual(cache.getStats().size, 0);
  });

  test('maxSize is exposed', () => {
    const cache = new LLMCache({ maxSize: 50 });
    assertEqual(cache.getStats().maxSize, 50);
  });
});

describe('LLMCache — Defaults', () => {
  test('default constructor works', () => {
    const cache = new LLMCache();
    assertEqual(cache._maxSize, 100);
    assertEqual(cache._ttlMs, 300000);
    assertEqual(cache._noCacheTaskTypes.size, 0);
  });

  test('empty object constructor works', () => {
    const cache = new LLMCache({});
    assertEqual(cache._maxSize, 100);
  });
});

run();
