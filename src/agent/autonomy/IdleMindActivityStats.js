// ============================================================
// GENESIS — autonomy/IdleMindActivityStats.js (v7.9.1)
//
// Per-activity-type aggregation mixin extracted from IdleMind.js
// in the v7.9.1 live-fix pass. Holds the small bit of state and
// the recording helper that keeps a running count of how often
// each idle-activity type (ideate, explore, research, plan, …)
// has run during the current session, so the dashboard can
// render a breakdown view instead of only the last five entries.
//
// Why split: IdleMind.js was 698 LOC, and the inline activity-
// counts logic plus its comments pushed it past the 700-LOC
// soft-guard. The recording helper is self-contained (no
// coupling to the think-loop except a single call-site) and
// lives well as a mixin on the IdleMind prototype.
//
// Coupling note: the helper reads/writes
//   this._activityCounts  Map<activityType, count>
//   this.activityLog      Array<{activity, timestamp}> (bounded 20)
// Both are initialised by IdleMind's constructor; the mixin is
// pure behaviour. Counts are session-frisch — reset on restart,
// matching the "this session" expectation of the dashboard view.
//
// Mixed onto IdleMind.prototype at module-load via Object.assign
// — see GoalDriverFailurePolicy.js for the canonical pattern.
// ============================================================

'use strict';

// v7.9.4: persistence file for cross-session activity stats.
// Kept under the same .genesis directory as journal/plans/etc. so a
// project-folder copy carries the full IdleMind history along.
const STATS_FILE = 'idle-activity-stats.json';
const STATS_SCHEMA_VERSION = 1;
// Bound the on-disk log to the same window the in-memory log uses (20).
const STATS_LOG_BOUND = 20;
// Debounce writes to coalesce activity-bursts (a dream cycle may
// schedule several rapid recordActivity calls). 1000ms is short enough
// that a crash within seconds still preserves recent stats, long
// enough to avoid I/O thrash.
const STATS_WRITE_DEBOUNCE_MS = 1000;

const activityStatsMixin = {

  /**
   * Record a completed activity. Pushes to the chronological
   * `activityLog` (bounded to last 20) AND increments the per-type
   * counter in `_activityCounts`. Called from the main think-loop
   * after a successful activity.run().
   *
   * v7.9.4: also schedules a debounced save so the stats survive
   * restarts. Save failures are logged at debug level and never
   * interrupt the think-loop.
   *
   * @param {string} activity - canonical activity name (ideate, explore, …)
   * @param {*} _result - the activity's return value (unused here,
   *   accepted for symmetry with _journal and for future stats)
   */
  _recordActivity(activity, _result) {
    this.activityLog.push({ activity, timestamp: Date.now() });
    if (this.activityLog.length > 20) {
      this.activityLog = this.activityLog.slice(-20);
    }
    if (!this._activityCounts) this._activityCounts = new Map();
    this._activityCounts.set(activity, (this._activityCounts.get(activity) || 0) + 1);
    this._saveActivityStats();
  },

  /**
   * v7.9.4: persist the in-memory activity stats to disk. Debounced via
   * StorageService.writeJSONDebounced so bursts collapse to a single
   * write. No-op if storage isn't available (e.g. in unit tests with
   * storageDir: null).
   */
  _saveActivityStats() {
    if (!this.storage || typeof this.storage.writeJSONDebounced !== 'function') return;
    try {
      const payload = {
        version: STATS_SCHEMA_VERSION,
        lastUpdated: Date.now(),
        // v7.9.11: persist thoughtCount alongside activityCounts. Pre-fix
        // the dashboard showed "0 thoughts · idle 24min" next to stored
        // activity counts in double digits (Garrus's Win field-trace
        // 2026-05-25 showed explore 5 · ideate 5 · reflect 4 · plan 4 ·
        // research 4 = 22 stored activities next to "0 thoughts"). Cause
        // was activityCounts on disk + thoughtCount session-only.
        //
        // Known limitation: thoughtCount is incremented in _think() before
        // skip-checks (user-active <60s, homeostasis-block, low-energy),
        // but _saveActivityStats only fires through _recordActivity after
        // a successful activity run. Skip-cycles therefore increment
        // without persisting — ~9% drift over a typical session. The
        // counter is "grossly accurate", not bookkeeping-precise, which
        // is fine for a dashboard indicator.
        thoughtCount: this.thoughtCount || 0,
        activityCounts: Object.fromEntries(this._activityCounts || []),
        activityLog: (this.activityLog || []).slice(-STATS_LOG_BOUND),
      };
      this.storage.writeJSONDebounced(STATS_FILE, payload, STATS_WRITE_DEBOUNCE_MS);
    } catch (err) {
      // never let persistence failures interrupt the think-loop
      if (typeof this._log?.debug === 'function') {
        this._log.debug('[IDLE-MIND] activity-stats save failed:', err.message);
      }
    }
  },

  /**
   * v7.9.4: restore activity stats from disk. Called from IdleMind
   * constructor after activityLog/activityCounts are initialised to
   * empty defaults. Schema mismatch, missing file, parse error all
   * fall through to empty state — boot must never block on this.
   */
  _loadActivityStats() {
    if (!this.storage || typeof this.storage.readJSON !== 'function') return;
    let data;
    try {
      data = this.storage.readJSON(STATS_FILE, null);
    } catch (err) {
      if (typeof this._log?.debug === 'function') {
        this._log.debug('[IDLE-MIND] activity-stats load failed (starting fresh):', err.message);
      }
      return;
    }
    if (!data || typeof data !== 'object') return;
    if (data.version !== STATS_SCHEMA_VERSION) return; // future-proofing
    if (Array.isArray(data.activityLog)) {
      // defensive: only accept entries that match the expected shape
      this.activityLog = data.activityLog
        .filter(e => e && typeof e.activity === 'string' && Number.isFinite(e.timestamp))
        .slice(-STATS_LOG_BOUND);
    }
    if (data.activityCounts && typeof data.activityCounts === 'object') {
      this._activityCounts = new Map(
        Object.entries(data.activityCounts).filter(([k, v]) => typeof k === 'string' && Number.isFinite(v))
      );
    }
    // v7.9.11: restore persistent thoughtCount. Missing field on legacy
    // stats files (v7.9.10 and earlier) falls back to the sum of
    // activityCounts so users don't restart at zero after upgrade — the
    // sum is a lower bound (skip-cycles weren't counted) but vastly
    // better than the "0 thoughts" dashboard inconsistency that triggered
    // this fix.
    if (Number.isFinite(data.thoughtCount)) {
      this.thoughtCount = data.thoughtCount;
    } else if (this._activityCounts && this._activityCounts.size > 0) {
      this.thoughtCount = Array.from(this._activityCounts.values())
        .reduce((sum, n) => sum + n, 0);
    }
  },

};

module.exports = { activityStatsMixin };
