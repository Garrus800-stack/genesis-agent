// @ts-checked-v5.6
// ============================================================
// GENESIS — CognitiveHealthTracker.js (v4.0.0)
//
// Resilience layer for Phase 9 Cognitive Architecture.
// Replaces the uniform "try { ... } catch (_e) { _log.debug('[catch] operation failed:', _e.message); _log.debug() }"
// pattern with per-service circuit breakers, exponential backoff,
// and automatic recovery.
//
// Problem:
//   Phase 9 services (ExpectationEngine, MentalSimulator,
//   DreamCycle, SelfNarrative, SurpriseAccumulator) all use
//   identical catch blocks: log + skip. When a service fails
//   systematically (e.g., WorldState.clone() broken), every
//   invocation re-fails — wasting CPU and flooding logs with
//   identical debug messages. No escalation, no degradation.
//
// Solution:
//   Per-service health tracking with three states:
//     HEALTHY   — service runs normally
//     DEGRADED  — service failed N times, on exponential backoff
//     DISABLED  — service failed too many times, fully disabled
//
//   Automatic recovery: after cooldown expires, the service
//   moves back to HEALTHY and gets one chance. If it fails
//   again, backoff doubles (up to max).
//
// Integration:
//   AgentLoopCognition:  tracker.guard('mentalSimulator', () => sim.simulate(plan))
//   DreamCycle:          tracker.guard('dreamCycle', () => this._consolidate())
//   SelfNarrative:       tracker.guard('selfNarrative', () => this._updateNarrative())
//   HealthMonitor:       tracker.getReport()
//   AgentCore._wireUI:   bus.on('cognitive:service-disabled', push to UI)
//
// EventBus integration:
//   Emits: cognitive:service-degraded, cognitive:service-disabled,
//          cognitive:service-recovered
//   Listens: (none — purely reactive to guard() calls)
// ============================================================

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('CognitiveHealthTracker');

// Service health states
const STATE = Object.freeze({
  HEALTHY:  'healthy',
  DEGRADED: 'degraded',
  DISABLED: 'disabled',
});

class CognitiveHealthTracker {
  static containerConfig = {
    name: 'cognitiveHealthTracker',
    phase: 9,
    deps: ['storage', 'eventStore'],
    tags: ['cognitive', 'health'],
    lateBindings: [],
  };

  /**
   * @param {object} [opts]
   * @param {object} [opts.bus] - EventBus
   * @param {object} [opts.storage] - StorageService
   * @param {object} [opts.eventStore] - EventStore
   * @param {object} [opts.config] - Override defaults
   */
  constructor({ bus, storage, eventStore, config } = {}) {
    this.bus = bus || NullBus;
    this.storage = storage || null;
    this.eventStore = eventStore || null;

    const cfg = config || {};

    // ── Tunable Parameters ───────────────────────────────
    /** Consecutive failures before transitioning to DEGRADED */
    this._failThreshold = cfg.failThreshold ?? 3;
    /** Consecutive failures while DEGRADED before DISABLED */
    this._disableThreshold = cfg.disableThreshold ?? 8;
    /** Initial backoff cooldown (ms) — doubles each time */
    this._initialBackoffMs = cfg.initialBackoffMs ?? 30000; // 30s
    /** Maximum backoff cooldown (ms) */
    this._maxBackoffMs = cfg.maxBackoffMs ?? 10 * 60 * 1000; // 10min
    /** Auto-recovery: if DISABLED, try again after this (ms). 0 = stay disabled */
    this._autoRecoverMs = cfg.autoRecoverMs ?? 30 * 60 * 1000; // 30min
    /** Max error messages stored per service (ring buffer) */
    this._maxErrorHistory = cfg.maxErrorHistory ?? 10;

    // ── Per-Service State ────────────────────────────────
    // Map<serviceName, ServiceHealth>
    this._services = new Map();

    // ── Global Stats ─────────────────────────────────────
    this._stats = {
      totalGuardCalls: 0,
      totalFailures: 0,
      totalSkipped: 0,  // Calls skipped because service was degraded/disabled
      totalRecoveries: 0,
    };
  }

