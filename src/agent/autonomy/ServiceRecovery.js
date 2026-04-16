// @ts-checked-v5.9
// ============================================================
// GENESIS — ServiceRecovery.js (v5.9.3)
//
// Auto-recovery for degraded services. Listens to
// health:degradation events and attempts to restore services
// by re-initializing or restarting them.
//
// Architecture:
//   health:degradation → classify → recover → verify → emit
//
// Recovery strategies:
//   1. REINIT  — call service.asyncLoad() to re-initialize
//   2. RESTART — stop() + delete from Container + re-resolve
//   3. RESET   — call service.reset() if available
//   4. SKIP    — service is not recoverable (kernel, bus, etc.)
//
// Circuit breaker: max 3 recovery attempts per service per
// sliding window (5 minutes). After that, service is marked
// as permanently degraded until manual intervention.
//
// Events emitted:
//   health:recovery          — service recovered successfully
//   health:recovery-failed   — recovery attempt failed
//   health:recovery-exhausted — circuit breaker tripped
// ============================================================

'use strict';

const { createLogger } = require('../core/Logger');

const _log = createLogger('ServiceRecovery');

/** @type {Set<string>} Services that should never be restarted */
const SKIP_SERVICES = new Set([
  'bus', 'storage', 'guard', 'settings', 'container',
  'logger', 'rootDir', 'genesisDir',
]);

/** @type {Set<string>} Services where asyncLoad() is the recovery path */
const REINIT_SERVICES = new Set([
  'knowledgeGraph', 'lessonsStore', 'sessionPersistence',
  'vectorMemory', 'episodicMemory',
  'userModel', 'promptEvolution', 'goalStack',
]);

const MAX_RETRIES = 3;
const WINDOW_MS = 5 * 60 * 1000; // 5 minutes

class ServiceRecovery {
  /**
   * @param {{ bus: *, container?: *, healthMonitor?: * }} deps
   */
  constructor({ bus, container, healthMonitor }) {
    /** @type {import('../core/EventBus').EventBus} */
    this.bus = bus;
    this.container = container || null;
    this.healthMonitor = healthMonitor || null;

    /** @type {Map<string, { attempts: number[], lastStrategy: string, exhausted: boolean }>} */
    this._tracker = new Map();

    /** @type {{ attempted: number, succeeded: number, failed: number, exhausted: number }} */
    this.stats = { attempted: 0, succeeded: 0, failed: 0, exhausted: 0 };

    /** @type {Array<Function>} */
    this._unsubs = [];
  }

  // ── Lifecycle ──────────────────────────────────────────

  boot() {
    this._unsubs.push(
      this.bus.on('health:degradation', (data, meta) => this._onDegradation(data, meta))
    );
    _log.info('ServiceRecovery active — listening for health:degradation');
  }

  stop() {
    for (const unsub of this._unsubs) {
      if (typeof unsub === 'function') unsub();
    }
    this._unsubs.length = 0;
  }

  // ── Core Recovery Logic ────────────────────────────────

  /**
   * Handle a degradation event.
   * @param {{ service: string, level: string, reason: string }} data
   * @param {*} [meta]
   */
  async _onDegradation(data, meta) {
    const { service, level, reason } = data;

    // Only act on critical or degraded — not info
    if (level !== 'critical' && level !== 'degraded') return;

    // Skip non-recoverable services
    if (SKIP_SERVICES.has(service)) return;

    // Check circuit breaker
    if (this._isExhausted(service)) return;

    // Classify and recover
    const strategy = this._classifyStrategy(service);
    _log.info(`Recovery attempt: ${service} (${strategy}) — reason: ${reason}`);

    this.stats.attempted++;
    this._recordAttempt(service);

    try {
      await this._executeStrategy(service, strategy);

      // Verify recovery
      const healthy = await this._verifyHealth(service);

      if (healthy) {
        this.stats.succeeded++;
        _log.info(`Recovery succeeded: ${service}`);
        this.bus.emit('health:recovery', {
          service,
          strategy,
          reason,
          attemptsUsed: this._getAttemptCount(service),
        }, { source: 'ServiceRecovery' });
      } else {
        throw new Error('Health check failed after recovery');
      }
    } catch (err) {
      this.stats.failed++;
      const msg = err instanceof Error ? err.message : String(err);
      _log.warn(`Recovery failed: ${service} — ${msg}`);

      this.bus.emit('health:recovery-failed', {
        service,
        strategy,
        reason,
        error: msg,
        attemptsRemaining: MAX_RETRIES - this._getAttemptCount(service),
      }, { source: 'ServiceRecovery' });

      // Check if exhausted after this failure
      if (this._isExhausted(service)) {
        this.stats.exhausted++;
        _log.warn(`Recovery exhausted: ${service} — ${MAX_RETRIES} attempts in ${WINDOW_MS / 60_000}min window`);
        this.bus.emit('health:recovery-exhausted', {
          service,
          totalAttempts: MAX_RETRIES,
        }, { source: 'ServiceRecovery' });
      }
    }
  }

