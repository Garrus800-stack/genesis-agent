// GENESIS — ports/ActiveReferencesPort.js (v7.3.7)
// ═══════════════════════════════════════════════════════════════
// Prevents races between DreamCycle (consolidates episodes in
// the background) and ChatOrchestrator (reads episodes for the
// current prompt). Any episode claimed by an active turn is
// skipped by DreamCycle until the turn releases it.
//
// DESIGN DECISIONS (from v7.3.7 spec):
//   - Turn-based (not timer-based): ChatOrchestrator calls
//     releaseTurn(turnId) when chat:completed fires. No drift.
//   - Clock-injected (Principle 0.3): deterministic tests.
//   - Idempotent claim: re-claiming within the same turn just
//     refreshes the timestamp, no errors, no duplicate entries.
//   - Self-expiring via TTL: entries stale beyond TTL are swept
//     on read. Defense against missed releaseTurn (e.g. crash).
//   - Public API only — no private-state grabbing across DI.
//
// USAGE:
//   ChatOrchestrator:
//     activeRefs.claim(episodeId, traceId)          // per access
//     activeRefs.releaseTurn(traceId)               // on chat:completed
//
//   DreamCycle:
//     if (activeRefs.isActive(episodeId)) continue;
// ═══════════════════════════════════════════════════════════════

'use strict';

const { createLogger } = require('../core/Logger');
const _log = createLogger('ActiveReferencesPort');

const DEFAULT_TTL_MS = 10 * 60 * 1000;  // 10 minutes

class ActiveReferencesPort {
  /**
   * @param {object} [opts]
   * @param {{ now: () => number }} [opts.clock] - Injectable clock (default: Date)
   */
  constructor({ clock = Date } = {}) {
    this._clock = clock;
    /** @type {Map<string, { turnId: string, claimedAt: number, ttlMs: number }>} */
    this._refs = new Map();
  }

  // ── Lifecycle ─────────────────────────────────────────────

  async asyncLoad() { /* nothing to load */ }
  start() { /* nothing to start */ }
  stop() { this._refs.clear(); }

  // ── Core API ──────────────────────────────────────────────

  /**
   * Claim an episode as actively referenced in the current turn.
   * Idempotent: a repeated claim within the same turn refreshes
   * the timestamp; a claim from a different turn overwrites.
   *
   * @param {string} episodeId
   * @param {string} turnId
   * @param {number} [ttlMs]
   */
  claim(episodeId, turnId, ttlMs = DEFAULT_TTL_MS) {
    if (!episodeId || !turnId) return;
    this._refs.set(episodeId, {
      turnId,
      claimedAt: this._clock.now(),
      ttlMs,
    });
  }

  /**
   * Check whether an episode is currently claimed.
   * Auto-expires stale entries beyond TTL.
   *
   * @param {string} episodeId
   * @returns {boolean}
   */
  isActive(episodeId) {
    if (!episodeId) return false;
    const r = this._refs.get(episodeId);
    if (!r) return false;
    if (this._clock.now() - r.claimedAt > r.ttlMs) {
      this._refs.delete(episodeId);
      return false;
    }
    return true;
  }

  /**
   * Release all references claimed under a specific turnId.
   * Called when chat:completed fires for that turn.
   *
   * @param {string} turnId
   * @returns {number} number of references released
   */
  releaseTurn(turnId) {
    if (!turnId) return 0;
    let released = 0;
    for (const [id, r] of this._refs) {
      if (r.turnId === turnId) {
        this._refs.delete(id);
        released++;
      }
    }
    return released;
  }

  // ── Maintenance ───────────────────────────────────────────

  /**
   * Remove expired entries regardless of turn. Can be called
   * periodically by a maintenance interval.
   *
   * @returns {number} number of entries swept
   */
  sweep() {
    const now = this._clock.now();
    let removed = 0;
    for (const [id, r] of this._refs) {
      if (now - r.claimedAt > r.ttlMs) {
        this._refs.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /** @returns {number} current number of active claims */
  size() { return this._refs.size; }

  /**
   * Diagnostic snapshot — used by Dashboard/health endpoints.
   * @returns {{ size: number, turns: string[] }}
   */
  getReport() {
    const turns = new Set();
    for (const r of this._refs.values()) turns.add(r.turnId);
    return { size: this._refs.size, turns: Array.from(turns) };
  }
}

module.exports = { ActiveReferencesPort };
