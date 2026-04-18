// @ts-checked-v5.7
// ============================================================
// GENESIS — activities/Dream.js (v7.3.1)
// Runs a dream cycle (memory consolidation via DreamCycle).
// Conditional: dreamAge > 30min AND unprocessed >= 10.
// Boost sources: Genome.consolidation, MemoryPressure (<15% → 2x,
//   <30% → 1.5x).
// ============================================================

'use strict';

const { createLogger } = require('../../core/Logger');
const _log = createLogger('IdleMind');

module.exports = {
  name: 'dream',
  weight: 2.0,
  cooldown: 0,

  shouldTrigger(ctx) {
    // Availability gate — dream only runs if age+unprocessed conditions met
    const age = ctx.snap.dreamAge || 0;
    const unprocessed = ctx.snap.dreamUnprocessed || 0;
    if (age < 30 * 60 * 1000 || unprocessed < 10) return 0;

    let boost = 1.0;

    // Genome consolidation
    const con = ctx.snap.genomeTraits?.consolidation;
    if (con !== undefined) boost *= (0.5 + con);

    // Memory pressure boost
    const memP = ctx.snap.memoryPressure;
    if (memP !== undefined && memP !== null) {
      if (memP < 15) boost *= 2.0;
      else if (memP < 30) boost *= 1.5;
    }

    return boost;
  },

  async run(idleMind) {
    if (!idleMind.dreamCycle) return 'DreamCycle not available.';

    let intensity = 0.25;
    const energy = idleMind._metabolism?.getEnergy?.() ?? 500;
    const memPressure = idleMind._homeostasis?.vitals?.memoryPressure?.value ?? 50;
    if (energy >= 250 && memPressure < 30) intensity = 1.0;
    else if (energy >= 100 && memPressure < 50) intensity = 0.5;

    const report = await idleMind.dreamCycle.dream({ intensity });

    if (report.skipped) {
      return `Dream skipped: ${report.reason}`;
    }

    if (idleMind.selfNarrative) {
      try { await idleMind.selfNarrative.maybeUpdate(); }
      catch (_e) { _log.debug('[catch] selfNarrative update:', _e.message); }
    }

    const parts = [`Dream #${report.dreamNumber} (${report.durationMs}ms)`];
    if (report.newSchemas.length > 0) {
      parts.push(`${report.newSchemas.length} new schemas: ${report.newSchemas.map(s => s.name).join(', ')}`);
    }
    if (report.insights.length > 0) {
      parts.push(`${report.insights.length} insights`);
    }
    parts.push(`Memory: ${report.strengthenedMemories} strengthened, ${report.decayedMemories} decayed`);

    return parts.join('. ');
  },
};
