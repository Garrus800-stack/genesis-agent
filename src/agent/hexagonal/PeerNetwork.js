// @ts-checked-v5.7
// ============================================================
// GENESIS — PeerNetwork.js (v3.8.1 — asyncLoad fix)
//
// v3.7.0: Split from 837-line monolith into focused modules:
//   PeerCrypto.js    — AES-256-GCM, HMAC auth, PBKDF2, rate limiting
//   PeerHealth.js    — Per-peer latency/failure tracking + scoring
//   PeerTransport.js — HTTP server/client, multicast discovery
//   PeerNetwork.js   — This file: orchestration facade
//
// PeerNetwork wires the modules together and provides the
// public API consumed by TaskDelegation, IdleMind, AgentCore.
// ============================================================

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { NullBus } = require('../core/EventBus');
const { PeerHealth } = require('./PeerHealth');
const { deriveSessionKey, verifyAuth, PeerRateLimiter } = require('./PeerCrypto');
const { PeerTransport } = require('./PeerTransport');
// FIX v5.1.0 (DI-1): CodeSafety injected via lateBinding (this._codeSafety)
const { safeJsonParse, atomicWriteFileSync } = require('../core/utils');
const { createLogger } = require('../core/Logger');
const _log = createLogger('PeerNetwork');

class PeerNetwork {
  /** @param {any} selfModel @param {any} skills @param {any} model @param {any} prompts @param {{ bus?: object, intervals?: object, guard?: object }} [opts] */
  constructor(selfModel, skills, model, prompts, { bus, intervals, guard } = {}) {
    this.selfModel = selfModel;
    this.skills = skills;
    this.model = model;
    this.prompts = prompts;
    this.bus = bus || NullBus;
    this._intervals = intervals || null;
    this.guard = guard || null;
    // v4.12.8: PeerConsensus — late-bound for state sync
    this.peerConsensus = null;

    /** @type {Map<string, object>} */
    this.peers = new Map();
    this.port = 0;

    this.config = {
      maxPeers: 20,
      peerTTL: 300000,
      rateLimitPerMin: 30,
      rateLimitCleanupInterval: 120000,
      gossipInterval: 60000,
      healthCheckInterval: 45000,
      announceInterval: 30000,
      // FIX v4.13.1 (Audit F-01): Code exchange disabled by default.
      // Peer code/skill exchange over HTTP is unencrypted — enable only
      // on trusted networks. Set to true via settings or constructor.
      enableCodeExchange: false,
    };

    // Security
    this._tokenPath = null;
    this._token = null;
    this._sessionKeys = new Map();
    // FIX v4.10.0 (S-1): Per-IP rate limiter for peer requests
    this._peerRateLimiter = new PeerRateLimiter(this.config.rateLimitPerMin);

    // Protocol
    this.protocolVersion = 3;
    this.minCompatVersion = 2;

    // v3.7.0: Extracted transport layer
    this._transport = new PeerTransport({ bus, config: this.config });

    // v5.7.0: Route handler table (CC reduction for _handlePeerRequest)
    this._routeHandlers = this._initRouteHandlers();
  }

  // ═══════════════════════════════════════════════════════
  // SECURITY
  // ═══════════════════════════════════════════════════════

  initSecurity(storageDir) {
    this._tokenPath = path.join(storageDir, 'peer-token.txt');
    if (fs.existsSync(this._tokenPath)) {
      this._token = fs.readFileSync(this._tokenPath, 'utf-8').trim();
    } else {
      this._token = crypto.randomBytes(32).toString('hex');
      // FIX v5.1.0 (N-3): Atomic write for peer auth token.
      atomicWriteFileSync(this._tokenPath, this._token, 'utf-8');
    }
  }

  // ═══════════════════════════════════════════════════════
  // SERVER
  // ═══════════════════════════════════════════════════════

  async startServer(port = 0) {
    this.port = await this._transport.startServer(
      port,
      this._token,
      (req, res, url) => this._handlePeerRequest(req, res, url)
    );
    _log.info(`[PEER] Server on port ${this.port} (protocol v${this.protocolVersion})`);
    return this.port;
  }