  // ── Strategy Classification ────────────────────────────

  /**
   * Determine recovery strategy for a service.
   * @param {string} service
   * @returns {'reinit'|'restart'|'reset'|'skip'}
   */
  _classifyStrategy(service) {
    if (SKIP_SERVICES.has(service)) return 'skip';
    if (REINIT_SERVICES.has(service)) return 'reinit';

    // Check if service instance has reset()
    const instance = this._resolveService(service);
    if (instance && typeof instance.reset === 'function') return 'reset';
    if (instance && typeof instance.asyncLoad === 'function') return 'reinit';

    return 'restart';
  }

  /**
   * Execute the chosen recovery strategy.
   * @param {string} service
   * @param {'reinit'|'restart'|'reset'|'skip'} strategy
   */
  async _executeStrategy(service, strategy) {
    const instance = this._resolveService(service);
    if (!instance && strategy !== 'restart') {
      throw new Error(`Service ${service} not found in container`);
    }

    switch (strategy) {
      case 'reinit':
        if (typeof instance.asyncLoad === 'function') {
          await instance.asyncLoad();
        } else {
          throw new Error(`${service} has no asyncLoad()`);
        }
        break;

      case 'reset':
        if (typeof instance.reset === 'function') {
          await instance.reset();
        } else {
          throw new Error(`${service} has no reset()`);
        }
        break;

      case 'restart':
        if (!this.container) throw new Error('No container — cannot restart');
        // Stop if possible
        if (instance && typeof instance.stop === 'function') {
          try { instance.stop(); } catch { /* best effort */ }
        }
        // Delete from resolved cache → forces re-creation on next resolve
        if (this.container.resolved) {
          this.container.resolved.delete(service);
        }
        // Re-resolve triggers factory
        const newInstance = this.container.resolve(service);
        // Re-wire late bindings
        if (this.container.wireLateBindings) {
          this.container.wireLateBindings();
        }
        // Boot if available
        if (newInstance && typeof newInstance.asyncLoad === 'function') {
          await newInstance.asyncLoad();
        }
        if (newInstance && typeof newInstance.boot === 'function') {
          newInstance.boot();
        }
        break;

      case 'skip':
        throw new Error(`${service} is not recoverable`);

      default:
        throw new Error(`Unknown strategy: ${strategy}`);
    }
  }

  // ── Circuit Breaker ────────────────────────────────────

  /**
   * Record a recovery attempt with timestamp.
   * @param {string} service
   */
  _recordAttempt(service) {
    if (!this._tracker.has(service)) {
      this._tracker.set(service, { attempts: [], lastStrategy: '', exhausted: false });
    }
    const entry = /** @type {{ attempts: number[], lastStrategy: string, exhausted: boolean }} */ (this._tracker.get(service));
    entry.attempts.push(Date.now());
    // Prune old attempts outside window
    const cutoff = Date.now() - WINDOW_MS;
    entry.attempts = entry.attempts.filter(t => t > cutoff);
  }

  /**
   * Get attempt count within current window.
   * @param {string} service
   * @returns {number}
   */
  _getAttemptCount(service) {
    const entry = this._tracker.get(service);
    if (!entry) return 0;
    const cutoff = Date.now() - WINDOW_MS;
    return entry.attempts.filter(t => t > cutoff).length;
  }

  /**
   * Check if recovery attempts are exhausted.
   * @param {string} service
   * @returns {boolean}
   */
  _isExhausted(service) {
    return this._getAttemptCount(service) >= MAX_RETRIES;
  }

  // ── Health Verification ────────────────────────────────

  /**
   * Verify a service is healthy after recovery.
   * @param {string} service
   * @returns {Promise<boolean>}
   */
  async _verifyHealth(service) {
    const instance = this._resolveService(service);
    if (!instance) return false;

    // Check if service has a health() or getHealth() method
    if (typeof instance.getHealth === 'function') {
      const health = await instance.getHealth();
      return health && health.status !== 'critical';
    }

    // Fallback: service exists and didn't throw during recovery
    return true;
  }

  // ── Helpers ────────────────────────────────────────────

  /**
   * Resolve a service from the container safely.
   * @param {string} service
   * @returns {*}
   */
  _resolveService(service) {
    if (!this.container) return null;
    try {
      return this.container.tryResolve
        ? this.container.tryResolve(service, null)
        : this.container.resolve(service);
    } catch { return null; }
  }

  /**
   * Get recovery stats and tracker state.
   * @returns {object}
   */
  getStats() {
    const services = {};
    for (const [name, entry] of this._tracker) {
      services[name] = {
        attempts: this._getAttemptCount(name),
        exhausted: this._isExhausted(name),
      };
    }
    return { ...this.stats, services };
  }
}

module.exports = { ServiceRecovery };
