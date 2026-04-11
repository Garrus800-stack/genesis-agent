// ============================================================
// GENESIS — DaemonController.js (V7-4A)
//
// External control channel for the AutonomousDaemon.
// Accepts JSON-Line commands over Unix Socket (Linux/macOS)
// or Named Pipe (Windows).
//
// Protocol:
//   Client sends:  { "id": "1", "method": "status", "params": {} }\n
//   Server sends:  { "id": "1", "result": { ... } }\n
//   On error:      { "id": "1", "error": { "code": -1, "message": "..." } }\n
//
// Methods:
//   ping         → { pong: true }
//   status       → Daemon status + health summary
//   goal         → Push a new goal  (params: { description })
//   stop         → Stop the daemon gracefully
//   check        → Run a specific check  (params: { type })
//   config       → Get/set daemon config (params: { key?, value? })
//   clients      → List connected clients
//
// Socket path:
//   Linux/macOS: /tmp/genesis-agent.sock  (or $GENESIS_SOCKET)
//   Windows:     \\.\pipe\genesis-agent
//
// Security:
//   - Binds to local socket only (filesystem permissions)
//   - Max 5 concurrent clients
//   - 4 KB max message size
//   - No auth (local-only, same-user)
//
// Phase: 6 (autonomy)
// ============================================================

'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');
const { DaemonControlPort } = require('../ports/DaemonControlPort');
const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('DaemonController');

const MAX_CLIENTS = 5;
const MAX_MESSAGE_BYTES = 4096;
const DEFAULT_SOCKET_LINUX = '/tmp/genesis-agent.sock';
const DEFAULT_PIPE_WIN32 = '\\\\.\\pipe\\genesis-agent';

/** @param {string|undefined} env */
function resolveSocketPath(env) {
  if (env) return env;
  return process.platform === 'win32' ? DEFAULT_PIPE_WIN32 : DEFAULT_SOCKET_LINUX;
}

class DaemonController extends DaemonControlPort {
  /**
   * @param {{ bus?: *, daemon?: *, agentLoop?: *, container?: *, socketPath?: string }} deps
   */
  constructor({ bus, daemon, agentLoop, container, socketPath } = {}) {
    super();
    this.bus = bus || NullBus;
    this.daemon = daemon || null;       // AutonomousDaemon
    this.agentLoop = agentLoop || null; // AgentLoop (for goal push)
    this.container = container || null; // DI container (for deep status)

    this._socketPath = resolveSocketPath(socketPath || process.env.GENESIS_SOCKET);
    this._server = null;
    this._clients = new Set();
    this._listening = false;

    // v7.0.2: Built once in constructor instead of per-call getter (minor perf fix)
    this._methods = {
      ping:    () => ({ pong: true, timestamp: Date.now() }),
      status:  (p) => this._methodStatus(p),
      goal:    (p) => this._methodGoal(p),
      chat:    (p) => this._methodChat(p),
      stop:    ()  => this._methodStop(),
      check:   (p) => this._methodCheck(p),
      config:  (p) => this._methodConfig(p),
      clients: ()  => this._methodClients(),
      update:  (p) => this._methodUpdate(p),  // v7.1.1: V7-4B/C — trigger update check
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────

  start() {
    if (this._server) return;

    // Clean up stale socket file (Unix only)
    if (process.platform !== 'win32') {
      try {
        const stat = fs.statSync(this._socketPath);
        if (stat.isSocket()) fs.unlinkSync(this._socketPath);
      } catch (_e) { /* does not exist — fine */ }
    }

    this._server = net.createServer((socket) => this._onConnection(socket));

    this._server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        _log.warn(`Socket ${this._socketPath} in use — control channel disabled`);
      } else {
        _log.warn('Control server error:', err.message);
      }
      this.bus.fire('daemon:control-error', { error: err.message }, { source: 'DaemonController' });
    });

