// @ts-checked-v5.7
// ============================================================
// GENESIS — EventCounter.js (v7.9.16 Phase 9)
//
// Passive observer that records significant runtime events to an
// append-only journal, so SelfTrajectory can fill the per-cycle
// `event_count` field and the dashboard can show the real per-day
// distribution. This is the observation phase of SelfTrajectory:
// no triggers, no thresholds — the counter only watches and records,
// so a non-arbitrary significance threshold can later be derived from
// the actual distribution under real use.
//
// Observed events (each a distinct type-tag in the journal line):
//   - goal:completed        → a goal/plan closed successfully
//   - goal:failed           → a goal pursuit failed
//   - goal:abandoned        → a goal was abandoned
//   - lessons:recorded      → a lesson was learned
//   - emotion:watchdog-reset→ the emotional watchdog reset a runaway state
//   - emotion:watchdog-alert→ the emotional watchdog raised an alert
//   - session:ending        → a session ended (carries durationMs)
//
// The three goal outcomes stay as three separate tags (not one
// "outcome" bucket) so the per-tag dashboard shows the success-vs-
// failure balance, one of the most interesting quantities for cycle
// interpretation. planner:complete is intentionally NOT observed — it
// fires at plan construction, not completion.
//
// Persistence: one line `{ts, type}` per event via storage.appendText,
// which is synchronous and fsync'd — durable before return, no debounce
// window, so a crash / SIGKILL / uncaughtException never loses a counted
// event. There is no in-memory counter: countSince()/summary() read the
// journal on demand (a few hundred tiny lines over weeks — a trivial
// scan), so the count is always consistent with disk and there is no
// boot-rebuild and no cache-invalidation risk.
//
// Dependency is one-way: the caller supplies the cycle boundary
// (SelfTrajectory.commit passes the previous entry's wallclock_end; the
// dashboard reads it from SelfTrajectory). EventCounter itself needs only
// the storage service and never references SelfTrajectory.
//
// Design notes:
//   - Additive — never modifies bus payloads, never blocks other
//     listeners. Single direction: events in, journal line out.
//   - Record failures are caught and logged, never propagated.
//   - Uses applySubscriptionHelper so the listener-lifecycle audit
//     recognises the start/stop subscription pair.
// ============================================================

'use strict';

const { createLogger } = require('../core/Logger');
const { applySubscriptionHelper } = require('../core/subscription-helper');
const _log = createLogger('EventCounter');

const JOURNAL_FILE = 'self-trajectory-events.jsonl';

// The significant-event types this counter observes. Each maps to a
// distinct type-tag in the journal line.
const COUNTED_EVENTS = Object.freeze([
  'goal:completed',
  'goal:failed',
  'goal:abandoned',
  'lessons:recorded',
  'emotion:watchdog-reset',
  'emotion:watchdog-alert',
  'session:ending',
]);

class EventCounter {
  /**
   * @param {{
   *   bus: any,
   *   storage: any,
   *   clock?: { now: () => number },
   * }} services
   */
  constructor({ bus, storage, clock = Date } = {}) {
    if (!storage) throw new Error('EventCounter requires a storage service');
    this.bus = bus;
    this.storage = storage;
    this._clock = clock;
    /** @type {Function[]} */ this._unsubs = [];  // applySubscriptionHelper uses this
    this._running = false;
  }

  start() {
    if (this._running) return;
    if (!this.bus || typeof this.bus.on !== 'function') return;
    this._running = true;

    // applySubscriptionHelper provides this._sub() / this._unsubAll()
    // which the listener-lifecycle audit recognises.
    for (const evt of COUNTED_EVENTS) {
      this._sub(evt, (data) => this._record(evt, data));
    }

    _log.info(`[EVENT-COUNTER] active — observing ${COUNTED_EVENTS.length} significant-event types`);
  }

  stop() {
    if (typeof this._unsubAll === 'function') this._unsubAll();
    this._running = false;
  }

  /**
   * Append one journal line per observed event. Durable before return
   * (appendText is fsync'd). session:ending carries durationMs so the
   * >Xmin significance can be applied at analysis time rather than baked
   * into a counting gate. Failures are caught and never propagated.
   * @param {string} type
   * @param {*} data
   */
  _record(type, data) {
    try {
      /** @type {{ ts: string, type: string, durationMs?: number }} */
      const line = { ts: new Date(this._clock.now()).toISOString(), type };
      if (type === 'session:ending' && data && typeof data.durationMs === 'number') {
        line.durationMs = data.durationMs;
      }
      this.storage.appendText(JOURNAL_FILE, JSON.stringify(line) + '\n');
    } catch (e) {
      _log.debug('[EVENT-COUNTER] record error (ignored):', e && e.message);
    }
  }

