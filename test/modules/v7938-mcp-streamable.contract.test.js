// ============================================================
// TEST — v7.9.38 MCP Streamable HTTP client + trusted-loopback opt-in
//
// Exact test command (for the Neo receipt):
//   node test/modules/v7938-mcp-streamable.contract.test.js
//
// Proves the five receipt points Neo named, plus the guards we added:
//   1. POST-first JSON-RPC connect over Streamable HTTP (zero GETs)
//   2. Mcp-Session-Id read from the response header and echoed back
//   3. JSON responses AND SSE-on-POST responses both parse
//   4. 202 empty body (notifications/initialized) tolerated, not a crash
//   5. Default-deny loopback; bearer-gated named-server opt-in
//   + client sends NO Origin header (probe-1 servers reject any present Origin)
//   + a trustLoopback entry WITHOUT a token is refused by Genesis itself
//   + non-loopback private ranges stay blocked even with trustLoopback
//   + legacy 'sse' transport default and the export are unchanged
// ============================================================
const http = require('http');
const assert = require('assert');
const { describe, test, run } = require('../harness');
const { McpServerConnection } = require('../../src/agent/capabilities/McpTransport');

// A minimal Streamable-HTTP MCP server that records what the client sent.
function miniServer() {
  const seen = { origin: 'NONE', auth: null, session: null, gets: 0 };
  const srv = http.createServer((req, res) => {
    if (req.method === 'GET') { seen.gets++; res.writeHead(405); res.end(); return; }
    if (req.headers.origin) seen.origin = req.headers.origin;
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      const msg = JSON.parse(b || '{}');
      if (msg.method === 'initialize') {
        seen.auth = req.headers.authorization;
        res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'sess-xyz' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'MiniNeo' }, capabilities: {} } }));
      } else if (msg.method === 'notifications/initialized') {
        seen.session = req.headers['mcp-session-id'];
        res.writeHead(202); res.end();
      } else if (msg.method === 'tools/list') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'healthcheck' }, { name: 'get_worker_topology' }] } }) + '\n\n');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
      }
    });
  });
  return { srv, seen };
}

// SSRF door: validate without opening a connection.
function validates(cfg, url) {
  const inst = Object.assign(Object.create(McpServerConnection.prototype), {
    name: 't', headers: cfg.headers || {}, token: cfg.token || null, trustLoopback: cfg.trustLoopback === true,
  });
  try { McpServerConnection.prototype._validateMcpUrl.call(inst, url); return true; }
  catch (_e) { return false; }
}

describe('v7.9.38 — Streamable HTTP client, end to end against a real server', () => {
  test('POST-first connect, session header, both body shapes, no Origin, bearer', async () => {
    const { srv, seen } = miniServer();
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const conn = new McpServerConnection({
      name: 'mini', url: `http://127.0.0.1:${port}/mcp`, transport: 'streamable',
      trustLoopback: true, token: 'secret-123',
    }, null);
    try {
      await conn.connect();
      assert.strictEqual(conn.status, 'ready', 'connect reaches ready over streamable HTTP');
      assert.strictEqual(conn.serverInfo.name, 'MiniNeo', 'serverInfo parsed from the JSON initialize response');
      assert.strictEqual(conn._sessionId, 'sess-xyz', 'Mcp-Session-Id read from the response header');
      assert.strictEqual(seen.auth, 'Bearer secret-123', 'the bearer token was sent');
      assert.strictEqual(seen.session, 'sess-xyz', 'the session id was echoed on notifications/initialized');
      const list = await conn._send('tools/list', {});
      assert.strictEqual(list.tools.length, 2, 'an SSE-on-POST response body parses into a JSON-RPC result');
      assert.strictEqual(seen.gets, 0, 'POST-first: the client never opened a GET event channel');
      assert.strictEqual(seen.origin, 'NONE', 'the client sent no Origin header');
    } finally {
      conn.disconnect(); // clears the heartbeat interval so the process can exit
      await new Promise((r) => srv.close(r));
    }
    assert.strictEqual(conn._sessionId, null, 'disconnect drops the streamable session id');
  });
});

describe('v7.9.38 — trusted-loopback opt-in is narrow and token-gated', () => {
  test('default-deny, token requirement, exact-host match, other private ranges stay blocked', () => {
    assert.strictEqual(validates({}, 'http://127.0.0.1:3580/mcp'), false, 'loopback blocked without opt-in (default deny)');
    assert.strictEqual(validates({ trustLoopback: true }, 'http://127.0.0.1:3580/mcp'), false, 'opt-in without a token is refused');
    assert.strictEqual(validates({ trustLoopback: true, token: 'x' }, 'http://127.0.0.1:3580/mcp'), true, 'opt-in + token passes for 127.0.0.1');
    assert.strictEqual(validates({ trustLoopback: true, token: 'x' }, 'http://localhost:3580/mcp'), true, 'opt-in + token passes for localhost');
    assert.strictEqual(validates({ trustLoopback: true, token: 'x' }, 'http://127.0.0.1.evil.com/mcp'), false, 'a look-alike host is NOT treated as loopback (no substring match)');
    assert.strictEqual(validates({ trustLoopback: true, token: 'x' }, 'http://10.0.0.5/mcp'), false, '10.x stays blocked even with trustLoopback');
    assert.strictEqual(validates({ trustLoopback: true, token: 'x' }, 'http://192.168.1.5/mcp'), false, '192.168.x stays blocked even with trustLoopback');
    assert.strictEqual(validates({}, 'https://mcp.example.com/mcp'), true, 'ordinary public URLs are unaffected');
  });

  test('a token supplied only via Authorization header also satisfies the gate', () => {
    assert.strictEqual(validates({ trustLoopback: true, headers: { Authorization: 'Bearer h' } }, 'http://127.0.0.1/mcp'), true, 'explicit Bearer header counts as auth');
  });

  test('empty, whitespace, and non-Bearer authorization are refused (Neo audit v7.9.38)', () => {
    assert.strictEqual(validates({ trustLoopback: true, headers: { Authorization: '' } }, 'http://127.0.0.1/mcp'), false, 'an empty Authorization header does not open the gate');
    assert.strictEqual(validates({ trustLoopback: true, headers: { Authorization: 'Basic x' } }, 'http://127.0.0.1/mcp'), false, 'a non-Bearer scheme (Basic) does not open the gate');
    assert.strictEqual(validates({ trustLoopback: true, headers: { Authorization: 'Bearer   ' } }, 'http://127.0.0.1/mcp'), false, 'Bearer with an empty credential does not open the gate');
    assert.strictEqual(validates({ trustLoopback: true, token: '   ' }, 'http://127.0.0.1/mcp'), false, 'a whitespace-only configured token does not open the gate');
    assert.strictEqual(validates({ trustLoopback: true, token: '' }, 'http://127.0.0.1/mcp'), false, 'an empty configured token does not open the gate');
  });
});

describe('v7.9.38 — legacy transport untouched', () => {
  test("default transport is still 'sse' and the export is stable", () => {
    const c = new McpServerConnection({ name: 'x', url: 'https://e.com/sse' }, null);
    assert.strictEqual(c.transport, 'sse', "no transport specified → still defaults to 'sse'");
    assert.strictEqual(typeof McpServerConnection, 'function', 'export unchanged');
  });
});

if (require.main === module) run();