  // FIX v5.5.0 (H-3): Sync persist on shutdown — writeJSONDebounced timer
  // won't fire after process exits. Same class as D-1/C-1.
  stop() {
    this._persistSync();
  }

  _persistSync() {
    if (!this.storage) return;
    try {
      const data = { services: {} };
      for (const [name, health] of this._services) {
        data.services[name] = {
          totalFailures: health.totalFailures,
          totalSuccesses: health.totalSuccesses,
          recoveries: health.recoveries,
        };
      }
      this.storage.writeJSON('cognitive-health.json', data);
    } catch (_e) { _log.debug('[catch] health state sync persist:', _e.message); }
  }

  // ════════════════════════════════════════════════════════
  // CORE API
  // ════════════════════════════════════════════════════════

  /**
   * Guard a cognitive service call. Wraps the function with
   * health-aware execution: skip if disabled/cooling-down,
   * track failures, manage state transitions.
   *
   * @param {string} serviceName - e.g. 'mentalSimulator', 'dreamCycle'
   * @param {Function} fn - The function to execute (sync or async)
   * @param {object} [options] - { fallback, context }
   * @returns {Promise<*>} The function's return value, or fallback on skip/failure
   */
  async guard(serviceName, fn, options = {}) {
    this._stats.totalGuardCalls++;
    const health = this._getOrCreate(serviceName);
    const { fallback = null, context = '' } = options;

    // ── Check if service should be skipped ───────────────
    if (health.state === STATE.DISABLED) {
      // Check auto-recovery timer
      if (this._autoRecoverMs > 0 && health.disabledAt &&
          Date.now() - health.disabledAt >= this._autoRecoverMs) {
        this._transitionTo(health, STATE.HEALTHY, 'auto-recovery timer expired');
      } else {
        this._stats.totalSkipped++;
        return fallback;
      }
    }

    if (health.state === STATE.DEGRADED) {
      // Check backoff timer
      if (Date.now() < health.backoffUntil) {
        this._stats.totalSkipped++;
        return fallback;
      }
      // Backoff expired — give it another chance
    }

    // ── Execute the function ─────────────────────────────
    try {
      const result = await fn();
      this._recordSuccess(health, serviceName);
      return result;
    } catch (err) {
      this._recordFailure(health, serviceName, err, context);
      return fallback;
    }
  }

  /**
   * Synchronous guard variant for non-async callers.
   * Same logic but does not await the function.
   *
   * @param {string} serviceName
   * @param {Function} fn - Synchronous function
   * @param {object} [options]
   * @returns {*}
   */
  guardSync(serviceName, fn, options = {}) {
    this._stats.totalGuardCalls++;
    const health = this._getOrCreate(serviceName);
    const { fallback = null, context = '' } = options;

    if (health.state === STATE.DISABLED) {
      if (this._autoRecoverMs > 0 && health.disabledAt &&
          Date.now() - health.disabledAt >= this._autoRecoverMs) {
        this._transitionTo(health, STATE.HEALTHY, 'auto-recovery timer expired');
      } else {
        this._stats.totalSkipped++;
        return fallback;
      }
    }

    if (health.state === STATE.DEGRADED && Date.now() < health.backoffUntil) {
      this._stats.totalSkipped++;
      return fallback;
    }

    try {
      const result = fn();
      this._recordSuccess(health, serviceName);
      return result;
    } catch (err) {
      this._recordFailure(health, serviceName, err, context);
      return fallback;
    }
  }

  /**
   * Manually reset a service to HEALTHY.
   * Use when a known issue has been fixed.
   * @param {string} serviceName
   */
  reset(serviceName) {
    const health = this._services.get(serviceName);
    if (!health) return;
    const oldState = health.state;
    this._transitionTo(health, STATE.HEALTHY, 'manual reset');
    if (oldState !== STATE.HEALTHY) {
      this._stats.totalRecoveries++;
    }
  }

  /**
   * Reset all services to HEALTHY.
   */
  resetAll() {
    for (const [name] of this._services) {
      this.reset(name);
    }
  }

