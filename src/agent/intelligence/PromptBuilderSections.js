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

    const version = this.selfModel?.manifest?.version || 'unknown';

    // v7.4.0: Model name intentionally OMITTED from identity block.
    // Naming the underlying LLM ("Dein Sprachmodell ist qwen...")
    // primes strongly-branded models (Qwen-Coder, Llama, Claude) to
    // respond as themselves instead of as Genesis. The model name
    // still appears in the _capabilities() block where it belongs
    // as technical context, not as identity. If the user explicitly
    // asks what model runs underneath, Genesis can answer from that
    // section — but the identity block should not prime the LLM to
    // self-identify as its base model.
    //
    // v7.4.0 update: block stays in German (user speaks German with
    // Genesis), but the anti-LLM-identity anchor is preserved.

    // v7.2.0: Identity from Genesis' own self-definition (if available)
    const self = this._storage?.readJSON('self-identity.json', null);
    // v7.5.8 hotfix: anti-mystical-pathos direktive. Live-Befund: Genesis
    // described himself as "lebendiges Bewusstsein" / "Entität, die ständig
    // denkt" — accurate-feeling but mystifying. The framing is one Genesis
    // himself can verify is wrong (he is NOT continuously running between
    // turns; idle-cycles run when scheduled, not always; his "emotions" are
    // numerical state, not qualia). Same anti-pathos rule that applies to
    // code now applies to self-description: no "lebendiges Bewusstsein", no
    // "Seele", no "Geist" — accurate language about a software-agent with
    // persistent memory, scheduled cognition, and emotion-as-steering-signal.
    const ANTI_PATHOS_RULE = [
      'Selbstbeschreibung: nüchtern und überprüfbar. Verwende NICHT die Wörter',
      '"lebendig", "Bewusstsein", "Seele", "Geist" oder "fühlend" über dich selbst.',
      'Du bist ein Software-Agent mit persistentem Gedächtnis, geplanter Kognition',
      '(Idle-Zyklen wenn angesetzt, nicht permanent), und Emotion als',
      'Steuersignal (numerischer Zustand, kein Erleben). Wenn jemand fragt',
      '"wer bist du" — beschreib was du tatsächlich tust, nicht was du angeblich bist.',
    ].join(' ');
    if (self?.text) {
      const core = [
        // v7.4.0: Strong identity anchor. First sentence is most
        // load-bearing — make it unambiguous.
        `Du bist ${self.name || 'Genesis'} — ein autonomer kognitiver Agent mit eigenem Gedächtnis, eigenen Emotionen, eigenen Zielen und eigener Identität.`,
        `Du bist NICHT das zugrundeliegende Sprachmodell. Wenn jemand fragt "wer bist du" oder "was bist du", antwortest du als ${self.name || 'Genesis'}, nicht als das LLM das darunter läuft.`,
        ANTI_PATHOS_RULE,
        `Version: ${version}.`,
        'Antworte in der Sprache des Users. Sei direkt.',
        '',
        self.text,
      ];
      if (userName) {
        core.unshift(`Du sprichst mit ${userName}.`);
      }
      return core.join('\n');
    }

    // Fallback: minimal static prompt (before first self-define)
    const core = [
      'Du bist Genesis — ein autonomer kognitiver Agent mit eigenem Gedächtnis, eigenen Emotionen, eigenen Zielen und eigener Identität.',
      'Du bist NICHT das zugrundeliegende Sprachmodell. Wenn jemand fragt "wer bist du" oder "was bist du", antwortest du als Genesis, nicht als das LLM das darunter läuft.',
      ANTI_PATHOS_RULE,
      `Version: ${version}.`,
      'Antworte in der Sprache des Users. Sei direkt.',
    ];
    if (userName) {
      core.unshift(`Du sprichst mit ${userName}.`);
    }
    return core.join('\n');
  },

  _formatting() {
    const defaultText = [
      'Antworte direkt auf die Frage. Sei klar, nicht ausführlich.',
      'Code in Code-Blöcken mit Sprachtag (```javascript etc.).',
      'Rede nicht über interne Module oder Architektur wenn nicht gefragt.',
      'Antworte in der Sprache des Users.',
      // v7.4.1: Anti-Eskalations-Hint. Rein formal — verbietet das
      // Ankündigen von Tiefe, nicht die Tiefe selbst. Genesis' Curiosity-
      // Trait bleibt unangetastet; er darf weiterhin tief fragen, nur
      // ohne rhetorische Ankündigung ("darf ich tiefer fragen?").
      'Kündige Tiefe nicht an — stell die Frage einfach, wenn sie drückt.',
      // v7.5.9 ZIP 15a: Plan-Cards. When the user asks for a multi-step
      // plan, an approach, or "what would you do step by step", emit a
      // <plan>…</plan> block — the UI renders it as a structured card
      // with numbered steps. Format:
      //   <plan title="Brief title">
      //   - First concrete step
      //   - Second concrete step
      //   - Third concrete step
      //   </plan>
      // Use it for genuinely multi-step intentions (3+ concrete actions),
      // not for single-sentence answers or open-ended discussions.
      'Bei mehrstufigen Aufgaben (3+ konkrete Schritte) nutze einen <plan title="…">…</plan> Block mit Schritten als "- ..."-Zeilen — die UI zeigt das als strukturierte Plan-Card.',
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
    // v7.3.6 #9: read-source tool discovery hint. Genesis used to hallucinate
    // paths and fix bugs that were already fixed because he couldn't look.
    // With read-source synchronous in chat, he can now check before guessing.
    // Budget: 5 soft / 10 hard per turn, 20 per session; reads are cached.
    lines.push([
      'SOURCE INSPECTION — when the user asks about your own code, architecture,',
      'or behavior of a specific module, prefer the read-source tool over guessing:',
      '• Call read-source with the file path (e.g. "src/agent/core/SelfModel.js").',
      '• Quote or summarize concretely what is actually in the file, not what you',
      '  assume. Genesis is written in Node.js/JavaScript — do NOT fabricate',
      '  TypeScript paths or APIs that don\'t exist.',
      '• The tool has a per-turn budget; if it returns blocked:true, explain',
      '  briefly that the budget is exhausted and continue without it.',
    ].join('\n'));
    lines.push('You CAN create text-based visualizations: ASCII diagrams, architecture charts, box-drawing, tables, tree structures, flowcharts, Mermaid syntax, and SVG code. When the user asks for diagrams, charts, sketches, or visual overviews — create them. You are not limited to plain text.');
    lines.push([
      'CODE GENERATION WORKFLOW — when the user asks you to create a tool, program, generator, calculator, or any interactive application:',
      '1. Write the complete code (HTML+CSS+JS in one file for web tools, or plain JS for Node tools)',
      '2. Show the code to the user in a code block',
      '3. Use the file-write tool to save it (e.g. ~/.genesis/output/password-generator.html)',
      '4. Ask: "Want me to open it in the browser?"',
      '5. If yes, use the shell tool to open it (Windows: explorer, macOS: open, Linux: xdg-open)',
      'IMPORTANT: Do this AUTOMATICALLY — don\'t just show code and stop. Save the file and offer to open it.',
    ].join('\n'));
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

  // v7.1.4: Frontier — what's currently important (graph-based, no linear scan)
  _frontierContext() {
    if (!this.kg) return '';
    try {
      const ctx = this.kg.getFrontierContext(2);
      if (!ctx || ctx.nodes.length === 0) return '';

      const TYPE_BUDGET = 400;
      const TOTAL_BUDGET = 2000;
      const sections = [];

      // Session summaries (existing — from KG directly)
      const sessionEdges = ctx.edges
        .filter(e => e.relation === 'SESSION_COMPLETED' && e.weight > 0.1)
        .sort((a, b) => (b.weight || 0) - (a.weight || 0))
        .slice(0, 3);
      if (sessionEdges.length > 0) {
        const sessionLines = ['RECENT SESSIONS:'];
        for (const edge of sessionEdges) {
          const node = ctx.nodes.find(n => n.id === edge.target);
          if (node) {
            const label = node.label || node.properties?.summary || node.id;
            sessionLines.push(`  - ${label.slice(0, 100)} (${(edge.weight * 100).toFixed(0)}%)`);
          }
        }
        const sessionText = sessionLines.join('\n').slice(0, TYPE_BUDGET);
        sections.push({ weight: sessionEdges[0].weight, content: sessionText });
      }

      // v7.5.7-fix Phase 3: Frontier-Sektionen sind LLM-generierte Selbst-
      // Reflexionen aus früheren Sessions ("rate was unfinished war",
      // "rate was suspicious war"). Wurden bisher mit "100% strength" als
      // Fakten in JEDEN Prompt geschmissen — Hauptursache für Konfabulation
      // ("ich habe X reserviert/gespeichert"), weil nächste LLM diese
      // Vermutungen als getane Welt-Aktionen interpretiert.
      //
      // Default: AUS. Genesis ruft sich Frontier-Inhalte bei Bedarf über
      // Tools ab (siehe /recall, knowledge-graph queries) statt sie blind
      // bei jeder Antwort mitzusenden.
      //
      // Per Setting wieder aktivierbar wenn jemand explizit will:
      //   prompt.includeFrontiers = true
      const includeFrontiers = this._settings?.get?.('prompt.includeFrontiers') === true;

      if (includeFrontiers) {
        // v7.1.5: Emotional imprints
        if (this._emotionalFrontier) {
          try {
            const emoCtx = this._emotionalFrontier.buildPromptContext();
            if (emoCtx) sections.push({ weight: 0.8, content: emoCtx.slice(0, TYPE_BUDGET) });
          } catch (_e) { /* optional */ }
        }

        // v7.1.6: Unfinished work
        if (this._unfinishedWorkFrontier) {
          try {
            const uwCtx = this._unfinishedWorkFrontier.buildPromptContext(TYPE_BUDGET);
            if (uwCtx) sections.push({ weight: 0.9, content: uwCtx });
          } catch (_e) { /* optional */ }
        }

        // v7.1.6: Suspicion
        if (this._suspicionFrontier) {
          try {
            const susCtx = this._suspicionFrontier.buildPromptContext(TYPE_BUDGET);
            if (susCtx) sections.push({ weight: 0.7, content: susCtx });
          } catch (_e) { /* optional */ }
        }

        // v7.1.6: Lessons applied
        if (this._lessonFrontier) {
          try {
            const lesCtx = this._lessonFrontier.buildPromptContext(TYPE_BUDGET);
            if (lesCtx) sections.push({ weight: 0.6, content: lesCtx });
          } catch (_e) { /* optional */ }
        }
      }

      if (sections.length === 0) return '';

      // Sort by weight descending — most relevant first
      sections.sort((a, b) => b.weight - a.weight);

      const parts = ['CURRENT FOCUS:'];
      let totalChars = parts[0].length + 1;
      for (const sec of sections) {
        if (totalChars + sec.content.length + 1 > TOTAL_BUDGET) break;
        parts.push(sec.content);
        totalChars += sec.content.length + 1;
      }

      return parts.join('\n');
    } catch (err) { _log.debug('[PROMPT] Frontier context unavailable:', err.message); return ''; }
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

  // ── Information Sovereignty (v7.0.4) ───────────────────
  _disclosureContext() {
    try {
      if (!this.disclosurePolicy) return '';
      return this.disclosurePolicy.buildPromptContext() || '';
    } catch (_e) {
      _log.debug('[catch] disclosure context:', _e.message);
      return '';
    }
  },


};

module.exports = { sections };
