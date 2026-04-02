// ============================================================
// TEST — McpServer.js (v5.8.0 — MCP Protocol Compliance)
// ============================================================

const { describe, it, after, before } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { McpServer } = require('../../src/agent/capabilities/McpServer');
const { EventBus } = require('../../src/agent/core/EventBus');

// ── Helpers ─────────────────────────────────────────────────

function mockToolRegistry() {
  const tools = new Map([
    ['shell', { name: 'shell', description: 'Run shell commands', schema: {}, input: { command: 'string' },
      handler: async (args) => `executed: ${args.command}`, stats: { calls: 0 } }],
    ['read_file', { name: 'read_file', description: 'Read a file', schema: {}, input: { path: 'string' },
      handler: async (args) => `content of ${args.path}`, stats: { calls: 0 } }],
    ['mcp:external-tool', { name: 'mcp:external-tool', description: 'Should be filtered', schema: {}, input: {},
      handler: async () => 'nope', stats: { calls: 0 } }],
  ]);
  return {
    listTools: () => [...tools.values()],
    hasTool: (name) => tools.has(name),
    execute: async (name, args) => {
      const t = tools.get(name);
      if (!t) throw new Error(`Tool not found: ${name}`);
      return t.handler(args);
    },
  };
}

async function rpc(port, method, params, id = 1) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const req = http.request({ hostname: '127.0.0.1', port, method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve(data); }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method: 'GET', path }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Tests ───────────────────────────────────────────────────

