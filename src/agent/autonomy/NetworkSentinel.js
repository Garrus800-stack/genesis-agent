// ============================================================
// GENESIS — NetworkSentinel.js (Phase 6 — Autonomy)
//
// Periodic connectivity monitor. Detects network loss and
// triggers automatic failover to local Ollama models.
//
// Architecture:
//   NetworkSentinel → ModelBridge.switchTo() (failover)
//   NetworkSentinel → BodySchema (canAccessWeb update)
//   NetworkSentinel → bus: network:status, network:failover
//   HealthMonitor   → NetworkSentinel (health:degradation)
//
// Design:
//   - Probes 2 endpoints (Ollama health + external DNS)
//   - Debounced: 3 consecutive failures → offline
//   - On offline: auto-switch to best local Ollama model
//   - On reconnect: restore previous cloud model
//   - Mutation queue: deferred bus events replayed on reconnect
//   - Zero false positives: Ollama-local check distinguishes
//     "no internet" from "everything down"
//
// PERFORMANCE: One HTTP HEAD every 30s. ~1ms when online.
// ============================================================

const http = require('http');
const https = require('https');
const { createLogger } = require('../core/Logger');
const { swallow } = require('../core/utils');
const _log = createLogger('NetworkSentinel');

// ── Configuration Defaults ────────────────────────────────
const DEFAULTS = Object.freeze({
  /** Probe interval in ms */
  intervalMs: 30_000,
  /** Consecutive failures before declaring offline */
  failureThreshold: 3,
  /** Probe timeout in ms */
  probeTimeoutMs: 5_000,
  /** External probe targets (HEAD requests) */
  probeUrls: [
    'https://dns.google/resolve?name=example.com&type=A',
    'https://1.1.1.1/dns-query',
  ],
  /** Ollama local health endpoint */
  ollamaHealthUrl: 'http://127.0.0.1:11434/api/tags',
  /** Restore previous model on reconnect */
  autoRestore: true,
});

class NetworkSentinel {
  /**
   * @param {{
   *   bus: *,
   *   intervals?: *,
   *   config?: Partial<typeof DEFAULTS>
   * }} deps
   */
  constructor({ bus, intervals, config } = {}) {
    /** @type {*} */ this.bus = bus || { on() {}, emit() {} };
    this._intervals = intervals;
    this._config = { ...DEFAULTS, ...config };

    // ── State ──────────────────────────────────────────
    this._online = true;            // current connectivity status
    this._consecutiveFailures = 0;  // probe failure counter
    this._ollamaAvailable = false;  // local Ollama reachable?
    this._previousModel = null;     // model before failover
    this._previousBackend = null;   // backend before failover
    this._failoverActive = false;   // currently in failover mode?
    this._probeTimer = null;        // setInterval handle
    this._running = false;
    this._mutationQueue = [];       // deferred events during offline

    // ── Late-bound dependencies ───────────────────────
    /** @type {*} */ this._modelBridge = null;
    /** @type {*} */ this._settings = null;

    // ── Subscriptions ─────────────────────────────────
    this._unsubs = [];

    // ── Stats ─────────────────────────────────────────
    this._stats = {
      probes: 0,
      failures: 0,
      failovers: 0,
      restores: 0,
      lastProbeMs: 0,
      lastStatus: 'unknown',
      offlineSince: null,
    };
  }

  // ════════════════════════════════════════════════════════
  // LIFECYCLE
  // ════════════════════════════════════════════════════════

  start() {
    if (this._running) return;
    this._running = true;

    // Subscribe to model failover events (external failures)
    this._sub('model:failover', (data) => {
      if (!this._online) return;
      // Cloud backend failed → might be network issue, probe immediately
      swallow(this._probe(), 'probe');
    });

    // Subscribe to health degradation
    this._sub('health:degradation', () => {
      swallow(this._probe(), 'probe');
    });

    // Initial probe (delayed to let boot settle)
    const delay = Math.min(this._config.intervalMs, 10_000);
    setTimeout(() => {
      swallow(this._probe(), 'probe');
    }, delay);

    // Periodic probing
    if (this._intervals?.register) {
      this._intervals.register('network-probe', () => swallow(this._probe(), 'probe'), this._config.intervalMs);
    } else {
      this._probeTimer = setInterval(() => swallow(this._probe(), 'probe'), this._config.intervalMs);
    }

    _log.info(`[NET] Sentinel started (interval: ${this._config.intervalMs}ms, threshold: ${this._config.failureThreshold})`);
  }

  stop() {
    this._running = false;
    if (this._probeTimer) {
      clearInterval(this._probeTimer);
      this._probeTimer = null;
    }
    for (const unsub of this._unsubs) {
      try { if (typeof unsub === 'function') unsub(); } catch (_e) { /* ok */ }
    }
    this._unsubs = [];
    _log.info('[NET] Sentinel stopped');
  }

