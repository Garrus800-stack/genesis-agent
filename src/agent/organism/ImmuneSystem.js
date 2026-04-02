// @ts-checked-v5.7
// ============================================================
// GENESIS — ImmuneSystem.js (v4.12.5 — Digitaler Organismus)
//
// PROBLEM: Genesis can detect illness (ErrorAggregator,
// Homeostasis warnings) but cannot heal itself. Errors are
// counted, patterns are spotted, but no automated response
// occurs. A body without white blood cells.
//
// SOLUTION: An immune system that detects recurring failure
// patterns and applies graduated self-repair responses:
//
// Level 1 — INFLAMMATION (immediate):
//   Repeated errors from the same source → quarantine that
//   code path by disabling the failing service temporarily.
//
// Level 2 — TARGETED REPAIR (minutes):
//   Known failure signatures → apply preset fixes:
//   - Circuit breaker stuck open → force half-open retry
//   - Memory leak pattern → force cache clear + GC
//   - Repeated tool errors → disable + re-register tool
//
// Level 3 — ADAPTIVE IMMUNITY (hours):
//   Learn from past healing. Store which interventions
//   worked for which symptoms. Next occurrence → faster fix.
//
// Architecture:
//   chat:error / health:degradation → ImmuneSystem.detect()
//   ImmuneSystem → quarantine / repair / adapt
//   ImmuneSystem → Homeostasis (report health state)
//   ImmuneSystem → EmotionalState (relief after healing)
//   ImmuneSystem → EventStore (record interventions)
//
// SAFETY: The immune system NEVER modifies source code.
// It only operates on runtime state (restart services,
// clear caches, toggle flags, force retries).
// ============================================================

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('ImmuneSystem');

// ── Failure Signature Patterns ──────────────────────────────
// Known symptoms and their remedies. Expandable via config.
const SIGNATURES = {
  'circuit-stuck-open': {
    detect: (errors) => errors.filter(e => /circuit.*open|ECONNREFUSED|timeout/i.test(e.message)).length >= 3,
    remedy: 'force-half-open',
    cooldownMs: 60000,
    description: 'Circuit breaker stuck open — forcing half-open retry',
  },
  'memory-leak': {
    detect: (errors, vitals) => vitals?.memoryPressure?.value > 88,
    remedy: 'force-gc-and-prune',
    cooldownMs: 120000,
    description: 'Memory pressure critical — forcing GC and cache prune',
  },
  'tool-crash-loop': {
    detect: (errors) => {
      const toolErrors = errors.filter(e => /tool.*error|tool.*fail|effector/i.test(e.message));
      if (toolErrors.length < 3) return false;
      // Same tool crashing repeatedly?
      const sources = toolErrors.map(e => e.source || 'unknown');
      const freq = {};
      for (const s of sources) freq[s] = (freq[s] || 0) + 1;
      return Object.values(freq).some(v => v >= 3);
    },
    remedy: 'quarantine-tool',
    cooldownMs: 300000,
    description: 'Tool crash loop detected — quarantining failing tool',
  },
  'model-degenerate': {
    detect: (errors) => errors.filter(e => /JSON|parse|malformed|unexpected token/i.test(e.message)).length >= 5,
    remedy: 'reset-model-state',
    cooldownMs: 180000,
    description: 'Model output degeneration — resetting conversation context',
  },
};

class ImmuneSystem {
  static containerConfig = {
    name: 'immuneSystem',
    phase: 7,
    deps: ['storage'],
    tags: ['organism', 'immune', 'self-repair'],
    lateBindings: [
      { prop: 'homeostasis', service: 'homeostasis', optional: true },
      { prop: 'emotionalState', service: 'emotionalState', optional: true },
      { prop: 'circuitBreaker', service: 'circuitBreaker', optional: true },
      { prop: 'llmCache', service: 'llmCache', optional: true },
      { prop: 'tools', service: 'tools', optional: true },
      { prop: 'conversationMemory', service: 'memory', optional: true },
      { prop: 'eventStore', service: 'eventStore', optional: true },
    ],
  };

