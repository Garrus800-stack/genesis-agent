// ============================================================
// GENESIS — ResourceRegistry.js (v7.4.5 "Durchhalten" — Baustein C)
//
// Single source of truth for "what external resources Genesis
// can rely on right now". Steps that need a resource declare
// it (via step-types requirements); the registry tells AgentLoop
// whether to proceed or block the goal until the resource comes
// back.
//
// Tracked resource tokens:
//   service:llm           — abstract; resolves to active backend
//   service:ollama        — local Ollama HTTP on 127.0.0.1:11434
//   service:anthropic     — Anthropic API reachable
//   service:openai        — OpenAI API reachable
//   network               — generic outbound internet
//   peer                  — at least one peer connected
//   file:<absolute-path>  — file present and readable on disk
//
// The registry keeps a cache and a list of subscribers.
// Status updates flow in via:
//   - Periodic poll-tick (every 30s) re-probing services
//   - WorldState/NetworkSentinel events (network:status,
//     network:restored)
//   - Explicit register(token, status) calls (for files: probe
//     on demand at requireAll() time, no caching beyond same-tick)
//
// On status flip:
//   available  → emit('resource:available',   { token })
//   unavailable→ emit('resource:unavailable', { token, reason })
//
// GoalDriver listens to these (Phantom-Listener wired in v7.4.5
// Baustein A: bus.on('resource:available', ...)). On available
// it triggers a re-scan, picking up Goals previously blocked on
// that resource.
// ============================================================

'use strict';

const fs = require('fs');
const http = require('http');
const { Logger } = require('../core/Logger.js');
const _log = new Logger('ResourceRegistry');

const POLL_INTERVAL_MS = 30 * 1000;        // re-probe services every 30s
const PROBE_TIMEOUT_MS = 2000;             // each probe HTTP timeout
const FILE_CACHE_MS = 1000;                // cache file existence ~1s

class ResourceRegistry {
  /**
   * @param {{
   *   bus: any,
   *   intervals?: any,
   *   modelBridge?: any,        // for active backend resolution
   *   worldState?: any,         // for ollama status snapshot
   * }} ctx
   */
  constructor({ bus, intervals = null, modelBridge = null, worldState = null }) {
    this.bus = bus;
    this._intervals = intervals;
    this.modelBridge = modelBridge;       // late-bound
    this.worldState = worldState;         // late-bound

    // token → { available: boolean, lastChecked: number, reason?: string }
    this._cache = new Map();
    this._fileCache = new Map();          // path → { ok, ts }

    this._pollIntervalId = null;
    this._unsubs = [];
    this._stopped = false;
  }

  async asyncLoad() {
    // Initial probe — sets state, but emits will happen even on first
    // call (no prior state). GoalDriver may not yet be listening (it
    // wires bus subscriptions later in its own asyncLoad), so we
    // re-probe once boot:complete fires to ensure resource:available
    // events reach all listeners.
    await this._probeAll();

    // Subscribe to network/perception events
    if (this.bus && this.bus.on) {
      this._unsubs.push(this.bus.on('network:status', (data) => {
        const ok = data?.online !== false;
        this._update('network', ok, ok ? null : 'network:status reported offline');
      }, { source: 'ResourceRegistry' }));

      this._unsubs.push(this.bus.on('network:restored', () => {
        this._update('network', true, null);
      }, { source: 'ResourceRegistry' }));

      // Polling triggers full re-probe (covers Ollama status changes
      // since WorldState doesn't emit events for those today)
      this._unsubs.push(this.bus.on('perception:ollama-tick', () => {
        this._probeOllama().catch(() => { /* swallow */ });
      }, { source: 'ResourceRegistry' }));

      // After boot:complete, force a fresh probe so initial
      // resource:available events reach late subscribers like
      // GoalDriver. Without this, blocked goals would wait until
      // the first poll-tick (~30s) before being unblocked at boot.
      this._unsubs.push(this.bus.on('boot:complete', () => {
        // Clear cache so _update sees this as a flip and re-emits
        this._cache.clear();
        this._probeAll().catch(() => { /* swallow */ });
      }, { source: 'ResourceRegistry' }));
    }

    // Periodic re-probe
    if (this._intervals && this._intervals.set) {
      this._pollIntervalId = this._intervals.set(
        'resource-poll',
        () => this._probeAll().catch(() => { /* swallow */ }),
        POLL_INTERVAL_MS
      );
    }

    _log.info('[RESOURCE] active — tracking services and network');
  }

  // ── Public API ─────────────────────────────────────────

  /**
   * Check all required tokens. Returns { ok, missing }.
   * @param {string[]} tokens
   * @returns {{ok: boolean, missing: string[]}}
   */
  requireAll(tokens) {
    if (!Array.isArray(tokens) || tokens.length === 0) {
      return { ok: true, missing: [] };
    }
    const missing = [];
    for (const token of tokens) {
      if (!this.isAvailable(token)) missing.push(token);
    }
    return { ok: missing.length === 0, missing };
  }

