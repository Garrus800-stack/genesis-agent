// @ts-checked-v5.7
// ============================================================
// GENESIS — activities/Tidy.js (v7.3.1)
// Prunes stale KG nodes + low-success procedural memories.
// Boost: NeedsSystem.maintenance, EmotionalState idle prio (low-energy),
// Genome consolidation.
// Sync operation (no await).
// ============================================================

'use strict';

module.exports = {
  name: 'tidy',
  weight: 0.6,
  cooldown: 0,

  shouldTrigger(ctx) {
    let boost = 1.0;

    const needRec = (ctx.snap.needs || []).find(n => n.activity === 'tidy');
    if (needRec) boost += needRec.score * 3;

    const idlePrio = ctx.snap.idlePriorities || {};
    if (idlePrio.tidy !== undefined) boost += idlePrio.tidy * 2;

    const con = ctx.snap.genomeTraits?.consolidation;
    if (con !== undefined) boost *= (0.5 + con);

    return boost;
  },

  async run(idleMind) {
    let tidied = 0;

    if (idleMind.kg) {
      const stats = idleMind.kg.getStats();
      if (stats.nodes > 100) {
        tidied += idleMind.kg.pruneStale(7);
      }
    }

    if (idleMind.memory?.db?.procedural) {
      const before = idleMind.memory.db.procedural.length;
      idleMind.memory.db.procedural = idleMind.memory.db.procedural.filter(
        p => p.successRate > 0.1 || p.attempts < 5
      );
      tidied += before - idleMind.memory.db.procedural.length;
    }

    return tidied > 0
      ? `Tidied up: ${tidied} stale entries removed.`
      : 'Nothing to tidy up.';
  },
};
