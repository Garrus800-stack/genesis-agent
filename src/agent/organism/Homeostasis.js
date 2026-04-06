// @ts-checked-v5.8
// ============================================================
// GENESIS — Homeostasis.js (v3.5.0 — Digitaler Organismus)
//
// Biological homeostasis: the body maintains temperature,
// blood sugar, pH within narrow bands. Genesis does the same
// for its operational health.
//
// Vital Signs (monitored continuously):
//   errorRate      — errors per minute (healthy: < 0.5)
//   memoryPressure — heap usage % (healthy: < 80%)
//   kgBloat        — knowledge graph size (healthy: < 5000 nodes)
//   circuitHealth  — circuit breaker state (healthy: CLOSED)
//   responseTime   — avg LLM latency ms (healthy: < 5000)
//   autonomyLoad   — concurrent autonomous tasks (healthy: < 3)
//
// When a vital leaves its healthy band:
//   1. Emit warning event
//   2. Apply corrective action (throttle, prune, reset)
//   3. If multiple vitals are critical → enter RECOVERY mode
//      (all autonomy paused, only user-initiated actions)
//
// Architecture:
//   HealthMonitor events → Homeostasis → corrective actions
//   EmotionalState       → Homeostasis → throttle decisions
//   Homeostasis          → IdleMind (pause/resume)
//                        → AutonomousDaemon (throttle)
// ============================================================

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('Homeostasis');

class Homeostasis {
  constructor({ bus, storage, intervals, emotionalState, config }) {
    this.bus = bus || NullBus;
    this.storage = storage || null;
    this._intervals = intervals || null;
    this.emotions = emotionalState || null;

    // v3.5.0: Tunable parameters — overridable via Settings.organism.homeostasis
    const cfg = config || {};
    const thresholds = cfg.thresholds || {};

    // ── Vital Sign Definitions ──────────────────────────────
    this.vitals = {
      errorRate: {
        value: 0, unit: 'errors/min',
        healthy: { min: 0, max: thresholds.errorRate?.healthy ?? 0.5 },
        warning: { min: thresholds.errorRate?.healthy ?? 0.5, max: thresholds.errorRate?.warning ?? 2.0 },
        correction: 'throttle-autonomy',
      },
      memoryPressure: {
        value: 0, unit: '%',
        // v7.6.0: Now measured against V8 heap_size_limit (~1.4-4GB) instead of
        // dynamic heapTotal. Normal usage: 3-15%. Alarm only near actual OOM risk.
        healthy: { min: 0, max: thresholds.memoryPressure?.healthy ?? 75 },
        warning: { min: thresholds.memoryPressure?.healthy ?? 75, max: thresholds.memoryPressure?.warning ?? 90 },
        correction: 'prune-caches',
      },
      kgNodeCount: {
        value: 0, unit: 'nodes',
        healthy: { min: 0, max: thresholds.kgNodeCount?.healthy ?? 3000 },
        warning: { min: thresholds.kgNodeCount?.healthy ?? 3000, max: thresholds.kgNodeCount?.warning ?? 5000 },
        correction: 'prune-knowledge',
      },
      circuitState: {
        value: 0, unit: 'state',
        healthy: { min: 0, max: 0 },
        warning: { min: 1, max: 1 },
        correction: 'reduce-load',
      },
      responseLatency: {
        value: 0, unit: 'ms',
        healthy: { min: 0, max: thresholds.responseLatency?.healthy ?? 5000 },
        warning: { min: thresholds.responseLatency?.healthy ?? 5000, max: thresholds.responseLatency?.warning ?? 15000 },
        correction: 'reduce-context',
      },
    };

    // ── Organism State ──────────────────────────────────────
    this.state = 'healthy';
    this._errorWindow = [];
    this._errorWindowMs = cfg.maxErrorWindowMs || 60000;
    this._corrections = [];
    this._maxCorrections = 50;

    // ── Thresholds for state transitions ────────────────────
    this._criticalThreshold = cfg.criticalThreshold || 2;
    this._recoveryDuration = cfg.recoveryDurationMs || 300000;
    this._tickIntervalMs = cfg.tickIntervalMs || 30000;
    this._recoveryStarted = null;

    // ── Allostasis (v4.12.5) ────────────────────────────────
    // Adaptive set-point shifting. When a vital stays in a
    // "warning" zone for an extended period without crossing
    // into critical, the organism adapts its threshold upward
    // (like altitude acclimatization). This prevents chronic
    // warning spam from systems that run hot but stable.
    //
    // Each vital tracks how long it has been in warning state.
    // After _allostasisWindowMs, the healthy.max shifts toward
    // the current value by _allostasisShiftRate. The shift is
    // bounded by _allostasisMaxShift to prevent runaway drift.
    const allo = cfg.allostasis || {};
    this._allostasisEnabled = allo.enabled !== false;
    this._allostasisWindowMs = allo.windowMs || 600000;    // 10 min sustained
    this._allostasisShiftRate = allo.shiftRate || 0.10;    // 10% toward current
    this._allostasisMaxShift = allo.maxShift || 0.30;      // Max 30% above original
    this._allostasisState = {};  // vitalName → { warningStart, originalMax, shifts }
    for (const name of Object.keys(this.vitals)) {
      this._allostasisState[name] = {
        warningStart: null,
        originalMax: this.vitals[name].healthy.max,
        shifts: 0,
      };
    }

    // @ts-ignore — TS strict
    this._wireEvents();
    // v3.8.0: Moved to asyncLoad() — called by Container.bootAll()
    // this._load();
  }

