// @ts-checked-v5.7
// ============================================================
// GENESIS — CommandHandlersGoals.js (v7.4.2 "Kassensturz")
//
// Extracted from CommandHandlers.js as part of the v7.4.2 domain
// split. Handles Goals, Plans, and Journal:
//   - plans    — render IdleMind.getPlans()
//   - goals    — add/cancel/show goals via GoalStack
//   - journal  — render IdleMind.readJournal(10)
//
// journal grouped here because it renders GoalStack-adjacent
// journal entries from the same agent-state subsystem.
//
// Prototype-Delegation from CommandHandlers.js via Object.assign.
// External API unchanged.
// ============================================================

'use strict';

const commandHandlersGoals = {

  async journal() {
    const entries = this.idleMind.readJournal(10);
    if (entries.length === 0) return this.lang.t('journal.empty');
    return `**Genesis Journal** (${this.lang.t('journal.last', { n: entries.length })}):\n\n${entries.map(e =>
      `**[${e.timestamp?.split('T')[0]} ${e.activity}]**\n${e.thought}`
    ).join('\n\n')}`;
  },

  async plans() {
    const plans = this.idleMind.getPlans();
    if (plans.length === 0) return this.lang.t('plans.empty');
    return `**${this.lang.t('plans.title')}** (${plans.length}):\n\n${plans.slice(-5).map(p =>
      `**${p.title}** [${p.priority}] -- ${p.status}\n${p.description?.slice(0, 200) || ''}`
    ).join('\n\n')}`;
  },

  async goals(message) {
    if (!this.goalStack) return this.lang.t('goals.unavailable');

    // v7.5.0: SLASH-ONLY entry. The IntentRouter only routes here
    // when message contains a "/goal" / "/ziel" / "/ziele" / "/goals"
    // slash-prefix (see slash-commands.js + IntentPatterns.js).
    // Free-text mentions of "goal/ziel" no longer trigger this
    // handler — they fall through to 'general' and Genesis answers
    // them conversationally with goal data injected as context.
    //
    // Subcommand parser: extract everything after the slash-prefix.
    // Format: /<prefix> <subcommand> [args...]
    //         /<prefix>                  → list (bare)
    const slashMatch = message.match(/(?:^|\s)\/(?:goal|ziel|ziele|goals)\b\s*(\w+)?\s*(.*)$/i);
    if (!slashMatch) {
      // Reached without a slash → defensive fallback to list. Should
      // not happen with the slash-discipline guard but stays safe.
      return this._renderGoalsList();
    }

    const subcommand = (slashMatch[1] || '').toLowerCase();
    const arg = (slashMatch[2] || '').trim();

    // Bare /goal — show list
    if (!subcommand) return this._renderGoalsList();

    // /goal add <text>  /goal set <text>  /goal new <text>  /goal create <text>
    // German aliases: setze, erstelle, hinzufuegen, hinzufügen
    if (/^(?:add|set|new|create|setze|erstelle|hinzufuegen|hinzufügen)$/i.test(subcommand)) {
      return this._addGoalCommand(arg);
    }

    // /goal cancel <n>  /goal abandon <n>
    // German aliases: lösch, entfern, abbrechen, stopp
    if (/^(?:cancel|abandon|lösch|löschen|löschen|entfern|entfernen|abbrechen|abbreche|stopp|stoppen)$/i.test(subcommand)) {
      return this._cancelGoalCommand(arg);
    }

    // /goal clear  /goal reset  → cancel-all with confirmation
    // German aliases: alle (typically used as: /goal lösche alle)
    if (/^(?:clear|reset|alle?)$/i.test(subcommand)) {
      return this._cancelAllCommand();
    }

    // /goal list  /goal show  /goal status
    // German aliases: liste, zeige, zeigen
    if (/^(?:list|show|status|liste|zeige?|zeigen)$/i.test(subcommand)) {
      return this._renderGoalsList();
    }

    // v7.5.0 Pass 2: Negotiation subcommands
    // /goal confirm <pendingId>
    if (/^(?:confirm|bestätige|bestätigen)$/i.test(subcommand)) {
      return this._confirmPendingCommand(arg);
    }
    // /goal revise <pendingId>: <new text>
    if (/^(?:revise|überarbeite|überarbeiten|ändere|aendere|ändern)$/i.test(subcommand)) {
      return this._revisePendingCommand(arg);
    }
    // /goal dismiss <pendingId>
    if (/^(?:dismiss|verwerfe|verwerfen|drop|reject)$/i.test(subcommand)) {
      return this._dismissPendingCommand(arg);
    }

    // /goal help
    if (/^(?:help|hilfe|h|\?)$/i.test(subcommand)) {
      return this.lang.t('goals.help');
    }

    return this.lang.t('goals.unknown_subcommand', { sub: subcommand });
  },

  // ── Subcommand implementations ──────────────────────────

  /** /goal add <text> — with optional negotiate-before-add flow */
  async _addGoalCommand(description) {
    if (!description || description.length < 2) {
      return this.lang.t('goals.add_empty');
    }
    // v7.5.0 Pass 2: Negotiate-before-add flow.
    // When agency.negotiateBeforeAdd is true, we don't directly add the
    // goal — instead we propose it as pending and trigger a clarification
    // dialog. The actual addGoal() happens after user confirmation via
    // /goal confirm <pendingId>.
    const negotiate = this.settings?.get?.('agency.negotiateBeforeAdd') === true;
    if (negotiate && typeof this.goalStack.proposePending === 'function') {
      const pendingId = this.goalStack.proposePending(description, 'user', 'high');
      if (pendingId) {
        // Fire negotiation event for PromptBuilder/agent loop to pick up.
        try {
          this.bus.fire('goal:negotiation-start', {
            pendingId,
            description,
            source: 'user',
          }, { source: 'CommandHandlersGoals' });
        } catch (_e) { /* never let event-fire break the response */ }
        return this.lang.t('goals.proposed', { description, pendingId });
      }
      // Fallback if proposePending returned null (rare) → direct add.
    }
    // Direct path (legacy, default in v7.5.0)
    const goal = await this.goalStack.addGoal(description, 'user', 'high');
    if (!goal) return this.lang.t('goals.add_failed');
    return this.lang.t('goals.created', { description: goal.description }) +
      `\n\n**${this.lang.t('goals.steps')}:**\n${goal.steps.map((s, i) =>
      `${i + 1}. [${s.type}] ${s.action}`
    ).join('\n')}`;
  },

  /** /goal cancel <n> — cancel single goal by index */
  _cancelGoalCommand(arg) {
    const idxNum = parseInt(arg, 10);
    if (isNaN(idxNum) || idxNum < 1) {
      return this.lang.t('goals.cancel_needs_number');
    }
    const idx = idxNum - 1;
    const active = this.goalStack.getActiveGoals();
    if (idx >= active.length) {
      return this.lang.t('goals.cancel_one_not_found', { idx: idxNum, count: active.length });
    }
    const target = active[idx];
    this.goalStack.abandonGoal(target.id);
    this.bus.emit('goal:abandoned', {
      id: target.id, description: target.description,
    }, { source: 'CommandHandlers' });
    return this.lang.t('goals.cancel_one_done', { description: target.description });
  },

  /** /goal clear — cancel all active goals (with 30s confirmation) */
  _cancelAllCommand() {
    const active = this.goalStack.getActiveGoals();
    if (active.length === 0) return this.lang.t('goals.none_active');
    // v7.5.0: confirmation guard. First call within 30s sets a token,
    // second call within window executes. Single-goal case: still
    // ask, because user might have meant /goal cancel 1.
    const now = Date.now();
    const TTL = 30_000;
    if (this._cancelAllConfirmedAt && (now - this._cancelAllConfirmedAt) < TTL) {
      // Confirmation valid — execute
      this._cancelAllConfirmedAt = null;
      let count = 0;
      for (const g of active) {
        this.goalStack.abandonGoal(g.id);
        this.bus.emit('goal:abandoned', {
          id: g.id, description: g.description,
        }, { source: 'CommandHandlers' });
        count++;
      }
      return this.lang.t('goals.cancel_all_done', { count });
    }
    if (this._cancelAllConfirmedAt && (now - this._cancelAllConfirmedAt) >= TTL) {
      // Stale — reset and ask again
      this._cancelAllConfirmedAt = null;
    }
    // First call — ask for confirmation
    this._cancelAllConfirmedAt = now;
    return this.lang.t('goals.cancel_all_confirm', { count: active.length });
  },

  /** /goal confirm <pendingId> — confirm pending goal proposal */
  async _confirmPendingCommand(pendingId) {
    if (!pendingId) return this.lang.t('goals.pending_id_missing');
    if (typeof this.goalStack.confirmPending !== 'function') {
      return this.lang.t('goals.negotiation_unavailable');
    }
    try {
      const goal = await this.goalStack.confirmPending(pendingId);
      if (!goal) return this.lang.t('goals.pending_not_found', { pendingId });
      return this.lang.t('goals.confirmed', { description: goal.description });
    } catch (err) {
      return this.lang.t('goals.confirm_failed', { error: err.message });
    }
  },

  /** /goal revise <pendingId>: <new text> — revise pending */
  _revisePendingCommand(arg) {
    const m = arg.match(/^(\S+)\s*[:\s]\s*(.+)$/);
    if (!m) return this.lang.t('goals.revise_format');
    const [, pendingId, newDescription] = m;
    if (typeof this.goalStack.revisePending !== 'function') {
      return this.lang.t('goals.negotiation_unavailable');
    }
    const ok = this.goalStack.revisePending(pendingId, newDescription.trim());
    if (!ok) return this.lang.t('goals.pending_not_found', { pendingId });
    // Re-fire negotiation start with new description
    try {
      this.bus.fire('goal:negotiation-start', {
        pendingId,
        description: newDescription.trim(),
        source: 'user',
        revised: true,
      }, { source: 'CommandHandlersGoals' });
    } catch (_e) { /* never break */ }
    return this.lang.t('goals.revised', { description: newDescription.trim(), pendingId });
  },

  /** /goal dismiss <pendingId> — drop pending proposal */
  _dismissPendingCommand(pendingId) {
    if (!pendingId) return this.lang.t('goals.pending_id_missing');
    if (typeof this.goalStack.dismissPending !== 'function') {
      return this.lang.t('goals.negotiation_unavailable');
    }
    const description = this.goalStack.dismissPending(pendingId);
    if (description == null) return this.lang.t('goals.pending_not_found', { pendingId });
    return this.lang.t('goals.dismissed', { description });
  },

  /** Render the active/recent goals list */
  _renderGoalsList() {
    const all = this.goalStack.getAll ? this.goalStack.getAll() : [];
    if (all.length === 0) return this.lang.t('goals.empty');
    const lines = [`**Genesis — ${this.lang.t('goals.title')}**`, ''];
    for (const g of all.slice(-8)) {
      const icon = g.status === 'completed' ? '[OK]'
                 : g.status === 'active'    ? '[>>]'
                 : g.status === 'failed'    ? '[!!]'
                 : '[--]';
      const progress = (g.steps && g.steps.length > 0) ? ` (${g.currentStep || 0}/${g.steps.length})` : '';
      lines.push(`${icon} **${g.description}**${progress} [${g.priority}]`);
      if (g.status === 'active' && g.steps && g.steps[g.currentStep]) {
        lines.push(`    ${this.lang.t('goals.next_step')}: ${g.steps[g.currentStep].action}`);
      }
    }
    // Append pending goals if any
    if (typeof this.goalStack.getPending === 'function') {
      const pending = this.goalStack.getPending();
      if (pending && pending.length > 0) {
        lines.push('');
        lines.push(`**${this.lang.t('goals.pending_title')}:**`);
        for (const p of pending) {
          lines.push(`[??] **${p.description}** \`${p.id}\``);
        }
      }
    }
    return lines.join('\n');
  },

};

module.exports = { commandHandlersGoals };
