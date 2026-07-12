// @ts-checked-v5.7
// ============================================================
// GENESIS AGENT — activities/Pause.js (v7.9.35, E2)
// ------------------------------------------------------------
// NOT the rest-mode: IdleMind's v7.9.12 rest-mode flag is the
// model-outage state — a condition that happens TO Genesis.
// Pause is the opposite: a deliberate CHOICE. The nineteenth
// activity, and the first that produces nothing.
//
// Pattern: { name, weight, cooldown, shouldTrigger(ctx), run(idleMind) }
//
// Trigger (decision G1=a): boost comes exclusively from the raw
//   rest need (ctx.snap.needsRaw.rest, 0..1) — the honest signal
//   that already grows with metabolic depletion. No invented
//   heuristics. Additive style like Journal's scorer.
//
// Run (decisions G2=b, review K4): no model, no tools, no bus
//   fires, no sleep — the choice of a production-free cycle IS
//   the act; the idle tick is the time, and Metabolism's
//   _restoreTick does the actual recovering. One private journal
//   line makes the rest rememberable (visibility routing is
//   native in JournalWriter), then a short return string feeds
//   the standard activity pipeline. The result stays under 50
//   chars and 'pause' is not in INSIGHT_ACTIVITIES — proactive
//   insight is structurally excluded twice.
// ============================================================

'use strict';

module.exports = {
  name: 'pause',
  weight: 0.5,
  cooldown: 2,

  /**
   * Pure scorer over the PickContext snapshot: neutral (1.0) when
   * rested, up to ~3.5 when the rest need is saturated.
   * @param {import('./PickContext').PickContext} ctx
   * @returns {number} boost multiplier (>= 1.0)
   */
  shouldTrigger(ctx) {
    const rest = ctx?.snap?.needsRaw?.rest ?? 0;
    return 1.0 + rest * 2.5;
  },

  /**
   * Rest deliberately. Writes one private journal line (when a
   * writer is wired — optional late-binding, degrades to nothing),
   * returns a short trace string for the standard pipeline.
   * @param {import('../IdleMind').IdleMind} idleMind
   * @returns {Promise<string>}
   */
  async run(idleMind) {
    const rest = idleMind?.needsSystem?.getNeeds?.()?.rest ?? null;
    let mood = null;
    try { mood = idleMind?.emotionalState?.getMood?.() ?? null; } catch (_e) { /* optional */ }

    try {
      idleMind?.journalWriter?.write?.({
        visibility: 'private',
        source: 'pause',
        content: mood ? `Ich habe geruht. Grundstimmung: ${mood}.` : 'Ich habe geruht.',
        tags: ['pause'],
      });
    } catch (_e) { /* the line is optional — resting is not */ }

    if (rest !== null) {
      // The only permitted 'rest' mention: the need level, not a name.
      console.log(`[IDLE-MIND] pause: resting deliberately (rest need ${rest})`);
    }
    return 'Habe bewusst geruht.';
  },
};