  // FIX v4.13.1: Made async — /sync/pull and /sync/push use await this._readBody()
  async _handlePeerRequest(req, res, url) {
    res.setHeader('Content-Type', 'application/json');

    // FIX v4.10.0 (K-3): Rate-limit ALL public endpoints by IP.
    const remoteIP = req.socket?.remoteAddress || 'unknown';
    if (!this._peerRateLimiter.check(remoteIP)) {
      res.statusCode = 429;
      res.end(JSON.stringify({ error: 'Rate limited' }));
      return;
    }

    // FIX v4.10.0 (S-1): Authenticate all requests except /health and /handshake.
    const PUBLIC_ENDPOINTS = new Set(['/health', '/handshake']);
    if (!PUBLIC_ENDPOINTS.has(url.pathname)) {
      if (this._token && !verifyAuth(req, this._token)) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'Unauthorized — HMAC auth required' }));
        return;
      }
    }

    try {
      const handler = this._routeHandlers[url.pathname];
      if (handler) {
        await handler.call(this, req, res, url);
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'Unknown endpoint' }));
      }
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  /** @private Route handler lookup table — initialized once in constructor via _initRouteHandlers() */
  _initRouteHandlers() {
    return {
      '/health': (_req, res) => {
        res.end(JSON.stringify({ ok: true, uptime: process.uptime(), protocol: this.protocolVersion }));
      },

      '/discover': (_req, res) => this._handleIdentity(res),
      '/identity': (_req, res) => this._handleIdentity(res),

      '/handshake': (_req, res) => {
        const nonce = crypto.randomBytes(16).toString('hex');
        res.end(JSON.stringify({ nonce, protocol: this.protocolVersion }));
      },

      '/skills': (_req, res) => {
        res.end(JSON.stringify(this.skills.listSkills()));
      },

      '/skill-code': (_req, res, url) => this._handleSkillCode(res, url),
      '/module-code': (_req, res, url) => this._handleModuleCode(res, url),

      '/peers': (_req, res) => {
        const peerList = [...this.peers.entries()]
          .filter(([, p]) => p.health.isHealthy)
          .map(([id, p]) => ({ id, host: p.host, port: p.port, protocol: p.protocol || 2 }));
        res.end(JSON.stringify({ peers: peerList }));
      },

      '/sync/pull': async (req, res) => this._handleSyncPull(req, res),
      '/sync/push': async (req, res) => this._handleSyncPush(req, res),
    };
  }

  _handleIdentity(res) {
    res.end(JSON.stringify({
      id: this.selfModel.getFullModel().identity,
      version: this.selfModel.getFullModel().version,
      protocol: this.protocolVersion,
      capabilities: this.selfModel.getCapabilities(),
      skills: this.skills.listSkills().map(s => s.name),
      port: this.port,
      features: { gossip: true, encryption: true, challengeResponse: true, codeExchange: true, skillImport: true },
    }));
  }

  _handleSkillCode(res, url) {
    // FIX v4.13.1 (Audit F-01): Code exchange must be explicitly enabled
    if (!this.config.enableCodeExchange) {
      res.statusCode = 403; res.end(JSON.stringify({ error: 'Code exchange disabled — enable via settings' })); return;
    }
    const skillName = url.searchParams.get('name');
    if (!skillName) { res.statusCode = 400; res.end(JSON.stringify({ error: 'Missing ?name=' })); return; }
    const skill = this.skills.loadedSkills.get(skillName);
    if (!skill) { res.statusCode = 404; res.end(JSON.stringify({ error: 'Skill not found' })); return; }
    const entryPath = path.join(skill.dir, skill.entry || 'index.js');
    const code = fs.readFileSync(entryPath, 'utf-8');
    const manifest = safeJsonParse(fs.readFileSync(path.join(skill.dir, 'skill-manifest.json'), 'utf-8'), null, 'PeerNetwork');
    if (!manifest) { res.statusCode = 500; res.end(JSON.stringify({ error: 'Invalid manifest' })); return; }
    res.end(JSON.stringify({ manifest, code }));
  }

  _handleModuleCode(res, url) {
    // FIX v4.13.1 (Audit F-01): Code exchange must be explicitly enabled
    if (!this.config.enableCodeExchange) {
      res.statusCode = 403; res.end(JSON.stringify({ error: 'Code exchange disabled — enable via settings' })); return;
    }
    const moduleName = url.searchParams.get('name');
    if (!moduleName) { res.statusCode = 400; res.end(JSON.stringify({ error: 'Missing ?name=' })); return; }
    if (moduleName.includes('..') || path.isAbsolute(moduleName)) {
      res.statusCode = 400; res.end(JSON.stringify({ error: 'Invalid module path' })); return;
    }
    const code = this.selfModel.readModule(moduleName);
    if (!code) { res.statusCode = 404; res.end(JSON.stringify({ error: 'Module not found' })); return; }
    const fullPath = path.join(this.selfModel.rootDir, moduleName);
    if (this.selfModel.guard?.isProtected(fullPath)) {
      res.statusCode = 403; res.end(JSON.stringify({ error: 'Protected module' })); return;
    }
    res.end(JSON.stringify({ file: moduleName, code }));
  }

  async _handleSyncPull(req, res) {
    if (!this.peerConsensus) { res.statusCode = 501; res.end(JSON.stringify({ error: 'Consensus not available' })); return; }
    let peerClocks = {};
    if (req.method === 'POST') {
      try {
        const body = await this._readBody(req);
        peerClocks = JSON.parse(body).clocks || {};
      } catch (err) { _log.debug('[SYNC] sync/pull body parse failed, using empty clocks:', err.message); }
    }
    const payload = this.peerConsensus.buildSyncPayload(peerClocks);
    res.end(JSON.stringify(payload));
  }

  async _handleSyncPush(req, res) {
    if (!this.peerConsensus) { res.statusCode = 501; res.end(JSON.stringify({ error: 'Consensus not available' })); return; }
    if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ error: 'POST required' })); return; }
    try {
      const body = await this._readBody(req);
      const payload = JSON.parse(body);
      const result = this.peerConsensus.applySyncPayload(payload);
      res.end(JSON.stringify(result));
    } catch (err) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  // ═══════════════════════════════════════════════════════
  // DISCOVERY & GOSSIP
  // ═══════════════════════════════════════════════════════

  startDiscovery() {
    this._transport.startDiscovery(this.port, (host, port) => {
      this.discoverPeer(host, port).catch(() => { /* best effort */ });
    });

    const register = (name, fn, interval, opts) => {
      if (this._intervals) this._intervals.register(name, fn, interval, opts);
      else { this['_handle_' + name] = setInterval(fn, interval); if (opts?.immediate) fn(); }
    };

    register('peer-announce', () => this._transport.announce(this.port, this.protocolVersion), this.config.announceInterval, { immediate: true });
    register('peer-gossip', () => this._gossip(), this.config.gossipInterval);
    register('peer-eviction', () => this._evictStalePeers(), this.config.peerTTL);
    register('peer-ratelimit-cleanup', () => this._transport.cleanupRateLimiter(), this.config.rateLimitCleanupInterval);
    register('peer-healthcheck', () => this._healthCheckPeers(), this.config.healthCheckInterval);

    _log.info(`[PEER] Multicast discovery on ${this.config.multicastGroup || '239.42.42.42'}:${this.config.multicastPort || 19420}`);
  }

  // v4.12.8: Read HTTP request body (for POST endpoints)
  _readBody(req, maxBytes = 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) { req.destroy(); reject(new Error('Body too large')); return; }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      req.on('error', reject);
    });
  }

  async _gossip() {
    for (const [, peer] of this.peers) {
      if (!peer.health.isHealthy || !peer.trusted) continue;
      try {
        const data = await this._transport.httpGet(
          `http://${peer.host}:${peer.port}/peers`,
          peer.token || this._token
        );
        if (data?.peers) {
          for (const remote of data.peers) {
            if (remote.id === this.selfModel.getFullModel().identity) continue;
            if (this.peers.has(remote.id)) continue;
            if (this.peers.size >= this.config.maxPeers) break;
            if ((remote.protocol || 2) < this.minCompatVersion) continue;
            this.discoverPeer(remote.host, remote.port).catch(() => { /* best effort */ });
          }
        }
      } catch (_e) { _log.debug('[catch] gossip is best-effort:', _e.message); }
    }
  }

  // ═══════════════════════════════════════════════════════
  // PEER HEALTH & EVICTION
  // ═══════════════════════════════════════════════════════

  _evictStalePeers() {
    const now = Date.now();
    for (const [id, peer] of this.peers) {
      if ((now - peer.health.lastSeen) > this.config.peerTTL) {
        this.peers.delete(id);
        this._sessionKeys.delete(id);
        this.bus.emit('peer:evicted', { id, reason: 'stale' }, { source: 'PeerNetwork' });
      }
    }
  }

  async _healthCheckPeers() {
    for (const [id, peer] of this.peers) {
      if (!peer.health.isHealthy && peer.health.failures >= 5) continue;
      const start = Date.now();
      try {
        await this._transport.httpGet(`http://${peer.host}:${peer.port}/health`);
        peer.health.recordSuccess(Date.now() - start);
      } catch (_e) { _log.debug("[catch] peer health check:", _e.message);
        peer.health.recordFailure();
        if (peer.health.failures >= 3) {
          this.bus.emit('peer:unhealthy', { id, failures: peer.health.failures }, { source: 'PeerNetwork' });
        }
      }
    }
  }

  getHealthyPeers() {
    return [...this.peers.entries()]
      .filter(([, p]) => p.health.isHealthy)
      .sort((a, b) => a[1].health.score - b[1].health.score)
      .map(([id, p]) => ({
        id, host: p.host, port: p.port,
        latency: Math.round(p.health.avgLatency),
        trusted: p.trusted, protocol: p.protocol,
      }));
  }

  // ═══════════════════════════════════════════════════════
  // CLIENT — Discovery & Trust
  // ═══════════════════════════════════════════════════════

  addPeer(id, host, port) {
    this.peers.set(id, {
      host, port, capabilities: [], skills: [],
      lastSeen: new Date().toISOString(),
      trusted: false, protocol: 2,
      health: new PeerHealth(),
    });
  }

  async discoverPeer(host, port) {
    const start = Date.now();
    try {
      const data = await this._transport.httpGet(`http://${host}:${port}/discover`);
      const peerProtocol = data.protocol || 2;
      if (peerProtocol < this.minCompatVersion) return null;

      const existing = this.peers.get(data.id);
      const health = existing?.health || new PeerHealth();
      health.recordSuccess(Date.now() - start);

      this.peers.set(data.id, {
        host, port,
        capabilities: data.capabilities || [],
        skills: data.skills || [],
        version: data.version,
        protocol: peerProtocol,
        features: data.features || {},
        lastSeen: new Date().toISOString(),
        trusted: existing?.trusted || false,
        token: existing?.token || null,
        health,
      });

      this.bus.emit('peer:discovered', { id: data.id, host, port, protocol: peerProtocol }, { source: 'PeerNetwork' });
      return data;
    } catch (err) {
      if (!err.message.includes('ECONNREFUSED') && !err.message.includes('Timeout')) {
        _log.warn(`[PEER] Discovery failed (${host}:${port}):`, err.message);
      }
      return null;
    }
  }

  trustPeer(peerId, token) {
    const peer = this.peers.get(peerId);
    if (!peer) return false;
    peer.trusted = true;
    peer.token = token;
    const salt = `${peerId}:${this.selfModel.getFullModel().identity}`;
    this._sessionKeys.set(peerId, deriveSessionKey(token, salt));
    this.bus.emit('peer:trusted', { id: peerId }, { source: 'PeerNetwork' });
    return true;
  }

  async scanLocalPeers(portRange = [19420, 19430]) {
    const found = [];
    const promises = [];
    for (let port = portRange[0]; port <= portRange[1]; port++) {
      if (port === this.port) continue;
      promises.push(
        this.discoverPeer('127.0.0.1', port)
          .then(peer => { if (peer) found.push(peer); })
          .catch(() => { /* best effort */ })
      );
    }
    await Promise.allSettled(promises);
    return found;
  }

  // ═══════════════════════════════════════════════════════
  // CODE & SKILL EXCHANGE
  // ═══════════════════════════════════════════════════════

  // ── Code Exchange → PeerNetworkExchange.js (v5.6.0) ──
  // (prototype delegation, see bottom of file)

  // ═══════════════════════════════════════════════════════
  // STATUS & SHUTDOWN
  // ═══════════════════════════════════════════════════════

  getPeerStatus() {
    return [...this.peers.entries()].map(([id, p]) => ({
      id, host: p.host, port: p.port,
      capabilities: p.capabilities, skills: p.skills,
      lastSeen: p.lastSeen, trusted: p.trusted,
      protocol: p.protocol || 2,
      health: {
        avgLatency: Math.round(p.health.avgLatency),
        failures: p.health.failures,
        isHealthy: p.health.isHealthy,
        score: Math.round(p.health.score),
      },
    }));
  }

  getNetworkStats() {
    const healthy = [...this.peers.values()].filter(p => p.health.isHealthy);
    const trusted = [...this.peers.values()].filter(p => p.trusted);
    return {
      totalPeers: this.peers.size,
      healthyPeers: healthy.length,
      trustedPeers: trusted.length,
      protocol: this.protocolVersion,
      listening: this.port,
      multicast: !this._transport._useBroadcast,
    };
  }

  async shutdown() {
    const clearNames = ['peer-announce', 'peer-gossip', 'peer-eviction', 'peer-ratelimit-cleanup', 'peer-healthcheck'];
    if (this._intervals) {
      for (const name of clearNames) this._intervals.clear(name);
    } else {
      for (const name of clearNames) {
        if (this['_handle_' + name]) clearInterval(this['_handle_' + name]);
      }
    }
    await this._transport.shutdown();
  }

  // ── v3.8.0: Boot-time auto-init ──────────────────────────
  // Called by Container.bootAll(). Absorbs the manual init from AgentCore:
  //   - initSecurity(genesisDir)
  //   - startServer(0)
  //   - startDiscovery()
  //   - scanLocalPeers() (fire-and-forget)
  // _genesisDir is set by the manifest factory.

  /** @internal Called by Container.bootAll() */
  async asyncLoad() {
    if (/** @type {any} */ (this)._genesisDir) this.initSecurity(/** @type {any} */ (this)._genesisDir);
    try {
      await this.startServer(0);
      this.startDiscovery();
      this.scanLocalPeers().catch(err =>
        _log.debug('[GENESIS] Peer scan failed:', err.message)
      );
    } catch (err) {
      _log.debug('[GENESIS] Peer network skipped:', err.message);
    }
  }

  /**
   * v7.4.0: Runtime snapshot for RuntimeStatePort.
   * I/O-free, in-memory only. Reports peer count and own
   * port number — both of which are safe for the prompt.
   *
   * CRITICAL WHITELIST: NEVER expose `this._token` (shared
   * secret for peer auth) or peer IP addresses. The sensitive-
   * scan CI test specifically looks for Bearer-token and
   * IPv4 patterns in the prompt output.
   */
  getRuntimeSnapshot() {
    return {
      peerCount: this.peers instanceof Map ? this.peers.size : 0,
      ownPort: typeof this.port === 'number' ? this.port : 0,
    };
  }
}

module.exports = { PeerNetwork, PeerHealth };

// Extracted to PeerNetworkExchange.js (v5.6.0) — same pattern
// as DreamCycle → DreamCycleAnalysis, GoalStack → GoalStackExecution.
const { exchange } = require('./PeerNetworkExchange');
Object.assign(PeerNetwork.prototype, exchange);
