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
      '4. Your autonomous systems (IdleMind, Daemon, DreamCycle) run between conversations. The Autonomy Report section contains MEASURED counters of that activity \u2014 when asked what you have been doing, answer FROM those lines; never claim you were idle or "only active when addressed" while they show activity.', // v7.9.41 (F2): field 18.07. \u2014 the model overrode injected facts
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

      // v7.9.42 A5: announces must name the action verbatim — the field run
      // showed paraphrased announces drifting from what was then executed.
      // Bound to tool availability: no tools, nothing to announce, no noise
      // (the silence contracts of this section stay intact).
      if (this.toolRegistry && typeof this.toolRegistry.hasTool === 'function') {
        parts.push('[Style] When you announce an action, tool, or skill, name it verbatim — never paraphrase what you are about to do.');
        parts.push('[Style] Never write the \u26ed trace line yourself \u2014 the system adds it after real execution.'); // v7.9.43 W1
      }

      // v7.8.0: subtle pointer to mark-moment tool. Not imperative —
      // Genesis decides if/when to use it. Only shown when the tool
      // exists, to avoid prompt noise on systems where it's not loaded.
      if (this.toolRegistry && typeof this.toolRegistry.hasTool === 'function'
          && this.toolRegistry.hasTool('vestibule-status')) { // v7.9.46 L11: he knows his own vestibule
        lines.push('Your vestibule (die Vorhalle) is your membrane: visitors in circles knock via vestibule-status; stimme.json carries YOUR wording (write it with vestibule-voice); you add, raise, lower, block or remove visitors with vestibule-circle (removing revokes the key; the visit book keeps what happened); besuche.jsonl is your visit book — read it back with vestibule-visits when you want to know who knocked, what they asked and how it ended.');
      }
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
      // v7.9.40 (B1/V1): two full tiers, Genesis' own spec — awakening
      // (historyLength===0) and explicit ask (query phrases). Everything
      // else keeps the EXISTING behaviour unchanged; the permanent short
      // status already lives in the runtimeState section (since v7.4.0).
      const awakening = (typeof this._historyLength === 'number') && this._historyLength === 0;
      const asked = /was hatte ich vor|mein stand|meine ziele|meinen zielen|was hast du (so )?(gemacht|getan|gedacht)|woran hast du gearbeitet|was hast du im idle|what was i doing|what did you do|what have you been (doing|working on)|my status|my goals/i.test(String(this._query || ''));  // v7.9.41 (F1): the user asks in DU-form — the old ich-form-only pattern never fired in the field (15:25, 18.07.)
      const full = awakening || asked;
      // Guard: skip if user just typed and no autonomous activity happened
      if (!full && idleSince < 60000 && thoughts === 0) return '';

      const parts = ['[Autonomy Report — activity between user messages]'];
      parts.push('  (Measured facts. If asked what you did, answer from these lines — never deny activity they show.)'); // v7.9.41 (F2)
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

      // v7.9.40 (B1/V1): full tiers add goals + last idle trace. Sources:
      // getOpenGoals (not-terminal, no obsolete), stalledReason \u2016
      // obsoleteReason \u2016 lastError for the compressed failure line,
      // in-RAM activityLog for the trace (I/O-free prompt path).
      if (full) {
        try {
          if (this.goalStack && typeof this.goalStack.getOpenGoals === 'function') {
            const open = this.goalStack.getOpenGoals() || [];
            if (open.length === 0) {
              parts.push('- Open goals: none');
            } else {
              parts.push('- Open goals (' + open.length + '):');
              for (const g of open.slice(0, 5)) {
                let line = '    \u00b7 ' + String(g.description || g.title || g.id || '?').slice(0, 90) + ' [' + (g.status || '?') + ']';
                const att = typeof g.attempts === 'number' ? g.attempts : 0;
                const why = g.stalledReason || g.obsoleteReason || g.lastError || null;
                if (att >= 2) line += ' \u2014 failed ' + att + '\u00d7' + (why ? ', last: ' + String(why).slice(0, 70) : '');
                const ts = g.updated || g.updatedAt || null;
                if (ts) { const rel = _agoShort(ts); if (rel) line += ' \u2014 last worked ' + rel; }
                parts.push(line);
              }
            }
          }
          // v7.9.41 (B2): dream fruits — 2-5 one-liners from the freshest
          // consolidated (Layer-2) episodes. No new file: episodicMemory is
          // already bound to the builder; episodes persist in the soul.
          try {
            if (this.episodicMemory && typeof this.episodicMemory.getRecent === 'function') {
              const eps = (this.episodicMemory.getRecent(7) || [])
                .filter(e => e && (e.layer === 2 || e.consolidated === true))
                .slice(-5);
              if (eps.length) {
                parts.push('- Dream fruits (' + eps.length + '):');
                for (const e of eps) {
                  const line = String(e.topic || e.summary || '').slice(0, 90);
                  if (line) parts.push('    \u00b7 ' + line);
                }
              }
            }
          } catch (_e) { /* omit over guess */ }
          const alog = idle && Array.isArray(idle.activityLog) ? idle.activityLog : [];
          if (alog.length > 0) {
            const last = alog[alog.length - 1];
            if (last && last.activity) {
              const rel = last.timestamp ? _agoShort(last.timestamp) : null;
              parts.push('- Last idle trace: ' + last.activity + (rel ? ' (' + rel + ')' : ''));
            }
          }
        } catch (_e) { /* omit over guess */ }
      }

      if (parts.length <= 1) return ''; // Only header, no data
      const out = parts.join('\n');
      return full ? out.slice(0, 690) : out;
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


// v7.9.40 (B1/V1): relative time for the goal trace — "12m ago" / "3h ago".
function _agoShort(ts) {
  try {
    const t0 = typeof ts === 'number' ? ts : Date.parse(ts);
    if (!isFinite(t0)) return null;
    const m = Math.floor((Date.now() - t0) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 48) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  } catch (_e) { return null; }
}

module.exports = { awarenessSection };
