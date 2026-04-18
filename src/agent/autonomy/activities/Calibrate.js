// @ts-checked-v5.7
// ============================================================
// GENESIS — activities/Calibrate.js (v7.3.1)
// Meta-cognitive adaptation via AdaptiveStrategy.
// Conditional: adaptiveStrategy service registered.
// Boost: Genome.consolidation.
// ============================================================

'use strict';

const { createLogger } = require('../../core/Logger');
const _log = createLogger('IdleMind');

module.exports = {
  name: 'calibrate',
  weight: 1.5,
  cooldown: 0,

  shouldTrigger(ctx) {
    // Availability gate
    if (!ctx.hasContainerService('adaptiveStrategy')) return 0;

    let boost = 1.0;

    // Genome consolidation
    const con = ctx.snap.genomeTraits?.consolidation;
    if (con !== undefined) boost *= (0.5 + con);

    return boost;
  },

  async run(idleMind) {
    const strategy = idleMind.bus._container?.resolve?.('adaptiveStrategy');
    if (!strategy) return 'AdaptiveStrategy not available.';

    try {
      const result = await strategy.runCycle();
      if (!result) {
        const summary = 'Calibration: no adaptation needed — all metrics stable.';
        idleMind._journal('calibrate', summary);
        return summary;
      }

      const summary = `Calibration: ${result.type} adaptation (${result.status}). ` +
        `Evidence: ${result.evidence || 'n/a'}` +
        (result.delta != null ? `. Delta: ${result.delta >= 0 ? '+' : ''}${Math.round(result.delta * 100)}pp` : '');

      idleMind._journal('calibrate', summary);
      return summary;
    } catch (err) {
      _log.warn('[IDLE-MIND] Calibration failed:', err.message);
      return `Calibration failed: ${err.message}`;
    }
  },
};
