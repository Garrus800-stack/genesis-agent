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

const activityStatsMixin = {

  /**
   * Record a completed activity. Pushes to the chronological
   * `activityLog` (bounded to last 20) AND increments the per-type
   * counter in `_activityCounts`. Called from the main think-loop
   * after a successful activity.run().
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
  },

};

module.exports = { activityStatsMixin };