  constructor({ bus, storage, intervals, config }) {
    this.bus = bus || NullBus;
    /** @type {Function[]} */ this._unsubs = [];
    this.storage = storage || null;
    this._intervals = intervals || null;

    // Late-bound
    this.homeostasis = null;
    this.emotionalState = null;
    this.circuitBreaker = null;
    this.llmCache = null;
    this.tools = null;
    this.conversationMemory = null;
    this.eventStore = null;

    // ── Configuration ────────────────────────────────────
    const cfg = config || {};
    this._errorWindowMs = cfg.errorWindowMs || 120000;  // 2 min sliding window
    this._scanIntervalMs = cfg.scanIntervalMs || 30000; // Scan every 30s
    this._signatures = { ...SIGNATURES, ...cfg.signatures };

    // ── State ────────────────────────────────────────────
    this._errorWindow = [];          // Recent errors for pattern matching
    this._quarantined = new Map();   // source → quarantine expiry
    this._cooldowns = new Map(); this._maxCooldowns = 200;     // signatureId → last applied timestamp
    this._interventionLog = [];      // History of all interventions
    this._maxLog = 100;

    // ── Adaptive Memory ─────────────────────────────────
    // Tracks which interventions worked (error rate dropped after)
    this._immuneMemory = new Map(); this._maxImmuneMemory = 500;  // signatureId → { successes, failures, lastApplied }

    this._wireEvents();
  }

  // ════════════════════════════════════════════════════════════
  // LIFECYCLE
  // ════════════════════════════════════════════════════════════

  start() {
    if (this._intervals) {
      this._intervals.register('immune-scan', () => this._scanForPatterns(), this._scanIntervalMs);
    }
    _log.info('[IMMUNE] Active — self-repair monitoring enabled');
  }


  /** @private Subscribe to bus event with auto-cleanup in stop() */
  _sub(event, handler, opts) {
    const unsub = this.bus.on(event, handler, opts);
    this._unsubs.push(typeof unsub === 'function' ? unsub : () => {});
    return unsub;
  }

  stop() {
    for (const unsub of this._unsubs) { try { unsub(); } catch (_) { /* best effort */ } }
    this._unsubs = [];
    if (this._intervals) {
      this._intervals.clear('immune-scan');
    }
    // FIX v5.1.0 (C-1): Sync write on shutdown.
    this._saveSync();
  }

  async asyncLoad() {
    if (!this.storage) return;
    try {
      const data = this.storage.readJSON('immune-memory.json', null);
      if (data?.memory) {
        for (const [k, v] of Object.entries(data.memory)) {
          this._immuneMemory.set(k, v);
    this._trimImmuneMemory();
        }
      }
      if (Array.isArray(data?.log)) {
        this._interventionLog = data.log.slice(-this._maxLog);
      }
    } catch (_e) { _log.debug('[IMMUNE] Load state:', _e.message); }
  }

  // ════════════════════════════════════════════════════════════
  // CORE: PATTERN DETECTION & RESPONSE
  // ════════════════════════════════════════════════════════════

  /**
   * Periodic scan: check error window against known signatures.
   */
  _scanForPatterns() {
    // Clean expired errors
    const now = Date.now();
    this._errorWindow = this._errorWindow.filter(e => now - e.ts < this._errorWindowMs);

    if (this._errorWindow.length < 2) return; // Not enough data

    // Clean expired quarantines
    for (const [source, expiry] of this._quarantined) {
      if (now > expiry) this._quarantined.delete(source);
    }

    // Get vitals for signature detection
    const vitals = this.homeostasis?.getVitals() || {};

    // Check each signature
    for (const [sigId, sig] of Object.entries(this._signatures)) {
      // Cooldown check
      const lastApplied = this._cooldowns.get(sigId) || 0;
      if (now - lastApplied < sig.cooldownMs) continue;

      try {
        if (sig.detect(this._errorWindow, vitals)) {
          this._applyRemedy(sigId, sig);
        }
      } catch (err) {
        _log.debug(`[IMMUNE] Signature ${sigId} detection error:`, err.message);
      }
    }
  }