  /**
   * Check if a service is currently available (HEALTHY or backoff expired).
   * @param {string} serviceName
   * @returns {boolean}
   */
  isAvailable(serviceName) {
    const health = this._services.get(serviceName);
    if (!health) return true; // Unknown = assume available
    if (health.state === STATE.HEALTHY) return true;
    if (health.state === STATE.DEGRADED) return Date.now() >= health.backoffUntil;
    if (health.state === STATE.DISABLED && this._autoRecoverMs > 0) {
      return health.disabledAt && Date.now() - health.disabledAt >= this._autoRecoverMs;
    }
    return false;
  }

  // ════════════════════════════════════════════════════════
  // REPORTING
  // ════════════════════════════════════════════════════════

  /**
   * Get a full report for HealthMonitor / Dashboard.
   * @returns {object}
   */
  getReport() {
    const services = {};
    for (const [name, health] of this._services) {
      services[name] = {
        state: health.state,
        consecutiveFailures: health.consecutiveFailures,
        totalFailures: health.totalFailures,
        totalSuccesses: health.totalSuccesses,
        lastError: health.lastError,
        lastErrorAt: health.lastErrorAt ? new Date(health.lastErrorAt).toISOString() : null,
        backoffMs: health.currentBackoffMs,
        backoffUntil: health.backoffUntil ? new Date(health.backoffUntil).toISOString() : null,
        disabledAt: health.disabledAt ? new Date(health.disabledAt).toISOString() : null,
        recoveries: health.recoveries,
      };
    }
    return {
      ...this._stats,
      services,
      trackedCount: this._services.size,
    };
  }

  /**
   * Get stats for a single service.
   * @param {string} serviceName
   * @returns {object|null}
   */
  getServiceHealth(serviceName) {
    const health = this._services.get(serviceName);
    if (!health) return null;
    return {
      state: health.state,
      consecutiveFailures: health.consecutiveFailures,
      available: this.isAvailable(serviceName),
      errorHistory: [...health.errorHistory],
    };
  }

  // ════════════════════════════════════════════════════════
  // PERSISTENCE
  // ════════════════════════════════════════════════════════

  async asyncLoad() {
    if (!this.storage) return;
    try {
      const saved = this.storage.readJSON('cognitive-health.json', null);
      if (saved && saved.services) {
        for (const [name, data] of Object.entries(saved.services)) {
          const health = this._getOrCreate(name);
          health.totalFailures = data.totalFailures || 0;
          health.totalSuccesses = data.totalSuccesses || 0;
          health.recoveries = data.recoveries || 0;
          // Don't restore transient state (backoff timers, disabled state)
          // — fresh boot gets a fresh chance
        }
      }
    } catch (_e) { _log.debug('[catch] first run or corrupt file:', _e.message); }
  }

  _persist() {
    if (!this.storage) return;
    try {
      const data = { services: {} };
      for (const [name, health] of this._services) {
        data.services[name] = {
          totalFailures: health.totalFailures,
          totalSuccesses: health.totalSuccesses,
          recoveries: health.recoveries,
        };
      }
      this.storage.writeJSONDebounced('cognitive-health.json', data, 5000);
    } catch (_e) { _log.debug('[catch] health state persist:', _e.message); }
  }

  // ════════════════════════════════════════════════════════
  // INTERNAL
  // ════════════════════════════════════════════════════════

  _getOrCreate(serviceName) {
    if (this._services.has(serviceName)) return this._services.get(serviceName);

    const health = {
      name: serviceName,
      state: STATE.HEALTHY,
      consecutiveFailures: 0,
      totalFailures: 0,
      totalSuccesses: 0,
      lastError: null,
      lastErrorAt: null,
      errorHistory: [],         // Ring buffer of last N error messages
      currentBackoffMs: this._initialBackoffMs,
      backoffUntil: null,       // Timestamp when backoff expires
      disabledAt: null,         // Timestamp when service was disabled
      recoveries: 0,
    };
    this._services.set(serviceName, health);
    return health;
  }

