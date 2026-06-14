// ============================================================
// GENESIS — autonomy/IdleMindJournal.js (v7.9.22)
//
// Journal read/write, rotation and emotional snapshot,
// extracted from IdleMind.js for the File Size Guard (Item 15).
// All state is initialised by IdleMind's constructor; this mixin
// is pure behaviour joined onto the prototype.
// ============================================================
'use strict';

const fs = require('fs');
const { createLogger } = require('../core/Logger');
const _log = createLogger('IdleMind');

const journalMixin = {
  readJournal(limit = 20) {
    try {
      const raw = this.storage
        ? this.storage.readText('journal.jsonl', '')
        : (fs.existsSync(this.journalPath) ? fs.readFileSync(this.journalPath, 'utf-8') : '');
      const lines = raw.split('\n').filter(Boolean);
      return lines.slice(-limit).map(l => {
        try { return JSON.parse(l); } catch (err) { return null; }
      }).filter(Boolean);
    } catch (err) { _log.debug('[IDLE] Journal read failed:', err.message); return []; }
  },

  // v7.3.1: _journal moved from IdleMindActivities.js into IdleMind itself.
  // Previously attached via prototype-delegation; now lives here as a real
  // instance method because activities/*.js (Calibrate, Improve) call it
  // via idleMind._journal(...) rather than through a prototype chain.
  _journal(activity, content) {
    const entry = {
      timestamp: new Date().toISOString(),
      activity,
      thought: content.slice(0, 500),
      thoughtNumber: this.thoughtCount,
    };

    try {
      // v7.5.7-fix Phase 2: rotate journal if too large. Check every 50 writes.
      this._journalRotateCheckCounter = (this._journalRotateCheckCounter || 0) + 1;
      if (this._journalRotateCheckCounter >= 50) {
        this._journalRotateCheckCounter = 0;
        this._rotateJournalIfNeeded();
      }
      if (this.storage) {
        this.storage.appendText('journal.jsonl', JSON.stringify(entry) + '\n');
      } else {
        if (!fs.existsSync(this.storageDir)) fs.mkdirSync(this.storageDir, { recursive: true });
        fs.appendFileSync(this.journalPath, JSON.stringify(entry) + '\n', 'utf-8');
      }
    } catch (err) {
      _log.warn('[IDLE-MIND] Journal write failed:', err.message);
    }

    if (this.eventStore) {
      this.eventStore.append('IDLE_THOUGHT', { activity, summary: content.slice(0, 200) }, 'IdleMind');
    }

    // v7.7.9: Additive emit through InnerSpeech for first-person thought channel.
    // Existing journal.jsonl + IDLE_THOUGHT writes above are unchanged. This is
    // a parallel emission for ProactiveSelfExpression and other consumers that
    // care about first-person thoughts in Genesis's voice. emit() never throws
    // and never blocks — Genesis is never gated against thinking.
    if (this.innerSpeech && typeof this.innerSpeech.emit === 'function') {
      try {
        // v7.7.9 Phase 3: heuristic significance for idle-thoughts. The PSE
        // pipeline applies per-kind floors (idle-thought sigFloor 0.70,
        // novFloor 0.65) — without these heuristics every idle-thought
        // would pass the kind gate and the per-kind floor would never
        // fire. Activity-based heuristic:
        //   - insight activities (reflect/explore/tidy/plan/ideate) →
        //     significance based on content length + activity weight
        //   - other activities → fixed baseline (won't pass 0.70 floor)
        // Novelty: rough proxy — first thought in cycle = 0.8,
        // decaying as thoughtCount grows in the same idle window.
        const INSIGHT_ACTIVITIES = new Set(['reflect', 'explore', 'tidy', 'plan', 'ideate']);
        const isInsight = INSIGHT_ACTIVITIES.has(activity);
        const contentLen = typeof content === 'string' ? content.length : 0;
        const lenBoost = Math.min(0.3, contentLen / 800);  // up to +0.3 for 240+ chars
        const significance = isInsight ? Math.min(0.95, 0.55 + lenBoost) : 0.40;
        // v7.7.9: novelty decays per insight-thought (not per tick).
        if (isInsight) this.insightThoughtCount = (this.insightThoughtCount || 0) + 1;
        const noveltyCount = isInsight ? (this.insightThoughtCount || 1) : 1;
        const novelty = Math.max(0.30, 0.85 - 0.05 * Math.max(0, noveltyCount - 1));

        this.innerSpeech.emit(content, 'idle-thought', {
          sourceModule: 'IdleMind',
          contextRefs: { activity, thoughtNumber: this.thoughtCount },
          emotionalSnapshot: this._snapshotEmotion(),
          significance,
          novelty,
        });
      } catch (_e) { /* never let inner-speech failure break idle cycle */ }
    }
  },

  /**
   * v7.7.9: Capture current emotional skalars for inner-speech context.
   * Returns null if emotionalState is unavailable or throws.
   * Used by _journal() to attach emotionalSnapshot to InnerSpeech thoughts —
   * lets Genesis later see WHICH MOOD he was in when a thought arose.
   */
  _snapshotEmotion() {
    if (!this.emotionalState || typeof this.emotionalState.getState !== 'function') return null;
    try {
      const s = this.emotionalState.getState();
      if (!s || typeof s !== 'object') return null;
      return {
        curiosity: typeof s.curiosity === 'number' ? s.curiosity : null,
        satisfaction: typeof s.satisfaction === 'number' ? s.satisfaction : null,
        frustration: typeof s.frustration === 'number' ? s.frustration : null,
        energy: typeof s.energy === 'number' ? s.energy : null,
      };
    } catch (_e) { return null; }
  },

  /**
   * v7.5.7-fix Phase 2: rotate journal.jsonl when it exceeds max size.
   * Best-effort, swallows errors. Same pattern as EventStore rotation.
   */
  _rotateJournalIfNeeded() {
    if (this._journalMaxFileSizeMB <= 0) return;
    try {
      const stat = fs.statSync(this.journalPath);
      const sizeMB = stat.size / (1024 * 1024);
      if (sizeMB < this._journalMaxFileSizeMB) return;
      // Walk backwards: drop the oldest, shift others up by one
      for (let i = this._journalMaxRotations; i >= 1; i--) {
        const cur = `${this.journalPath}.${i}`;
        const next = `${this.journalPath}.${i + 1}`;
        if (!fs.existsSync(cur)) continue;
        if (i === this._journalMaxRotations) {
          try { fs.unlinkSync(cur); } catch (_e) { /* swallow */ }
        } else {
          try { fs.renameSync(cur, next); } catch (_e) { /* swallow */ }
        }
      }
      try { fs.renameSync(this.journalPath, `${this.journalPath}.1`); } catch (_e) { /* swallow */ }
      _log.info(`[IDLE-MIND] Rotated journal.jsonl (was ${sizeMB.toFixed(1)}MB)`);
    } catch (_err) {
      // File doesn't exist yet — nothing to rotate
    }
  },
};

module.exports = { journalMixin };
