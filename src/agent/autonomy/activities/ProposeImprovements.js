// @ts-checked
// ============================================================
// GENESIS — autonomy/activities/ProposeImprovements.js (v7.9.20)
// Idle activity that turns agent-loop-analysis insights (written by the
// pursuit loop into the knowledge graph) into improvement proposals for
// the human to Approve/Reject in the dashboard. It only READS insights —
// it does not create them — and it never modifies code itself. Files a
// self-modification lesson has flagged as regressed (facet O) are excluded.
// ============================================================

'use strict';

const { createLogger } = require('../../core/Logger');
const { buildProposals } = require('./improvement-proposals');
const _log = createLogger('IdleMind');

module.exports = {
  name: 'propose-improvements',
  weight: 0.7,
  cooldown: 0,

  shouldTrigger(ctx) {
    let boost = 0.6;
    const idlePrio = ctx.snap.idlePriorities || {};
    if (idlePrio.plan !== undefined) boost += idlePrio.plan; // shares the planning drive
    return boost;
  },

  async run(idleMind) {
    const kg = idleMind.kg;
    if (!kg || typeof kg.getNodesByType !== 'function') return null;

    // Read agent-loop-analysis insights (defensive about node shape).
    let nodes = [];
    try { nodes = kg.getNodesByType('insight') || []; } catch (_e) { return null; }
    const insights = nodes
      .map(n => {
        const p = (n && (n.properties || n.data)) || n || {};
        return { type: p.type, module: p.module, full: p.full, insight: (n && n.label) || p.full };
      })
      .filter(x => x.type === 'agent-loop-analysis');
    if (insights.length === 0) return null;

    // Facet O: never propose touching a file a self-modification lesson flagged.
    let harmedFiles = [];
    try {
      const lessons = (idleMind.lessonsStore && idleMind.lessonsStore.recall)
        ? (idleMind.lessonsStore.recall('self-modification') || []) : [];
      harmedFiles = lessons
        .map(l => (l && (l.file || (l.strategy && l.strategy.file))) || null)
        .filter(Boolean);
    } catch (_e) { harmedFiles = []; }

    idleMind.proposals = idleMind.proposals || [];
    const fresh = buildProposals(insights, { existing: idleMind.proposals, harmedFiles, now: Date.now() });
    // v7.9.20 (S): proposals normally wait for the human (status 'proposed').
    // They are auto-approved ('attempted', no card) ONLY when self-mod
    // confirmation is off AND the trust level approves SELF_MODIFY (now
    // 'critical' → FULL_AUTONOMY only). On any uncertainty the safe,
    // human-confirmed default stands.
    try {
      const tls = idleMind._trustLevelSystem;
      if (tls && typeof tls.checkApproval === 'function' && typeof tls.selfModRequiresConfirmation === 'function'
          && !tls.selfModRequiresConfirmation() && tls.checkApproval('SELF_MODIFY').approved) {
        for (const p of fresh) p.status = 'attempted';
      }
    } catch (_e) { /* keep proposals human-confirmed */ }
    if (fresh.length > 0) {
      idleMind.proposals = idleMind.proposals.concat(fresh).slice(-20); // bounded store
      if (typeof idleMind._saveProposals === 'function') idleMind._saveProposals();
      _log.info(`[IDLE-MIND] ProposeImprovements: ${fresh.length} new proposal(s) raised`);
    }
    return `proposed ${fresh.length}`;
  },
};