    this._server.listen(this._socketPath, () => {
      this._listening = true;
      // Set socket permissions (owner-only on Unix)
      if (process.platform !== 'win32') {
        try { fs.chmodSync(this._socketPath, 0o600); } catch (_e) { /* best effort */ }
      }
      _log.info(`Control channel listening on ${this._socketPath}`);
      this.bus.fire('daemon:control-listening', { path: this._socketPath }, { source: 'DaemonController' });
    });
  }

  stop() {
    this._listening = false;

    // Close all client connections
    for (const client of this._clients) {
      try { client.destroy(); } catch (_e) { /* ok */ }
    }
    this._clients.clear();

    // Close server
    if (this._server) {
      this._server.close();
      this._server = null;
    }

    // Remove socket file (Unix only)
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(this._socketPath); } catch (_e) { /* ok */ }
    }

    _log.info('Control channel closed');
    this.bus.fire('daemon:control-closed', {}, { source: 'DaemonController' });
  }

  isListening() { return this._listening; }
  getAddress() { return this._listening ? this._socketPath : null; }
  getClientCount() { return this._clients.size; }

  // ── Connection Handling ───────────────────────────────────

  _onConnection(socket) {
    if (this._clients.size >= MAX_CLIENTS) {
      const err = JSON.stringify({ id: null, error: { code: -2, message: 'Max clients reached' } }) + '\n';
      socket.write(err);
      socket.destroy();
      return;
    }

    this._clients.add(socket);
    _log.info(`Client connected (${this._clients.size}/${MAX_CLIENTS})`);
    this.bus.fire('daemon:control-connected', { clients: this._clients.size }, { source: 'DaemonController' });

    let buffer = '';

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > MAX_MESSAGE_BYTES) {
        this._sendError(socket, null, -3, 'Message too large');
        buffer = '';
        return;
      }

      // Process complete lines
      let newlineIdx;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (line.length > 0) {
          this._handleLine(socket, line);
        }
      }
    });

    socket.on('close', () => {
      this._clients.delete(socket);
      _log.info(`Client disconnected (${this._clients.size}/${MAX_CLIENTS})`);
      this.bus.fire('daemon:control-disconnected', { clients: this._clients.size }, { source: 'DaemonController' });
    });

    socket.on('error', (err) => {
      _log.debug('Client socket error:', err.message);
      this._clients.delete(socket);
    });
  }

  // ── Message Dispatch ──────────────────────────────────────

  /** @param {net.Socket} socket  @param {string} line */
  _handleLine(socket, line) {
    let req;
    try {
      req = JSON.parse(line);
    } catch (_e) {
      this._sendError(socket, null, -32700, 'Parse error');
      return;
    }

    const id = req.id ?? null;
    const method = req.method;
    const params = req.params || {};

    if (typeof method !== 'string') {
      this._sendError(socket, id, -32600, 'Missing method');
      return;
    }

    this.bus.fire('daemon:control-command', { method, id }, { source: 'DaemonController' });

    // Dispatch
    const handler = this._methods[method];
    if (!handler) {
      this._sendError(socket, id, -32601, `Unknown method: ${method}`);
      return;
    }

    try {
      const resultOrPromise = handler.call(this, params);
      if (resultOrPromise && typeof resultOrPromise.then === 'function') {
        resultOrPromise
          .then((result) => this._sendResult(socket, id, result))
          .catch((err) => this._sendError(socket, id, -1, err.message));
      } else {
        this._sendResult(socket, id, resultOrPromise);
      }
    } catch (err) {
      this._sendError(socket, id, -1, err.message);
    }
  }


  _methodStatus(_params) {
    const daemonStatus = this.daemon?.getStatus?.() || { running: false };
    const services = this.container
      ? { total: this.container.registrations.size, resolved: this.container.resolved.size }
      : null;
    return {
      daemon: daemonStatus,
      services,
      uptime: Math.round(process.uptime()),
      memory: {
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
        heap: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      },
      pid: process.pid,
    };
  }

  async _methodGoal(params) {
    const desc = params.description || params.goal;
    if (!desc || typeof desc !== 'string') {
      throw new Error('Missing required param: description');
    }
    if (!this.agentLoop) {
      throw new Error('AgentLoop not available');
    }
    // Push goal — returns goal ID or similar
    const result = await this.agentLoop.pursue(desc);
    return { accepted: true, description: desc, result: result ?? null };
  }

  _methodStop() {
    if (this.daemon) {
      this.daemon.stop();
    }
    // Schedule process exit after response is sent
    setTimeout(() => {
      _log.info('Shutdown requested via control channel');
      this.stop();
      process.emit('SIGTERM');
    }, 200);
    return { stopping: true };
  }

  async _methodCheck(params) {
    const type = params.type;
    if (!type || typeof type !== 'string') {
      throw new Error('Missing required param: type (health|optimize|gaps|consolidate|learn)');
    }
    if (!this.daemon) {
      throw new Error('Daemon not available');
    }
    const result = await this.daemon.runCheck(type);
    return { type, result };
  }

  _methodConfig(params) {
    if (!this.daemon) throw new Error('Daemon not available');

    // Read
    if (!params.key && !params.value) {
      return { config: this.daemon.config };
    }

    // Read specific key
    if (params.key && params.value === undefined) {
      const val = this.daemon.config[params.key];
      if (val === undefined) throw new Error(`Unknown config key: ${params.key}`);
      return { [params.key]: val };
    }

    // Write
    if (params.key && params.value !== undefined) {
      if (!(params.key in this.daemon.config)) throw new Error(`Unknown config key: ${params.key}`);
      this.daemon.config[params.key] = params.value;
      return { updated: params.key, value: params.value };
    }

    throw new Error('Invalid config params — use { key } to read or { key, value } to write');
  }

  _methodClients() {
    return {
      count: this._clients.size,
      max: MAX_CLIENTS,
    };
  }

  // v7.1.1: Chat command — send a message to Genesis via control channel
  async _methodChat(params) {
    const message = params.message || params.msg;
    if (!message || typeof message !== 'string') {
      throw new Error('Missing required param: message');
    }
    const orchestrator = this.container?.tryResolve?.('chatOrchestrator');
    if (!orchestrator) {
      throw new Error('ChatOrchestrator not available');
    }
    const result = await orchestrator.handleChat(message);
    return { message, response: result.text, intent: result.intent };
  }

  // v7.1.1: Update command — check for updates (and optionally apply) via control channel
  async _methodUpdate(params) {
    const updater = this.container?.tryResolve?.('autoUpdater');
    if (!updater) {
      throw new Error('AutoUpdater not available');
    }
    const force = params?.force === true;
    if (force) {
      // Temporarily enable autoApply for this triggered check if not already set
      const wasAutoApply = updater._autoApply;
      if (params.apply === true) updater._autoApply = true;
      const result = await updater.checkForUpdate();
      updater._autoApply = wasAutoApply;
      return { ...result, status: updater.getStatus() };
    }
    const result = await updater.checkForUpdate();
    return { ...result, status: updater.getStatus() };
  }

  // ── Transport Helpers ─────────────────────────────────────

  /** @param {net.Socket} socket */
  _sendResult(socket, id, result) {
    if (socket.destroyed) return;
    try {
      socket.write(JSON.stringify({ id, result }) + '\n');
    } catch (_e) { /* client gone */ }
  }

  /** @param {net.Socket} socket */
  _sendError(socket, id, code, message) {
    if (socket.destroyed) return;
    try {
      socket.write(JSON.stringify({ id, error: { code, message } }) + '\n');
    } catch (_e) { /* client gone */ }
  }
}

module.exports = { DaemonController, resolveSocketPath, DEFAULT_SOCKET_LINUX, DEFAULT_PIPE_WIN32 };
