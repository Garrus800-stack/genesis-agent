/**
 * ConsciousnessState.js
 * ─────────────────────
 * Finite state machine for consciousness modes.
 *
 * States:
 *   AWAKE          → Normal waking consciousness
 *   DAYDREAM       → Low cognitive load, peripheral reflection
 *   DEEP_SLEEP     → Full dream consolidation cycle
 *   HYPERVIGILANT  → Maximum alertness, all channels active
 *
 * Valid transitions:
 *   AWAKE → DAYDREAM, DEEP_SLEEP, HYPERVIGILANT
 *   DAYDREAM → AWAKE, DEEP_SLEEP
 *   DEEP_SLEEP → AWAKE
 *   HYPERVIGILANT → AWAKE
 *
 * @version 1.0.0
 */

'use strict';

const VALID_STATES = new Set(['AWAKE', 'DAYDREAM', 'DEEP_SLEEP', 'HYPERVIGILANT']);

const VALID_TRANSITIONS = {
  'AWAKE':          new Set(['DAYDREAM', 'DEEP_SLEEP', 'HYPERVIGILANT']),
  'DAYDREAM':       new Set(['AWAKE', 'DEEP_SLEEP']),
  'DEEP_SLEEP':     new Set(['AWAKE']),
  'HYPERVIGILANT':  new Set(['AWAKE']),
};

class ConsciousnessState {

  constructor() {
    /** @type {string} Current state */
    this.current   = 'AWAKE';

    /** @type {string|null} Previous state */
    this.previous  = null;

    /** @type {number} Timestamp when current state was entered */
    this.enteredAt = Date.now();

    /** @type {Array<Object>} State transition history */
    this._history  = [];

    /** @type {number} Max history entries */
    this._maxHistory = 100;
  }

  /**
   * Transition to a new state.
   *
   * @param {string} newState
   * @returns {boolean} Whether the transition was valid and executed
   */
  transition(newState) {
    if (!VALID_STATES.has(newState)) {
      return false;
    }

    if (newState === this.current) {
      return true; // Already in this state
    }

    const allowedTransitions = VALID_TRANSITIONS[this.current];
    if (!allowedTransitions || !allowedTransitions.has(newState)) {
      return false;
    }

    const now = Date.now();

    this._history.push({
      from:      this.current,
      to:        newState,
      timestamp: now,
      duration:  now - this.enteredAt,
    });

    if (this._history.length > this._maxHistory) {
      this._history = this._history.slice(-50);
    }

    this.previous  = this.current;
    this.current   = newState;
    this.enteredAt = now;

    return true;
  }

  /**
   * Get time spent in current state (ms).
   * @returns {number}
   */
  getTimeInState() {
    return Date.now() - this.enteredAt;
  }

  /**
   * Get recent transition history.
   * @param {number} [count=10]
   * @returns {Array<Object>}
   */
  getHistory(count = 10) {
    return this._history.slice(-count);
  }

  /**
   * Get statistics about state durations.
   * @returns {Object}
   */
  getStats() {
    const stats = {};
    for (const state of VALID_STATES) {
      stats[state] = { totalTime: 0, transitionCount: 0 };
    }

    for (const entry of this._history) {
      if (stats[entry.from]) {
        stats[entry.from].totalTime += entry.duration;
        stats[entry.from].transitionCount++;
      }
    }

    return stats;
  }

  // ═══════════════════════════════════════════════════════════════
  // SERIALIZATION
  // ═══════════════════════════════════════════════════════════════

  serialize() {
    return {
      current:   this.current,
      previous:  this.previous,
      enteredAt: this.enteredAt,
      history:   this._history.slice(-20),
    };
  }

  deserialize(data) {
    if (!data) return;
    this.current   = VALID_STATES.has(data.current) ? data.current : 'AWAKE';
    this.previous  = data.previous || null;
    this.enteredAt = data.enteredAt || Date.now();
    this._history  = data.history || [];
  }
}

module.exports = ConsciousnessState;
