// GENESIS — revolution/ApprovalGate.js
// ═══════════════════════════════════════════════════════════════
// v7.6.0: Extracted from AgentLoop — approval/rejection lifecycle.
// Trust-gated bypass via TrustLevelSystem.
// ═══════════════════════════════════════════════════════════════

'use strict';

const { createLogger } = require('../core/Logger');
const _log = createLogger('ApprovalGate');

const DEFAULT_TIMEOUT_MS = 60_000;

class ApprovalGate {
  /**
   * @param {{ bus: *, trustLevelSystem?: *, timeoutMs?: number }} opts
   */
  constructor({ bus, trustLevelSystem, timeoutMs }) {
    this.bus = bus;
    this.trustLevelSystem = trustLevelSystem || null;
    this._timeoutMs = timeoutMs || DEFAULT_TIMEOUT_MS;
    this._pending = null;
    /** @type {string|null} */ this.currentGoalId = null;
  }

  /**
   * Request user approval. Returns a Promise<boolean>.
   * Auto-rejects after timeout. Trust system can auto-approve.
   */
  request(action, description) {
    // Trust-gated bypass
    if (this.trustLevelSystem) {
      const trust = this.trustLevelSystem.checkApproval(action);
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
      const timeout = setTimeout(() => {
        this._pending = null;
        resolve(false);
      }, this._timeoutMs);

      this._pending = {
        action, description,
        resolve: (approved) => {
          clearTimeout(timeout);
          this._pending = null;
          resolve(approved);
        },
        reject: () => {
          clearTimeout(timeout);
          this._pending = null;
          resolve(false);
        },
      };

      this.bus.fire('agent-loop:approval-needed', {
        action, description,
        goalId: this.currentGoalId,
      }, { source: 'ApprovalGate' });
    });
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