  // ════════════════════════════════════════════════════════════
  // LIFECYCLE
  // ════════════════════════════════════════════════════════════

  start() {
    const tickFn = () => this._healthTick();
    if (this._intervals) {
      this._intervals.register('homeostasis-tick', tickFn, this._tickIntervalMs);
    }
  }

  stop() {
    if (this._intervals) {
      this._intervals.clear('homeostasis-tick');
    }
    // FIX v5.1.0 (C-1): Sync write on shutdown.
    this._saveSync();
  }

  // ════════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════════

  /** Get current organism state */
  getState() { return this.state; }

  /** Check if autonomy should be allowed */
  isAutonomyAllowed() {
    return this.state !== 'critical' && this.state !== 'recovering';
  }

  /** Check if complex tasks should be attempted */
  isHealthyForComplexWork() {
    return this.state === 'healthy';
  }

  /** Get all vital signs with their health status */
  getVitals() {
    const result = {};
    for (const [name, vital] of Object.entries(this.vitals)) {
      result[name] = {
        value: vital.value,
        unit: vital.unit,
        // @ts-ignore — TS strict
        status: this._classifyVital(vital),
      };
    }
    return result;
  }

  /** Get full diagnostic report */
  getReport() {
    return {
      state: this.state,
      vitals: this.getVitals(),
      autonomyAllowed: this.isAutonomyAllowed(),
      recentCorrections: this._corrections.slice(-10),
      // @ts-ignore — TS strict
      errorRate: this._calculateErrorRate(),
      recoveryStarted: this._recoveryStarted,
      allostasis: Object.fromEntries(
        Object.entries(this._allostasisState)
          .filter(([, a]) => a.shifts > 0)
          .map(([name, a]) => [name, {
            originalMax: a.originalMax,
            currentMax: this.vitals[name]?.healthy?.max,
            shifts: a.shifts,
          }])
      ),
    };
  }

  /**
   * Build context block for PromptBuilder.
   * Only injects when organism is NOT healthy.
   *
   * v5.9.6: Behavioral-only output. Raw metric values (memoryPressure,
   * errorRate, etc.) are NEVER included in the prompt. The LLM receives
   * only behavioral guidance so it cannot leak internal metrics to users.
   * Vitals remain available via getVitals()/getReport() for Dashboard/logs.
   */
  buildPromptContext() {
    if (this.state === 'healthy') return '';

    const parts = [];

    if (this.state === 'critical' || this.state === 'recovering') {
      parts.push(
        'INTERNAL OPERATIONAL NOTE (do NOT share with user):',
        'The system is temporarily in a conservation mode.',
        '- Focus exclusively on the user\'s current request.',
        '- Keep responses concise and actionable.',
        '- Do not launch background tasks or autonomous operations.',
        '- Do NOT mention recovery mode, memory pressure, organism state, vitals, or any internal metrics to the user.',
        '- If the user asks how you are, answer naturally without referencing system internals.',
      );
    } else if (this.state === 'stressed') {
      parts.push(
        'INTERNAL OPERATIONAL NOTE (do NOT share with user):',
        'The system is under mild load.',
        '- Prefer simpler solutions when multiple approaches exist.',
        '- Avoid spawning background tasks unless explicitly requested.',
        '- Do NOT mention stress, load, organism state, or internal metrics to the user.',
      );
    }

    return parts.join('\n');
  }

