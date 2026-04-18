// @ts-checked-v5.7
// ============================================================
// GENESIS — activities/Journal.js (v7.3.1)
// Consolidates recent thoughts into a brief journal entry.
// Original method was _writeJournalEntry() — renamed to match
// Activity naming. Boost: NeedsSystem.rest+knowledge,
// EmotionalState idle prio (frustration → journaling).
// ============================================================

'use strict';

module.exports = {
  name: 'journal',
  weight: 0.5,
  cooldown: 0,

  shouldTrigger(ctx) {
    let boost = 1.0;

    const needRec = (ctx.snap.needs || []).find(n => n.activity === 'journal');
    if (needRec) boost += needRec.score * 3;

    const idlePrio = ctx.snap.idlePriorities || {};
    if (idlePrio.journal !== undefined) boost += idlePrio.journal * 2;

    return boost;
  },

  async run(idleMind) {
    const recentThoughts = idleMind.readJournal(5);
    if (recentThoughts.length === 0) return 'No recent thoughts to consolidate.';

    const summaries = recentThoughts.map(t => `[${t.activity}] ${t.thought?.slice(0, 100)}`).join('\n');
    const prompt = `You are Genesis. You are writing a brief journal entry to consolidate recent thoughts.\n\nRecent thoughts:\n${summaries}\n\nWrite a brief consolidation (2-3 sentences). What patterns do you see? What should you focus on next?`;

    return idleMind.model.chat(prompt, [], 'analysis');
  },
};
