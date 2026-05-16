// ============================================================
// GENESIS — SkillCandidateNarrative.js (Phase 9 — Cognitive Architecture)
//
// v7.8.9 — Reflects on accumulated skill candidates.
//
// Reacts immediately to each passing candidate (koennen:candidate-recorded
// with gatePass=true). When ≥3 candidates passed gate within the last
// 7 days, and a 6-hour cooldown has elapsed since the last reflection,
// emits 'koennen:candidates-noticed' — which SelfNarrative listens to
// and boosts its _changeAccumulator.
//
// Effect: when Genesis is actively producing skill-candidate trajectories,
// his self-narrative updates more often. No explicit "I noticed X
// candidates" text — the boost flows through the existing narrative
// update path.
//
// Integration:
//   'koennen:candidate-recorded' (gatePass=true) → _onCandidate() (input)
//   'koennen:candidates-noticed' (output, fired when threshold + cooldown ok)
//
// No timer, no dream-cycle dependency — direct event-driven reaction.
// ============================================================

'use strict';

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const { applySubscriptionHelper } = require('../core/subscription-helper');
const _log = createLogger('SkillCandidateNarrative');

const REFLECTION_COOLDOWN_MS = 6 * 60 * 60 * 1000;   // 6 hours
const REFLECTION_WINDOW_MS   = 7 * 24 * 60 * 60 * 1000; // 7 days
const MIN_CANDIDATES_FOR_NOTICE = 3;

class SkillCandidateNarrative {
  /**
   * @param {{ bus: *, koennenCandidateLog?: * }} deps
   */
  constructor({ bus, koennenCandidateLog }) {
    this.bus = bus || NullBus;
    /** @type {Function[]} */ this._unsubs = [];
    this.koennenCandidateLog = koennenCandidateLog || null;
    this._lastReflectionTs = 0;
    this._started = false;
  }

  start() {
    if (this._started) return;
    this._started = true;
    this._sub('koennen:candidate-recorded', (data) => this._onCandidate(data));
    _log.info('[KOENNEN-NARR] Active — listening for candidate notices');
  }

  stop() {
    this._unsubAll();
    this._started = false;
  }

  _onCandidate(_data) {
    if (!this.koennenCandidateLog) return;

    const now = Date.now();
    if ((now - this._lastReflectionTs) < REFLECTION_COOLDOWN_MS) return;

    const since = now - REFLECTION_WINDOW_MS;
    const recent = this.koennenCandidateLog.getCandidatesSince(since);
    if (!Array.isArray(recent)) return;

    const passed = recent.filter(c => c && c.gatePass === true);
    if (passed.length < MIN_CANDIDATES_FOR_NOTICE) return;

    // Sample last 3 titles (deduplicate, max 50 chars each)
    const seen = new Set();
    const sampleTitles = [];
    for (let i = passed.length - 1; i >= 0 && sampleTitles.length < 3; i--) {
      const t = (passed[i].taskTitle || '').slice(0, 50);
      if (t && !seen.has(t)) {
        seen.add(t);
        sampleTitles.unshift(t);
      }
    }

    this.bus.fire('koennen:candidates-noticed', {
      count: passed.length,
      windowMs: REFLECTION_WINDOW_MS,
      sampleTitles,
    }, { source: 'SkillCandidateNarrative' });

    this._lastReflectionTs = now;
    _log.info(`[KOENNEN-NARR] Noticed ${passed.length} candidates over last 7 days`);
  }

  // ── Inspection / testing helpers ─────────────────────
  getLastReflectionTs() { return this._lastReflectionTs; }
}

applySubscriptionHelper(SkillCandidateNarrative, { defaultSource: 'SkillCandidateNarrative' });

module.exports = { SkillCandidateNarrative };
