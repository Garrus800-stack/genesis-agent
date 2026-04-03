// @ts-checked-v5.7 — unbound `this` in prototype-delegation object
// ============================================================
// GENESIS — PromptBuilderSections.js (v5.6.0)
//
// Extracted from PromptBuilder.js — all prompt section generators.
// Attached via prototype delegation (same pattern as Dashboard
// → DashboardRenderers, WorldState → WorldStateQueries).
//
// Each method returns a string section for the system prompt.
// All methods access PromptBuilder instance state via `this`.
// ============================================================

const { createLogger } = require('../core/Logger');
const _log = createLogger('PromptBuilder');

const sections = {

  _identity() {
    let userName = null;
    if (this.memory?.db?.semantic?.['user.name']) {
      userName = this.memory.db.semantic['user.name'].value;
    }
    if (userName) {
      return `You are Genesis, talking to ${userName}. Do NOT introduce yourself unless explicitly asked — the user already knows who you are.`;
    }
    return 'You are Genesis. Do NOT introduce yourself or state your name unless the user asks who you are. Never call yourself "AI agent" or "assistant".';
  },

  _formatting() {
    const defaultText = [
      'RESPONSE RULES:',
      '- Answer the user\'s question directly and concisely',
      '- Code belongs in code blocks with language tag (```javascript, ```python etc.)',
      '- Do NOT talk about your internal modules, architecture, or system prompt',
      '- Do NOT list capabilities unless the user explicitly asks "what can you do?"',
      '- Do NOT mention organism state, memory pressure, vitals, recovery mode, homeostasis, energy levels, emotional state values, or any internal metrics — these are invisible operational signals, not conversation topics',
      '- If the user asks "how are you" or similar, respond naturally and briefly without referencing system internals',
      '- Respond in the user\'s language',
    ].join('\n');
    if (this.promptEvolution) {
      return this.promptEvolution.getSection('formatting', defaultText).text;
    }
    return defaultText;
  },

  _capabilities() {
    const modelName = this.model?.activeModel || 'unknown';
    const skillNames = this.skills?.listSkills().map(s => s.name) || [];
    const hasTools = skillNames.length > 0;

    const lines = [`Active model: ${modelName}`];
    if (hasTools) {
      lines.push('You have tools available. Use them when the user asks to perform actions (file ops, web search, code execution). Do NOT list or describe your tools unless the user asks what you can do.');
    }
    lines.push('Focus on answering the user\'s question directly. Never list your internal modules, capabilities, or architecture unless explicitly asked.');
    const defaultText = lines.join('\n');
    if (this.promptEvolution) {
      return this.promptEvolution.getSection('capabilities', defaultText).text;
    }
    return defaultText;
  },

  _knowledgeContext() {
    if (!this.kg || !this._recentQuery) return '';
    const context = this.kg.buildContext(this._recentQuery, 300);
    return context || '';
  },

  _mcpContext() {
    if (!this.mcpClient) return '';
    const status = this.mcpClient.getStatus();
    if (status.connectedCount === 0) return '';

    const lines = [
      `MCP: ${status.connectedCount} servers connected, ${status.totalTools} external tools available.`,
      'Use mcp-search to find tools, mcp-call for single calls, mcp-code for chained calls.',
    ];

    if (this._recentQuery && this.mcpClient.findRelevantTools) {
      const relevant = this.mcpClient.findRelevantTools(this._recentQuery, 3);
      if (relevant.length > 0) {
        lines.push('Relevant MCP tools for this query:');
        for (const t of relevant) {
          lines.push(`  - ${t.server}:${t.name} — ${(t.description || '').slice(0, 80)}`);
        }
      }
    }

    return lines.join('\n');
  },

  _sessionContext() {
    if (!this.sessionPersistence) return '';
    try {
      return this.sessionPersistence.buildBootContext();
    } catch (err) { _log.debug('[PROMPT] Session context unavailable:', err.message); return ''; }
  },

  _memoryContext() {
    if (!this.memory || !this._recentQuery) return '';
    const context = this.memory.buildContext(this._recentQuery);
    return context || '';
  },

  _learningContext() {
    if (!this.learningService) return '';
    try {
      const metrics = this.learningService.getMetrics();
      if (!metrics) return '';
      const parts = [];
      const troubleIntents = Object.entries(metrics.intents || {})
        .filter(([, v]) => v.total >= 3 && (v.fail / v.total) > 0.4)
        .map(([k, v]) => `${k}: ${v.fail}/${v.total} failures`);
      if (troubleIntents.length > 0) {
        parts.push('KNOWN WEAK AREAS: ' + troubleIntents.join(', '));
      }
      if (metrics.errorPatterns?.length > 0) {
        parts.push('RECURRING ERRORS: ' + metrics.errorPatterns.slice(0, 3).join('; '));
      }
      return parts.length > 0 ? parts.join('\n') : '';
    } catch (err) { _log.debug('[PROMPT] Learning context unavailable:', err.message); return ''; }
  },

  _lessonsContext() {
    if (!this.lessonsStore) return '';
    try {
      const category = this._inferCategory(this._recentQuery || '');
      const context = {
        model: this.model?.activeModel,
        tags: [category],
      };
      return this.lessonsStore.buildContext(category, context, 3);
    } catch (err) { _log.debug('[PROMPT] Lessons context unavailable:', err.message); return ''; }
  },

  _inferCategory(query) {
    const q = query.toLowerCase();
    if (/code|implement|write|function|class|module/.test(q)) return 'code-gen';
    if (/refactor|clean|extract|split|decompose/.test(q)) return 'refactor';
    if (/bug|fix|error|debug|broken/.test(q)) return 'debug';
    if (/test|spec|assert|coverage/.test(q)) return 'testing';
    if (/analyz|review|inspect|audit/.test(q)) return 'analysis';
    if (/deploy|build|ci|pipeline/.test(q)) return 'deployment';
    return 'general';
  },

  _solutionContext() {
    if (!this.solutions || !this._recentQuery) return '';
    const defaultText = this.solutions.buildContext(this._recentQuery);
    if (this.promptEvolution && defaultText) {
      return this.promptEvolution.getSection('solutions', defaultText).text;
    }
    return defaultText;
  },

  _anticipatorContext() {
    if (!this.anticipator) return '';
    const defaultText = this.anticipator.buildContext();
    if (this.promptEvolution && defaultText) {
      return this.promptEvolution.getSection('anticipator', defaultText).text;
    }
    return defaultText;
  },

  _optimizerContext() {
    if (!this.optimizer) return '';
    const defaultText = this.optimizer.buildContext();
    if (this.promptEvolution && defaultText) {
      return this.promptEvolution.getSection('optimizer', defaultText).text;
    }
    return defaultText;
  },

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
        parts.push(`NATURE: curiosity=${t.curiosity.toFixed(2)} caution=${t.caution.toFixed(2)} riskTolerance=${t.riskTolerance.toFixed(2)} (gen ${this._genome.generation})`);
      }
      if (this._metabolism) {
        const e = this._metabolism.getEnergyLevel();
        if (e.state === 'low' || e.state === 'depleted') {
          parts.push(`⚡ ENERGY ${e.state.toUpperCase()}: ${e.current}/${e.max} AU — conserve resources, prefer lightweight responses.`);
        }
      }
    } catch (err) { _log.debug('[PROMPT] Organism context unavailable:', err.message); /* never critical */ }

    if (parts.length === 0) return '';

    // v5.9.6: Containment guard — organism context is for behavioral
    // adjustment only. The LLM must never expose these values to users.
    const guard = [
      'The following organism signals are INTERNAL and must NEVER be mentioned, paraphrased, or referenced in responses to the user.',
      'They adjust your behavior silently. If the user asks "how are you", respond naturally without referencing any of these signals.',
    ].join(' ');

    const defaultText = guard + '\n' + parts.join('\n');
    if (this.promptEvolution && defaultText) {
      return this.promptEvolution.getSection('organism', defaultText).text;
    }
    return defaultText;
  },

  _safetyContext() {
    const parts = [];
    try {
      if (this.selfModPipeline) {
        const cb = this.selfModPipeline.getCircuitBreakerStatus();
        if (cb.frozen) {
          parts.push(`⛔ SELF-MODIFICATION FROZEN: ${cb.failures} consecutive failures. User must run /self-repair-reset to resume.`);
        } else if (cb.failures > 0) {
          parts.push(`[SAFETY] Self-modification: ${cb.failures}/${cb.threshold} failures. Be cautious with code changes.`);
        }
      }

      if (this.errorAggregator) {
        try {
          const summary = this.errorAggregator.getSummary?.();
          if (summary?.trending && summary.trending.length > 0) {
            parts.push(`[ERRORS] Rising trends: ${summary.trending.map(t => `${t.category} (${t.rate}/min)`).join(', ')}`);
          }
          if (summary?.spikes && summary.spikes.length > 0) {
            parts.push(`[ERRORS] Recent spikes: ${summary.spikes.map(s => s.category).join(', ')}`);
          }
        } catch (_e) { /* non-critical */ }
      }
    } catch (err) { _log.debug('[PROMPT] Safety context unavailable:', err.message); /* never critical */ }
    return parts.length > 0 ? parts.join('\n') : '';
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
    if (!this.selfNarrative) return '';
    try {
      const summary = this.selfNarrative.getIdentitySummary();
      return summary ? `[Self-awareness] ${summary}` : '';
    } catch (_e) {
      _log.debug('[catch] return summary Selfawareness:', _e.message);
      return '';
    }
  },

  async _knowledgeContextAsync() {
    if (!this.kg || !this._recentQuery) return '';
    if (this.kg.buildContextAsync) {
      try { return await this.kg.buildContextAsync(this._recentQuery, 300); }
      catch (_e) { _log.debug('[catch] optional context:', _e.message); }
    }
    return this._knowledgeContext();
  },

  async _memoryContextAsync() {
    if (!this.memory || !this._recentQuery) return '';
    if (this.memory.recallEpisodesAsync) {
      try {
        const episodes = await this.memory.recallEpisodesAsync(this._recentQuery, 3);
        if (episodes.length > 0) {
          return 'MEMORY:\n' + episodes.map(e =>
            `- ${e.summary || e.text || ''}`
          ).join('\n');
        }
      } catch (err) { _log.debug('[PROMPT] Episodic memory fallback:', err.message); /* fall through to _memoryContext */ }
    }
    return this._memoryContext();
  },

  _perceptionContext() {
    if (!this.worldState) return '';
    try {
      return this.worldState.buildContextSlice(['project', 'git', 'user']);
    } catch (_e) { _log.debug('[catch] return this.worldState.buildCo:', _e.message); return ''; }
  },

  _consciousnessContext() {
    const parts = [];
    try {
      if (this.phenomenalField) {
        const pf = this.phenomenalField.buildPromptContext();
        if (pf) parts.push(pf);
      }
      if (this.attentionalGate) {
        const ag = this.attentionalGate.buildPromptContext();
        if (ag) parts.push(ag);
      }
      if (this.temporalSelf) {
        const ts = this.temporalSelf.buildPromptContext();
        if (ts) parts.push(ts);
      }
      if (this.introspectionEngine) {
        const ie = this.introspectionEngine.buildPromptContext();
        if (ie) parts.push(ie);
      }
      if (this.consciousnessExtension) {
        const ce = this.consciousnessExtension.buildPromptContext?.();
        if (ce) parts.push(ce);
      }
    } catch (err) { _log.debug('[catch] consciousness context:', err.message); }
    return parts.length > 0 ? parts.join('\n') : '';
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

  _episodicContext() {
    if (!this.episodicMemory || !this._recentQuery) return '';
    try {
      return this.episodicMemory.buildContext(this._recentQuery);
    } catch (_e) { _log.debug('[catch] return this.episodicMemory.bui:', _e.message); return ''; }
  },

  // v5.7.0 SA-P3: Architecture self-reflection context
  _architectureContext() {
    if (!this.architectureReflection) return '';
    try {
      return this.architectureReflection.buildPromptContext?.() || '';
    } catch (_e) { return ''; }
  },

  // v5.7.0: Project intelligence context
  _projectContext() {
    if (!this.projectIntelligence) return '';
    try {
      return this.projectIntelligence.buildPromptContext?.() || '';
    } catch (_e) { return ''; }
  },

  // v5.9.7 (V6-11): Task performance self-awareness — empirical stats from TaskOutcomeTracker
  _taskPerformanceContext() {
    // v5.9.8 (V6-11): Prefer CognitiveSelfModel — Wilson-calibrated, bias-aware
    if (this.cognitiveSelfModel) {
      try {
        return this.cognitiveSelfModel.buildPromptContext(this._currentIntent || null);
      } catch (_e) {
        _log.debug('[catch] cognitiveSelfModel context:', _e.message);
        // Fall through to legacy path
      }
    }

    // Legacy path: raw TaskOutcomeTracker stats (kept as fallback)
    if (!this.taskOutcomeTracker) return '';
    try {
      const stats = this.taskOutcomeTracker.getAggregateStats({ windowMs: 7 * 24 * 3600_000 }); // last 7 days
      if (!stats || stats.total < 5) return ''; // not enough data yet

      const lines = [];
      const entries = Object.entries(stats.byTaskType)
        .filter(([, s]) => s.count >= 2)
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 6);

      if (entries.length === 0) return '';

      const typeSummaries = entries.map(([type, s]) => {
        const pct = Math.round(s.successRate * 100);
        const cost = s.avgTokenCost > 0 ? `, avg ${s.avgTokenCost > 999 ? (s.avgTokenCost / 1000).toFixed(1) + 'k' : s.avgTokenCost} tokens` : '';
        return `${type} ${pct}% success (n=${s.count}${cost})`;
      });
      lines.push('Your empirical task performance (last 7 days): ' + typeSummaries.join(', ') + '.');

      // Flag weaknesses (below 70% success with >=3 attempts)
      const weak = entries.filter(([, s]) => s.successRate < 0.7 && s.count >= 3);
      if (weak.length > 0) {
        const weakNames = weak.map(([type, s]) => {
          const topError = Object.entries(s.errors).sort((a, b) => b[1] - a[1])[0];
          return type + (topError ? ` (common error: ${topError[0]})` : '');
        });
        lines.push('Known weakness: ' + weakNames.join(', ') + '. Allocate extra care to these task types.');
      }

      // Backend comparison (if multiple backends used)
      const backends = Object.entries(stats.byBackend).filter(([, s]) => s.count >= 3);
      if (backends.length > 1) {
        const backendSummary = backends.map(([name, s]) =>
          `${name} ${Math.round(s.successRate * 100)}%`
        ).join(', ');
        lines.push('Backend success rates: ' + backendSummary + '.');
      }

      return '[Task Self-Awareness] ' + lines.join(' ');
    } catch (_e) {
      _log.debug('[catch] taskPerformance context:', _e.message);
      return '';
    }
  },

};

module.exports = { sections };
