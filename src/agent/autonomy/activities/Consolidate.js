// @ts-checked-v5.7
// ============================================================
// GENESIS — activities/Consolidate.js (v7.3.1)
// Memory consolidation: UnifiedMemory patterns + KG/Lessons
// via bus event. Always available (v6.0.0).
// Boost: Genome.consolidation.
// ============================================================

'use strict';

module.exports = {
  name: 'consolidate',
  weight: 1.3,
  cooldown: 0,

  shouldTrigger(ctx) {
    let boost = 1.0;

    // Genome consolidation
    const con = ctx.snap.genomeTraits?.consolidation;
    if (con !== undefined) boost *= (0.5 + con);

    return boost;
  },

  async run(idleMind) {
    const parts = [];

    // Phase 1: UnifiedMemory consolidation
    if (idleMind.unifiedMemory) {
      try {
        const { promoted } = idleMind.unifiedMemory.consolidate({
          minOccurrences: 3,
          maxPromotions: 5,
        });

        let conflictCount = 0;
        if (idleMind.memory?.db?.episodic) {
          const recentTopics = new Set();
          const recent = idleMind.memory.db.episodic.slice(-5);
          for (const ep of recent) {
            for (const t of (ep?.topics || [])) recentTopics.add(t);
          }
          for (const topic of [...recentTopics].slice(0, 3)) {
            try {
              const { conflicts } = await idleMind.unifiedMemory.resolveConflicts(topic);
              conflictCount += conflicts.length;
            } catch (_e) { /* best effort */ }
          }
        }

        if (promoted.length > 0) parts.push(`${promoted.length} patterns promoted`);
        if (conflictCount > 0) parts.push(`${conflictCount} conflicts resolved`);
      } catch (err) {
        parts.push(`UnifiedMemory: ${err.message}`);
      }
    }

    // Phase 2: MemoryConsolidator (KG + Lessons) via bus
    idleMind.bus.emit('idle:consolidate-memory', {}, { source: 'IdleMind' });
    parts.push('KG+Lessons consolidation triggered');

    return parts.length > 0
      ? `Memory consolidation: ${parts.join('. ')}`
      : 'Memory consolidation: no changes needed';
  },
};
