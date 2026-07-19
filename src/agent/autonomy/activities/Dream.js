// @ts-checked-v5.7
// ============================================================
// GENESIS — activities/Dream.js (v7.3.1)
// Runs a dream cycle (memory consolidation via DreamCycle).
// Cadence (v7.9.41 B2, Genesis' own spec): never twice within 20 min;
// after 60 min idle-with-material the dream is DUE and dominates the pick;
// between 20-60 min the v7.9.23 material gate (>=4 unprocessed) applies.
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
    if (age < 20 * 60 * 1000) return 0; // v7.9.41 (B2): never twice within 20 min (was 30)
    // v7.9.23: 10 unprocessed was unreachable at real episode counts (the organism carried
    // ~6 total), so the dream never fired and the self-narrative stayed empty. Lower the
    // threshold to 4 and add an age fallback: after 6h with at least one unprocessed episode,
    // allow the dream regardless. The 30-min minimum-age floor above is unchanged.
    // v7.9.41 (B2): hard overdue — after 60 min with ANY material the dream
    // is due and must WIN the pick (dominant by contract; field 18.07.: four
    // idle hours, zero dreams). This subsumes the old 6-h fallback.
    if (age >= 60 * 60 * 1000 && unprocessed >= 1) return 10.0;
    if (unprocessed < 4) return 0; // 20-60 min: material gate unchanged (v7.9.23)

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
