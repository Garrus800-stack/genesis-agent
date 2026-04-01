// ============================================================
// GENESIS — test/modules/mcpserver-security.test.js (v5.9.2)
//
// Tests for MCP Server security hardening:
//   - API key authentication (Bearer + x-api-key)
//   - Sliding-window rate limiting
//   - CORS origin filtering
//   - Body size enforcement
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const http = require('http');

const ROOT = require('path').resolve(__dirname, '..', '..');
const { McpServer } = require(ROOT + '/src/agent/capabilities/McpServer');

// ── Auth Tests ──────────────────────────────────────────────

describe('McpServer — API key auth', () => {
  test('no key configured → all requests pass', async () => {
    const server = new McpServer({ tools: null, security: { apiKey: null } });
    const port = await server.start(0);
    const res = await jsonRpc(port, 'ping', {});
    assertEqual(res.status, 200);
    await server.stop();
  });

  test('key configured → rejects without auth', async () => {
    const server = new McpServer({ tools: null, security: { apiKey: 'secret-123' } });
    const port = await server.start(0);
    const res = await jsonRpc(port, 'ping', {}, {});
    assertEqual(res.status, 401);
    await server.stop();
  });

  test('key configured → accepts Bearer header', async () => {
    const server = new McpServer({ tools: null, security: { apiKey: 'secret-123' } });
    const port = await server.start(0);
    // First initialize
    await jsonRpc(port, 'initialize', {}, { Authorization: 'Bearer secret-123' });
    const res = await jsonRpc(port, 'ping', {}, { Authorization: 'Bearer secret-123' });
    assertEqual(res.status, 200);
    await server.stop();
  });

  test('key configured → accepts x-api-key header', async () => {
    const server = new McpServer({ tools: null, security: { apiKey: 'secret-123' } });
    const port = await server.start(0);
    const res = await jsonRpc(port, 'ping', {}, { 'x-api-key': 'secret-123' });
    assertEqual(res.status, 200);
    await server.stop();
  });

  test('key configured → rejects wrong key', async () => {
    const server = new McpServer({ tools: null, security: { apiKey: 'secret-123' } });
    const port = await server.start(0);
    const res = await jsonRpc(port, 'ping', {}, { Authorization: 'Bearer wrong-key' });
    assertEqual(res.status, 401);
    await server.stop();
  });

  test('health endpoint bypasses auth', async () => {
    const server = new McpServer({ tools: null, security: { apiKey: 'secret-123' } });
    const port = await server.start(0);
    const res = await httpGet(port, '/health');
    assertEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assertEqual(body.status, 'ok');
    await server.stop();
  });
});

// ── Rate Limiting Tests ─────────────────────────────────────

describe('McpServer — rate limiting', () => {
  test('allows requests under limit', async () => {
    const server = new McpServer({ tools: null, security: { rateLimitPerMin: 10 } });
    const port = await server.start(0);
    for (let i = 0; i < 10; i++) {
      const res = await jsonRpc(port, 'ping', {});
      assertEqual(res.status, 200);
    }
    await server.stop();
  });

  test('rejects requests over limit with 429', async () => {
    const server = new McpServer({ tools: null, security: { rateLimitPerMin: 3 } });
    const port = await server.start(0);
    // First 3 should succeed
    for (let i = 0; i < 3; i++) {
      await jsonRpc(port, 'ping', {});
    }
    // 4th should be rate-limited
    const res = await jsonRpc(port, 'ping', {});
    assertEqual(res.status, 429);
    assertEqual(server.stats.rateLimited, 1);
    await server.stop();
  });

  test('rate limit 0 disables limiting', async () => {
    const server = new McpServer({ tools: null, security: { rateLimitPerMin: 0 } });
    const port = await server.start(0);
    // Should never 429
    for (let i = 0; i < 20; i++) {
      const res = await jsonRpc(port, 'ping', {});
      assertEqual(res.status, 200);
    }
    await server.stop();
  });
});

// ── CORS Tests ──────────────────────────────────────────────

describe('McpServer — CORS', () => {
  test('default CORS allows localhost origin', async () => {
    const server = new McpServer({ tools: null });
    const port = await server.start(0);
    const res = await jsonRpc(port, 'ping', {}, { Origin: 'http://localhost:3000' });
    assertEqual(res.headers['access-control-allow-origin'], 'http://localhost:3000');
    await server.stop();
  });

  test('default CORS allows 127.0.0.1 origin', async () => {
    const server = new McpServer({ tools: null });
    const port = await server.start(0);
    const res = await jsonRpc(port, 'ping', {}, { Origin: 'http://127.0.0.1:8080' });
    assertEqual(res.headers['access-control-allow-origin'], 'http://127.0.0.1:8080');
    await server.stop();
  });

  test('default CORS blocks external origin', async () => {
    const server = new McpServer({ tools: null });
    const port = await server.start(0);
    const res = await jsonRpc(port, 'ping', {}, { Origin: 'http://evil.com' });
    assertEqual(res.headers['access-control-allow-origin'], '');
    await server.stop();
  });

  test('wildcard CORS allows all origins', async () => {
    const server = new McpServer({ tools: null, security: { corsOrigins: ['*'] } });
    const port = await server.start(0);
    const res = await jsonRpc(port, 'ping', {}, { Origin: 'http://evil.com' });
    assertEqual(res.headers['access-control-allow-origin'], '*');
    await server.stop();
  });

  test('CORS allows Mcp-Session-Id header', async () => {
    const server = new McpServer({ tools: null });
    const port = await server.start(0);
    const res = await jsonRpc(port, 'ping', {});
    const allowHeaders = res.headers['access-control-allow-headers'] || '';
    assert(allowHeaders.includes('Mcp-Session-Id'), 'Should allow Mcp-Session-Id header');
    await server.stop();
  });

  test('no Origin header allows request (non-browser clients)', async () => {
    const server = new McpServer({ tools: null });
    const port = await server.start(0);
    const res = await jsonRpc(port, 'ping', {});
    assertEqual(res.status, 200);
    await server.stop();
  });
});

// ── Stats Tests ─────────────────────────────────────────────

describe('McpServer — security stats', () => {
  test('tracks authRejected count', async () => {
    const server = new McpServer({ tools: null, security: { apiKey: 'key' } });
    const port = await server.start(0);
    await jsonRpc(port, 'ping', {});  // No auth → rejected
    await jsonRpc(port, 'ping', {});  // No auth → rejected
    assertEqual(server.stats.authRejected, 2);
    await server.stop();
  });

  test('tracks rateLimited count', async () => {
    const server = new McpServer({ tools: null, security: { rateLimitPerMin: 1 } });
    const port = await server.start(0);
    await jsonRpc(port, 'ping', {});  // OK
    await jsonRpc(port, 'ping', {});  // Rate limited
    assertEqual(server.stats.rateLimited, 1);
    await server.stop();
  });
});

// ── HTTP Helpers ────────────────────────────────────────────

function jsonRpc(port, method, params, extraHeaders = {}) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const options = {
      hostname: '127.0.0.1', port, path: '/', method: 'POST',
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.write(body);
    req.end();
  });
}

function httpGet(port, path) {
  return new Promise((resolve) => {
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
  });
}

run();
