// @ts-checked-v5.6
// ============================================================
// GENESIS AGENT — CircuitBreaker.js (moved to core/ in v5.2.0)
// Resilience pattern. Prevents cascade failures when
// external services (LLM, MCP, Peers) are down.
//
// v5.2.0: Moved from intelligence/ to core/ — used by 5+ layers
// (autonomy, hexagonal, capabilities, organism, intelligence).
// Zero layer-specific dependencies (only EventBus + Logger).
//
// States: CLOSED (normal) → OPEN (failing) → HALF-OPEN (testing)
// ============================================================

const { NullBus } = require('./EventBus');
const { createLogger } = require('./Logger');
const _log = createLogger('CircuitBreaker');

class CircuitBreaker {
  /**
   * @param {object} [config]
   * @param {string} [config.name] - Identifier for this breaker
   * @param {number} [config.failureThreshold] - Failures before opening (default: 3)
   * @param {number} [config.cooldownMs] - Time in OPEN before trying HALF-OPEN (default: 30s)
   * @param {number} [config.timeoutMs] - Max time per call before counting as failure (default: 15s)
   * @param {number} [config.maxRetries] - Retries before counting as failure (default: 2)
   * @param {number} [config.retryDelayMs] - Delay between retries (default: 1s)
   * @param {Function} [config.fallback] - Fallback function when circuit is OPEN
   * @param {*} [config.bus] - Optional EventBus override
   * @param {*} [bus] - EventBus (legacy positional)
   */
  constructor(config = {}, bus) {
    this.bus = config.bus || bus || NullBus;
    this.name = config.name || 'default';
    this.failureThreshold = config.failureThreshold || 3;
    this.cooldownMs = config.cooldownMs || 30000;
    this.timeoutMs = config.timeoutMs || 15000;
    this.maxRetries = config.maxRetries ?? 2;
    this.retryDelayMs = config.retryDelayMs ?? 1000;
    this.fallback = config.fallback || null;

    // State
    this.state = 'CLOSED';    // CLOSED | OPEN | HALF_OPEN
    this.failures = 0;
    this.successes = 0;
    this.lastFailure = null;
    this.lastSuccess = null;
    this.openedAt = null;

    // Stats
    this.stats = {
      totalCalls: 0,
      totalFailures: 0,
      totalSuccesses: 0,
      totalFallbacks: 0,
      /** @type {Array<{from: string, to: string, at: string}>} */
      stateChanges: [],
    };
  }

  /**
   * Execute a function through the circuit breaker
   * @param {Function} fn - Async function to execute
   * @param {...*} args - Arguments to pass
   * @returns {Promise<*>} Result from fn or fallback
   */
  async execute(fn, ...args) {
    this.stats.totalCalls++;

    // If OPEN, check if cooldown elapsed
    if (this.state === 'OPEN') {
      if (Date.now() - (this.openedAt || 0) >= this.cooldownMs) {
        this._transition('HALF_OPEN');
      } else {
        // Circuit is open — use fallback or throw
        return this._handleOpen(args);
      }
    }

    // Try to execute with retry logic
    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const result = await this._executeWithTimeout(fn, args);
        this._onSuccess();
        return result;
      } catch (err) {
        lastError = err;
        if (attempt < this.maxRetries) {
          await this._delay(this.retryDelayMs * (attempt + 1)); // Exponential-ish backoff
        }
      }
    }

    // All retries exhausted
    this._onFailure(lastError);

    // If circuit just opened, try fallback
    if (this.state === 'OPEN' && this.fallback) {
      return this._handleOpen(args);
    }

    throw lastError;
  }

  /**
   * Execute fn with a timeout wrapper
   */
  async _executeWithTimeout(fn, args) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Circuit ${this.name}: Timeout nach ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      Promise.resolve(fn(...args))
        .then(result => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch(err => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  _onSuccess() {
    this.failures = 0;
    this.successes++;
    this.lastSuccess = Date.now();
    this.stats.totalSuccesses++;

    if (this.state === 'HALF_OPEN') {
      this._transition('CLOSED');
    }
  }

  _onFailure(error) {
    this.failures++;
    this.lastFailure = Date.now();
    this.stats.totalFailures++;

    if (this.state === 'HALF_OPEN') {
      // Failed during test — back to OPEN
      this._transition('OPEN');
    } else if (this.failures >= this.failureThreshold) {
      this._transition('OPEN');
    }
  }

  async _handleOpen(args) {
    if (this.fallback) {
      this.stats.totalFallbacks++;
      this.bus.emit('circuit:fallback', { name: this.name }, { source: 'CircuitBreaker' });
      return await this.fallback(...args);
    }
    throw new Error(`Circuit ${this.name} is OPEN. Service unavailable.`);
  }

  _transition(newState) {
    const oldState = this.state;
    this.state = newState;

    if (newState === 'OPEN') {
      this.openedAt = Date.now();
    }
    if (newState === 'CLOSED') {
      this.failures = 0;
    }

    this.stats.stateChanges.push({
      from: oldState,
      to: newState,
      at: new Date().toISOString(),
    });

    // Keep only last 20 state changes
    if (this.stats.stateChanges.length > 20) {
      this.stats.stateChanges = this.stats.stateChanges.slice(-20);
    }

    this.bus.emit('circuit:state-change', {
      name: this.name,
      from: oldState,
      to: newState,
    }, { source: 'CircuitBreaker' });

    _log.info(`[CIRCUIT:${this.name}] ${oldState} -> ${newState}`);
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /** Force circuit closed (manual recovery) */
  reset() {
    this._transition('CLOSED');
    this.failures = 0;
  }

  /** Get current status */
  getStatus() {
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      lastFailure: this.lastFailure,
      lastSuccess: this.lastSuccess,
      stats: { ...this.stats },
    };
  }
}

module.exports = { CircuitBreaker };
