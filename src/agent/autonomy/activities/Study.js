// @ts-checked-v5.7
// ============================================================
// GENESIS — activities/Study.js (v7.3.1)
// v7.2.8 activity: learn from LLM's training knowledge during idle.
// Conditional: model.activeModel + kg.
// Anti-feedback-loop:
//   1. 2h cooldown per topic
//   2. Skip topics already covered by research (complementarity)
// Boost: Genome.curiosity (0.5+cur).
// ============================================================

'use strict';

module.exports = {
  name: 'study',
  weight: 0.9,
  cooldown: 0,

  shouldTrigger(ctx) {
    // Availability gates
    if (!ctx.services.model?.activeModel) return 0;
    if (!ctx.services.kg) return 0;

    let boost = 1.0;

    // NeedsSystem recommendation
    const needRec = (ctx.snap.needs || []).find(n => n.activity === 'study');
    if (needRec) boost += needRec.score * 3;

    // Genome curiosity
    const cur = ctx.snap.genomeTraits?.curiosity;
    if (cur !== undefined) boost *= (0.5 + cur);

    return boost;
  },

  async run(idleMind) {
    if (!idleMind.model || !idleMind.kg) return null;

    const allNodes = [...idleMind.kg.graph.nodes.values()]
      .filter(n => typeof n.type === 'string' && n.type !== 'system' && n.label?.length > 3);

    if (allNodes.length === 0) return null;

    // Filter 1: skip topics studied in last 2h
    const recentStudies = idleMind.kg.getNodesByType('learning')
      .filter(n => n.properties?.source === 'idle-study'
        && Date.now() - (n.created || 0) < 2 * 60 * 60 * 1000);
    const studiedLabels = new Set(recentStudies.map(n => (n.properties?.topic || '').toLowerCase()));

    // Filter 2: skip topics already covered by web research
    const researchedLabels = new Set(
      idleMind.kg.getNodesByType('research').map(n => (n.properties?.topic || '').toLowerCase())
    );

    const candidates = allNodes
      .filter(n => !studiedLabels.has(n.label.toLowerCase())
        && !researchedLabels.has(n.label.toLowerCase()))
      .sort((a, b) => (b.accessCount || 0) - (a.accessCount || 0))
      .slice(0, 10);

    if (candidates.length === 0) return null;

    const topic = candidates[Math.floor(Math.random() * candidates.length)];

    const prompt = `You are Genesis, an autonomous AI agent. You are studying during idle time — the user cannot see this.\n\nTopic: "${topic.label}"\n\nTeach yourself something useful about this topic. Focus on:\n- Practical techniques or patterns\n- Common pitfalls to avoid\n- Connections to other concepts\n\nRespond in 3-4 sentences. Be specific, not generic.`;

    const insight = await idleMind.model.chat(prompt, [], 'analysis');

    if (insight && insight.length > 20) {
      idleMind.kg.addNode('learning', insight.slice(0, 80), {
        type: 'llm-study',
        topic: topic.label,
        full: insight.slice(0, 500),
        source: 'idle-study',
      });
      return `Studied "${topic.label}": ${insight.slice(0, 100)}...`;
    }

    return null;
  },
};
