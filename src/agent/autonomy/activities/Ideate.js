// @ts-checked-v5.7
// ============================================================
// GENESIS — activities/Ideate.js (v7.3.1)
// Brainstorms new capabilities.
// Boost: NeedsSystem, EmotionalState idle prio (curiosity+satisfaction),
// Genome curiosity, Frontier curiosity-sustained (1 + 0.4*cd).
// ============================================================

'use strict';

const tfidf = require('../../core/tfidf');

// v7.9.25: ideate near-duplicate guard. GraphStore.addNode dedups only EXACT
// normalized labels, so semantically-near ideas ("Path Generator" vs "Pathway
// Generator") become separate nodes and the same idea recurs across cycles. We
// (a) feed the recent ideas back into the prompt so the model can diverge, and
// (b) measure TF-IDF cosine of a fresh idea against the recent ones. Threshold
// 0.40 is measured on the real idea distribution: genuine near-dups cluster at
// 0.49–0.68, distinct ideas at <=0.13, with a wide empty gap between.
const SIMILARITY_THRESHOLD = 0.40;
const RECENT_IDEAS_LIMIT = 8;

function recentIdeaLabels(kg) {
  if (!kg || typeof kg.getNodesByType !== 'function') return [];
  return kg.getNodesByType('idea')
    .slice()
    .sort((a, b) => (b.created || 0) - (a.created || 0))
    .slice(0, RECENT_IDEAS_LIMIT)
    .map(n => n.label)
    .filter(Boolean);
}

function maxSimilarity(text, others) {
  if (!text || others.length === 0) return 0;
  const vocab = tfidf.buildVocabulary([text, ...others]);
  const tv = tfidf.textToVector(text, vocab);
  let max = 0;
  for (const other of others) {
    const sim = tfidf.cosineSimilarity(tv, tfidf.textToVector(other, vocab));
    if (sim > max) max = sim;
  }
  return max;
}

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
    const recent = recentIdeaLabels(idleMind.kg);

    const recentBlock = recent.length
      ? `\n\nYou recently proposed these ideas — propose something genuinely different:\n${recent.map(r => '- ' + r.replace(/\s+/g, ' ').trim()).join('\n')}`
      : '';
    const buildPrompt = (extra) => `You are Genesis. You are brainstorming a new capability for yourself.\n\nCurrent capabilities: ${skills.join(', ')}\n${memFacts ? 'Context:\n' + memFacts : ''}${recentBlock}${extra || ''}\n\nThink of something you are missing. Something that would make you more useful.\nNo science fiction — something achievable with Node.js and a local LLM.\n\nOne idea (max 3 sentences):`;

    let thought = await idleMind.model.chat(buildPrompt(), [], 'creative');

    // Near-duplicate guard: if the fresh idea is lexically close to a recent one,
    // retry ONCE with a stronger hint; if it is still close, keep the first —
    // one retry only, ideation must never stall in a loop.
    if (recent.length && maxSimilarity(thought.slice(0, 80), recent) >= SIMILARITY_THRESHOLD) {
      const retry = await idleMind.model.chat(
        buildPrompt('\n\nYour previous idea was too close to one you already had — pick a different area entirely.'),
        [], 'creative');
      if (maxSimilarity(retry.slice(0, 80), recent) < SIMILARITY_THRESHOLD) {
        thought = retry;
      }
    }

    if (idleMind.kg) {
      idleMind.kg.addNode('idea', thought.slice(0, 80), {
        type: 'feature-idea',
        full: thought.slice(0, 500),
      });
    }

    return thought;
  },
};
