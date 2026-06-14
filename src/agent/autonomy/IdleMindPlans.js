// ============================================================
// GENESIS — autonomy/IdleMindPlans.js (v7.9.22)
//
// Plan/proposal persistence plus the goal<->plan link (Item 4),
// extracted from IdleMind.js for the File Size Guard (Item 15).
// All state is initialised by IdleMind's constructor; this mixin
// is pure behaviour joined onto the prototype.
// ============================================================
'use strict';

const fs = require('fs');
const { safeJsonParse, atomicWriteFileSync } = require('../core/utils');
const { createLogger } = require('../core/Logger');
const _log = createLogger('IdleMind');

const plansMixin = {
  getPlans() { return this.plans; },

  updatePlanStatus(planId, status) {
    const plan = this.plans.find(p => p.id === planId);
    if (plan) {
      plan.status = status;
      plan.updated = new Date().toISOString();
      this._savePlans();
    }
  },

  _loadPlans() {
    try {
      if (this.storage) return this.storage.readJSON('plans.json', []);
      if (fs.existsSync(this.planPath)) return safeJsonParse(fs.readFileSync(this.planPath, 'utf-8'), null, 'IdleMind');
    } catch (err) { _log.debug('[IDLE] Plan load failed:', err.message); }
    return [];
  },

  _savePlans() {
    try {
      if (this.storage) { this.storage.writeJSONDebounced('plans.json', this.plans); return; }
      if (!fs.existsSync(this.storageDir)) fs.mkdirSync(this.storageDir, { recursive: true });
      // FIX v5.1.0 (N-3): Atomic write fallback when StorageService unavailable.
      atomicWriteFileSync(this.planPath, JSON.stringify(this.plans, null, 2), 'utf-8');
    } catch (err) {
      _log.warn('[IDLE-MIND] Plan save failed:', err.message);
    }
  },

  // FIX v5.5.0 (H-1): Synchronous persist for shutdown path.
  _savePlansSync() {
    try {
      if (this.storage) { this.storage.writeJSON('plans.json', this.plans); return; }
      if (!fs.existsSync(this.storageDir)) fs.mkdirSync(this.storageDir, { recursive: true });
      atomicWriteFileSync(this.planPath, JSON.stringify(this.plans, null, 2), 'utf-8');
    } catch (err) {
      _log.warn('[IDLE-MIND] Plan sync save failed:', err.message);
    }
  },

  // v7.9.20 (D): improvement-proposal persistence (mirrors plans).
  _loadProposals() {
    try {
      if (this.storage) return this.storage.readJSON('proposals.json', []);
      if (fs.existsSync(this.proposalPath)) return safeJsonParse(fs.readFileSync(this.proposalPath, 'utf-8'), null, 'IdleMind');
    } catch (err) { _log.debug('[IDLE] Proposal load failed:', err.message); }
    return [];
  },

  _saveProposals() {
    try {
      if (this.storage) { this.storage.writeJSONDebounced('proposals.json', this.proposals); return; }
      if (!fs.existsSync(this.storageDir)) fs.mkdirSync(this.storageDir, { recursive: true });
      atomicWriteFileSync(this.proposalPath, JSON.stringify(this.proposals, null, 2), 'utf-8');
    } catch (err) {
      _log.warn('[IDLE-MIND] Proposal save failed:', err.message);
    }
  },
  // v7.9.22 Item 4: persist the goal->plan back-link on the plan, so it survives a
  // restart. A falsy goalId (addGoal refused the goal) records no link.
  _linkGoalToPlan(goalId, planId) {
    if (!goalId) return;
    const plan = this.plans.find(p => p.id === planId);
    if (!plan) return;
    plan.goalId = goalId;
    this._savePlans();
  },

  // v7.9.22 Item 4: when a linked goal reaches a terminal state, move its plan off
  // 'new' to match — only if it is not already that status (updatePlanStatus writes
  // unconditionally, so the not-already-that guard lives here).
  _onGoalTerminal(data, status) {
    const goalId = data && data.id;
    if (!goalId) return;
    const plan = this.plans.find(p => p.goalId === goalId);
    if (plan && plan.status !== status) {
      this.updatePlanStatus(plan.id, status);
    }
  },

  // v7.9.22 Item 4: subscribe to the three terminal goal states GoalPersistence
  // archives, so a plan whose goal completes, fails, or is abandoned no longer
  // strands at 'new'. Uses the existing _sub helper.
  _subscribeGoalTerminal() {
    this._sub('goal:completed', (data) => this._onGoalTerminal(data, 'completed'), { source: 'IdleMind' });
    this._sub('goal:failed', (data) => this._onGoalTerminal(data, 'failed'), { source: 'IdleMind' });
    this._sub('goal:abandoned', (data) => this._onGoalTerminal(data, 'abandoned'), { source: 'IdleMind' });
  },

  // v7.9.22 R2: heal a plan whose goal<->plan link predates Item 4 (or was lost to a crash
  // between a goal's creation and its terminal event). Item 4's forward path cannot reach a
  // plan whose goal terminated before the link existed — it strands at 'new' while the goal
  // sits archived as terminal. This standing, idempotent boot pass bridges the two by the only
  // shared key: the plan's title is the goal's description (the Plan activity creates the goal
  // via addGoal(title, …), and GoalStack.addGoal's first parameter is description). It considers
  // only plans with no goalId and a non-terminal status; on exactly one terminal archived goal
  // whose description equals the title it adopts that goal's id and terminal status; on zero or
  // many it leaves the plan untouched (the single-match rule guards a title collision; the
  // 50-cap archive means a goal already rolled out leaves its plan as it is).
  _reconcilePreLinkPlans() {
    const TERMINAL = new Set(['completed', 'failed', 'abandoned']);
    const candidates = (this.plans || []).filter(p => p && !p.goalId && !TERMINAL.has(p.status));
    if (candidates.length === 0) return;
    let archive;
    try {
      archive = this.storage ? this.storage.readJSON('goals/archive.json', []) : [];
    } catch (_e) { return; }
    if (!Array.isArray(archive) || archive.length === 0) return;
    let healed = 0;
    for (const plan of candidates) {
      const matches = archive.filter(g => g && TERMINAL.has(g.status) && g.description === plan.title);
      if (matches.length !== 1) continue;   // zero or a title collision → leave it untouched
      plan.goalId = matches[0].id;
      plan.status = matches[0].status;
      plan.updated = new Date().toISOString();
      healed++;
    }
    if (healed > 0) {
      this._savePlans();
      _log.info(`[IDLE] R2: reconciled ${healed} pre-link plan(s) against archived terminal goals`);
    }
  },
};

module.exports = { plansMixin };
