// @ts-checked-v5.7
// ============================================================
// GENESIS — McpTransport.js (v5.2.0 — CircuitBreaker)
//
// v5.2.0: callTool() and _send() wrapped with per-server
// CircuitBreaker instances. A hanging MCP server no longer
// blocks the AgentLoop until global timeout (10 min).
//
// State transitions:
//   CLOSED (normal) → OPEN (3 failures) → HALF_OPEN (30s cooldown)
//   HALF_OPEN success → CLOSED
//   HALF_OPEN failure → OPEN
//
// Transport layer for MCP server connections.
// Handles: SSE/HTTP transport, JSON-RPC messaging, heartbeat,
// request queue, reconnection, health tracking.
//
// Protocol: JSON-RPC 2.0 / MCP 2025-03-26
// Transport: SSE + Streamable HTTP
// ============================================================

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { NullBus } = require('../core/EventBus');
// FIX v4.10.0 (L-3): Use safeJsonParse for all network-sourced JSON
const { safeJsonParse } = require('../core/utils');
const { CircuitBreaker } = require('../core/CircuitBreaker');
const { TIMEOUTS } = require('../core/Constants');
const { createLogger } = require('../core/Logger');
const _log = createLogger('McpTransport');

let _rpcId = 0;
function jsonrpc(method, params = {}) {
  return { jsonrpc: '2.0', id: ++_rpcId, method, params };
}

class McpServerConnection {
  constructor(config, bus) {
    this.bus = bus || NullBus;
    this.name = config.name;
    this.url = config.url;
    this.transport = config.transport || 'sse';
    this.headers = config.headers || {};
    this.enabled = config.enabled !== false;

    // State machine: disconnected → connecting → ready → degraded → error
    this.status = 'disconnected';
    this.tools = [];
    this.serverInfo = null;
    this.capabilities = {};
    this.error = null;

    this._sseConnection = null;
    this._sessionUrl = null;
    this._pendingRequests = new Map();
    this._reconnectAttempts = 0;
    this._maxReconnects = 5;
    this._requestTimeout = 30000;

    // Request queue for degraded state
    this._requestQueue = [];
    this._maxQueueDepth = 20;

    // Health tracking
    this._healthStats = {
      totalRequests: 0,
      failures: 0,
      lastLatency: 0,
      latencies: [],
      lastHealthCheck: 0,
    };

    this._heartbeatHandle = null;

    // v5.2.0: Per-server CircuitBreaker
    this._circuitBreaker = new CircuitBreaker({
      name: `mcp:${this.name}`,
      failureThreshold: config.circuitBreakerThreshold || 3,
      cooldownMs: config.circuitBreakerCooldownMs || 30000,
      timeoutMs: config.circuitBreakerTimeoutMs || 15000,
      maxRetries: config.circuitBreakerRetries ?? 1,
      retryDelayMs: config.circuitBreakerRetryDelayMs ?? 2000,
// @ts-ignore
      fallback: null,  // No fallback — let caller handle
    }, this.bus);
  }