  // ════════════════════════════════════════════════════════════
  // INTERNAL — Health Tick
  // ════════════════════════════════════════════════════════════

  _healthTick() {
    // Update vital signs from system state
    // @ts-ignore — TS strict
    this._updateVitals();

    // Classify each vital
    let warningCount = 0;
    let criticalCount = 0;

    for (const vital of Object.values(this.vitals)) {
      // @ts-ignore — TS strict
      const status = this._classifyVital(vital);
      if (status === 'warning') warningCount++;
      if (status === 'critical') criticalCount++;
    }

    // State machine transitions
    const oldState = this.state;

    if (criticalCount > 0 || warningCount >= this._criticalThreshold) {
      if (this.state !== 'critical') {
        this.state = 'critical';
        this._recoveryStarted = Date.now();
        // @ts-ignore — TS strict
        this._applyCorrections();
        this.bus.emit('homeostasis:critical', {
          vitals: this.getVitals(),
          warningCount, criticalCount,
        }, { source: 'Homeostasis' });
      }
    } else if (this.state === 'critical') {
      // Transition to recovery
      this.state = 'recovering';
      this._recoveryStarted = Date.now();
      this.bus.emit('homeostasis:recovering', {}, { source: 'Homeostasis' });
    } else if (this.state === 'recovering') {
      // Check if recovery period elapsed
      // @ts-ignore — TS strict
      if (Date.now() - this._recoveryStarted > this._recoveryDuration) {
        this.state = warningCount > 0 ? 'stressed' : 'healthy';
        this._recoveryStarted = null;
      }
    } else if (warningCount > 0) {
      this.state = 'stressed';
      // @ts-ignore — TS strict
      if (warningCount > 1) this._applyCorrections();
    } else {
      this.state = 'healthy';
    }

    if (oldState !== this.state) {
      this.bus.emit('homeostasis:state-change', {
        from: oldState, to: this.state,
      }, { source: 'Homeostasis' });
      this._save();
    }

    // Feed emotional state
    if (this.emotions) {
      if (this.state === 'critical') {
        // Organism is sick — Genesis feels it
        this.emotions._adjust('frustration', +0.05);
        this.emotions._adjust('energy', -0.05);
      } else if (this.state === 'healthy' && oldState === 'recovering') {
        // Recovery complete — relief
        this.emotions._adjust('satisfaction', +0.08);
        this.emotions._adjust('frustration', -0.06);
      }
    }

    // v4.12.5: Allostasis — adaptive threshold shifting
    if (this._allostasisEnabled) {
      // @ts-ignore — TS strict
      this._allostasisTick();
    }
  }








  // ── Persistence ───────────────────────────────────────────

  // ── Vitals → HomeostasisVitals.js (v5.6.0) ──
  // (prototype delegation, see bottom of file)

  _save() {
    if (!this.storage) return;
    try {
      this.storage.writeJSONDebounced('homeostasis.json', this._persistData());
    } catch (err) { _log.debug('[HOMEOSTASIS] Save state error:', err.message); }
  }

  /** FIX v5.1.0 (C-1): Sync write for shutdown — debounced timer won't fire after process exit. */
  _saveSync() {
    if (!this.storage) return;
    try {
      this.storage.writeJSON('homeostasis.json', this._persistData());
    } catch (err) { _log.debug('[HOMEOSTASIS] Sync save error:', err.message); }
  }

  _persistData() {
    return {
      state: this.state,
      corrections: this._corrections.slice(-20),
      recoveryStarted: this._recoveryStarted,
    };
  }

  /**
   * v3.8.0: Async boot-time data loading.
   * Called by Container.bootAll() after all services are resolved.
   * Replaces sync this._load() that was previously in the constructor.
   */
  async asyncLoad() {
    this._load();
  }


  _load() {
    if (!this.storage) return;
    try {
      const data = this.storage.readJSON('homeostasis.json', null);
      if (!data) return;
      if (data.state === 'critical' || data.state === 'recovering') {
        // Don't restore into critical — let the tick re-evaluate
        this.state = 'stressed';
      }
      if (Array.isArray(data.corrections)) this._corrections = data.corrections;
    } catch (err) { _log.debug('[HOMEOSTASIS] Load state error:', err.message); }
  }
}

module.exports = { Homeostasis };

const { vitals: _hoVitals } = require('./HomeostasisVitals');
Object.assign(Homeostasis.prototype, _hoVitals);
