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

    // ── Cancel / Abandon goals ────────────────────────────
    // "cancel all goals" / "lösche alle ziele" / "abandon all" / "clear goals"
    const cancelAllMatch = message.match(/(?:cancel|abandon|clear|lösch|entfern|reset).*(?:all|alle).*(?:goal|ziel)/i) ||
                           message.match(/(?:lösch|entfern|clear|reset).*(?:goal|ziel)/i) ||
                           message.match(/(?:goal|ziel).*(?:lösch|entfern|clear|cancel|reset|abandon)/i);
    if (cancelAllMatch) {
      const active = this.goalStack.getActiveGoals();
      if (active.length === 0) return '**Keine aktiven Ziele vorhanden.**';
      let count = 0;
      for (const g of active) {
        this.goalStack.abandonGoal(g.id);
        this.bus.emit('goal:abandoned', { id: g.id, description: g.description }, { source: 'CommandHandlers' });
        count++;
      }
      return `**${count} Ziel(e) abgebrochen.**`;
    }

    // "cancel goal 1" / "lösche ziel 2" / "stopp ziel 3"
    const cancelOneMatch = message.match(/(?:cancel|abandon|lösch|entfern|stopp).*(?:goal|ziel)\s*#?(\d+)/i);
    if (cancelOneMatch) {
      const idx = parseInt(cancelOneMatch[1], 10) - 1;
      const active = this.goalStack.getActiveGoals();
      if (idx < 0 || idx >= active.length) return `**Ziel #${idx + 1} nicht gefunden.** Aktive Ziele: ${active.length}`;
      const target = active[idx];
      this.goalStack.abandonGoal(target.id);
      this.bus.emit('goal:abandoned', { id: target.id, description: target.description }, { source: 'CommandHandlers' });
      return `**Ziel abgebrochen:** ${target.description}`;
    }

    // ── Add a goal ────────────────────────────────────────
    // v7.4.5.fix: bilingual patterns. German keeps its colon-form,
    // English now also matches "set me a goal to ...", "add a goal
    // to ...", "create a new goal: ..." — both with and without
    // colon. Order matters: more specific (colon-form) wins first.
    const addMatch =
      // German: ziel ... setze/erstelle/hinzufuegen/add : <desc>
      message.match(/ziel.*(?:setze|erstelle|hinzufuegen|add).*?:\s*(.+)/i) ||
      // German: setze/erstelle/add ... ziel : <desc>
      message.match(/(?:setze|erstelle|add).*ziel.*?:\s*(.+)/i) ||
      // German colon-free: "setze (mir) ein ziel <desc>" / "erstelle ein ziel <desc>"
      message.match(/(?:setze|erstelle)\s+(?:mir\s+)?(?:ein|das|den)?\s*ziel(?:\s+(?:zu|um|nach|für|fuer))?\s+(.+)/i) ||
      // English: set/create/add ... goal : <desc>
      message.match(/(?:set|create|add).*goal.*?:\s*(.+)/i) ||
      // English colon-free: "set (me) a goal to ...", "add a (new) goal to ...", "create a new goal to ..."
      message.match(/(?:set|create|add)\s+(?:me\s+)?(?:(?:a|an|the|new|another)\s+){0,3}goal\s+(?:to|that|for)?\s+(.+)/i) ||
      // English very-short: "new goal: X" / "new goal X"
      message.match(/^\s*new\s+goal\s*[:]?\s*(.+)/i);
    if (addMatch) {
      const goal = await this.goalStack.addGoal(addMatch[1].trim(), 'user', 'high');
      return this.lang.t('goals.created', { description: goal.description }) +
        `\n\n**${this.lang.t('goals.steps')}:**\n${goal.steps.map((s, i) =>
        `${i + 1}. [${s.type}] ${s.action}`
      ).join('\n')}`;
    }

    // Show active goals
    const active = this.goalStack.getActiveGoals();
    const all = this.goalStack.getAll();

    if (all.length === 0) return this.lang.t('goals.empty');

    const lines = [`**Genesis — ${this.lang.t('goals.title')}**`, ''];
    for (const g of all.slice(-8)) {
      const icon = g.status === 'completed' ? '[OK]' : g.status === 'active' ? '[>>]' : g.status === 'failed' ? '[!!]' : '[--]';
      const progress = g.steps.length > 0 ? ` (${g.currentStep}/${g.steps.length})` : '';
      lines.push(`${icon} **${g.description}**${progress} [${g.priority}]`);
      if (g.status === 'active' && g.steps[g.currentStep]) {
        lines.push(`    ${this.lang.t('goals.next_step')}: ${g.steps[g.currentStep].action}`);
      }
    }
    return lines.join('\n');
  },

};

module.exports = { commandHandlersGoals };