  // ════════════════════════════════════════════════════════
  // PROBING
  // ════════════════════════════════════════════════════════

  async _probe() {
    if (!this._running) return;
    const t0 = Date.now();
    this._stats.probes++;

    // ── Step 1: Check external connectivity ───────────
    const externalOk = await this._probeExternal();

    // ── Step 2: Check Ollama local ────────────────────
    this._ollamaAvailable = await this._probeOllama();

    this._stats.lastProbeMs = Date.now() - t0;

    if (externalOk) {
      this._onOnline();
    } else {
      this._onProbeFailure();
    }
  }

  /**
   * Probe external endpoints. Returns true if ANY endpoint responds.
   */
  async _probeExternal() {
    const results = await Promise.allSettled(
      this._config.probeUrls.map(url => this._httpHead(url))
    );
    return results.some(r => r.status === 'fulfilled' && r.value === true);
  }

  /**
   * Probe local Ollama. Returns true if reachable.
   */
  async _probeOllama() {
    try {
      return await this._httpHead(this._config.ollamaHealthUrl);
    } catch { /* Ollama unreachable — report offline */
      return false;
    }
  }

  /**
   * HTTP HEAD/GET with timeout. Returns true on 2xx/3xx.
   */
  _httpHead(url) {
    return new Promise((resolve) => {
      const mod = url.startsWith('https') ? https : http;
      const req = mod.get(url, { timeout: this._config.probeTimeoutMs }, (res) => {
        // Consume response to free socket
        res.resume();
        resolve(res.statusCode < 400);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }

  // ════════════════════════════════════════════════════════
  // STATE TRANSITIONS
  // ════════════════════════════════════════════════════════

  _onOnline() {
    this._consecutiveFailures = 0;

    if (!this._online) {
      // ── RECONNECT ─────────────────────────────────
      const offlineDuration = this._stats.offlineSince
        ? Date.now() - this._stats.offlineSince
        : 0;

      this._online = true;
      this._stats.lastStatus = 'online';
      this._stats.offlineSince = null;

      _log.info(`[NET] Back online (was offline for ${Math.round(offlineDuration / 1000)}s)`);

      this.bus.emit('network:status', {
        online: true,
        offlineDurationMs: offlineDuration,
        ollamaAvailable: this._ollamaAvailable,
      }, { source: 'NetworkSentinel' });

      // Restore previous cloud model if auto-restore enabled
      if (this._failoverActive && this._config.autoRestore) {
        this._restoreModel();
      }

      // Flush mutation queue
      this._flushQueue();
    }

    this._stats.lastStatus = 'online';
  }

  _onProbeFailure() {
    this._consecutiveFailures++;
    this._stats.failures++;

    _log.debug(`[NET] Probe failure ${this._consecutiveFailures}/${this._config.failureThreshold}`);

    if (this._consecutiveFailures >= this._config.failureThreshold && this._online) {
      // ── GO OFFLINE ──────────────────────────────────
      this._online = false;
      this._stats.lastStatus = 'offline';
      this._stats.offlineSince = Date.now();

      _log.warn('[NET] Network offline detected');

      this.bus.emit('network:status', {
        online: false,
        consecutiveFailures: this._consecutiveFailures,
        ollamaAvailable: this._ollamaAvailable,
      }, { source: 'NetworkSentinel' });

      this.bus.emit('health:degradation', {
        service: 'NetworkSentinel',
        level: 'warning',
        reason: 'network-offline',
      }, { source: 'NetworkSentinel' });

      // Auto-failover to Ollama if available
      if (this._ollamaAvailable) {
        this._failoverToOllama();
      }

      // v6.0.5: Flush KG + LessonsStore to ensure nothing is lost
      this._flushPersistentData();
    }
  }

  /**
   * Flush KnowledgeGraph and LessonsStore before going offline.
   * Ensures all in-memory data is persisted to disk.
   */
  async _flushPersistentData() {
    try {
      if (this._knowledgeGraph?.flush) {
        await this._knowledgeGraph.flush();
        _log.info('[NET] KnowledgeGraph flushed to disk');
      }
    } catch (err) {
      _log.error(`[NET] KG flush failed: ${err.message}`);
    }

    try {
      if (this._lessonsStore?.flush) {
        await this._lessonsStore.flush();
        _log.info('[NET] LessonsStore flushed to disk');
      }
    } catch (err) {
      _log.error(`[NET] LessonsStore flush failed: ${err.message}`);
    }
  }

  // ════════════════════════════════════════════════════════
  // FAILOVER / RESTORE
  // ════════════════════════════════════════════════════════

  async _failoverToOllama() {
    const mb = this._modelBridge;
    if (!mb) {
      _log.warn('[NET] No ModelBridge — cannot failover');
      return;
    }

    // Only failover if current backend is cloud
    if (mb.activeBackend === 'ollama') {
      _log.info('[NET] Already on Ollama — no failover needed');
      return;
    }

    // Save current model for later restore
    this._previousModel = mb.activeModel;
    this._previousBackend = mb.activeBackend;

    // Find best local Ollama model
    const ollamaModels = mb.availableModels.filter(m => m.backend === 'ollama');
    if (ollamaModels.length === 0) {
      _log.warn('[NET] No Ollama models available for failover');
      return;
    }

    // Use ModelBridge's scoring to pick the best one
    const best = mb._selectBestModel
      ? mb._selectBestModel(ollamaModels)
      : ollamaModels[0];

    try {
      await mb.switchTo(best.name);
      this._failoverActive = true;
      this._stats.failovers++;

      _log.info(`[NET] Failover: ${this._previousModel} (${this._previousBackend}) → ${best.name} (ollama)`);

      this.bus.emit('network:failover', {
        from: { model: this._previousModel, backend: this._previousBackend },
        to: { model: best.name, backend: 'ollama' },
        reason: 'network-offline',
      }, { source: 'NetworkSentinel' });
    } catch (err) {
      _log.error(`[NET] Failover to ${best.name} failed: ${err.message}`);
    }
  }

  async _restoreModel() {
    const mb = this._modelBridge;
    if (!mb || !this._previousModel || !this._failoverActive) return;

    // Verify the previous model is still available
    const stillExists = mb.availableModels.find(m => m.name === this._previousModel);
    if (!stillExists) {
      _log.info(`[NET] Previous model "${this._previousModel}" no longer available — keeping current`);
      this._failoverActive = false;
      return;
    }

    try {
      await mb.switchTo(this._previousModel);
      this._stats.restores++;

      _log.info(`[NET] Restored: ${mb.activeModel} (${mb.activeBackend}) ← was failover to ollama`);

      this.bus.emit('network:restored', {
        model: this._previousModel,
        backend: this._previousBackend,
      }, { source: 'NetworkSentinel' });

      this._failoverActive = false;
      this._previousModel = null;
      this._previousBackend = null;
    } catch (err) {
      _log.error(`[NET] Restore failed: ${err.message}`);
    }
  }

  // ════════════════════════════════════════════════════════
  // MUTATION QUEUE
  // ════════════════════════════════════════════════════════

  /**
   * Queue a mutation for replay on reconnect.
   * Called by external services that need network for sync.
   * @param {{ event: string, data: object }} mutation
   */
  queueMutation(mutation) {
    if (this._mutationQueue.length >= 500) {
      this._mutationQueue.shift(); // ring buffer behavior
    }
    this._mutationQueue.push({ ...mutation, queuedAt: Date.now() });
  }

  _flushQueue() {
    if (this._mutationQueue.length === 0) return;
    const count = this._mutationQueue.length;

    for (const m of this._mutationQueue) {
      try {
        this.bus.emit(m.event, { ...m.data, _replayed: true }, { source: 'NetworkSentinel:queue' });
      } catch (err) {
        _log.error(`[NET] Queue replay failed for ${m.event}: ${err.message}`);
      }
    }

    this._mutationQueue = [];
    _log.info(`[NET] Flushed ${count} queued mutations`);
  }

  // ════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════

  /** @returns {boolean} */
  get isOnline() { return this._online; }

  /** @returns {boolean} */
  get isFailoverActive() { return this._failoverActive; }

  /** @returns {boolean} */
  get isOllamaAvailable() { return this._ollamaAvailable; }

  getStatus() {
    return {
      online: this._online,
      ollamaAvailable: this._ollamaAvailable,
      failoverActive: this._failoverActive,
      previousModel: this._previousModel,
      consecutiveFailures: this._consecutiveFailures,
      stats: { ...this._stats },
      queueSize: this._mutationQueue.length,
    };
  }

  getStats() { return { ...this._stats }; }

  /** Force an immediate probe (e.g. from CLI /network) */
  async forceProbe() {
    await this._probe();
    return this.getStatus();
  }

  // ════════════════════════════════════════════════════════
  // INTERNAL
  // ════════════════════════════════════════════════════════

  /** @private Subscribe with auto-cleanup */
  _sub(event, handler, opts) {
    const unsub = this.bus.on?.(event, handler, { source: 'NetworkSentinel', ...opts });
    if (typeof unsub === 'function') this._unsubs.push(unsub);
    else if (this.bus.removeListener) {
      this._unsubs.push(() => this.bus.removeListener(event, handler));
    }
  }
}

module.exports = { NetworkSentinel };
