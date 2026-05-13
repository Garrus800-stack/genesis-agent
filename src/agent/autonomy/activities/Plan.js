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

    // v7.7.9 (post-burnin P2): list real source files so the LLM can
    // only reference them. Cap at 30 to keep prompt size manageable.
    const realPaths = modules.slice(0, 30).map(m => m.file).join('\n');

    // v7.7.9 (post-burnin P2): show recent failed/obsolete goals so the
    // LLM doesn't propose the same abstract meta-goal again.
    const recentFailed = (idleMind.goalStack?.goals || [])
      .filter(g => ['obsolete', 'stalled', 'failed'].includes(g.status))
      .slice(-5)
      .map(g => `- ${(g.description || '').slice(0, 80)} [${g.status}]`)
      .join('\n');

    const prompt = `You are Genesis. Propose ONE concrete, verifiable improvement.\n\nReal source files you can reference (use EXACTLY these paths, do not invent):\n${realPaths}\n\nYour capabilities: ${caps.join(', ')}\n${existingPlans.length ? 'Previous plans:\n' + existingPlans.map(p => `- ${p.title}: ${p.status}`).join('\n') : ''}\n${recentFailed ? '\nRecently FAILED goals (do NOT propose similar ones — they are obsolete):\n' + recentFailed : ''}\n\nRules:\n- Pick a SMALL, concrete improvement (not an abstract meta-system).\n- Reference ONLY real files from the list above.\n- The improvement must be verifiable in <= 3 steps.\n- If you cannot find a small concrete improvement, output: TITLE: SKIP\n\nFormat:\nTITLE: [Short name, or SKIP if no concrete idea]\nPRIORITY: [high/medium/low]\nEFFORT: [small/medium/large]\nDESCRIPTION: [What exactly should be improved, max 3 sentences]\nFIRST_STEP: [The very first concrete step, referencing a real file]`;

    const thought = await idleMind.model.chat(prompt, [], 'analysis');

    const titleMatch = thought.match(/TITLE:\s*(.+)/i) || thought.match(/TITEL:\s*(.+)/i);
    const prioMatch = thought.match(/PRIORITY:\s*(.+)/i) || thought.match(/PRIORITAET:\s*(.+)/i);
    if (titleMatch) {
      const title = titleMatch[1].trim();

      // v7.7.9 (post-burnin P2): respect SKIP signal from LLM and
      // skip empty/single-word abstract titles.
      if (/^skip$/i.test(title)) {
        _log.info('[IDLE-MIND] Plan: LLM returned SKIP — no concrete improvement found');
        return thought;
      }

      // v7.7.9 (post-burnin P2): token-overlap check against recently
      // failed goals. If 2+ tokens overlap with a recent failure → skip.
      const _tokenize = (s) => (s || '').toLowerCase()
        .replace(/[^a-z0-9äöüß]+/g, ' ').split(/\s+/).filter(t => t.length >= 4);
      const titleTokens = new Set(_tokenize(title));
      const recentFailedDescs = (idleMind.goalStack?.goals || [])
        .filter(g => ['obsolete', 'stalled', 'failed'].includes(g.status))
        .slice(-10)
        .map(g => g.description || '');
      let _maxOverlap = 0;
      for (const desc of recentFailedDescs) {
        const overlap = _tokenize(desc).filter(t => titleTokens.has(t)).length;
        if (overlap > _maxOverlap) _maxOverlap = overlap;
      }
      if (_maxOverlap >= 2) {
        _log.info(`[IDLE-MIND] Plan: skipping "${title.slice(0, 50)}" — ${_maxOverlap} tokens overlap with recent failures`);
        return thought;
      }

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