  /**
   * Read the event journal, returning every recorded line as a parsed
   * object. Corrupt/partial lines are skipped (defensive). On-demand —
   * no in-memory state, so always consistent with disk.
   * @returns {Array<{ts: string, type: string, durationMs?: number}>}
   * @private
   */
  _readJournal() {
    const raw = this.storage.readText(JOURNAL_FILE, '');
    if (!raw) return [];
    const out = [];
    for (const ln of raw.split('\n')) {
      const s = ln.trim();
      if (!s) continue;
      try { out.push(JSON.parse(s)); } catch (_e) { /* skip partial/corrupt line */ }
    }
    return out;
  }

  /**
   * Count significant events with ts strictly after `since` (half-open
   * window: ts > since). `since` is the wallclock_end of the last
   * committed trajectory entry; the caller supplies it. null/undefined →
   * count all recorded events (the first cycle, before any entry exists).
   * @param {string|null} [since] ISO timestamp, or null for "all".
   * @returns {number}
   */
  countSince(since = null) {
    const sinceTs = since ? Date.parse(since) : null;
    let n = 0;
    for (const e of this._readJournal()) {
      if (sinceTs === null) { n++; continue; }
      const t = Date.parse(e.ts);
      if (Number.isFinite(t) && t > sinceTs) n++;
    }
    return n;
  }

  /**
   * Composition for the dashboard: total, per-type counts, and per-day
   * counts (bucketed by the date part of ts). Optional `since` applies
   * the same half-open window as countSince; omitted → whole journal.
   * Readable from the moment the counter is live (the per-day buckets do
   * not depend on any trajectory entry having been committed).
   * @param {string|null} [since]
   * @returns {{ total: number, byType: Record<string, number>, byDay: Record<string, number> }}
   */
  summary(since = null) {
    const sinceTs = since ? Date.parse(since) : null;
    /** @type {Record<string, number>} */ const byType = {};
    /** @type {Record<string, number>} */ const byDay = {};
    let total = 0;
    for (const e of this._readJournal()) {
      if (sinceTs !== null) {
        const t = Date.parse(e.ts);
        if (!(Number.isFinite(t) && t > sinceTs)) continue;
      }
      total++;
      byType[e.type] = (byType[e.type] || 0) + 1;
      const day = typeof e.ts === 'string' ? e.ts.slice(0, 10) : 'unknown';
      byDay[day] = (byDay[day] || 0) + 1;
    }
    return { total, byType, byDay };
  }

  /**
   * Bounded-window composition for cycle-vs-cycle comparison (v7.9.17).
   * Counts events in the half-open window (since, until]: ts > since AND
   * ts <= until. The lower bound is exclusive to match countSince/summary
   * (so a cycle boundary's own event is not double-counted between two
   * adjacent cycles); the upper bound is inclusive so an entry's
   * wallclock_end belongs to the cycle that ends there. `since` null →
   * no lower bound (counts from the start of the journal); `until` null →
   * no upper bound (equivalent window to summary(since), but kept as its
   * own implementation — summary(since) is behaviour-pinned by the
   * v7.9.16 test corpus and is not aliased here).
   * @param {string|null} [since] ISO timestamp, exclusive lower bound.
   * @param {string|null} [until] ISO timestamp, inclusive upper bound.
   * @returns {{ total: number, byType: Record<string, number>, byDay: Record<string, number> }}
   */
  summaryBetween(since = null, until = null) {
    const sinceTs = since ? Date.parse(since) : null;
    const untilTs = until ? Date.parse(until) : null;
    /** @type {Record<string, number>} */ const byType = {};
    /** @type {Record<string, number>} */ const byDay = {};
    let total = 0;
    for (const e of this._readJournal()) {
      const t = Date.parse(e.ts);
      if (!Number.isFinite(t)) continue;
      if (sinceTs !== null && !(t > sinceTs)) continue;
      if (untilTs !== null && !(t <= untilTs)) continue;
      total++;
      byType[e.type] = (byType[e.type] || 0) + 1;
      const day = typeof e.ts === 'string' ? e.ts.slice(0, 10) : 'unknown';
      byDay[day] = (byDay[day] || 0) + 1;
    }
    return { total, byType, byDay };
  }
}

applySubscriptionHelper(EventCounter, { defaultSource: 'EventCounter' });

module.exports = { EventCounter, COUNTED_EVENTS, JOURNAL_FILE };
