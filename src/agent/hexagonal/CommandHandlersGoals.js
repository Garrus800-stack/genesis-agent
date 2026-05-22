// @ts-checked-v5.7
// ============================================================
// GENESIS — CommandHandlersGoals.js (v7.4.2 "Kassensturz")
//
// Extracted from CommandHandlers.js as part of the v7.4.2 domain
// split. Handles Goals, Plans, Journal, and Affect-Trail:
//   - plans         — render IdleMind.getPlans()
//   - goals         — add/cancel/show goals via GoalStack
//   - journal       — render IdleMind.readJournal(10)
//   - affect-trail  — render KoennenCandidateLog boundaries (v7.8.9)
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
    this.bus.fire('goal:abandoned', {
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
        this.bus.fire('goal:abandoned', {
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

  // v7.8.9 (koennen-v789 contract): /affect-trail [n] — show recent
  // AgentLoop boundaries with affect snapshot, gate-pass status, current θ,
  // and overall pass-rate statistics. Surfaces the calibration data for
  // v7.9.0 — Garrus can inspect what kinds of trajectories Genesis is
  // tagging as skill-candidates and tune EmotionalState reactivity if
  // affect varies too little.
  async affectTrail(message) {
    if (!this.koennenCandidateLog) {
      return 'KoennenCandidateLog not available.';
    }

    const m = (message || '').match(/\/(?:affect-trail|affekt-trail)\s+(\d+)/i);
    const limit = m ? parseInt(m[1], 10) : 20;

    const boundaries = this.koennenCandidateLog.getRecentBoundaries(limit);
    const stats = this.koennenCandidateLog.getStats();

    if (!boundaries || boundaries.length === 0) {
      return 'No AgentLoop boundaries recorded yet.\n\n' +
             'Affect-encoding only fires when Genesis pursues a Goal via the AgentLoop. ' +
             'Plain chat, /create-skill, /settings etc. do NOT trigger it. ' +
             'Start a Goal (use the goals panel or "neues Ziel: ..." in chat) and let Genesis work on it — ' +
             'boundaries appear here as soon as the first step completes.';
    }

    const passPct = (stats.gatePassRate * 100).toFixed(0);
    const header = `**Affect Trail** (last ${boundaries.length} of ${stats.totalEvaluated}, ` +
      `${passPct}% pass rate, θ=${stats.currentTheta.toFixed(2)}` +
      (stats.missedStarts > 0 ? `, ${stats.missedStarts} missed starts` : '') + `):`;

    const lines = boundaries.map(b => {
      const sym = b.gatePass ? '✓' : '·';
      const sat = (b.affect.satisfaction_end ?? 0).toFixed(2);
      const frP = (b.affect.frustration_peak ?? 0).toFixed(2);
      const stepCount = b.affect.step_count || 0;
      const surA = stepCount > 0
        ? (b.affect.surprise_sum / stepCount).toFixed(2)
        : '—';
      const title = (b.taskTitle || '(unnamed)').slice(0, 50);
      return `${sym} ${title} — sat=${sat} frP=${frP} surA=${surA}`;
    });

    return `${header}\n\n${lines.join('\n')}`;
  },

  // v7.9.4 (koennen-promotion-v794 contract): /skills-pending — list ALL
  // Können skills grouped by status (promoted, rehearsing, pending,
  // quarantined, discarded). Replaces the v7.9.0 single-status view.
  // Built-in skills (src/skills/) are listed separately at top.
  skillsPending(_message) {
    const fs = require('fs');
    const path = require('path');

    const genesisDir = this._genesisDir || '.genesis';
    const pendingDir = path.join(genesisDir, 'koennen', 'skills-pending');

    const tracker = this.skillEffectivenessTracker || null;
    const sm = this.skillManager || null;

    // Built-in skills first (just names).
    let builtinLine = '';
    if (sm && typeof sm.listSkills === 'function') {
      try {
        const all = sm.listSkills();
        const builtin = all.filter(s => !s.koennen);
        const names = builtin.map(s => s.name).join(', ');
        if (builtin.length > 0) builtinLine = `**Built-in** (${builtin.length}): ${names}\n\n`;
      } catch (_e) { /* ignore */ }
    }

    if (!fs.existsSync(pendingDir)) {
      return (builtinLine || '') + 'No Können skills yet. SkillCrystallizer has not produced any extractions.';
    }

    let entries;
    try {
      entries = fs.readdirSync(pendingDir, { withFileTypes: true })
        .filter(e => e.isDirectory());
    } catch (err) {
      return `Could not read skills-pending directory: ${err.message}`;
    }

    if (entries.length === 0) {
      return (builtinLine || '') + 'No Können skills yet.';
    }

    // Group by status. Legacy manifests without status default to 'pending'.
    // Malformed manifests get a stub entry under 'pending' with "(no description)"
    // so the user sees the directory exists and can decide what to do — this
    // matches v7.9.0 behavior preserved by the koennen-crystallizer-v790 contract.
    const groups = { promoted: [], rehearsing: [], pending: [], quarantined: [], discarded: [] };
    for (const e of entries) {
      const manifestPath = path.join(pendingDir, e.name, 'skill-manifest.json');
      let manifest = null;
      try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
      catch { /* malformed — fall through to stub */ }

      if (!manifest) {
        groups.pending.push({
          name: e.name, runs: 0, lb: '—', rehearsals: 0, distinct: 0,
          manifest: { koennen: {} }, desc: '(no description)',
        });
        continue;
      }

      const status = manifest.status || 'pending';
      if (!groups[status]) continue;

      const stats = tracker ? tracker.getStats(e.name) : null;
      const runs = stats ? stats.total : 0;
      const lb = stats ? (stats.wilsonLB * 100).toFixed(0) + '%' : '—';
      const rehearsals = (manifest.koennen && manifest.koennen.rehearsalCount) || 0;
      const distinct = manifest.koennen && Array.isArray(manifest.koennen.rehearsedInputHashes)
        ? new Set(manifest.koennen.rehearsedInputHashes).size : 0;
      const desc = manifest.description || '(no description)';

      groups[status].push({ name: e.name, runs, lb, rehearsals, distinct, manifest, desc });
    }

    const totalKoennen = Object.values(groups).reduce((s, arr) => s + arr.length, 0);
    if (totalKoennen === 0) {
      return (builtinLine || '') + 'No Können skills yet.';
    }

    const out = [builtinLine, `**Skills** (${totalKoennen} Können total):\n`];

    if (groups.promoted.length > 0) {
      out.push(`**Promoted** (${groups.promoted.length}):`);
      for (const s of groups.promoted) {
        const promotedAt = s.manifest.koennen && s.manifest.koennen.promotedAt
          ? new Date(s.manifest.koennen.promotedAt).toISOString().slice(0, 10) : '—';
        out.push(`  ● ${s.name} — Wilson ${s.lb} (${s.runs} invokes, since ${promotedAt})`);
      }
    }
    if (groups.rehearsing.length > 0) {
      out.push(`\n**Rehearsing** (${groups.rehearsing.length}):`);
      for (const s of groups.rehearsing) {
        out.push(`  ○ ${s.name} — Wilson ${s.lb}, ${s.rehearsals} rehearsals, ${s.distinct} distinct inputs`);
      }
    }
    if (groups.pending.length > 0) {
      out.push(`\n**Pending** (${groups.pending.length}):`);
      for (const s of groups.pending) {
        const cAt = s.manifest.koennen && s.manifest.koennen.crystallizedAt
          ? new Date(s.manifest.koennen.crystallizedAt).toISOString().slice(0, 10) : '—';
        // Include the description (or "(no description)" stub) so malformed
        // manifests still render a visible row per the v7.9.0 contract.
        out.push(`  · ${s.name} — ${s.desc} (crystallized ${cAt})`);
      }
    }
    if (groups.quarantined.length > 0) {
      out.push(`\n**Quarantined** (${groups.quarantined.length}):`);
      for (const s of groups.quarantined) {
        out.push(`  ⚠ ${s.name} — Wilson ${s.lb} (${s.runs} invokes)`);
      }
    }
    if (groups.discarded.length > 0) {
      out.push(`\n**Discarded** (${groups.discarded.length}):`);
      for (const s of groups.discarded) {
        const reason = s.manifest.koennen && s.manifest.koennen.discardedReason
          ? `"${s.manifest.koennen.discardedReason.slice(0, 60)}"` : '(no reason)';
        out.push(`  ✗ ${s.name} — ${reason}`);
      }
    }

    return out.join('\n');
  },

  // v7.9.4 (koennen-promotion-v794 contract): /skill-info <name> — show
  // full info on one skill including its acquisitionContext biography.
  skillInfo(message) {
    const fs = require('fs');
    const path = require('path');

    const match = message.match(/\/(?:skill-info|skill-bio)\s+(\S+)/i);
    if (!match) return 'Usage: /skill-info <skill-name>';
    const name = match[1];

    const genesisDir = this._genesisDir || '.genesis';
    const manifestPath = path.join(genesisDir, 'koennen', 'skills-pending', name, 'skill-manifest.json');
    if (!fs.existsSync(manifestPath)) {
      return `Skill "${name}" not found in Können directory.`;
    }

    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
    catch (err) { return `Could not read skill manifest: ${err.message}`; }

    const tracker = this.skillEffectivenessTracker || null;
    const stats = tracker ? tracker.getStats(name) : null;
    const ko = manifest.koennen || {};

    const lines = [];
    lines.push(`**Skill: ${name}**`);
    lines.push(`Status: ${manifest.status || 'pending'}`);
    if (ko.promotedAt) lines.push(`Promoted: ${new Date(ko.promotedAt).toISOString().slice(0, 19).replace('T', ' ')}`);
    if (ko.discardedAt) {
      lines.push(`Discarded: ${new Date(ko.discardedAt).toISOString().slice(0, 19).replace('T', ' ')}`);
      if (ko.discardedReason) lines.push(`Discard reason: "${ko.discardedReason}"`);
    }
    if (stats) {
      lines.push(`Wilson-LB: ${(stats.wilsonLB * 100).toFixed(0)}% (${stats.successes}/${stats.total})`);
    } else {
      lines.push('Wilson-LB: — (not yet tracked)');
    }
    const distinctCount = Array.isArray(ko.rehearsedInputHashes) ? new Set(ko.rehearsedInputHashes).size : 0;
    lines.push(`Rehearsals: ${ko.rehearsalCount || 0} (${distinctCount} distinct inputs)`);
    if (ko.crystallizedAt) {
      lines.push(`Crystallized: ${new Date(ko.crystallizedAt).toISOString().slice(0, 10)}`);
    }
    lines.push('');
    lines.push('**Acquisition context:**');
    if (ko.acquisitionContext) {
      lines.push(`"${ko.acquisitionContext}"`);
    } else {
      lines.push('No biography (crystallized before v7.9.4)');
    }
    lines.push('');
    lines.push(`**Description:** ${manifest.description || '(no description)'}`);

    return lines.join('\n');
  },

  // v7.9.4 (koennen-promotion-v794 contract): /skill-discard <name> <reason>
  // soft-discards a skill (status → 'discarded'). Reason min 10 chars.
  // Fires skill:discarded event which CoreMemories picks up as bypass-event.
  async skillDiscard(message) {
    const match = message.match(/\/skill-discard\s+(\S+)\s+(.+)/i);
    if (!match) {
      return 'Usage: /skill-discard <skill-name> <reason (min 10 chars)>';
    }
    const name = match[1];
    const reason = match[2].trim();

    if (reason.length < 10) {
      return 'A discard reason must be at least 10 characters. Be specific about why this skill does not fit.';
    }

    const sm = this.skillManager;
    if (!sm || typeof sm.discardSkill !== 'function') {
      return 'SkillManager not available — cannot discard.';
    }

    try {
      const r = await sm.discardSkill(name, reason);
      return `Discarded skill "${r.name}" with reason:\n"${reason}"\n\nThis is now a Core Memory.`;
    } catch (err) {
      return `Could not discard "${name}": ${err.message}`;
    }
  },

};

module.exports = { commandHandlersGoals };
