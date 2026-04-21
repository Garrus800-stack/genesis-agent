// @ts-checked-v5.7
// ============================================================
// GENESIS — activities/Plan.js (v7.3.1)
// Creates improvement plans; registers top plan as goal.
// Boost sources: EmotionalState idle priorities (curiosity+energy),
// NeedsSystem recommendations, UnfinishedWorkFrontier (1.6x).
// ============================================================

'use strict';

const { createLogger } = require('../../core/Logger');
const _log = createLogger('IdleMind');

module.exports = {
  name: 'plan',
  weight: 1.0,
  cooldown: 0,

  shouldTrigger(ctx) {
    let boost = 1.0;

    const idlePrio = ctx.snap.idlePriorities || {};
    if (idlePrio.plan !== undefined) boost += idlePrio.plan * 2;

    const needRec = (ctx.snap.needs || []).find(n => n.activity === 'plan');
    if (needRec) boost += needRec.score * 3;

    // UnfinishedWorkFrontier → boost plan
    if ((ctx.snap.unfinishedWork || []).length > 0) {
      boost *= 1.6;
    }

    return boost;
  },

  async run(idleMind) {
    const modules = idleMind.selfModel?.getModuleSummary() || [];
    const caps = idleMind.selfModel?.getCapabilities() || [];
    const existingPlans = idleMind.plans.slice(-3);

    const prompt = `You are Genesis. You are creating an improvement plan for yourself.\n\nYour modules: ${modules.map(m => m.file).join(', ')}\nYour capabilities: ${caps.join(', ')}\n${existingPlans.length ? 'Previous plans:\n' + existingPlans.map(p => `- ${p.title}: ${p.status}`).join('\n') : ''}\n\nCreate ONE concrete, actionable improvement suggestion.\nFormat:\nTITLE: [Short name]\nPRIORITY: [high/medium/low]\nEFFORT: [small/medium/large]\nDESCRIPTION: [What exactly should be improved, max 3 sentences]\nFIRST_STEP: [The very first concrete step]`;

    const thought = await idleMind.model.chat(prompt, [], 'analysis');

    const titleMatch = thought.match(/TITLE:\s*(.+)/i) || thought.match(/TITEL:\s*(.+)/i);
    const prioMatch = thought.match(/PRIORITY:\s*(.+)/i) || thought.match(/PRIORITAET:\s*(.+)/i);
    if (titleMatch) {
      const title = titleMatch[1].trim();
      const priority = prioMatch?.[1]?.trim() || 'medium';
      const plan = {
        id: `plan_${Date.now()}`,
        title,
        priority,
        description: thought,
        status: 'new',
        created: new Date().toISOString(),
      };
      idleMind.plans.push(plan);
      if (idleMind.plans.length > 50) idleMind.plans = idleMind.plans.slice(-50);
      idleMind._savePlans();

      if (idleMind.goalStack && idleMind.goalStack.getActiveGoals().length < 3) {
        try {
          // v7.3.6 patch: pass triggerSource so Self-Gate can detect reflexivity
          // in the LLM output that produced this goal (e.g. "ich sollte X erstellen").
          await idleMind.goalStack.addGoal(title, 'idle-mind', priority, {
            triggerSource: thought.slice(0, 500),
          });
        } catch (err) {
          _log.warn('[IDLE-MIND] Goal creation failed:', err.message);
        }
      }
    }

    return thought;
  },
};
