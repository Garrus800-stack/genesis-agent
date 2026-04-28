// ============================================================
// GENESIS — planning/GoalStackPending.js (v7.5.1)
//
// Extracted from GoalStack.js to keep GoalStack.js below the
// 900-LOC architectural-fitness threshold. Contains the v7.5.0
// pending-goals subsystem (negotiate-before-add): proposals from
// the user that haven't been committed to the active stack yet,
// living transiently in a Map with a 1-hour TTL. Resolved via
// /goal confirm | revise | dismiss. After confirmation, the
// pending entry becomes a real Goal via addGoal() and is removed
// from pendingGoals.
//
// Same prototype-delegation pattern as GoalStackExecution,
// PromptBuilder, ContainerDiagnostics, SelfModel{Parsing,
// Capabilities, SourceRead}, ChatOrchestrator, CommandHandlers.
// External API unchanged — every caller (CommandHandlersGoals,
// AgentLoop, ChatOrchestratorHelpers) keeps working through
// the prototype chain.
// ============================================================

'use strict';

const goalStackPending = {

  /**
   * Propose a goal for negotiation. Returns the pendingId.
   *
   * v7.5.1 (F-fix): dedupes against existing pending entries.
   * Two `/goal add X` in a row used to create two pending entries
   * with identical text — the user would see two proposals, confirm
   * both, and the second confirm would silently fail when addGoal's
   * capability-gate blocked the duplicate. Now: refresh TTL on the
   * existing entry and return its id, so the user sees a single
   * pending entry that stays alive.
   *
   * @param {string} description
   * @param {string} [source] - typically 'user'
   * @param {string} [priority]
   * @returns {string|null} pendingId, or null if description is invalid
   */
  proposePending(description, source = 'user', priority = 'high') {
    if (!description || typeof description !== 'string' || description.length < 2) return null;
    this._sweepExpiredPending();
    const trimmed = description.trim();
    for (const entry of this.pendingGoals.values()) {
      if (entry.description === trimmed) {
        entry.createdAt = Date.now();
        return entry.id;
      }
    }
    const id = `pending_${Date.now().toString(36)}_${(++this._pendingIdSeq).toString(36)}`;
    const entry = { id, description: trimmed, source, priority, createdAt: Date.now() };
    this.pendingGoals.set(id, entry);
    try {
      this.bus.emit('goal:proposed', {
        id, description: entry.description, source,
      }, { source: 'GoalStack' });
    } catch (_e) { /* never break */ }
    return id;
  },

  /**
   * Confirm a pending goal — moves it to the active stack via addGoal.
   * Returns the created Goal, or null if the pendingId is unknown / expired.
   * @param {string} pendingId
   * @returns {Promise<object|null>}
   */
  async confirmPending(pendingId) {
    this._sweepExpiredPending();
    const entry = this.pendingGoals.get(pendingId);
    if (!entry) return null;
    this.pendingGoals.delete(pendingId);
    try {
      this.bus.emit('goal:negotiation-confirmed', {
        pendingId, description: entry.description,
      }, { source: 'GoalStack' });
    } catch (_e) { /* never break */ }
    return await this.addGoal(entry.description, entry.source, entry.priority);
  },

  /**
   * Revise a pending goal's description, keeping it pending.
   * Returns true if found and revised, false if not found.
   * @param {string} pendingId
   * @param {string} newDescription
   * @returns {boolean}
   */
  revisePending(pendingId, newDescription) {
    this._sweepExpiredPending();
    const entry = this.pendingGoals.get(pendingId);
    if (!entry) return false;
    if (!newDescription || typeof newDescription !== 'string' || newDescription.length < 2) return false;
    entry.description = newDescription.trim();
    entry.createdAt = Date.now();  // reset TTL on revision
    try {
      this.bus.emit('goal:negotiation-revised', {
        pendingId, description: entry.description,
      }, { source: 'GoalStack' });
    } catch (_e) { /* never break */ }
    return true;
  },

  /**
   * Dismiss a pending goal. Returns the dismissed description, or null
   * if not found (so caller can show "not found" vs "dismissed: X").
   * @param {string} pendingId
   * @returns {string|null}
   */
  dismissPending(pendingId) {
    this._sweepExpiredPending();
    const entry = this.pendingGoals.get(pendingId);
    if (!entry) return null;
    this.pendingGoals.delete(pendingId);
    try {
      this.bus.emit('goal:negotiation-dismissed', {
        pendingId, description: entry.description,
      }, { source: 'GoalStack' });
    } catch (_e) { /* never break */ }
    return entry.description;
  },

  /**
   * List current pending goals (post-sweep).
   * @returns {Array<{id: string, description: string, source: string, priority: string, createdAt: number}>}
   */
  getPending() {
    this._sweepExpiredPending();
    return Array.from(this.pendingGoals.values());
  },

  /** Drop pending entries older than _pendingTTL. Internal. */
  _sweepExpiredPending() {
    const cutoff = Date.now() - this._pendingTTL;
    for (const [id, entry] of this.pendingGoals) {
      if (entry.createdAt < cutoff) {
        this.pendingGoals.delete(id);
        try {
          this.bus.emit('goal:negotiation-expired', {
            pendingId: id, description: entry.description,
          }, { source: 'GoalStack' });
        } catch (_e) { /* never break */ }
      }
    }
  },

};

module.exports = { goalStackPending };
