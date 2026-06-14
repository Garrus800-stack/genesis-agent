// ============================================================
// GENESIS — autonomy/IdleMindStatus.js (v7.9.22)
//
// Status and runtime-snapshot reads of instance state,
// extracted from IdleMind.js for the File Size Guard (Item 15).
// All state is initialised by IdleMind's constructor; this mixin
// is pure behaviour joined onto the prototype.
// ============================================================
'use strict';

const fs = require('fs');
const { createLogger } = require('../core/Logger');
const _log = createLogger('IdleMind');

const statusMixin = {
  getStatus() {
    let journalCount = 0;
    try {
      const raw = this.storage
        ? this.storage.readText('journal.jsonl', '')
        : (fs.existsSync(this.journalPath) ? fs.readFileSync(this.journalPath, 'utf-8') : '');
      journalCount = raw.split('\n').filter(Boolean).length;
    } catch (err) { _log.debug('[IDLE-MIND] Journal write error:', err.message); }
    return {
      running: this.running,
      idleSince: Date.now() - this.lastUserActivity,
      isIdle: (Date.now() - this.lastUserActivity) >= this.idleThreshold,
      thoughtCount: this.thoughtCount,
      recentActivities: this.activityLog.slice(-5),
      // v7.9.1: per-type aggregation for the Insights Timeline renderer.
      activityCounts: Object.fromEntries(this._activityCounts || []),
      plans: this.plans.length,
      activeGoals: this.goalStack ? this.goalStack.getActiveGoals().length : 0,
      totalGoals: this.goalStack ? this.goalStack.getAll().length : 0,
      journalEntries: journalCount,
    };
  },

  /**
   * v7.4.0: Runtime snapshot for RuntimeStatePort.
   *
   * CRITICAL: I/O-free by design. This is NOT a wrapper around
   * getStatus() — getStatus() does fs.readFileSync on journal.jsonl
   * at every call, which would block the prompt-build path with
   * disk-I/O. getRuntimeSnapshot() reads only in-memory fields.
   *
   * The LLM sees the latest activity from activityLog (already in
   * RAM, bounded) and minutesIdle (computed from lastUserActivity
   * which is updated on every event). journal line-count is
   * intentionally omitted — if the LLM needs it, a separate tool
   * call can fetch it.
   */
  getRuntimeSnapshot() {
    const now = Date.now();
    const idleMs = now - this.lastUserActivity;
    const minutesIdle = Math.floor(idleMs / 60000);
    // Latest activity (if any). activityLog is in-memory, bounded.
    let currentActivity = null;
    let lastActivityAgo = null;
    if (this.activityLog.length > 0) {
      const last = this.activityLog[this.activityLog.length - 1];
      currentActivity = last.activity || null;
      lastActivityAgo = Math.floor((now - last.timestamp) / 1000);
    }
    return {
      running: this.running,
      isIdle: idleMs >= this.idleThreshold,
      minutesIdle,
      thoughtCount: this.thoughtCount,
      currentActivity,
      lastActivityAgoSeconds: lastActivityAgo,
    };
  },
};

module.exports = { statusMixin };
