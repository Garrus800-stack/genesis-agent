// GENESIS — revolution/ApprovalGate.js
// ═══════════════════════════════════════════════════════════════
// Extracted from AgentLoop — approval/rejection lifecycle.
// Trust-gated bypass via TrustLevelSystem.
// ═══════════════════════════════════════════════════════════════

'use strict';

const { createLogger } = require('../core/Logger');
const _log = createLogger('ApprovalGate');

// v7.9.1: Default timeout raised from 60s to 5 minutes after live-run
// observation (2026-05-17) where the user saw the approval card briefly
// appear, looked away, and the 60s timeout auto-rejected before they
// could click. The auto-reject then cascaded into the goal-reject-loop
// (see GoalDriverFailurePolicy v7.9.1 cooldown). 5 minutes gives a real
// human window to read the plan/blockers and respond consciously.
// Override via settings.json `approval.timeoutMs` or constructor opt.
const DEFAULT_TIMEOUT_MS = 300_000;

class ApprovalGate {
  /**
   * @param {{ bus: *, trustLevelSystem?: *, timeoutMs?: number, parent?: * }} opts
   */
  constructor({ bus, trustLevelSystem, timeoutMs, parent }) {
    this.bus = bus;
    this.trustLevelSystem = trustLevelSystem || null;
    this._parent = parent || null; // v7.2.2: Lazy-read for late-bound services
    // v7.9.20: nullish so a passed-in 0 ("no timeout") is preserved. 0 / negative
    // → no auto-reject timer in request(); the prompt stays until approve()/reject().
    this._timeoutMs = (timeoutMs == null) ? DEFAULT_TIMEOUT_MS : timeoutMs;
    this._pending = null;
    /** @type {string|null} */ this.currentGoalId = null;
  }

  /**
   * Request user approval. Returns a Promise<boolean>.
   * Auto-rejects after timeout. Trust system can auto-approve.
   */
  request(action, description, opts = {}) { // v7.9.37 (G2/G4): meta + per-request timeout
    // FIX v7.2.2: Read trustLevelSystem lazily from parent if not set directly.
    // ApprovalGate is constructed during AgentLoop's constructor when
    // trustLevelSystem is still null (not yet late-bound by Container).
    // Reading from the parent at request-time picks up the live reference.
    const tls = this.trustLevelSystem || this._parent?.trustLevelSystem;

    // Trust-gated bypass
    if (tls) {
      const trust = tls.checkApproval(action);
      if (trust.approved) {
        _log.info(`[TRUST] Auto-approved "${action}" — ${trust.reason}`);
        this.bus.fire('agent-loop:auto-approved', {
          action, description,
          reason: trust.reason,
          goalId: this.currentGoalId,
        }, { source: 'ApprovalGate' });
        return Promise.resolve(true);
      }
    }

    return new Promise((resolve) => {
      // v7.9.20: only arm an auto-reject timer when a positive timeout is configured.
      // _timeoutMs <= 0 means "stay until the user clicks" — the prompt persists in the
      // Dashboard indefinitely and resolves only through approve()/reject().
      const _effTimeout = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : this._timeoutMs;
      const timeout = _effTimeout > 0
        ? setTimeout(() => { this._pending = null; resolve(opts.onTimeout === 'timeout' ? 'timeout' : false); }, _effTimeout)
        : null;

      this._pending = {
        action, description,
        resolve: (approved) => {
          if (timeout) clearTimeout(timeout);
          this._pending = null;
          resolve(approved);
        },
        reject: () => {
          if (timeout) clearTimeout(timeout);
          this._pending = null;
          resolve(false);
        },
      };

      const _tls = this.trustLevelSystem || this._parent?.trustLevelSystem;
      this.bus.fire('agent-loop:approval-needed', {
        action, description,
        goalId: this.currentGoalId,
        ...(opts.meta || {}),
        trustLevel: _tls?._level ?? null, // v7.9.37 (G2): the card names the level
      }, { source: 'ApprovalGate' });
    });
  }

  /**
   * v7.9.37 (G2/G3): build a human-readable plan-approval card. Field 11.07.:
   * the card said only "Unknown step type" tech-speak — no goal, no why, no
   * consequence. Self-modification content is named and never trust-bypassed.
   */
  buildPlanCard({ goalDescription, dryRun, presetGoal }) {
    const selfMod = (presetGoal?.steps || []).some(s =>
      /(create|relocate|move|write|generate)\b[^\n]{0,80}\bsrc[\\/]/i.test(s?.description || ''));
    const issueLines = (dryRun.validation?.results || [])
      .flatMap(r => (r.issues || []).map(i => `- Step ${r.stepIndex} (${r.type}): ${i}`))
      .slice(0, 6).join('\n') || String(dryRun.summary || '').slice(0, 400);
    return {
      action: selfMod ? 'self-modification' : 'plan-has-issues',
      description: `Approval needed — goal: "${(goalDescription || '').slice(0, 120)}"\n` +
        `Why: ${presetGoal?.source || 'agent'} plan with ${dryRun.validation?.totalIssues ?? '?'} real blocker(s)${selfMod ? ' (contains self-modification)' : ''}\n` +
        `${issueLines}\n\nApprove = run this plan anyway · Reject = drop the goal`,
      opts: { timeoutMs: 10 * 60 * 1000, onTimeout: 'timeout',
        meta: { goalDescription: (goalDescription || '').slice(0, 200), selfMod } },
    };
  }

  /** v7.9.37 (G4): one-call plan approval — build the card, ask, return true/false/'timeout'. */
  requestPlanCard(input) {
    const c = this.buildPlanCard(input);
    return this.request(c.action, c.description, c.opts);
  }

  /** User approves the pending action. */
  approve() {
    if (this._pending) {
      this._pending.resolve(true);
    }
  }

  /** User rejects the pending action. */
  reject(reason = 'User rejected') {
    if (this._pending) {
      _log.info(`[APPROVAL] Rejected: ${reason}`);
      this._pending.reject();
    }
  }

  /** @returns {boolean} Whether an approval is pending. */
  get isPending() {
    return this._pending !== null;
  }

  /** @returns {{ action: string, description: string }|null} */
  get pendingAction() {
    return this._pending
      ? { action: this._pending.action, description: this._pending.description }
      : null;
  }

  /** Cancel any pending approval (used on stop). */
  cancel() {
    if (this._pending) {
      this._pending.reject();
    }
  }
}

module.exports = { ApprovalGate };
