// @ts-checked-v5.7
// ============================================================
// GENESIS — activities/Ideate.js (v7.3.1)
// Brainstorms new capabilities.
// Boost: NeedsSystem, EmotionalState idle prio (curiosity+satisfaction),
// Genome curiosity, Frontier curiosity-sustained (1 + 0.4*cd).
// ============================================================

'use strict';

module.exports = {
  name: 'ideate',
  weight: 0.8,
  cooldown: 0,

  shouldTrigger(ctx) {
    let boost = 1.0;

    const needRec = (ctx.snap.needs || []).find(n => n.activity === 'ideate');
    if (needRec) boost += needRec.score * 3;

    const idlePrio = ctx.snap.idlePriorities || {};
    if (idlePrio.ideate !== undefined) boost += idlePrio.ideate * 2;

    const cur = ctx.snap.genomeTraits?.curiosity;
    if (cur !== undefined) boost *= (0.5 + cur);

    for (const imp of (ctx.snap.imprints || [])) {
      const curiositySust = (imp.sustained || []).filter(s => s.dim === 'curiosity');
      if (curiositySust.length > 0) {
        const cooldownFactor = ctx.cycleState.recentImprintIds?.has(imp.nodeId) ? 0.5 : 1.0;
        boost *= (1 + 0.4 * cooldownFactor);
      }
    }

    return boost;
  },

  async run(idleMind) {
    const skills = idleMind.selfModel?.getCapabilities() || [];
    const memFacts = idleMind.memory?.getFactContext(5) || '';

    const prompt = `You are Genesis. You are brainstorming a new capability for yourself.\n\nCurrent capabilities: ${skills.join(', ')}\n${memFacts ? 'Context:\n' + memFacts : ''}\n\nThink of something you are missing. Something that would make you more useful.\nNo science fiction — something achievable with Node.js and a local LLM.\n\nOne idea (max 3 sentences):`;

    const thought = await idleMind.model.chat(prompt, [], 'creative');

    if (idleMind.kg) {
      idleMind.kg.addNode('idea', thought.slice(0, 80), {
        type: 'feature-idea',
        full: thought.slice(0, 500),
      });
    }

    return thought;
  },
};
