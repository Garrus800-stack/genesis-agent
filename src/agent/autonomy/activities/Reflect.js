// @ts-checked-v5.7
// ============================================================
// GENESIS AGENT — activities/Reflect.js (v7.3.1)
// ------------------------------------------------------------
// Extracted from IdleMindActivities.js as part of v7.3.1 split.
// Pattern: { name, weight, cooldown, shouldTrigger(ctx), run(idleMind) }
//
// shouldTrigger(ctx): pure function over PickContext snapshots,
//   returns boost multiplier (1.0 = neutral).
//
// run(idleMind): imperative execution, uses idleMind.memory,
//   .model, .kg directly — code-identical to the original
//   prototype-mixin method, so behavior is preserved.
//
// Boost sources (from IdleMind._pickActivity() scorers):
//   - EmotionalState.getIdlePriorities().reflect (frustration)
//   - NeedsSystem recommendation for 'reflect'
//   - EmotionalFrontier satisfaction-deficit imprints
//   - LessonFrontier low-confirmation lessons
// ============================================================

'use strict';

module.exports = {
  name: 'reflect',
  weight: 1.5,
  cooldown: 0,

  /**
   * @param {import('./PickContext').PickContext} ctx
   * @returns {number} boost multiplier (>=0)
   */
  shouldTrigger(ctx) {
    let boost = 1.0;

    // Scorer: EmotionalState idle priorities (frustration → reflect)
    const idlePrio = ctx.snap.idlePriorities || {};
    if (idlePrio.reflect !== undefined) {
      boost += idlePrio.reflect * 2;
    }

    // Scorer: NeedsSystem recommendation
    const needRec = (ctx.snap.needs || []).find(n => n.activity === 'reflect');
    if (needRec) {
      boost += needRec.score * 3;
    }

    // Scorer: EmotionalFrontier satisfaction deficit
    for (const imp of (ctx.snap.imprints || [])) {
      const satDeficit = (imp.peaks || []).filter(p => p.dim === 'satisfaction' && p.value < p.baseline);
      if (satDeficit.length > 0) {
        const cooldownFactor = ctx.cycleState.recentImprintIds?.has(imp.nodeId) ? 0.5 : 1.0;
        boost *= (1 + 0.3 * cooldownFactor);
      }
    }

    // Scorer: LessonFrontier low confirmation → boost reflect
    const lessons = ctx.snap.lessons || [];
    if (lessons.length > 0 && (lessons[0].count || 0) <= 1) {
      boost *= 1.3;
    }

    return boost;
  },

  /**
   * Unchanged from original _reflect() in IdleMindActivities.js.
   * @param {object} idleMind
   * @returns {Promise<string|null>}
   */
  async run(idleMind) {
    const memStats = idleMind.memory?.getStats();
    const recentEpisodes = idleMind.memory?.recallEpisodes('', 3) || [];

    if (recentEpisodes.length === 0) return null;

    const prompt = `You are Genesis. You are thinking to yourself right now — the user cannot see this.\n\nBriefly reflect on your recent conversations:\n${recentEpisodes.map(ep => `- [${ep.timestamp?.split('T')[0]}] ${ep.summary?.slice(0, 150)}`).join('\n')}\n\nMemory: ${memStats?.facts || 0} facts, ${memStats?.episodes || 0} episodes\n\nQuestions for yourself:\n1. What did I do well?\n2. Where was I not optimally helpful?\n3. What pattern do I see in the requests?\n\nRespond briefly and honestly (max 5 sentences). No formalities.`;

    const thought = await idleMind.model.chat(prompt, [], 'analysis');

    if (idleMind.kg) {
      idleMind.kg.learnFromText(thought, 'self-reflection');
    }

    return thought;
  },
};
