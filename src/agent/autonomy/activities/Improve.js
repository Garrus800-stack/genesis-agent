// @ts-checked-v5.7
// ============================================================
// GENESIS — activities/Improve.js (v7.3.1)
// Autonomous self-improvement via GoalSynthesizer.
// Conditional: goalSynthesizer service registered.
// Boost sources: CognitiveSelfModel weak areas (1 + N*0.8x),
//   Genome.selfAwareness (0.5 + sa).
// ============================================================

'use strict';

const { createLogger } = require('../../core/Logger');
const _log = createLogger('IdleMind');

module.exports = {
  name: 'improve',
  weight: 1.8,
  cooldown: 0,

  shouldTrigger(ctx) {
    if (!ctx.hasContainerService('goalSynthesizer')) return 0;

    let boost = 1.0;

    // Weak areas — stronger boost than explore
    const weakAreas = ctx.snap.weakAreas || [];
    if (weakAreas.length > 0) {
      boost *= (1 + weakAreas.length * 0.8);
    }

    // selfAwareness trait
    const sa = ctx.snap.genomeTraits?.selfAwareness;
    if (sa !== undefined) boost *= (0.5 + sa);

    return boost;
  },

  async run(idleMind) {
    try {
      const goalSynthesizer = idleMind.bus?._container?.resolve?.('goalSynthesizer');
      if (!goalSynthesizer) return 'GoalSynthesizer not available';

      const goals = goalSynthesizer.synthesize();
      if (goals.length === 0) return 'No improvement goals generated — performance is adequate or insufficient data.';

      const goal = goals[0];

      if (idleMind.goalStack) {
        // v7.3.6 patch: pass triggerSource so Self-Gate can log goal-origin.
        // Source is synthesized from metrics, not LLM reflex — this string
        // simply documents the cause for telemetry.
        const triggerSource = `self-improvement synthesized from metrics: ${goal.title}`;
        await idleMind.goalStack.addGoal(goal.title, 'self-improvement', 'medium', {
          triggerSource,
        });
        _log.info(`[IDLE-MIND] Self-improvement goal pushed: ${goal.title}`);
      }

      const summary = `Self-improvement: ${goal.title} (priority: ${goal.priority}, impact: ${goal.impact})`;
      idleMind._journal('improve', summary);
      return summary;
    } catch (err) {
      _log.warn('[IDLE-MIND] Improve failed:', err.message);
      return `Improve failed: ${err.message}`;
    }
  },
};