  /**
   * Apply a remedy for a detected pattern.
   */
  _applyRemedy(signatureId, signature) {
    const now = Date.now();
    this._cooldowns.set(signatureId, now);
    this._trimCooldowns();

    _log.info(`[IMMUNE] Applying remedy: ${signature.description}`);

    const intervention = {
      ts: now,
      signature: signatureId,
      remedy: signature.remedy,
      description: signature.description,
      errorCountBefore: this._errorWindow.length,
      /** @type {boolean|null} */
      success: null, // Determined later
    };

    try {
      switch (signature.remedy) {
        case 'force-half-open':
          this._remedyForceHalfOpen();
          break;
        case 'force-gc-and-prune':
          this._remedyForceGCAndPrune();
          break;
        case 'quarantine-tool':
          this._remedyQuarantineTool();
          break;
        case 'reset-model-state':
          this._remedyResetModelState();
          break;
        default:
          _log.warn(`[IMMUNE] Unknown remedy: ${signature.remedy}`);
          return;
      }

      intervention.success = true;

      // Update adaptive memory
      const mem = this._immuneMemory.get(signatureId) || { successes: 0, failures: 0 };
      mem.successes++;
      mem.lastApplied = now;
      this._immuneMemory.set(signatureId, mem);
    this._trimImmuneMemory();

      // Emotional feedback — relief after healing
      if (this.emotionalState) {
        this.emotionalState._adjust('frustration', -0.05);
        this.emotionalState._adjust('satisfaction', +0.03);
      }

      this.bus.emit('immune:intervention', {
        signature: signatureId,
        remedy: signature.remedy,
        description: signature.description,
      }, { source: 'ImmuneSystem' });

    } catch (err) {
      intervention.success = false;
      _log.warn(`[IMMUNE] Remedy failed (${signatureId}):`, err.message);

      const mem = this._immuneMemory.get(signatureId) || { successes: 0, failures: 0 };
      mem.failures++;
      this._immuneMemory.set(signatureId, mem);
    this._trimImmuneMemory();
    }

    this._interventionLog.push(intervention);
    if (this._interventionLog.length > this._maxLog) {
      this._interventionLog = this._interventionLog.slice(-this._maxLog);
    }

    this._save();
  }

  // ── Specific Remedies ─────────────────────────────────────

  _remedyForceHalfOpen() {
    if (!this.circuitBreaker) {
      _log.debug('[IMMUNE] No circuit breaker available');
      return;
    }
    const state = this.circuitBreaker.getState?.();
    if (state === 'open') {
      this.circuitBreaker.forceHalfOpen?.();
      _log.info('[IMMUNE] Circuit breaker forced to HALF_OPEN');
    }
  }

  _remedyForceGCAndPrune() {
    // Clear LLM cache
    if (this.llmCache) {
      try { this.llmCache.clear(); } catch { /* safe */ }
      _log.info('[IMMUNE] LLM cache cleared');
    }

    // Force GC if exposed
    if (global.gc) {
      try { global.gc(); } catch { /* safe */ }
      _log.info('[IMMUNE] Forced garbage collection');
    }

    // Emit prune request for KnowledgeGraph (HomeostasisEffectors will handle)
    this.bus.emit('homeostasis:prune-caches', {
      memoryPressure: 95,
      source: 'ImmuneSystem',
    }, { source: 'ImmuneSystem' });
  }

  _remedyQuarantineTool() {
    // Find the most frequently failing tool
    const toolErrors = this._errorWindow.filter(e =>
      /tool.*error|tool.*fail|effector/i.test(e.message));
    const freq = {};
    for (const e of toolErrors) {
      const src = e.source || 'unknown';
      freq[src] = (freq[src] || 0) + 1;
    }
    const worst = Object.entries(freq).sort((a, b) => b[1] - a[1])[0];
    if (worst) {
      this._quarantined.set(worst[0], Date.now() + 300000); // 5 min quarantine
      _log.info(`[IMMUNE] Quarantined tool source: ${worst[0]} for 5 minutes`);

      this.bus.emit('immune:quarantine', {
        source: worst[0],
        durationMs: 300000,
      }, { source: 'ImmuneSystem' });
    }
  }