  // FIX v4.12.4 (M-02): SSRF protection for MCP server URLs.
  // Prevents connections to private/local IPs and loopback addresses.
  // Same patterns as WebFetcher._isPrivateIP / _validateUrl.
  _validateMcpUrl(url) {
    let parsed;
    try { parsed = new URL(url); } catch (_e) {
      throw new Error(`[MCP:SSRF] Invalid URL: ${url}`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(`[MCP:SSRF] Only HTTP/HTTPS allowed, got: ${parsed.protocol}`);
    }
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    const privatePatterns = [
      /^127\./, /^10\./, /^172\.(1[6-9]|2[0-9]|3[01])\./,
      /^192\.168\./, /^169\.254\./, /^0\./, /^::1$/, /^::$/,
      /^fc[0-9a-f]{2}:/i, /^fd[0-9a-f]{2}:/i, /^fe80:/i,
      /^::ffff:127\./i, /^::ffff:10\./i, /^::ffff:192\.168\./i,
      /^::ffff:172\.(1[6-9]|2[0-9]|3[01])\./i,
    ];
    const blocked = ['localhost', '127.0.0.1', '0.0.0.0'];
    for (const b of blocked) {
      if (hostname.includes(b)) throw new Error(`[MCP:SSRF] Blocked host: ${hostname}`);
    }
    for (const pattern of privatePatterns) {
      if (pattern.test(hostname)) throw new Error(`[MCP:SSRF] Private IP blocked: ${hostname}`);
    }
    // Block numeric IP obfuscation (decimal, hex)
    if (/^\d{8,}$/.test(hostname) || /^0x[0-9a-f]+$/i.test(hostname)) {
      throw new Error(`[MCP:SSRF] Numeric IP format blocked: ${hostname}`);
    }
  }

  // ── Connect ──────────────────────────────────────────────

  async connect() {
    if (!this.enabled) return;

    // FIX v4.12.4 (M-02): SSRF protection — validate URL before connecting.
    // Mirrors WebFetcher's _validateUrl / _isPrivateIP pattern.
    this._validateMcpUrl(this.url);

    // FIX v3.8.0: Clean up previous connection before reconnecting.
    // Without this, _maybeReconnect() → connect() leaks the old SSE
    // response stream and heartbeat interval.
    if (this._sseConnection) {
      try { this._sseConnection.destroy(); } catch (_e) { _log.debug('[catch] SSE destroy:', _e.message); }
      this._sseConnection = null;
    }
    if (this._heartbeatHandle) {
      clearInterval(this._heartbeatHandle);
      this._heartbeatHandle = null;
    }

    this.status = 'connecting';
    this.error = null;

    this.bus.emit('mcp:connecting', { name: this.name, url: this.url }, { source: 'McpTransport' });

    try {
      if (this.transport === 'sse') {
        await this._connectSSE();
      } else {
        // @ts-ignore — _connectHTTP defined below
        await this._connectHTTP();
      }
      this._startHeartbeat();
    } catch (err) {
      this.status = 'error';
      this.error = err.message;
      this.bus.emit('mcp:error', { name: this.name, error: err.message }, { source: 'McpTransport' });
      throw err;
    }
  }

  // ── SSE Transport ────────────────────────────────────────

  async _connectSSE() {
    return new Promise((resolve, reject) => {
      const parsed = new URL(this.url);
      const proto = parsed.protocol === 'https:' ? https : http;
      const timeout = setTimeout(() => reject(new Error(`SSE timeout: ${this.name}`)), TIMEOUTS.MCP_SSE_CONNECT);

      const req = proto.request({
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: { 'Accept': 'text/event-stream', 'Cache-Control': 'no-cache', ...this.headers },
      }, (res) => {
        if (res.statusCode !== 200) {
          clearTimeout(timeout);
          return reject(new Error(`SSE ${res.statusCode}: ${res.statusMessage}`));
        }

        this._sseConnection = res;
        let buffer = '';

        res.setEncoding('utf-8');
        res.on('data', (chunk) => {
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          let evt = null, data = '';

          for (const line of lines) {
            if (line.startsWith('event:')) evt = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
            else if (line === '' && data) {
              this._handleSSE(evt, data);
              evt = null; data = '';
            }
          }
        });

        res.on('end', () => {
          this.status = 'disconnected';
          this.bus.emit('mcp:disconnected', { name: this.name }, { source: 'McpTransport' });
          this._maybeReconnect();
        });

        res.on('error', (err) => {
          this.status = 'error';
          this.error = err.message;
        });

        this._onceEndpoint = (d) => {
          clearTimeout(timeout);
          this._sessionUrl = d.url || d;
          if (this._sessionUrl && !this._sessionUrl.startsWith('http')) {
            this._sessionUrl = new URL(this._sessionUrl, this.url).toString();
          }
          // FIX v4.12.4 (M-02): Re-validate redirected session URL against SSRF
          try { this._validateMcpUrl(this._sessionUrl); } catch (e) {
            this._sessionUrl = null;
            return reject(e);
          }
          this._initialize().then(resolve).catch(reject);
        };
      });

      req.on('error', (err) => { clearTimeout(timeout); reject(err); });
      req.end();
    });
  }

  _handleSSE(event, dataStr) {
    let data;
    try { data = JSON.parse(dataStr); } catch (err) { _log.debug('[MCP:SSE] JSON parse fallback:', err.message); data = dataStr; }

    if (event === 'endpoint' && this._onceEndpoint) {
      const fn = this._onceEndpoint;
      this._onceEndpoint = null;
      return fn(data);
    }

    if (data?.jsonrpc === '2.0' && data.id != null) {
      const p = this._pendingRequests.get(data.id);
      if (p) {
        clearTimeout(p.timer);
        this._pendingRequests.delete(data.id);
        data.error ? p.reject(new Error(data.error.message || JSON.stringify(data.error))) : p.resolve(data.result);
      }
    }

    if (event === 'notification' || data?.method) {
      this.bus.emit('mcp:notification', {
        name: this.name,
        method: data?.method || event,
        params: data?.params || data,
      }, { source: 'McpTransport' });
    }
  }

  // ── JSON-RPC ─────────────────────────────────────────────

  async _send(method, params = {}) {
    this._healthStats.totalRequests++;
    const start = Date.now();

    try {
      const msg = jsonrpc(method, params);
      const url = (this.transport === 'sse' && this._sessionUrl) ? this._sessionUrl : this.url;

      let result;
      if (this.transport === 'sse' && this._sessionUrl) {
        result = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            this._pendingRequests.delete(msg.id);
            reject(new Error(`Timeout: ${method}`));
          }, this._requestTimeout);
          this._pendingRequests.set(msg.id, { resolve, reject, timer });
          this._post(url, msg).catch(reject);
        });
      } else {
        result = await this._post(url, msg);
      }

      const latency = Date.now() - start;
      this._recordLatency(latency);

      if (this.status === 'degraded') {
        this.status = 'ready';
        this._drainQueue();
      }

      return result;
    } catch (err) {
      this._healthStats.failures++;
      const recentFailRate = this._healthStats.failures / Math.max(this._healthStats.totalRequests, 1);
      if (recentFailRate > 0.3 && this.status === 'ready') {
        this.status = 'degraded';
        this.bus.emit('mcp:degraded', { name: this.name, failRate: recentFailRate }, { source: 'McpTransport' });
      }
      throw err;
    }
  }

  _recordLatency(ms) {
// @ts-ignore
    this._healthStats.lastLatency = ms;
    // @ts-ignore
    this._healthStats.latencies.push(ms);
    if (this._healthStats.latencies.length > 20) this._healthStats.latencies.shift();
  }

  getLatencyPercentiles() {
    const sorted = [...this._healthStats.latencies].sort((a, b) => a - b);
    if (sorted.length === 0) return { p50: 0, p95: 0, p99: 0 };
    return {
      p50: sorted[Math.floor(sorted.length * 0.5)] || 0,
      p95: sorted[Math.floor(sorted.length * 0.95)] || 0,
      p99: sorted[Math.floor(sorted.length * 0.99)] || 0,
    };
  }

  // ── Request Queue (for degraded state) ─────────────────

  enqueue(method, params) {
    if (this._requestQueue.length >= this._maxQueueDepth) {
      throw new Error(`Request queue full for ${this.name}`);
    }
    return new Promise((resolve, reject) => {
      this._requestQueue.push({ method, params, resolve, reject });
    });
  }

  async _drainQueue() {
    while (this._requestQueue.length > 0 && this.status === 'ready') {
      const { method, params, resolve, reject } = this._requestQueue.shift();
      try {
        const result = await this._send(method, params);
        resolve(result);
      } catch (err) {
        reject(err);
        break;
      }
    }
  }

  // ── Heartbeat ──────────────────────────────────────────
  // NOTE (v4.0.0 F-06): This setInterval is intentionally NOT using IntervalManager.
  // McpTransport is a per-connection object (not a singleton service), so each
  // connection manages its own heartbeat. Cleanup happens in disconnect().

  _startHeartbeat() {
    if (this._heartbeatHandle) clearInterval(this._heartbeatHandle);
    this._heartbeatHandle = setInterval(async () => {
      if (this.status !== 'ready' && this.status !== 'degraded') return;
      try {
        await this._send('ping', {}).catch(err => _log.debug('[MCP] Ping failed:', err.message));
        this._healthStats.lastHealthCheck = Date.now();
      } catch (err) { _log.debug('[MCP-TRANSPORT] Heartbeat error:', err.message); }
    }, 30000);
  }

  async _post(url, body) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const proto = parsed.protocol === 'https:' ? https : http;
      const payload = JSON.stringify(body);

      const req = proto.request({
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...this.headers },
      }, (res) => {
        let data = '';
        res.setEncoding('utf-8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            const p = safeJsonParse(data, null, 'McpTransport');
            if (!p) { reject(new Error('Invalid JSON from ' + this.name)); return; }
            p.error ? reject(new Error(p.error.message || JSON.stringify(p.error))) : resolve(p.result !== undefined ? p.result : p);
          } catch (err) { reject(new Error('Invalid JSON from ' + this.name)); }
        });
      });

      req.setTimeout(this._requestTimeout, () => { req.destroy(); reject(new Error('POST timeout')); });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  // ── MCP Initialize ───────────────────────────────────────

  async _initialize() {
    const result = await this._send('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: { roots: { listChanged: false } },
      clientInfo: { name: 'genesis-agent', version: '5.9.8' },
    });

    this.serverInfo = result.serverInfo || {};
    this.capabilities = result.capabilities || {};

    try {
      await this._post(this._sessionUrl || this.url, { jsonrpc: '2.0', method: 'notifications/initialized' });
    } catch (err) { _log.debug('[MCP-TRANSPORT] Capability parse error:', err.message); }

    this.status = 'ready';
    this._reconnectAttempts = 0;

    // v5.2.0: Reset circuit breaker on successful connect
    this._circuitBreaker.reset();

    this.bus.emit('mcp:connected', {
      name: this.name, serverInfo: this.serverInfo, capabilities: this.capabilities,
    }, { source: 'McpTransport' });

    _log.info(`[MCP] Connected: ${this.name} (${this.serverInfo.name || '?'})`);
  }

  async discoverTools() {
    if (this.status !== 'ready') return [];
    try {
      const result = await this._send('tools/list', {});
      this.tools = (result.tools || []).map(t => ({
        name: t.name, description: t.description || '',
        inputSchema: t.inputSchema || {}, server: this.name,
      }));
      this.bus.emit('mcp:tools-discovered', { name: this.name, count: this.tools.length }, { source: 'McpTransport' });
      return this.tools;
    } catch (err) {
      _log.warn(`[MCP] Tool discovery failed (${this.name}):`, err.message);
      return [];
    }
  }

  /**
   * v5.2.0: callTool wrapped with CircuitBreaker.
   * - CLOSED: calls _send() normally (with retry + timeout)
   * - OPEN: throws immediately — no 30s wait on a dead server
   * - HALF_OPEN: single probe call to test recovery
   *
   * The CircuitBreaker's own timeout (15s default) is shorter than
   * _requestTimeout (30s), giving faster failure detection.
   */
  async callTool(toolName, args = {}) {
    if (this.status === 'degraded') {
      return this.enqueue('tools/call', { name: toolName, arguments: args });
    }
    if (this.status !== 'ready') throw new Error(`${this.name} not connected (${this.status})`);

    return this._circuitBreaker.execute(
      () => this._send('tools/call', { name: toolName, arguments: args })
    );
  }

  _maybeReconnect() {
    if (this._reconnectAttempts >= this._maxReconnects) return;
    this._reconnectAttempts++;
    const base = Math.min(1000 * 2 ** this._reconnectAttempts, 30000);
    const jitter = Math.random() * base * 0.3;
    const delay = base + jitter;
    _log.info(`[MCP] Reconnecting ${this.name} in ${Math.round(delay)}ms (attempt ${this._reconnectAttempts})`);
    setTimeout(() => this.connect().catch(err => _log.debug('[MCP] Reconnect failed:', err.message)), delay);
  }

  disconnect() {
    this._reconnectAttempts = this._maxReconnects;
    if (this._heartbeatHandle) { clearInterval(this._heartbeatHandle); this._heartbeatHandle = null; }
    if (this._sseConnection) { this._sseConnection.destroy(); this._sseConnection = null; }
    for (const [, p] of this._pendingRequests) { clearTimeout(p.timer); p.reject(new Error('Disconnected')); }
    this._pendingRequests.clear();
    for (const { reject } of this._requestQueue) reject(new Error('Disconnected'));
    this._requestQueue = [];
    this.status = 'disconnected';
    this.tools = [];
  }

  getStatus() {
    return {
      name: this.name, url: this.url, transport: this.transport,
      status: this.status, error: this.error,
      serverInfo: this.serverInfo, toolCount: this.tools.length,
      tools: this.tools.map(t => t.name), enabled: this.enabled,
      health: {
        totalRequests: this._healthStats.totalRequests,
        failures: this._healthStats.failures,
        lastLatency: this._healthStats.lastLatency,
        percentiles: this.getLatencyPercentiles(),
        queueDepth: this._requestQueue.length,
      },
      // v5.2.0: Circuit breaker status
      circuitBreaker: this._circuitBreaker.getStatus(),
    };
  }
}

module.exports = { McpServerConnection };