describe('McpServer', () => {
  let server;
  let port;
  let bus;

  before(async () => {
    bus = new EventBus();
    server = new McpServer({ tools: mockToolRegistry(), bus });
    port = await server.start(0);
  });

  after(async () => {
    await server.stop();
  });

  // ── Protocol ────────────────────────────────────────────

  describe('initialize', () => {
    it('returns protocol version and capabilities', async () => {
      const res = await rpc(port, 'initialize', {});
      assert.equal(res.result.protocolVersion, '2025-03-26');
      assert.ok(res.result.capabilities.tools);
      assert.equal(res.result.capabilities.tools.listChanged, true);
      assert.ok(res.result.serverInfo);
      assert.equal(res.result.serverInfo.name, 'genesis-agent');
    });
  });

  describe('ping', () => {
    it('returns empty object', async () => {
      const res = await rpc(port, 'ping', {});
      assert.deepEqual(res.result, {});
    });
  });

  describe('unknown method', () => {
    it('returns -32601 Method not found', async () => {
      const res = await rpc(port, 'nonexistent/method', {});
      assert.ok(res.error);
      assert.equal(res.error.code, -32601);
    });
  });

  // ── Tools ───────────────────────────────────────────────

  describe('tools/list', () => {
    it('lists native tools excluding mcp: prefix', async () => {
      const res = await rpc(port, 'tools/list', {});
      const names = res.result.tools.map(t => t.name);
      assert.ok(names.includes('shell'));
      assert.ok(names.includes('read_file'));
      assert.ok(!names.includes('mcp:external-tool'));
    });

    it('each tool has inputSchema', async () => {
      const res = await rpc(port, 'tools/list', {});
      for (const t of res.result.tools) {
        assert.ok(t.inputSchema, `${t.name} missing inputSchema`);
        assert.equal(t.inputSchema.type, 'object');
      }
    });
  });

  describe('tools/call', () => {
    it('executes a native tool', async () => {
      const res = await rpc(port, 'tools/call', { name: 'shell', arguments: { command: 'ls' } });
      assert.ok(res.result.content);
      assert.equal(res.result.content[0].type, 'text');
      assert.ok(res.result.content[0].text.includes('executed: ls'));
    });

    it('returns error for missing tool', async () => {
      const res = await rpc(port, 'tools/call', { name: 'nonexistent' });
      assert.ok(res.error);
      assert.equal(res.error.code, -32601);
    });

    it('returns error for missing name param', async () => {
      const res = await rpc(port, 'tools/call', {});
      assert.ok(res.error);
      assert.equal(res.error.code, -32602);
    });
  });

  // ── Bridge Tools ────────────────────────────────────────

  describe('bridge tools', () => {
    it('registered bridge tools appear in tools/list', async () => {
      server.registerBridgeTool('genesis.test-bridge', {
        description: 'A test bridge tool',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
        handler: async (args) => `bridged: ${args.q}`,
      });

      const res = await rpc(port, 'tools/list', {});
      const names = res.result.tools.map(t => t.name);
      assert.ok(names.includes('genesis.test-bridge'));
    });

    it('bridge tool can be called', async () => {
      const res = await rpc(port, 'tools/call', { name: 'genesis.test-bridge', arguments: { q: 'hello' } });
      assert.ok(res.result.content[0].text.includes('bridged: hello'));
    });

    it('bridge tool takes precedence over native tool with same name', async () => {
      server.registerBridgeTool('shell', {
        description: 'Override shell',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => 'bridge-shell',
      });

      const res = await rpc(port, 'tools/call', { name: 'shell', arguments: {} });
      assert.ok(res.result.content[0].text.includes('bridge-shell'));

      // Cleanup
      server.unregisterBridgeTool('shell');
      server.unregisterBridgeTool('genesis.test-bridge');
    });
  });

  // ── Resources (stub) ───────────────────────────────────

  describe('resources/list', () => {
    it('returns empty resources array', async () => {
      const res = await rpc(port, 'resources/list', {});
      assert.deepEqual(res.result.resources, []);
    });
  });

  describe('resources/read', () => {
    it('returns not found error', async () => {
      const res = await rpc(port, 'resources/read', { uri: 'genesis://anything' });
      assert.ok(res.error);
      assert.equal(res.error.code, -32601);
    });
  });

  // ── JSON-RPC Error Handling ─────────────────────────────

  describe('error handling', () => {
    it('parse error for invalid JSON', async () => {
      const res = await new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port, method: 'POST', headers: { 'Content-Type': 'application/json' } }, (r) => {
          let d = '';
          r.on('data', (c) => { d += c; });
          r.on('end', () => resolve(JSON.parse(d)));
        });
        req.on('error', reject);
        req.end('{invalid json}');
      });
      assert.equal(res.error.code, -32700);
    });

    it('invalid request for missing jsonrpc field', async () => {
      const res = await new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port, method: 'POST', headers: { 'Content-Type': 'application/json' } }, (r) => {
          let d = '';
          r.on('data', (c) => { d += c; });
          r.on('end', () => resolve(JSON.parse(d)));
        });
        req.on('error', reject);
        req.end(JSON.stringify({ id: 1, method: 'ping' }));
      });
      assert.equal(res.error.code, -32600);
    });
  });

  // ── HTTP Endpoints ──────────────────────────────────────

  describe('health endpoint', () => {
    it('returns status ok', async () => {
      const res = await httpGet(port, '/health');
      assert.equal(res.status, 200);
      const body = JSON.parse(res.data);
      assert.equal(body.status, 'ok');
      assert.ok(body.version);
    });
  });

  describe('405 for unsupported methods', () => {
    it('rejects PUT', async () => {
      const res = await new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port, method: 'PUT' }, (r) => {
          resolve({ status: r.statusCode });
        });
        req.on('error', reject);
        req.end();
      });
      assert.equal(res.status, 405);
    });
  });

  // ── Stats ───────────────────────────────────────────────

  describe('stats', () => {
    it('tracks tool calls', async () => {
      const before = server.stats.toolCalls;
      await rpc(port, 'tools/call', { name: 'read_file', arguments: { path: 'test.js' } });
      assert.equal(server.stats.toolCalls, before + 1);
    });
  });

  // ── Resources ────────────────────────────────────────────

  describe('resources', () => {
    it('empty list when no resources registered', async () => {
      const res = await rpc(port, 'resources/list', {});
      assert.deepEqual(res.result.resources, []);
    });

    it('registered resource appears in list', async () => {
      server.registerResource('genesis://test/data', {
        name: 'Test Data',
        description: 'Test resource',
        handler: async () => ({ value: 42 }),
      });

      const res = await rpc(port, 'resources/list', {});
      const uris = res.result.resources.map(r => r.uri);
      assert.ok(uris.includes('genesis://test/data'));
    });

    it('resource can be read', async () => {
      const res = await rpc(port, 'resources/read', { uri: 'genesis://test/data' });
      assert.ok(res.result.contents);
      assert.equal(res.result.contents[0].uri, 'genesis://test/data');
      const data = JSON.parse(res.result.contents[0].text);
      assert.equal(data.value, 42);
    });

    it('reading unknown resource returns error', async () => {
      const res = await rpc(port, 'resources/read', { uri: 'genesis://nonexistent' });
      assert.ok(res.error);
      assert.equal(res.error.code, -32601);
    });

    it('unregister removes resource', async () => {
      server.unregisterResource('genesis://test/data');
      const res = await rpc(port, 'resources/list', {});
      assert.deepEqual(res.result.resources, []);
    });

    it('resources/templates/list returns empty', async () => {
      const res = await rpc(port, 'resources/templates/list', {});
      assert.deepEqual(res.result.resourceTemplates, []);
    });
  });

  // ── Streamable HTTP ─────────────────────────────────────

  describe('streamable HTTP', () => {
    it('responds with SSE when Accept: text/event-stream', async () => {
      const res = await new Promise((resolve, reject) => {
        const body = JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'ping' });
        const req = http.request({
          hostname: '127.0.0.1', port, method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
        }, (r) => {
          let d = '';
          r.on('data', (c) => { d += c; });
          r.on('end', () => resolve({ status: r.statusCode, contentType: r.headers['content-type'], data: d }));
        });
        req.on('error', reject);
        req.end(body);
      });
      assert.equal(res.status, 200);
      assert.ok(res.contentType.includes('text/event-stream'));
      assert.ok(res.data.includes('event: message'));
      assert.ok(res.data.includes('"id":99'));
    });

    it('tracks session via Mcp-Session-Id header', async () => {
      await new Promise((resolve, reject) => {
        const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
        const req = http.request({
          hostname: '127.0.0.1', port, method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'test-session-123' },
        }, (r) => { let d = ''; r.on('data', c => { d += c; }); r.on('end', () => resolve(d)); });
        req.on('error', reject);
        req.end(body);
      });
      // Session should be tracked (internal check)
      assert.ok(server._sessions.has('test-session-123'));
    });
  });

  // ── Lifecycle ───────────────────────────────────────────

  describe('lifecycle', () => {
    it('isRunning reflects state', () => {
      assert.ok(server.isRunning);
    });

    it('port returns server port', () => {
      assert.equal(server.port, port);
    });

    it('shutdown alias works', async () => {
      const s2 = new McpServer({ tools: mockToolRegistry(), bus });
      const p2 = await s2.start(0);
      assert.ok(s2.isRunning);
      await s2.shutdown();
      assert.ok(!s2.isRunning);
    });
  });
});