  _remedyResetModelState() {
    // Clear conversation context to break degenerate output loops
    if (this.conversationMemory?.clearRecent) {
      try {
        this.conversationMemory.clearRecent(5); // Clear last 5 turns
        _log.info('[IMMUNE] Cleared last 5 conversation turns');
      } catch { /* safe */ }
    }

    // Clear LLM cache to prevent cached bad responses
    if (this.llmCache) {
      try { this.llmCache.clear(); } catch { /* safe */ }
    }
  }

  /** Check if a source is currently quarantined */
  isQuarantined(source) {
    const expiry = this._quarantined.get(source);
    if (!expiry) return false;
    if (Date.now() > expiry) {
      this._quarantined.delete(source);
      return false;
    }
    return true;
  }

  // ════════════════════════════════════════════════════════════
  // EVENT WIRING
  // ════════════════════════════════════════════════════════════

  _wireEvents() {
    // Collect errors into the sliding window
    this._sub('chat:error', (data) => {
      this._errorWindow.push({
        ts: Date.now(),
        message: data?.message || 'unknown',
        source: data?.source || 'unknown',
      });
    }, { source: 'ImmuneSystem', priority: -12 });

    // Health degradation events
    this._sub('health:degradation', (data) => {
      this._errorWindow.push({
        ts: Date.now(),
        message: `health-degradation: ${data?.reason || 'unknown'}`,
        source: data?.service || 'health',
      });
      // Immediate scan on degradation
      this._scanForPatterns();
    }, { source: 'ImmuneSystem', priority: -10 });

    // Homeostasis critical → immediate scan
    this._sub('homeostasis:critical', () => {
      this._scanForPatterns();
    }, { source: 'ImmuneSystem', priority: -10 });
  }

  // ════════════════════════════════════════════════════════════
  // PERSISTENCE
  // ════════════════════════════════════════════════════════════

  _save() {
    if (!this.storage) return;
    try {
      this.storage.writeJSONDebounced('immune-memory.json', this._persistData());
    } catch (err) { _log.debug('[IMMUNE] Save error:', err.message); }
  }

  /** FIX v5.1.0 (C-1): Sync write for shutdown. */
  _saveSync() {
    if (!this.storage) return;
    try {
      this.storage.writeJSON('immune-memory.json', this._persistData());
    } catch (err) { _log.debug('[IMMUNE] Sync save error:', err.message); }
  }

  _persistData() {
    return {
      memory: Object.fromEntries(this._immuneMemory),
      log: this._interventionLog.slice(-30),
    };
  }

  // ════════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════════

  getReport() {
    return {
      activeQuarantines: Array.from(this._quarantined.entries()).map(([source, expiry]) => ({
        source, expiresIn: Math.max(0, expiry - Date.now()),
      })),
      recentInterventions: this._interventionLog.slice(-5),
      immuneMemory: Object.fromEntries(this._immuneMemory),
      errorWindowSize: this._errorWindow.length,
    };
  }

  /** Build prompt context — only when immune system is active */
  buildPromptContext() {
    const quarantines = Array.from(this._quarantined.keys());
    if (quarantines.length === 0) return '';

    return `IMMUNE SYSTEM: ${quarantines.length} service(s) quarantined: ${quarantines.join(', ')}. Avoid using these tools until they recover.`;
  }

  /** DA-1: Evict oldest entries when _immuneMemory exceeds cap */
  _trimImmuneMemory() {
    if (this._immuneMemory.size <= this._maxImmuneMemory) return;
    const sorted = [...this._immuneMemory.entries()].sort((a, b) => (a[1].lastSeen || 0) - (b[1].lastSeen || 0));
    while (this._immuneMemory.size > this._maxImmuneMemory && sorted.length > 0) {
      const entry = sorted.shift(); if (entry) this._immuneMemory.delete(entry[0]);
    }
  }

  /** DA-1: Evict oldest entries when _cooldowns exceeds cap */
  _trimCooldowns() {
    if (this._cooldowns.size <= this._maxCooldowns) return;
    const sorted = [...this._cooldowns.entries()].sort((a, b) => a[1] - b[1]);
    while (this._cooldowns.size > this._maxCooldowns && sorted.length > 0) {
      const cd = sorted.shift(); if (cd) this._cooldowns.delete(cd[0]);
    }
  }
}

module.exports = { ImmuneSystem };
