// ============================================================
// GENESIS — test/modules/v784-node-version-resolver.test.js (v7.8.4)
//
// install-db contract: NodeVersionResolver must
//   - return fresh cache when ≤24h old
//   - fetch live from nodejs.org/dist/index.json on cache miss
//   - fall back to stale cache when fetch fails
//   - fall back to hardcoded v22.22.2 when both cache and fetch are absent
//   - filter to v22 LTS only (no silent drift to v23/v24)
//   - construct correct installer URLs from the resolved version
// ============================================================

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  Promise.resolve().then(async () => {
    try {
      await fn();
      passed++;
      console.log(`    ✅ ${name}`);
    } catch (err) {
      failed++;
      failures.push({ name, error: err.message });
      console.log(`    ❌ ${name}: ${err.message}`);
    }
  });
}

const { NodeVersionResolver, FALLBACK, MAJOR } = require('../../src/agent/capabilities/NodeVersionResolver');

// ── helpers ────────────────────────────────────────────────

function tmpCacheDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-noderesolver-'));
}

/**
 * Build a mock https client that responds with a given body & status.
 * @param {object} opts
 * @param {string|object} [opts.body]
 * @param {number} [opts.statusCode]
 * @param {string} [opts.error]
 * @param {boolean} [opts.timeout]
 */
function mockHttps({ body = '[]', statusCode = 200, error, timeout = false } = {}) {
  return {
    get(_url, _opts, cb) {
      const req = new EventEmitter();
      req.destroy = () => {};
      setImmediate(() => {
        if (error) { req.emit('error', new Error(error)); return; }
        if (timeout) { req.emit('timeout'); return; }
        const res = new EventEmitter();
        res.statusCode = statusCode;
        res.resume = () => {};
        cb(res);
        setImmediate(() => {
          const data = typeof body === 'string' ? body : JSON.stringify(body);
          res.emit('data', data);
          res.emit('end');
        });
      });
      return req;
    },
  };
}

// ── tests ──────────────────────────────────────────────────

test('install-db contract: fresh cache hit returns source=cache', async () => {
  const dir = tmpCacheDir();
  const cache = {
    version: 'v22.20.0',
    urls: { win32: { url: 'x', filename: 'a', label: 'b' }, darwin: { url: 'y', filename: 'c', label: 'd' } },
    fetchedAt: 1000,
  };
  fs.writeFileSync(path.join(dir, 'node-latest.json'), JSON.stringify(cache));
  const resolver = new NodeVersionResolver({
    cacheDir: dir,
    httpsClient: mockHttps({ body: 'should not be called' }),
    now: () => 1000 + 60 * 60 * 1000, // 1h later → still fresh
  });
  const result = await resolver.resolve();
  assert.strictEqual(result.source, 'cache');
  assert.strictEqual(result.version, 'v22.20.0');
});

test('install-db contract: cache miss triggers live fetch (source=live)', async () => {
  const dir = tmpCacheDir();
  const releases = [
    { version: 'v23.5.0', lts: false },          // newer non-LTS — must be skipped
    { version: 'v22.20.1', lts: 'Jod' },         // v22 LTS — winner
    { version: 'v22.20.0', lts: 'Jod' },         // older v22 LTS — must come second
    { version: 'v20.18.0', lts: 'Iron' },        // v20 LTS — must be skipped
  ];
  const resolver = new NodeVersionResolver({
    cacheDir: dir,
    httpsClient: mockHttps({ body: releases }),
    now: () => 1000,
  });
  const result = await resolver.resolve();
  assert.strictEqual(result.source, 'live');
  assert.strictEqual(result.version, 'v22.20.1');
  assert.match(result.urls.win32.url, /v22\.20\.1.*\.msi$/);
  assert.match(result.urls.darwin.url, /v22\.20\.1.*\.pkg$/);
  // cache must have been written
  assert.ok(fs.existsSync(path.join(dir, 'node-latest.json')));
});

test('install-db contract: live fetch fail + no cache → fallback (hardcoded v22)', async () => {
  const dir = tmpCacheDir();
  const resolver = new NodeVersionResolver({
    cacheDir: dir,
    httpsClient: mockHttps({ error: 'ENETUNREACH' }),
    now: () => 1000,
  });
  const result = await resolver.resolve();
  assert.strictEqual(result.source, 'fallback');
  assert.strictEqual(result.version, FALLBACK.version);
  assert.match(result.version, /^v22\./);
});

test('install-db contract: live fetch fail + stale cache → stale-cache (not fallback)', async () => {
  const dir = tmpCacheDir();
  const cache = {
    version: 'v22.18.0',
    urls: FALLBACK.urls,
    fetchedAt: 1000,
  };
  fs.writeFileSync(path.join(dir, 'node-latest.json'), JSON.stringify(cache));
  const resolver = new NodeVersionResolver({
    cacheDir: dir,
    httpsClient: mockHttps({ error: 'ENETUNREACH' }),
    now: () => 1000 + 48 * 60 * 60 * 1000, // 48h later → stale
  });
  const result = await resolver.resolve();
  assert.strictEqual(result.source, 'stale-cache');
  assert.strictEqual(result.version, 'v22.18.0');
});

test('install-db contract: malformed JSON response → fallback (not crash)', async () => {
  const dir = tmpCacheDir();
  const resolver = new NodeVersionResolver({
    cacheDir: dir,
    httpsClient: mockHttps({ body: 'not-json-at-all' }),
    now: () => 1000,
  });
  const result = await resolver.resolve();
  assert.strictEqual(result.source, 'fallback');
});

test('install-db contract: non-200 status → fallback', async () => {
  const dir = tmpCacheDir();
  const resolver = new NodeVersionResolver({
    cacheDir: dir,
    httpsClient: mockHttps({ statusCode: 503, body: 'Service Unavailable' }),
    now: () => 1000,
  });
  const result = await resolver.resolve();
  assert.strictEqual(result.source, 'fallback');
});

test('install-db contract: response with no v22 LTS → fallback', async () => {
  const dir = tmpCacheDir();
  // Releases that don't include any v22 LTS — only v23 (non-LTS) and v20
  const releases = [
    { version: 'v23.5.0', lts: false },
    { version: 'v20.18.0', lts: 'Iron' },
  ];
  const resolver = new NodeVersionResolver({
    cacheDir: dir,
    httpsClient: mockHttps({ body: releases }),
    now: () => 1000,
  });
  const result = await resolver.resolve();
  assert.strictEqual(result.source, 'fallback');
});

test('install-db contract: pinned major is v22 (no silent v24 drift)', () => {
  assert.strictEqual(MAJOR, 'v22');
  assert.match(FALLBACK.version, /^v22\./);
});

test('install-db contract: throws on construction without cacheDir', () => {
  assert.throws(() => new NodeVersionResolver({}), /cacheDir/);
});

test('install-db contract: timeout aborts and yields fallback', async () => {
  const dir = tmpCacheDir();
  const resolver = new NodeVersionResolver({
    cacheDir: dir,
    httpsClient: mockHttps({ timeout: true }),
    now: () => 1000,
  });
  const result = await resolver.resolve();
  assert.strictEqual(result.source, 'fallback');
});

// ── summary ───────────────────────────────────────────────

(async () => {
  await new Promise((r) => setTimeout(r, 200));
  if (failed > 0) {
    console.log(`\n  ${failed} failure(s):`);
    for (const f of failures) console.log(`    - ${f.name}: ${f.error}`);
    process.exit(1);
  }
  console.log(`    ${passed} passed`);
})();
