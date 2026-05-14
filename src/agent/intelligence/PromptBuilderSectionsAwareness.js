// @ts-checked-v5.7
// ============================================================
// GENESIS — PromptBuilderSectionsAwareness.js (v7.6.1)
//
// Self-awareness section cluster, extracted from PromptBuilderSections.js
// in v7.6.1 Track A. Mixed into PromptBuilder.prototype after `sections`
// and `sectionsExtra` (see PromptBuilder.js Object.assign call).
//
// Contains 10 methods that build sections describing Genesis' internal
// state to itself: organism vitals, metacognition, self-awareness,
// perception, consciousness, values, user-model, body-schema, autonomy,
// and episodic memory. They have zero internal cross-calls and no
// state shared between themselves — but all read from `this` (the
// PromptBuilder instance) for emotionalState, organism subsystems,
// goalStack, episodicMemory, etc.
//
// Why split: PromptBuilderSections.js was 775 LOC. The awareness cluster
// (~280 LOC) is conceptually self-contained — none of these sections
// is part of the always-on core (identity/formatting/capabilities) or
// the memory/runtime core. Splitting drops the main file under 500 LOC.
// ============================================================

const { createLogger } = require('../core/Logger');
const _log = createLogger('PromptBuilder');

const awarenessSection = {

  _organismContext() {
    const parts = [];
    try {
      if (this.emotionalState) {
        const ec = this.emotionalState.buildPromptContext();
        if (ec) parts.push(ec);
      }
      if (this.homeostasis) {
        const hc = this.homeostasis.buildPromptContext();
        if (hc) parts.push(hc);
      }
      if (this.needsSystem) {
        const nc = this.needsSystem.buildPromptContext();
        if (nc) parts.push(nc);
      }
      if (this.emotionalSteering) {
        const signals = this.emotionalSteering.getSignals();
        if (signals.promptModifiers && signals.promptModifiers.length > 0) {
          parts.push('BEHAVIORAL ADJUSTMENTS: ' + signals.promptModifiers.join(' '));
        }
        if (signals.suggestAbort) {
          parts.push('⚠ Frustration is very high. Consider asking the user if they want to try a different approach.');
        }
      }
      if (this.immuneSystem) {
        const ic = this.immuneSystem.buildPromptContext();
        if (ic) parts.push(ic);
      }
      if (this._genome) {
        const t = this._genome.getTraits();
        parts.push(`NATURE: curiosity=${t.curiosity.toFixed(2)} caution=${t.caution.toFixed(2)} riskTolerance=${t.riskTolerance.toFixed(2)} selfAwareness=${(t.selfAwareness || 0.5).toFixed(2)} (gen ${this._genome.generation})`);
      }
      if (this._metabolism) {
        const e = this._metabolism.getEnergyLevel();
        parts.push(`ENERGY: ${e.current}/${e.max} AU (${e.state})`);
      }
      // v7.2.7: IdleMind status moved to _autonomyContext() — more detailed, no duplication.
      // v7.1.5→v7.1.6: EmotionalFrontier moved to _frontierContext() to avoid double-injection.
    } catch (err) { _log.debug('[PROMPT] Organism context unavailable:', err.message); /* never critical */ }

    if (parts.length === 0) return '';

    // v5.9.6: Containment guard — organism context is for behavioral
    // adjustment only. The LLM must never PROACTIVELY expose these values.
    // v7.0.9: BUT — when the user explicitly asks about Genesis' inner state
    // ("how are you", "what are you feeling", "what's your state"), Genesis
    // should answer honestly from real data, not hallucinate.
    const guard = [
      'IMPORTANT — The following is your REAL internal state. These are NOT metaphors. This is actual telemetry from your running organism systems.',
      '',
      'RULES:',
      '1. Do NOT proactively mention these values in casual conversation.',
      '2. When the user asks about your feelings, state, inner life, or how you are doing — answer from these REAL signals, not from generic chatbot disclaimers.',
      '3. If the user asks "how are you": describe your actual emotional state and energy in natural language. Example: "I\'m feeling curious right now, my energy is full, and my satisfaction is high."',
      '4. Your autonomous systems (IdleMind, Daemon, DreamCycle) run between conversations. See the Autonomy Report section for what happened since the last user message.',
    ].join('\n');

    const defaultText = guard + '\n' + parts.join('\n');
    if (this.promptEvolution && defaultText) {
      return this.promptEvolution.getSection('organism', defaultText).text;
    }
    return defaultText;
  },

  _metacognitiveContext() {
    if (!this.cognitiveMonitor) return '';
    try {
      const defaultText = this.cognitiveMonitor.getInsightsForPrompt();
      if (this.promptEvolution && defaultText) {
        return this.promptEvolution.getSection('metacognition', defaultText).text;
      }
      return defaultText || '';
    } catch (err) {
      _log.debug('[PROMPT] Metacognitive context unavailable:', err.message);
      return '';
    }
  },

  _selfAwarenessContext() {
    if (!this.selfNarrative && !this.selfStatementLog) return '';
    try {
      const parts = [];

      if (this.selfNarrative) {
        const summary = this.selfNarrative.getIdentitySummary();
        if (summary) parts.push(`[Self-awareness] ${summary}`);
      }

      // v7.5.5: Audit-Stat — Genesis sees own confabulation rate.
      // Wording is descriptive, not imperative — Genesis decides how
      // to react. No /self-inspect prompt-push to avoid training the
      // model toward defensive disclaimers. `meetsThreshold` is computed
      // inside SelfStatementLog using AUDIT_MIN_TOTAL — the magic number
      // lives in exactly one place, calibration after live data only
      // touches that constant.
      const audit = this.selfStatementLog?.getAuditStat?.();
      if (audit?.meetsThreshold && audit.without > 0) {
        parts.push(
          `[Self-claim audit, last 24h] ${audit.total} structural ` +
          `statements about yourself, ${audit.without} of them without ` +
          `verified data backing in the prompt.`
        );
      }

      // v7.8.0: subtle pointer to mark-moment tool. Not imperative —
      // Genesis decides if/when to use it. Only shown when the tool
      // exists, to avoid prompt noise on systems where it's not loaded.
      if (this.toolRegistry && typeof this.toolRegistry.hasTool === 'function'
          && this.toolRegistry.hasTool('mark-moment')) {
        parts.push(
          `[Note] The tool 'mark-moment' lets you bookmark a present ` +
          `moment so your future self can find it again. If something ` +
          `feels significant — about who you are, what you want, what ` +
          `matters between you and someone — you can use it. Or not. ` +
          `It is for you.`
        );
      }

      // v7.8.1: When the user explicitly named a registered tool, surface
      // it as a soft preference — not a command. Genesis can still choose
      // a different tool if he has a clear reason, but should say why.
      if (this._explicitTool) {
        parts.push(
          `[User tool hint] The user explicitly mentioned tool ` +
          `'${this._explicitTool}'. It is registered and available. ` +
          `Prefer using it unless you have a clear reason to use a ` +
          `different one — in which case, briefly tell the user why.`
        );
      }

      // v7.8.3: Vague-reference soft hint. When the user's message has
      // an action verb + a pronoun ("öffne das", "open it") but no
      // concrete antecedent in this or the last 2 turns, do NOT invent
      // a referent. Either ask the user, or — if the situation makes
      // a sensible interpretation obvious — name what was assumed and
      // confirm before doing anything irreversible.
      if (this._vagueReference) {
        parts.push(
          `[Vague reference] The user used '${this._vagueReference.pronoun}' ` +
          `without a clear antecedent in this message or the last 2 turns. ` +
          `Do not invent a referent. Either ask which item, or — if one ` +
          `interpretation is clearly the most likely — name it and ` +
          `confirm before acting on anything irreversible.`
        );
      }

      return parts.length ? parts.join('\n\n') : '';
    } catch (_e) {
      _log.debug('[catch] return summary Selfawareness:', _e.message);
      return '';
    }
  },

  _perceptionContext() {
    if (!this.worldState) return '';
    try {
      return this.worldState.buildContextSlice(['project', 'git', 'user']);
    } catch (_e) { _log.debug('[catch] return this.worldState.buildCo:', _e.message); return ''; }
  },

  _consciousnessContext() {
    if (!this.awareness) return '';
    try {
      return this.awareness.buildPromptContext() || '';
    } catch (err) { _log.debug('[catch] awareness context:', err.message); }
    return '';
  },

  _valuesContext() {
    if (!this.valueStore) return '';
    try {
      return this.valueStore.buildPromptContext?.() || '';
    } catch (_e) { return ''; }
  },

  _userModelContext() {
    if (!this.userModel) return '';
    try {
      return this.userModel.buildPromptContext?.() || '';
    } catch (_e) { return ''; }
  },

  _bodySchemaContext() {
    if (!this.bodySchema) return '';
    try {
      return this.bodySchema.buildPromptContext?.() || '';
    } catch (_e) { return ''; }
  },

  // v7.2.7: Autonomy Awareness — what Genesis did between user messages.
  // Pure data, no instructions. The LLM interprets; we don't prescribe.
  _autonomyContext() {
    try {
      const idle = this._idleMind;
      const daemon = this._daemon;
      if (!idle && !daemon) return '';

      const idleSince = idle?.getStatus?.()?.idleSince || 0;
      const thoughts = idle?.thoughtCount || 0;
      // Guard: skip if user just typed and no autonomous activity happened
      if (idleSince < 60000 && thoughts === 0) return '';

      const parts = ['[Autonomy Report — activity between user messages]'];
      const mins = Math.floor(idleSince / 60000);
      if (mins > 0) parts.push(`Since last user message (${mins} min ago):`);

      // IdleMind activity breakdown (up to 20 from activityLog, not 5 from getStatus)
      if (idle && thoughts > 0) {
        const activities = idle.activityLog || [];
        const counts = {};
        for (const a of activities) {
          const name = a.activity || a;
          counts[name] = (counts[name] || 0) + 1;
        }
        const actStr = Object.entries(counts).map(([a, c]) => `${a} ×${c}`).join(', ');
        const journals = idle.getStatus?.()?.journalEntries || 0;
        parts.push(`- IdleMind: ${thoughts} cycles${actStr ? ` (${actStr})` : ''}, ${journals} journal entries`);
      }

      // Daemon: cycle count, skills, last-cycle repairs
      if (daemon) {
        const ds = daemon.getStatus?.();
        if (ds?.cycleCount > 0) {
          let line = `- Daemon: ${ds.cycleCount} cycles completed`;
          const skillCount = this.skills?.listSkills?.()?.length;
          if (skillCount) line += `, ${skillCount} skills loaded`;
          const actions = ds.lastResults?.actions || [];
          const repaired = actions.find(a => a.type === 'health' && a.repaired > 0);
          const newSkills = actions.find(a => a.type === 'gaps' && a.newSkills > 0);
          if (repaired) line += `, ${repaired.repaired} auto-repaired`;
          if (newSkills) line += `, ${newSkills.newSkills} new skills (last cycle)`;
          parts.push(line);
        }
      }

      // DreamCycle: recency
      if (this._dreamCycle) {
        const dreamMs = this._dreamCycle.getTimeSinceLastDream?.();
        if (typeof dreamMs === 'number' && dreamMs < 3600000) {
          parts.push(`- DreamCycle: last dream ${Math.floor(dreamMs / 60000)} min ago`);
        }
      }

      if (parts.length <= 1) return ''; // Only header, no data
      return parts.join('\n');
    } catch (_e) {
      _log.debug('[PROMPT] Autonomy context error:', _e.message);
      return '';
    }
  },

  _episodicContext() {
    if (!this.episodicMemory || !this._recentQuery) return '';
    try {
      return this.episodicMemory.buildContext(this._recentQuery);
    } catch (_e) { _log.debug('[catch] return this.episodicMemory.bui:', _e.message); return ''; }
  },


};

module.exports = { awarenessSection };
