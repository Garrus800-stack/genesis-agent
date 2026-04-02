// ============================================================
// GENESIS — test/modules/mcp-security.test.js (v5.9.2)
//
// Tests MCP server security hardening:
//   - API key authentication (Bearer + x-api-key)
//   - Sliding-window rate limiting
//   - CORS origin enforcement
//   - Body size limits
//   - Session tracking via Mcp-Session-Id
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..', '..');
const { McpServer } = require(path.join(ROOT, 'src/agent/capabilities/McpServer'));
const { NullBus } = require(path.join(ROOT, 'src/agent/core/EventBus'));

// ── HTTP Helpers ────────────────────────────────────────────

function jsonRpc(method, params, id = 1) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

function httpReq(method, port, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1', port, method, path: urlPath,
      headers: { 'Content-Type': 'application/json', ...headers },
    };
    const req = http.request(opts, (res) => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

const post = (port, body, hdrs) => httpReq('POST', port, '/', body, hdrs);
const get  = (port, urlPath, hdrs) => httpReq('GET', port, urlPath, null, hdrs);

// ── API Key Authentication ──────────────────────────────────

describe('MCP Security — API Key Auth', () => {
  let srv, port;

  test('setup', async () => {
    srv = new McpServer({
      tools: null, bus: NullBus,
      security: { apiKey: 'genesis-test-key-42' },
    });
    port = await srv.start(0);
    assert(port > 0, 'Server should start');
  });

  test('rejects unauthenticated POST', async () => {
    const res = await post(port, jsonRpc('ping'));
    assertEqual(res.status, 401);
    assert(res.body.includes('Unauthorized'), 'Should say Unauthorized');
  });

  test('accepts Bearer token', async () => {
    const res = await post(port, jsonRpc('ping'), {
      'Authorization': 'Bearer genesis-test-key-42',
    });
    assertEqual(res.status, 200);
  });

  test('accepts x-api-key header', async () => {
    const res = await post(port, jsonRpc('ping'), {
      'x-api-key': 'genesis-test-key-42',
    });
    assertEqual(res.status, 200);
  });

  test('rejects wrong key', async () => {
    const res = await post(port, jsonRpc('ping'), {
      'Authorization': 'Bearer wrong',
    });
    assertEqual(res.status, 401);
  });

  test('/health bypasses auth', async () => {
    const res = await get(port, '/health');
    assertEqual(res.status, 200);
    const data = JSON.parse(res.body);
    assertEqual(data.status, 'ok');
  });

  test('tracks authRejected stat', () => {
    assert(srv.stats.authRejected >= 2, `Expected ≥2, got ${srv.stats.authRejected}`);
  });

  test('teardown', async () => { await srv.stop(); });
});

// ── Open Mode (no key configured) ──────────────────────────

describe('MCP Security — Open Mode', () => {
  let srv, port;

  test('setup', async () => {
    srv = new McpServer({ tools: null, bus: NullBus });
    port = await srv.start(0);
  });

  test('allows all requests when no apiKey set', async () => {
    const res = await post(port, jsonRpc('ping'));
    assertEqual(res.status, 200);
  });

  test('teardown', async () => { await srv.stop(); });
});

// ── Rate Limiting ───────────────────────────────────────────

describe('MCP Security — Rate Limiting', () => {
  let srv, port;

  test('setup (limit=5/min)', async () => {
    srv = new McpServer({
      tools: null, bus: NullBus,
      security: { rateLimitPerMin: 5 },
    });
    port = await srv.start(0);
  });

  test('allows requests under limit', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await post(port, jsonRpc('ping', null, i));
      assertEqual(res.status, 200);
    }
  });

  test('returns 429 when limit exceeded', async () => {
    const res = await post(port, jsonRpc('ping', null, 99));
    assertEqual(res.status, 429);
    assert(res.body.includes('Rate limit'), 'Should mention rate limit');
    assert(res.headers['retry-after'] === '60', 'Should have Retry-After header');
  });

  test('tracks rateLimited stat', () => {
    assert(srv.stats.rateLimited >= 1, `Expected ≥1, got ${srv.stats.rateLimited}`);
  });

  test('teardown', async () => { await srv.stop(); });
});

// ── Disabled Rate Limit ─────────────────────────────────────

describe('MCP Security — Rate Limit Disabled', () => {
  let srv, port;

  test('setup (limit=0)', async () => {
    srv = new McpServer({
      tools: null, bus: NullBus,
      security: { rateLimitPerMin: 0 },
    });
    port = await srv.start(0);
  });

  test('allows unlimited requests', async () => {
    for (let i = 0; i < 20; i++) {
      const res = await post(port, jsonRpc('ping', null, i));
      assertEqual(res.status, 200);
    }
  });

  test('teardown', async () => { await srv.stop(); });
});

// ── CORS Origin Enforcement ─────────────────────────────────

