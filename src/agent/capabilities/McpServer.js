// @ts-checked-v5.9
// ============================================================
// GENESIS — McpServer.js (v5.9.2 — Hardened MCP Protocol)
//
// Genesis as an MCP Server — exposes Genesis tools to external
// MCP clients via HTTP POST + SSE transport.
//
// Protocol: JSON-RPC 2.0 / MCP 2025-03-26
// Capabilities: tools (listChanged), resources (listChanged)
//
// v5.8.0: Proper JSON-RPC error codes, dynamic version,
//         listChanged notifications, CORS, resource stubs,
//         connection tracking, graceful shutdown.
// v5.9.2: Security hardening — optional API key auth,
//         sliding-window rate limiter (120 req/min default),
//         configurable CORS origins (localhost-only default),
//         body size cap (1 MB), Mcp-Session-Id in CORS headers.
// ============================================================

const http = require('http');
const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('McpServer');

// JSON-RPC 2.0 standard error codes
const ERR_PARSE       = -32700;
const ERR_INVALID_REQ = -32600;
const ERR_NOT_FOUND   = -32601;
const ERR_INVALID_PAR = -32602;
const ERR_INTERNAL    = -32603;

// Security defaults
const DEFAULT_RATE_LIMIT   = 120;   // requests per minute
const DEFAULT_BODY_MAX     = 1e6;   // 1 MB
const DEFAULT_CORS_ORIGINS = ['http://127.0.0.1', 'http://localhost'];

/** @type {string} */
let _version = '5.8.0';
try {
  const _pkg = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));
  _version = _pkg.version || _version;
} catch (_e) { /* fallback */ }

class McpServer {
  /**
   * @param {{ tools: *, bus?: *, bridgeTools?: Map<string, *>, security?: { apiKey?: string, rateLimitPerMin?: number, corsOrigins?: string[], bodyMaxBytes?: number } }} config
   */
  constructor({ tools, bus, bridgeTools, security }) {
    /** @type {*} */ this.tools = tools;
    /** @type {*} */ this.bus = bus || NullBus;
    /** @type {Map<string, *>} */ this._bridgeTools = bridgeTools || new Map();
    /** @type {Map<string, { uri: string, name: string, description: string, mimeType: string, handler: () => Promise<*> }>} */
    this._resources = new Map();
    /** @type {*} */ this._httpServer = null;
    /** @type {number | null} */ this._serverPort = null;
    /** @type {Set<*>} */ this._sseClients = new Set();
    /** @type {Map<string, *>} */ this._sessions = new Map();
    /** @type {{ connected: number, toolCalls: number, errors: number, resourceReads: number, rateLimited: number, authRejected: number }} */
    this._stats = { connected: 0, toolCalls: 0, errors: 0, resourceReads: 0, rateLimited: 0, authRejected: 0 };
    /** @type {boolean} */ this._initialized = false;

    // ── Security config ──────────────────────────────────
    const sec = security || {};
    /** @type {string|null} */  this._apiKey       = sec.apiKey || null;
    /** @type {number} */       this._rateLimit    = sec.rateLimitPerMin || DEFAULT_RATE_LIMIT;
    /** @type {string[]} */     this._corsOrigins  = sec.corsOrigins || DEFAULT_CORS_ORIGINS;
    /** @type {number} */       this._bodyMax      = sec.bodyMaxBytes || DEFAULT_BODY_MAX;

    // Sliding-window rate limiter: { ip -> timestamp[] }
    /** @type {Map<string, number[]>} */ this._rateBuckets = new Map();
    /** @type {*} */ this._ratePruneTimer = null;
  }

  // ── Lifecycle ─────────────────────────────────────────────

