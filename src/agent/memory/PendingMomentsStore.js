// GENESIS — memory/PendingMomentsStore.js (v7.3.7)
// ═══════════════════════════════════════════════════════════════
// Holds episodes Genesis (or the user) marked as "potentially
// significant" via the mark-moment tool. Reviewed in the next
// DreamCycle Phase 1.5 with KEEP / ELEVATE / LET_FADE.
//
// Lifecycle of a moment:
//   1. mark()        → status='pending', stored
//   2. Reviewed in DreamCycle Phase 1.5 (max 5 per cycle)
//      → markReviewed(id, 'elevate'|'let_fade'|'keep')
//   3. Expired (>7 days unreviewed)
//      → markExpired(id), logged to journal
//
// DESIGN DECISIONS (v7.3.7 spec Sektion 11):
//   - JSONL append for crash robustness, full rewrite on update
//     (file is small — only pending pins, no archive)
//   - 7-day expiry so unreviewed pins don't pile up forever
//   - Clock-injected (Principle 0.3)
//   - Status: pending | reviewed | expired
// ═══════════════════════════════════════════════════════════════

'use strict';

const fs = require('fs');
const path = require('path');
const { createLogger } = require('../core/Logger');
const _log = createLogger('PendingMomentsStore');

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const VALID_STATUSES = new Set(['pending', 'reviewed', 'expired']);

class PendingMomentsStore {
  /**
   * @param {object} opts
   * @param {object} opts.bus
   * @param {string} opts.storageDir - .genesis directory root
   * @param {{ now: () => number }} [opts.clock]
   */
  constructor({ bus, storageDir, clock = Date }) {
    if (!storageDir) throw new Error('PendingMomentsStore requires storageDir');
    this.bus = bus || { emit: () => {} };
    this._clock = clock;
    this.file = path.join(storageDir, 'pending-moments.jsonl');
    this._moments = [];
    this._counter = 0;
    this._load();
  }

  // ── Lifecycle ─────────────────────────────────────────────

  async asyncLoad() { /* loaded in constructor */ }
  start() { /* no background work */ }
  stop() { this._persist(); }

  // ── Internal: load + persist ──────────────────────────────

  _load() {
    if (!fs.existsSync(this.file)) return;
    let raw;
    try { raw = fs.readFileSync(this.file, 'utf8'); }
    catch (e) {
      _log.warn(`[PENDING] read failed (${this.file}):`, e.message);
      return;
    }
    const lines = raw.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const m = JSON.parse(line);
        if (m && m.id) {
          this._moments.push(m);
          // Restore counter to the highest seen suffix (so new IDs don't collide)
          const match = /_(\d+)$/.exec(m.id);
          if (match) {
            const n = parseInt(match[1], 10);
            if (Number.isFinite(n) && n > this._counter) this._counter = n;
          }
        }
      } catch {
        // skip corrupt line
      }
    }
  }

  _persist() {
    try {
      const body = this._moments.map(m => JSON.stringify(m)).join('\n');
      fs.writeFileSync(this.file, body + (body ? '\n' : ''));
    } catch (e) {
      _log.error('[PENDING] persist failed:', e.message);
    }
  }

  // ── Public API: mark ──────────────────────────────────────

  /**
   * Mark an episode as a pending moment for later review.
   *
   * @param {object} opts
   * @param {string} opts.episodeId
   * @param {string} [opts.summary]
   * @param {string} [opts.triggerContext='self-marked']
   * @returns {string|null} moment ID or null on invalid input
   */
  mark({ episodeId, summary, triggerContext = 'self-marked' } = {}) {
    if (!episodeId) {
      _log.warn('[PENDING] mark() called without episodeId');
      return null;
    }
    this._counter++;
    const now = this._clock.now();
    const id = `pm_${now}_${this._counter}`;
    const record = {
      id,
      episodeId,
      summary: typeof summary === 'string' ? summary.slice(0, 200) : '',
      triggerContext,
      pinnedAt: new Date(now).toISOString(),
      status: 'pending',
      reviewedAs: null,
    };
    this._moments.push(record);
    this._persist();

    this.bus.emit('memory:marked', {
      id,
      episodeId,
      timestamp: record.pinnedAt,
      triggerContext,
    }, { source: 'PendingMomentsStore' });

    return id;
  }

  // ── Public API: query ─────────────────────────────────────

  /** All pending (not reviewed/expired) moments. */
  getAll() { return this._moments.filter(m => m.status === 'pending'); }

  /** Count of pending moments. */
  getCount() { return this.getAll().length; }

  /** Get moment by ID (any status). */
  getById(id) { return this._moments.find(m => m.id === id) || null; }

  // ── Public API: state transitions ─────────────────────────

  /**
   * Mark a moment as reviewed with a decision.
   *
   * @param {string} id
   * @param {'elevate'|'let_fade'|'keep'} decision
   * @returns {boolean} true on success
   */
  markReviewed(id, decision) {
    const m = this.getById(id);
    if (!m) return false;
    if (m.status !== 'pending') return false;
    m.status = 'reviewed';
    m.reviewedAs = decision;
    m.reviewedAt = new Date(this._clock.now()).toISOString();
    this._persist();
    return true;
  }

  /**
   * Mark a moment as expired (>7d unreviewed). Logged separately
   * by the caller (DreamCycle writes a journal entry).
   *
   * @param {string} id
   * @returns {boolean} true on success
   */
  markExpired(id) {
    const m = this.getById(id);
    if (!m) return false;
    if (m.status !== 'pending') return false;
    m.status = 'expired';
    m.expiredAt = new Date(this._clock.now()).toISOString();
    this._persist();
    return true;
  }

  /**
   * Helper for DreamCycle: which pending moments are past expiry?
   * @returns {object[]}
   */
  getExpiredCandidates() {
    const now = this._clock.now();
    return this.getAll().filter(m => {
      const ageMs = now - new Date(m.pinnedAt).getTime();
      return ageMs > MAX_AGE_MS;
    });
  }

  // ── Diagnostics ───────────────────────────────────────────

  getReport() {
    const counts = { pending: 0, reviewed: 0, expired: 0 };
    for (const m of this._moments) {
      if (VALID_STATUSES.has(m.status)) counts[m.status]++;
    }
    return { total: this._moments.length, ...counts };
  }
}

module.exports = { PendingMomentsStore };