  /**
   * Is this token currently available?
   * Resolves abstract tokens like 'service:llm' to the concrete
   * active backend.
   */
  isAvailable(token) {
    if (!token || typeof token !== 'string') return true;

    // file:<path> probed on demand (1s cache)
    if (token.startsWith('file:')) {
      const path = token.slice(5);
      const cached = this._fileCache.get(path);
      const now = Date.now();
      if (cached && (now - cached.ts) < FILE_CACHE_MS) return cached.ok;
      let ok = false;
      try {
        fs.accessSync(path, fs.constants.R_OK);
        ok = true;
      } catch (_e) { ok = false; }
      this._fileCache.set(path, { ok, ts: now });
      return ok;
    }

    // service:llm → resolve to active backend
    if (token === 'service:llm') {
      const backend = this.modelBridge?.activeBackend;
      if (!backend) return false;
      // available if EITHER active backend is up
      // (failover backend would also count, but we keep this
      // simple — if active is up, we proceed)
      return this.isAvailable(`service:${backend}`);
    }

    const entry = this._cache.get(token);
    return entry ? entry.available : false;
  }

  getStatus(token) {
    if (token === 'service:llm') {
      const backend = this.modelBridge?.activeBackend;
      return backend ? this.getStatus(`service:${backend}`) : null;
    }
    return this._cache.get(token) || null;
  }

  /** Manually mark a resource. Used by external probes/subscriptions. */
  register(token, available, reason = null) {
    this._update(token, available, reason);
  }

  getStats() {
    const summary = {};
    for (const [token, entry] of this._cache) {
      summary[token] = entry.available ? 'available' : 'unavailable';
    }
    return summary;
  }

  // ── Probing ────────────────────────────────────────────

  async _probeAll() {
    if (this._stopped) return;
    await Promise.allSettled([
      this._probeOllama(),
      this._probeNetwork(),
      this._probeAnthropic(),
      this._probeOpenAI(),
    ]);
  }

  _probeOllama() {
    // Prefer worldState snapshot (already polled by DesktopPerception
    // every few seconds — avoid double-polling). Fall back to direct
    // probe only if worldState is unavailable.
    if (this.worldState && this.worldState.state?.runtime) {
      const status = this.worldState.state.runtime.ollamaStatus;
      const ok = status === 'running';
      this._update('service:ollama', ok, ok ? null : `ollamaStatus=${status}`);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const req = http.get('http://127.0.0.1:11434/api/tags',
        { timeout: PROBE_TIMEOUT_MS }, (res) => {
          const ok = res.statusCode === 200;
          this._update('service:ollama', ok, ok ? null : `HTTP ${res.statusCode}`);
          res.resume();  // drain
          resolve();
        });
      req.on('error', (err) => {
        this._update('service:ollama', false, err.code || err.message);
        resolve();
      });
      req.on('timeout', () => {
        req.destroy();
        this._update('service:ollama', false, 'probe timeout');
        resolve();
      });
    });
  }

  _probeNetwork() {
    // Don't actively poll the internet — let NetworkSentinel events
    // drive this. If we never see an event, default to available
    // (most users have network).
    if (!this._cache.has('network')) {
      this._update('network', true, null);
    }
    return Promise.resolve();
  }

  _probeAnthropic() {
    // No active probe (would consume API quota). Mark available
    // when network is up; let CircuitBreaker handle actual failures.
    const networkOk = this.isAvailable('network');
    this._update('service:anthropic', networkOk, networkOk ? null : 'no network');
    return Promise.resolve();
  }

  _probeOpenAI() {
    const networkOk = this.isAvailable('network');
    this._update('service:openai', networkOk, networkOk ? null : 'no network');
    return Promise.resolve();
  }

  // ── State update + event emit ──────────────────────────

  _update(token, available, reason) {
    const prev = this._cache.get(token);
    const next = { available: !!available, lastChecked: Date.now(), reason: reason || null };
    this._cache.set(token, next);

    // Emit only on flip (or on first registration)
    if (!prev || prev.available !== next.available) {
      const eventName = next.available ? 'resource:available' : 'resource:unavailable';
      try {
        this.bus.fire(eventName, {
          token,
          reason: next.reason,
        }, { source: 'ResourceRegistry' });
      } catch (_e) { /* best-effort */ }

      _log.debug(`[RESOURCE] ${token} → ${next.available ? 'AVAILABLE' : 'UNAVAILABLE'}${reason ? ` (${reason})` : ''}`);
    }
  }

  stop() {
    if (this._stopped) return;
    this._stopped = true;
    for (const u of this._unsubs) {
      try { u(); } catch (_e) { /* swallow */ }
    }
    this._unsubs = [];
    if (this._intervals && this._pollIntervalId) {
      try { this._intervals.clear(this._pollIntervalId); } catch (_e) { /* swallow */ }
    }
  }
}

module.exports = { ResourceRegistry };