  /** Start serving Genesis tools over HTTP + SSE */
  async start(port = 0) {
    if (this._httpServer) return this._serverPort;

    // Prune stale rate-limit entries every 60s
    this._ratePruneTimer = setInterval(() => {
      const cutoff = Date.now() - 60_000;
      for (const [ip, timestamps] of this._rateBuckets) {
        const fresh = timestamps.filter(t => t > cutoff);
        if (fresh.length === 0) this._rateBuckets.delete(ip);
        else this._rateBuckets.set(ip, fresh);
      }
    }, 60_000);
    if (this._ratePruneTimer.unref) this._ratePruneTimer.unref();

    this._httpServer = http.createServer((req, res) => {
      // CORS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(204, this._corsHeaders(req));
        return res.end();
      }

      // ── Auth gate ────────────────────────────────────
      if (!this._checkAuth(req)) {
        this._stats.authRejected++;
        _log.warn(`[MCP-SERVER] Auth rejected from ${req.socket.remoteAddress}`);
        res.writeHead(401, { 'Content-Type': 'application/json', ...this._corsHeaders(req) });
        return res.end(JSON.stringify({ error: 'Unauthorized — set mcp.serve.apiKey in Settings' }));
      }

      // ── Rate limiter ─────────────────────────────────
      if (!this._checkRate(req)) {
        this._stats.rateLimited++;
        _log.warn(`[MCP-SERVER] Rate limited: ${req.socket.remoteAddress}`);
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60', ...this._corsHeaders(req) });
        return res.end(JSON.stringify({ error: `Rate limit exceeded (${this._rateLimit} req/min)` }));
      }

      // SSE endpoint
      if (req.method === 'GET' && req.url === '/sse') {
        return this._handleSSE(req, res);
      }

      // Health check (no auth required — useful for probes)
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json', ...this._corsHeaders(req) });
        return res.end(JSON.stringify({ status: 'ok', version: _version, clients: this._sseClients.size }));
      }

      // JSON-RPC POST
      if (req.method === 'POST') {
        return this._handlePost(req, res);
      }

      res.writeHead(405, this._corsHeaders(req));
      res.end();
    });

    return new Promise((resolve) => {
      const server = /** @type {NonNullable<typeof this._httpServer>} */ (this._httpServer);
      server.listen(port, '127.0.0.1', () => {
        const addr = server.address();
        this._serverPort = (typeof addr === 'object' && addr) ? addr.port : port;
        _log.info(`[MCP-SERVER] Genesis serving on port ${this._serverPort} (HTTP + SSE)`);
        this.bus.fire('mcp:server-started', { port: this._serverPort }, { source: 'McpServer' });
        resolve(this._serverPort);
      });
    });
  }

  async stop() {
    if (this._ratePruneTimer) { clearInterval(this._ratePruneTimer); this._ratePruneTimer = null; }
    this._rateBuckets.clear();

    for (const client of this._sseClients) {
      try { client.end(); } catch (_e) { /* best effort */ }
    }
    this._sseClients.clear();

    if (this._httpServer) {
      await new Promise((resolve) => {
        /** @type {NonNullable<typeof this._httpServer>} */ (this._httpServer).close(resolve);
      });
      this._httpServer = null;
    }
    this._serverPort = null;
    this._initialized = false;
  }

  /** Alias for backward compat */
  shutdown() { return this.stop(); }

  // ── HTTP Handling ─────────────────────────────────────────

  /** @param {import('http').IncomingMessage} req @param {import('http').ServerResponse} res */
  _handlePost(req, res) {
    let body = '';
    const maxBytes = this._bodyMax;
    req.on('data', (/** @type {string} */ c) => {
      body += c;
      if (body.length > maxBytes) {
        _log.warn(`[MCP-SERVER] Request body exceeded ${maxBytes} bytes — connection destroyed`);
        req.destroy();
      }
    });
    req.on('end', async () => {
      const wantsStream = (req.headers.accept || '').includes('text/event-stream');
      const sessionId = /** @type {string|undefined} */ (req.headers['mcp-session-id']);
      const corsH = this._corsHeaders(req);

      // Parse
      let msg;
      try {
        msg = JSON.parse(body);
      } catch (_e) {
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsH });
        res.end(JSON.stringify(this._rpcError(null, ERR_PARSE, 'Parse error')));
        return;
      }

      // Validate
      if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsH });
        res.end(JSON.stringify(this._rpcError(msg?.id ?? null, ERR_INVALID_REQ, 'Invalid JSON-RPC request')));
        return;
      }

      // Track session
      if (sessionId) this._sessions.set(sessionId, { lastSeen: Date.now() });

      // Notifications (no id) — fire and forget
      if (msg.id === undefined || msg.id === null) {
        try { await this._dispatch(msg); } catch (_e) { /* notification errors are silent */ }
        res.writeHead(204, corsH);
        res.end();
        return;
      }

      // v5.9.0: Streamable HTTP — if client accepts text/event-stream, respond as SSE on POST
      if (wantsStream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...corsH });
        try {
          const result = await this._dispatch(msg);
          res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`);
        } catch (err) {
          this._stats.errors++;
          const code = /** @type {*} */ (err).rpcCode || ERR_INTERNAL;
          res.write(`event: message\ndata: ${JSON.stringify(this._rpcError(msg.id, code, err.message))}\n\n`);
        }
        res.end();
        return;
      }

      // Standard JSON-RPC response
      try {
        const result = await this._dispatch(msg);
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsH });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      } catch (err) {
        this._stats.errors++;
        const code = /** @type {*} */ (err).rpcCode || ERR_INTERNAL;
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsH });
        res.end(JSON.stringify(this._rpcError(msg.id, code, err.message)));
      }
    });
  }

  // ── SSE ───────────────────────────────────────────────────

  /** @param {import('http').IncomingMessage} req @param {import('http').ServerResponse} res */
  _handleSSE(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      ...this._corsHeaders(req),
    });

    const postUrl = `http://127.0.0.1:${this._serverPort}/`;
    res.write(`event: endpoint\ndata: ${JSON.stringify({ url: postUrl })}\n\n`);

    this._sseClients.add(res);
    this._stats.connected++;
    _log.debug(`[MCP-SERVER] SSE client connected (total: ${this._sseClients.size})`);

    req.on('close', () => {
      this._sseClients.delete(res);
      _log.debug(`[MCP-SERVER] SSE client disconnected (total: ${this._sseClients.size})`);
    });
  }

  /** Broadcast an event to all SSE clients */
  broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this._sseClients) {
      try { client.write(payload); } catch (_e) { _log.debug('[MCP-SERVER] Broadcast error'); }
    }
  }

  /** Notify clients that tool list changed */
  notifyToolsChanged() {
    this.broadcast('message', {
      jsonrpc: '2.0',
      method: 'notifications/tools/list_changed',
    });
  }

  // ── JSON-RPC Dispatch ─────────────────────────────────────

  /** @param {{ method: string, params?: * }} msg */
  async _dispatch(msg) {
    switch (msg.method) {

      case 'initialize':
        this._initialized = true;
        return {
          protocolVersion: '2025-03-26',
          capabilities: {
            tools: { listChanged: true },
            resources: { subscribe: false, listChanged: true },
          },
          serverInfo: { name: 'genesis-agent', version: _version },
        };

      case 'notifications/initialized':
        return undefined; // Notification ACK

      case 'ping':
        return {};

      case 'tools/list':
        return { tools: this._collectToolSchemas() };

      case 'tools/call':
        return this._handleToolCall(msg.params);

      case 'resources/list':
        return { resources: this._collectResources() };

      case 'resources/read':
        return this._handleResourceRead(msg.params);

      case 'resources/templates/list':
        return { resourceTemplates: [] };

      default:
        throw this._rpcErr(ERR_NOT_FOUND, `Method not found: ${msg.method}`);
    }
  }

  // ── Tool Collection ───────────────────────────────────────

  /** @returns {Array<{ name: string, description: string, inputSchema: object }>} */
  _collectToolSchemas() {
    const tools = [];

    // Bridge tools (from McpServerToolBridge) — these have proper schemas
    for (const [name, def] of this._bridgeTools) {
      tools.push({
        name,
        description: def.description || '',
        inputSchema: def.inputSchema || { type: 'object', properties: {} },
      });
    }

    // ToolRegistry tools (native) — exclude mcp: prefix to avoid loops
    if (this.tools && typeof this.tools.listTools === 'function') {
      for (const t of this.tools.listTools()) {
        if (t.name.startsWith('mcp:')) continue;
        if (this._bridgeTools.has(t.name)) continue; // Bridge takes precedence
        tools.push({
          name: t.name,
          description: t.description || t.schema?.description || '',
          inputSchema: t.schema?.inputSchema || {
            type: 'object',
            properties: Object.fromEntries(
              Object.entries(t.input || {}).map(([k, v]) => [k, { type: v }])
            ),
          },
        });
      }
    }

    return tools;
  }

  // ── Tool Execution ────────────────────────────────────────

  /** @param {{ name: string, arguments?: object }} params */
  async _handleToolCall(params) {
    if (!params || !params.name) {
      throw this._rpcErr(ERR_INVALID_PAR, 'Missing required parameter: name');
    }

    const { name, arguments: args } = params;
    this._stats.toolCalls++;

    _log.info(`[MCP-SERVER] Tool call: ${name}`);
    this.bus.fire('mcp:tool-call', { server: 'self', tool: name }, { source: 'McpServer' });

    // Bridge tools first
    if (this._bridgeTools.has(name)) {
      const def = this._bridgeTools.get(name);
      try {
        const result = await def.handler(args || {});
        return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }

    // ToolRegistry fallback
    if (this.tools && typeof this.tools.hasTool === 'function' && this.tools.hasTool(name)) {
      try {
        const result = await this.tools.execute(name, args || {});
        return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }

    throw this._rpcErr(ERR_NOT_FOUND, `Tool not found: ${name}`);
  }

  // ── Resource Collection ─────────────────────────────────

  /** @returns {Array<{ uri: string, name: string, description: string, mimeType: string }>} */
  _collectResources() {
    const resources = [];
    for (const [, r] of this._resources) {
      resources.push({ uri: r.uri, name: r.name, description: r.description, mimeType: r.mimeType });
    }
    return resources;
  }

  // ── Resource Read ───────────────────────────────────────

  /** @param {{ uri: string }} params */
  async _handleResourceRead(params) {
    if (!params || !params.uri) {
      throw this._rpcErr(ERR_INVALID_PAR, 'Missing required parameter: uri');
    }

    const provider = this._resources.get(params.uri);
    if (!provider) {
      throw this._rpcErr(ERR_NOT_FOUND, `Resource not found: ${params.uri}`);
    }

    this._stats.resourceReads++;
    _log.info(`[MCP-SERVER] Resource read: ${params.uri}`);
    this.bus.fire('mcp:resource-read', { uri: params.uri }, { source: 'McpServer' });

    try {
      const data = await provider.handler();
      const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      return { contents: [{ uri: params.uri, mimeType: provider.mimeType, text }] };
    } catch (err) {
      throw this._rpcErr(ERR_INTERNAL, `Resource read failed: ${err.message}`);
    }
  }

  // ── Resource Registration ───────────────────────────────

  /**
   * Register a resource provider.
   * @param {string} uri — e.g. "genesis://knowledge-graph/stats"
   * @param {{ name: string, description: string, mimeType?: string, handler: () => Promise<*> }} def
   */
  registerResource(uri, def) {
    this._resources.set(uri, {
      uri,
      name: def.name,
      description: def.description,
      mimeType: def.mimeType || 'application/json',
      handler: def.handler,
    });
    _log.info(`[MCP-SERVER] Resource registered: ${uri}`);
    if (this._initialized) {
      this.broadcast('message', { jsonrpc: '2.0', method: 'notifications/resources/list_changed' });
    }
  }

  /**
   * Unregister a resource provider.
   * @param {string} uri
   * @returns {boolean}
   */
  unregisterResource(uri) {
    const removed = this._resources.delete(uri);
    if (removed && this._initialized) {
      this.broadcast('message', { jsonrpc: '2.0', method: 'notifications/resources/list_changed' });
    }
    return removed;
  }

  // ── Helpers ───────────────────────────────────────────────

  // ── Security ───────────────────────────────────────────────

  /**
   * CORS headers — reflects Origin if in the allowed list,
   * otherwise returns no Allow-Origin (browser will block).
   * @param {import('http').IncomingMessage} [req]
   */
  _corsHeaders(req) {
    const origin = req?.headers?.origin || '';
    let allowOrigin = '';

    // If corsOrigins contains '*', allow everything (explicit opt-in)
    if (this._corsOrigins.includes('*')) {
      allowOrigin = '*';
    } else if (origin) {
      // Match origin against allowed list (protocol + host, port-insensitive for localhost)
      const allowed = this._corsOrigins.some(ao => {
        if (origin === ao) return true;
        // Allow any port on localhost/127.0.0.1
        if ((ao === 'http://127.0.0.1' || ao === 'http://localhost') &&
            (origin.startsWith('http://127.0.0.1') || origin.startsWith('http://localhost'))) return true;
        return false;
      });
      if (allowed) allowOrigin = origin;
    } else {
      // No Origin header = same-origin or non-browser client (curl, IDE) — allow
      allowOrigin = '*';
    }

    return {
      'Access-Control-Allow-Origin': allowOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id',
    };
  }

  /**
   * Check API key auth. If no key is configured, all requests pass.
   * Checks `Authorization: Bearer <key>` header.
   * @param {import('http').IncomingMessage} req
   * @returns {boolean}
   */
  _checkAuth(req) {
    if (!this._apiKey) return true; // No key configured = open (local-first default)
    // Health endpoint bypasses auth
    if (req.method === 'GET' && req.url === '/health') return true;

    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) {
      return authHeader.slice(7).trim() === this._apiKey;
    }
    // Also accept x-api-key header (common in MCP clients)
    const xKey = /** @type {string} */ (req.headers['x-api-key'] || '');
    return xKey === this._apiKey;
  }

  /**
   * Sliding-window rate limiter per IP.
   * @param {import('http').IncomingMessage} req
   * @returns {boolean}
   */
  _checkRate(req) {
    if (this._rateLimit <= 0) return true; // 0 = disabled
    const ip = req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const cutoff = now - 60_000;

    let timestamps = this._rateBuckets.get(ip);
    if (!timestamps) { timestamps = []; this._rateBuckets.set(ip, timestamps); }

    // Prune old entries inline
    while (timestamps.length > 0 && timestamps[0] <= cutoff) timestamps.shift();

    if (timestamps.length >= this._rateLimit) return false;
    timestamps.push(now);
    return true;
  }

  /** @param {number} code @param {string} message */
  _rpcErr(code, message) {
    const err = new Error(message);
    /** @type {*} */ (err).rpcCode = code;
    return err;
  }

  /** @param {*} id @param {number} code @param {string} message */
  _rpcError(id, code, message) {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }

  // ── Bridge Tool Registration ──────────────────────────────

  /**
   * Register a bridge tool (from McpServerToolBridge).
   * @param {string} name
   * @param {{ description: string, inputSchema: object, handler: Function }} def
   */
  registerBridgeTool(name, def) {
    this._bridgeTools.set(name, def);
    _log.info(`[MCP-SERVER] Bridge tool registered: ${name}`);
    if (this._initialized) this.notifyToolsChanged();
  }

  /**
   * Unregister a bridge tool.
   * @param {string} name
   * @returns {boolean}
   */
  unregisterBridgeTool(name) {
    const removed = this._bridgeTools.delete(name);
    if (removed && this._initialized) this.notifyToolsChanged();
    return removed;
  }

  // ── Accessors ─────────────────────────────────────────────

  get port() { return this._serverPort; }
  get isRunning() { return !!this._httpServer; }
  get clientCount() { return this._sseClients.size; }
  get stats() { return { ...this._stats, clients: this._sseClients.size }; }
}

module.exports = { McpServer };
