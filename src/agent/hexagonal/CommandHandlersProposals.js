// @ts-checked-v5.7
// ============================================================
// GENESIS — CommandHandlersProposals.js (v7.9.20)
//
// Self-improvement proposal handlers, merged onto CommandHandlers via
// Object.assign (same prototype-delegation pattern as the other
// CommandHandlers* mixins). Kept in its own mixin so CommandHandlersGoals
// does not grow past its structure cap (Contract v742).
//
//   listProposals()   — render the open (status 'proposed') proposals
//   _acceptProposal()  — mark a proposal 'attempted' (human approved)
//   _rejectProposal()  — mark a proposal 'dismissed' + start a cooldown so
//                         the same insight is not re-proposed for a while
//
// The proposals live on IdleMind (idleMind.proposals), written by the
// ProposeImprovements activity. These handlers only read/transition them.
// ============================================================

'use strict';

const DISMISS_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

const commandHandlersProposals = {

  async listProposals() {
    const proposals = (this.idleMind && this.idleMind.proposals) || [];
    const open = proposals.filter(p => p && p.status === 'proposed');
    if (open.length === 0) return this.lang ? this.lang.t('proposals.empty') : 'No open improvement proposals.';
    return open.map(p => `- [${p.id}] ${p.title}${p.file ? ` (${p.file})` : ''}`).join('\n');
  },

  // Human approved — record intent to attempt. Genesis never self-applies code;
  // the proposal is marked 'attempted' for the human/agent to act on.
  async _acceptProposal(id) {
    const proposals = (this.idleMind && this.idleMind.proposals) || [];
    const p = proposals.find(x => x && x.id === id);
    if (!p) return null;
    p.status = 'attempted';
    p.decidedAt = new Date().toISOString();
    if (this.idleMind && typeof this.idleMind._saveProposals === 'function') this.idleMind._saveProposals();
    return p;
  },

  // Human rejected — dismiss and start a cooldown so the same insight does not
  // immediately re-surface (the cooldown is carried on the proposal itself and
  // honoured by improvement-proposals.buildProposals).
  async _rejectProposal(id) {
    const proposals = (this.idleMind && this.idleMind.proposals) || [];
    const p = proposals.find(x => x && x.id === id);
    if (!p) return null;
    p.status = 'dismissed';
    p.decidedAt = new Date().toISOString();
    p.cooldownUntil = Date.now() + DISMISS_COOLDOWN_MS;
    if (this.idleMind && typeof this.idleMind._saveProposals === 'function') this.idleMind._saveProposals();
    return p;
  },

};

module.exports = { commandHandlersProposals };