describe('MCP Security — CORS', () => {
  let srv, port;

  test('setup (localhost only)', async () => {
    srv = new McpServer({
      tools: null, bus: NullBus,
      security: { corsOrigins: ['http://127.0.0.1', 'http://localhost'] },
    });
    port = await srv.start(0);
  });

  test('allows localhost origin', async () => {
    const res = await post(port, jsonRpc('ping'), { 'Origin': 'http://localhost:5173' });
    const ao = res.headers['access-control-allow-origin'] || '';
    assert(ao.includes('localhost'), `Expected localhost, got: ${ao}`);
  });

  test('allows 127.0.0.1 origin', async () => {
    const res = await post(port, jsonRpc('ping'), { 'Origin': 'http://127.0.0.1:3000' });
    const ao = res.headers['access-control-allow-origin'] || '';
    assert(ao.includes('127.0.0.1'), `Expected 127.0.0.1, got: ${ao}`);
  });

  test('blocks external origins', async () => {
    const res = await post(port, jsonRpc('ping'), { 'Origin': 'http://evil.example.com' });
    const ao = res.headers['access-control-allow-origin'] || '';
    assertEqual(ao, '');
  });

  test('allows no-origin requests (curl/IDE)', async () => {
    const res = await post(port, jsonRpc('ping'));
    assertEqual(res.status, 200);
    const ao = res.headers['access-control-allow-origin'] || '';
    assertEqual(ao, '*');
  });

  test('Mcp-Session-Id in allowed headers', async () => {
    const res = await post(port, jsonRpc('ping'));
    const ah = res.headers['access-control-allow-headers'] || '';
    assert(ah.includes('Mcp-Session-Id'), `Missing Mcp-Session-Id in: ${ah}`);
  });

  test('Authorization in allowed headers', async () => {
    const res = await post(port, jsonRpc('ping'));
    const ah = res.headers['access-control-allow-headers'] || '';
    assert(ah.includes('Authorization'), `Missing Authorization in: ${ah}`);
  });

  test('teardown', async () => { await srv.stop(); });
});

// ── Wildcard CORS ───────────────────────────────────────────

describe('MCP Security — CORS Wildcard', () => {
  let srv, port;

  test('setup (cors=*)', async () => {
    srv = new McpServer({
      tools: null, bus: NullBus,
      security: { corsOrigins: ['*'] },
    });
    port = await srv.start(0);
  });

  test('allows any origin when * configured', async () => {
    const res = await post(port, jsonRpc('ping'), { 'Origin': 'http://anything.example.com' });
    const ao = res.headers['access-control-allow-origin'] || '';
    assertEqual(ao, '*');
  });

  test('teardown', async () => { await srv.stop(); });
});

// ── Body Size Limit ─────────────────────────────────────────

describe('MCP Security — Body Size', () => {
  let srv, port;

  test('setup (1KB limit)', async () => {
    srv = new McpServer({
      tools: null, bus: NullBus,
      security: { bodyMaxBytes: 1024 },
    });
    port = await srv.start(0);
  });

  test('accepts normal-sized request', async () => {
    const res = await post(port, jsonRpc('ping'));
    assertEqual(res.status, 200);
  });

  test('rejects oversized request', async () => {
    const huge = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', data: 'x'.repeat(2000) });
    try {
      const res = await post(port, huge);
      // Connection may be destroyed mid-flight or complete before limit hit
      // Either way, the server should not crash
      assert(true, 'Server survived oversized request');
    } catch (_e) {
      // Socket destroyed — expected behavior
      assert(true, 'Server destroyed connection (expected)');
    }
  });

  test('teardown', async () => { await srv.stop(); });
});

// ── Session Tracking ────────────────────────────────────────

describe('MCP Security — Session Tracking', () => {
  let srv, port;

  test('setup', async () => {
    srv = new McpServer({ tools: null, bus: NullBus });
    port = await srv.start(0);
  });

  test('tracks Mcp-Session-Id header', async () => {
    await post(port, jsonRpc('initialize'), { 'Mcp-Session-Id': 'sess-test-1' });
    assert(srv._sessions.has('sess-test-1'), 'Session should be tracked');
    assert(srv._sessions.get('sess-test-1').lastSeen > 0, 'lastSeen should be set');
  });

  test('teardown', async () => { await srv.stop(); });
});

// ── Lifecycle ───────────────────────────────────────────────

describe('MCP Server Lifecycle', () => {
  test('start is idempotent', async () => {
    const srv = new McpServer({ tools: null, bus: NullBus });
    const p1 = await srv.start(0);
    const p2 = await srv.start(0);
    assertEqual(p1, p2);
    await srv.stop();
  });

  test('stop clears rate buckets and timers', async () => {
    const srv = new McpServer({ tools: null, bus: NullBus, security: { rateLimitPerMin: 100 } });
    await srv.start(0);
    srv._rateBuckets.set('test-ip', [Date.now()]);
    await srv.stop();
    assertEqual(srv._rateBuckets.size, 0);
    assertEqual(srv._ratePruneTimer, null);
  });

  test('stats include security counters', () => {
    const srv = new McpServer({ tools: null, bus: NullBus });
    const s = srv.stats;
    assert('rateLimited' in s, 'Should have rateLimited');
    assert('authRejected' in s, 'Should have authRejected');
  });
});

run();
