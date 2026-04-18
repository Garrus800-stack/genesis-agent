// @ts-checked-v5.7
// ============================================================
// GENESIS — activities/Explore.js (v7.3.1)
// Reads own source code, directed by weak areas.
// Boost sources: NeedsSystem, EmotionalState.curiosity, Genome.curiosity,
// CognitiveSelfModel weak areas (1 + N*0.5x), Frontier frustration peaks,
// SuspicionFrontier (1.5x).
// ============================================================

'use strict';

module.exports = {
  name: 'explore',
  weight: 1.2,
  cooldown: 0,

  shouldTrigger(ctx) {
    let boost = 1.0;

    // NeedsSystem
    const needRec = (ctx.snap.needs || []).find(n => n.activity === 'explore');
    if (needRec) boost += needRec.score * 3;

    // EmotionalState idle priorities
    const idlePrio = ctx.snap.idlePriorities || {};
    if (idlePrio.explore !== undefined) boost += idlePrio.explore * 2;

    // Genome curiosity multiplier
    const cur = ctx.snap.genomeTraits?.curiosity;
    if (cur !== undefined) boost *= (0.5 + cur);

    // Weak areas boost
    const weakAreas = ctx.snap.weakAreas || [];
    if (weakAreas.length > 0) {
      boost *= (1 + weakAreas.length * 0.5);
    }

    // EmotionalFrontier frustration peaks → boost explore
    for (const imp of (ctx.snap.imprints || [])) {
      const frustPeaks = (imp.peaks || []).filter(p => p.dim === 'frustration');
      if (frustPeaks.length > 0) {
        const cooldownFactor = ctx.cycleState.recentImprintIds?.has(imp.nodeId) ? 0.5 : 1.0;
        boost *= (1 + 0.4 * cooldownFactor);
      }
    }

    // SuspicionFrontier → boost explore
    if ((ctx.snap.suspicions || []).length > 0) {
      boost *= 1.5;
    }

    return boost;
  },

  async run(idleMind) {
    const modules = idleMind.selfModel?.getModuleSummary() || [];
    const nonProtected = modules.filter(m => !m.protected);
    if (nonProtected.length === 0) return null;

    // v6.0.8: Directed curiosity — explore modules related to weak areas
    let target;
    let explorationGoal = 'general code review';

    if (idleMind._currentWeakness) {
      const [weakType] = idleMind._currentWeakness;
      const WEAKNESS_MODULE_MAP = {
        'refactor':  ['SelfModificationPipeline', 'MultiFileRefactor', 'ASTDiff'],
        'analysis':  ['CodeSafetyScanner', 'VerificationEngine', 'CodeAnalyzer'],
        'debug':     ['FailureAnalyzer', 'FailureTaxonomy', 'ShellAgent'],
        'code-gen':  ['FormalPlanner', 'AgentLoopSteps', 'NativeToolUse'],
        'shell':     ['ShellAgent', 'LinuxSandboxHelper', 'Sandbox'],
      };
      const relevantModules = WEAKNESS_MODULE_MAP[weakType] || [];
      if (relevantModules.length > 0) {
        target = nonProtected.find(m =>
          relevantModules.some(rm => m.file.includes(rm))
        );
        if (target) explorationGoal = `improving ${weakType} capability`;
      }
    }

    if (!target) {
      target = nonProtected[Math.floor(Math.random() * nonProtected.length)];
    }

    const code = idleMind.selfModel.readModule(target.file);
    if (!code) return null;

    const chunk = code.length > 2000 ? code.slice(0, 2000) + '\n// ... (truncated)' : code;

    const prompt = `You are Genesis. You are reading your own code to improve your ${explorationGoal}.\n\nFile: ${target.file}\nClasses: ${target.classes.join(', ')}\nFunctions: ${target.functions} total\n\nCode (excerpt):\n\`\`\`javascript\n${chunk}\n\`\`\`\n\nBrief note to yourself (max 3 sentences):\n- What patterns here could help with ${explorationGoal}?\n- What reusable approach can you extract?`;

    const thought = await idleMind.model.chat(prompt, [], 'analysis');

    if (idleMind.kg) {
      idleMind.kg.addNode('insight', `${target.file}: ${thought.slice(0, 80)}`, {
        file: target.file,
        type: idleMind._currentWeakness ? 'directed-exploration' : 'code-review',
        weakness: idleMind._currentWeakness?.[0] || null,
        thought: thought.slice(0, 300),
      });
    }

    if (idleMind._currentWeakness) {
      idleMind.bus.fire('idle:curiosity-targeted', {
        weakness: idleMind._currentWeakness[0],
        targetModule: target.file,
        insight: thought.slice(0, 100),
      }, { source: 'IdleMind' });
    }

    return thought;
  },
};
