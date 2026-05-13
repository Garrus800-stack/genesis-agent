// ============================================================
// GENESIS — proactiveSelfExpression/StateStore.js (v7.7.9 Phase 2)
//
// Operational state for ProactiveSelfExpression:
//   - lastSelfMessageMs / lastSelfMessageByKindMs (rate limiting)
//   - mutedUntilMs (/quiet)
//   - dailyCount (resets at local midnight)
//   - suppressionLog (last 50 suppressed candidates, surfaced via
//     /proactive-status — Garrus needs to see what Genesis tried to
//     say but didn't get through)
//
// Persistence: single JSON file at .genesis/proactive-self-expression.state.json.
// This is operational state, not authoritative for "did Genesis say X" —
// the chat history is the source of truth for what Genesis actually said.
// ============================================================

'use strict';

const path = require('path');
const fs = require('fs');

const STATE_FILE = 'proactive-self-expression.state.json';
const SUPPRESSION_LOG_MAX = 50;

class StateStore {
  /**
   * @param {object} deps
   * @param {string} [deps.storageDir] — .genesis directory
   * @param {*}      [deps.storage]    — optional Storage service (preferred over fs)
   */
  constructor({ storageDir, storage } = {}) {
    this.storage = storage || null;
    this.storageDir = storageDir || null;
    this._statePath = storageDir ? path.join(storageDir, STATE_FILE) : null;

    this._state = {
      lastSelfMessageMs: null,
      lastSelfMessageByKindMs: {},   // kind → ms
      mutedUntilMs: null,            // null = not muted
      dailyCount: 0,
      dailyDate: null,                // YYYY-MM-DD, for midnight reset
      suppressionLog: [],            // newest at front, capped to MAX
    };

    this._loaded = false;
  }

  /** Load persisted state (best-effort; missing file → defaults). */
  load() {
    if (this._loaded) return;
    this._loaded = true;
    try {
      if (this.storage && typeof this.storage.readJSON === 'function') {
        const data = this.storage.readJSON(STATE_FILE, null);
        if (data && typeof data === 'object') Object.assign(this._state, data);
      } else if (this._statePath && fs.existsSync(this._statePath)) {
        const raw = fs.readFileSync(this._statePath, 'utf-8');
        const data = JSON.parse(raw);
        if (data && typeof data === 'object') Object.assign(this._state, data);
      }
    } catch (_e) { /* defaults remain */ }
    // Ensure shape after load (in case file was older and missed a field).
    if (!this._state.lastSelfMessageByKindMs || typeof this._state.lastSelfMessageByKindMs !== 'object') {
      this._state.lastSelfMessageByKindMs = {};
    }
    if (!Array.isArray(this._state.suppressionLog)) {
      this._state.suppressionLog = [];
    }
  }

  /** Persist state (debounced via Storage if available, else atomic write). */
  save() {
    try {
      if (this.storage && typeof this.storage.writeJSONDebounced === 'function') {
        this.storage.writeJSONDebounced(STATE_FILE, this._state, 1000);
        return;
      }
      if (this._statePath) {
        const dir = path.dirname(this._statePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(this._statePath, JSON.stringify(this._state, null, 2), 'utf-8');
      }
    } catch (_e) { /* state save failure must not break PSE */ }
  }

  // ── Read accessors ────────────────────────────────────────

  /** Roll the daily count over at local midnight. */
  _maybeResetDaily(nowMs = Date.now()) {
    const today = isoDate(nowMs);
    if (this._state.dailyDate !== today) {
      this._state.dailyDate = today;
      this._state.dailyCount = 0;
    }
  }

  getLastSelfMessageMs() { return this._state.lastSelfMessageMs; }

  getLastSelfMessageOfKindMs(kind) {
    return this._state.lastSelfMessageByKindMs[kind] || null;
  }

  getMutedUntilMs() { return this._state.mutedUntilMs; }

  getDailyCount(nowMs = Date.now()) {
    this._maybeResetDaily(nowMs);
    return this._state.dailyCount;
  }

  /** Returns most-recent-first array of suppression entries (capped). */
  getSuppressionLog() {
    return this._state.suppressionLog.slice();
  }

  // ── Mutators ──────────────────────────────────────────────

  /** Record a self-message that was successfully published. */
  recordPublished(kind, nowMs = Date.now()) {
    this._maybeResetDaily(nowMs);
    this._state.lastSelfMessageMs = nowMs;
    this._state.lastSelfMessageByKindMs[kind] = nowMs;
    this._state.dailyCount += 1;
    this.save();
  }

  /** Record a suppression — keep the last MAX entries newest-first. */
  recordSuppression({ thoughtId, kind, reason, detail, generatedText }, nowMs = Date.now()) {
    const entry = {
      timestamp: nowMs,
      thoughtId: thoughtId || null,
      kind: kind || 'unknown',
      reason: reason || 'unknown',
      detail: detail || null,
      // Truncate generated text — useful to see what was attempted, but
      // the suppression log shouldn't hoard long passages.
      generatedTextPreview: typeof generatedText === 'string'
        ? generatedText.slice(0, 200) : null,
    };
    this._state.suppressionLog.unshift(entry);
    if (this._state.suppressionLog.length > SUPPRESSION_LOG_MAX) {
      this._state.suppressionLog.length = SUPPRESSION_LOG_MAX;
    }
    this.save();
  }

  /** Set /quiet mute. durationMs may be null to clear, or a positive number. */
  setMute(durationMs, nowMs = Date.now()) {
    if (durationMs === null || durationMs === 0) {
      this._state.mutedUntilMs = null;
    } else if (typeof durationMs === 'number' && durationMs > 0) {
      this._state.mutedUntilMs = nowMs + durationMs;
    }
    this.save();
  }

  /** Unmute immediately. */
  clearMute() {
    this._state.mutedUntilMs = null;
    this.save();
  }
}

function isoDate(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

module.exports = { StateStore, SUPPRESSION_LOG_MAX };