  _recordSuccess(health, serviceName) {
    health.totalSuccesses++;

    if (health.state !== STATE.HEALTHY) {
      // Recovery!
      const oldState = health.state;
      this._transitionTo(health, STATE.HEALTHY, `succeeded after ${health.consecutiveFailures} failures`);
      health.recoveries++;
      this._stats.totalRecoveries++;

      this.bus.fire('cognitive:service-recovered', {
        service: serviceName,
        previousState: oldState,
        totalRecoveries: health.recoveries,
      }, { source: 'CognitiveHealthTracker' });
    }

    // Reset failure counter on success
    health.consecutiveFailures = 0;
    // Decay backoff toward initial on success
    health.currentBackoffMs = Math.max(
      this._initialBackoffMs,
      Math.floor(health.currentBackoffMs * 0.5)
    );
  }

  _recordFailure(health, serviceName, err, context) {
    health.consecutiveFailures++;
    health.totalFailures++;
    health.lastError = err.message;
    health.lastErrorAt = Date.now();
    this._stats.totalFailures++;

    // Ring buffer for error history
    health.errorHistory.push({
      message: err.message,
      context: context || '',
      timestamp: Date.now(),
    });
    if (health.errorHistory.length > this._maxErrorHistory) {
      health.errorHistory.shift();
    }

    // ── State Transitions ────────────────────────────────
    if (health.state === STATE.HEALTHY && health.consecutiveFailures >= this._failThreshold) {
      // HEALTHY → DEGRADED
      this._transitionTo(health, STATE.DEGRADED, err.message);
      health.backoffUntil = Date.now() + health.currentBackoffMs;

      this.bus.fire('cognitive:service-degraded', {
        service: serviceName,
        failures: health.consecutiveFailures,
        backoffMs: health.currentBackoffMs,
        lastError: err.message,
      }, { source: 'CognitiveHealthTracker' });

      this.eventStore?.append('COGNITIVE_SERVICE_DEGRADED', {
        service: serviceName,
        failures: health.consecutiveFailures,
        backoffMs: health.currentBackoffMs,
        error: err.message,
        context,
      }, 'CognitiveHealthTracker');

    } else if (health.state === STATE.DEGRADED && health.consecutiveFailures >= this._disableThreshold) {
      // DEGRADED → DISABLED
      this._transitionTo(health, STATE.DISABLED, err.message);
      health.disabledAt = Date.now();

      this.bus.fire('cognitive:service-disabled', {
        service: serviceName,
        failures: health.consecutiveFailures,
        totalFailures: health.totalFailures,
        lastError: err.message,
        autoRecoverMs: this._autoRecoverMs,
      }, { source: 'CognitiveHealthTracker' });

      this.eventStore?.append('COGNITIVE_SERVICE_DISABLED', {
        service: serviceName,
        failures: health.consecutiveFailures,
        error: err.message,
        autoRecoverMs: this._autoRecoverMs,
      }, 'CognitiveHealthTracker');

    } else if (health.state === STATE.DEGRADED) {
      // Still DEGRADED — increase backoff (exponential)
      health.currentBackoffMs = Math.min(
        health.currentBackoffMs * 2,
        this._maxBackoffMs
      );
      health.backoffUntil = Date.now() + health.currentBackoffMs;
    } else {
      // HEALTHY but under threshold — just log
      _log.debug(`[COGNITIVE-HEALTH] ${serviceName} failed (${health.consecutiveFailures}/${this._failThreshold}): ${err.message}`);
    }

    this._persist();
  }

  _transitionTo(health, newState, reason) {
    const oldState = health.state;
    health.state = newState;

    if (newState === STATE.HEALTHY) {
      health.consecutiveFailures = 0;
      health.backoffUntil = null;
      health.disabledAt = null;
      health.currentBackoffMs = this._initialBackoffMs;
    }

    _log.info(`[COGNITIVE-HEALTH] ${health.name}: ${oldState} → ${newState} (${reason})`);
  }
}

module.exports = { CognitiveHealthTracker, COGNITIVE_HEALTH_STATE: STATE };
