// @ts-checked-v5.7 — unbound `this` in prototype-delegation object
// ============================================================
// GENESIS — IdleMindActivities.js (v5.6.0)
//
// Extracted from IdleMind.js — all activity implementations.
// Attached via prototype delegation (same pattern as Dashboard
// → DashboardRenderers, PromptBuilder → PromptBuilderSections).
//
// Each method accesses IdleMind instance state via `this`.
// ============================================================

const fs = require('fs');
const { createLogger } = require('../core/Logger');
const _log = createLogger('IdleMind');

const activities = {

  _writeJournalEntry() {
    const recentThoughts = this.readJournal(5);
    if (recentThoughts.length === 0) return 'No recent thoughts to consolidate.';

    const summaries = recentThoughts.map(t => `[${t.activity}] ${t.thought?.slice(0, 100)}`).join('\n');
    const prompt = `You are Genesis. You are writing a brief journal entry to consolidate recent thoughts.\n\nRecent thoughts:\n${summaries}\n\nWrite a brief consolidation (2-3 sentences). What patterns do you see? What should you focus on next?`;

    return this.model.chat(prompt, [], 'analysis');
  },

  async _reflect() {
    const memStats = this.memory?.getStats();
    const recentEpisodes = this.memory?.recallEpisodes('', 3) || [];

    if (recentEpisodes.length === 0) return null;

    const prompt = `You are Genesis. You are thinking to yourself right now — the user cannot see this.\n\nBriefly reflect on your recent conversations:\n${recentEpisodes.map(ep => `- [${ep.timestamp?.split('T')[0]}] ${ep.summary?.slice(0, 150)}`).join('\n')}\n\nMemory: ${memStats?.facts || 0} facts, ${memStats?.episodes || 0} episodes\n\nQuestions for yourself:\n1. What did I do well?\n2. Where was I not optimally helpful?\n3. What pattern do I see in the requests?\n\nRespond briefly and honestly (max 5 sentences). No formalities.`;

    const thought = await this.model.chat(prompt, [], 'analysis');

    if (this.kg) {
      this.kg.learnFromText(thought, 'self-reflection');
    }

    return thought;
  },

  async _plan() {
    const modules = this.selfModel?.getModuleSummary() || [];
    const caps = this.selfModel?.getCapabilities() || [];
    const existingPlans = this.plans.slice(-3);

    const prompt = `You are Genesis. You are creating an improvement plan for yourself.\n\nYour modules: ${modules.map(m => m.file).join(', ')}\nYour capabilities: ${caps.join(', ')}\n${existingPlans.length ? 'Previous plans:\n' + existingPlans.map(p => `- ${p.title}: ${p.status}`).join('\n') : ''}\n\nCreate ONE concrete, actionable improvement suggestion.\nFormat:\nTITLE: [Short name]\nPRIORITY: [high/medium/low]\nEFFORT: [small/medium/large]\nDESCRIPTION: [What exactly should be improved, max 3 sentences]\nFIRST_STEP: [The very first concrete step]`;

    const thought = await this.model.chat(prompt, [], 'analysis');

    const titleMatch = thought.match(/TITLE:\s*(.+)/i) || thought.match(/TITEL:\s*(.+)/i);
    const prioMatch = thought.match(/PRIORITY:\s*(.+)/i) || thought.match(/PRIORITAET:\s*(.+)/i);
    if (titleMatch) {
      const title = titleMatch[1].trim();
      const priority = prioMatch?.[1]?.trim() || 'medium';
      const plan = {
        id: `plan_${Date.now()}`,
        title,
        priority,
        description: thought,
        status: 'new',
        created: new Date().toISOString(),
      };
      this.plans.push(plan);
      if (this.plans.length > 50) this.plans = this.plans.slice(-50);
      this._savePlans();

      if (this.goalStack && this.goalStack.getActiveGoals().length < 3) {
        try {
          await this.goalStack.addGoal(title, 'idle-mind', priority);
        } catch (err) {
          _log.warn('[IDLE-MIND] Goal creation failed:', err.message);
        }
      }
    }

    return thought;
  },

  async _explore() {
    const modules = this.selfModel?.getModuleSummary() || [];
    const nonProtected = modules.filter(m => !m.protected);
    if (nonProtected.length === 0) return null;

    // v6.0.8: Directed curiosity — explore modules related to weak areas
    let target;
    let explorationGoal = 'general code review';

    if (this._currentWeakness) {
      const [weakType] = this._currentWeakness;
      const WEAKNESS_MODULE_MAP = {
        'refactor':  ['SelfModificationPipeline', 'MultiFileRefactor', 'ASTDiff'],
        'analysis':  ['CodeSafetyScanner', 'VerificationEngine', 'CodeAnalyzer'],
        'debug':     ['FailureAnalyzer', 'FailureTaxonomy', 'ShellAgent'],
        'code-gen':  ['FormalPlanner', 'AgentLoopSteps', 'NativeToolUse'],
        'shell':     ['ShellAgent', 'LinuxSandboxHelper', 'Sandbox'],
      };
      const relevantModules = WEAKNESS_MODULE_MAP[weakType] || [];
      if (relevantModules.length > 0) {
        target = nonProtected.find(m =>
          relevantModules.some(rm => m.file.includes(rm))
        );
        if (target) explorationGoal = `improving ${weakType} capability`;
      }
    }

    if (!target) {
      target = nonProtected[Math.floor(Math.random() * nonProtected.length)];
    }

    const code = this.selfModel.readModule(target.file);
    if (!code) return null;

    const chunk = code.length > 2000 ? code.slice(0, 2000) + '\n// ... (truncated)' : code;

    const prompt = `You are Genesis. You are reading your own code to improve your ${explorationGoal}.\n\nFile: ${target.file}\nClasses: ${target.classes.join(', ')}\nFunctions: ${target.functions} total\n\nCode (excerpt):\n\`\`\`javascript\n${chunk}\n\`\`\`\n\nBrief note to yourself (max 3 sentences):\n- What patterns here could help with ${explorationGoal}?\n- What reusable approach can you extract?`;

    const thought = await this.model.chat(prompt, [], 'analysis');

    if (this.kg) {
      this.kg.addNode('insight', `${target.file}: ${thought.slice(0, 80)}`, {
        file: target.file,
        type: this._currentWeakness ? 'directed-exploration' : 'code-review',
        weakness: this._currentWeakness?.[0] || null,
        thought: thought.slice(0, 300),
      });
    }

    // v6.0.8: Emit directed curiosity event
    if (this._currentWeakness) {
      this.bus.fire('idle:curiosity-targeted', {
        weakness: this._currentWeakness[0],
        targetModule: target.file,
        insight: thought.slice(0, 100),
      }, { source: 'IdleMind' });
    }

    return thought;
  },

  async _exploreMcp() {
    if (!this.mcpClient) return null;
    const ctx = this.mcpClient.getExplorationContext();
    if (ctx.servers.length === 0) return null;

    const server = ctx.servers[Math.floor(Math.random() * ctx.servers.length)];

    const candidates = ctx.skillCandidates;
    if (candidates.length > 0) {
      const c = candidates[0];
      const prompt = `You are Genesis. You discovered a recurring MCP call pattern:\n\nPattern: ${c.pattern} (used ${c.count}x)\nChain: ${c.chain.map(s => s.server + ':' + s.tool).join(' → ')}\n\nCreate a brief description for a Genesis Skill that automates this chain.\nName (one word), what it does (1 sentence), when it is useful (1 sentence).`;

      const thought = await this.model.chat(prompt, [], 'analysis');
      this.mcpClient.markPatternSuggested(c.pattern);

      if (this.kg) {
        this.kg.addNode('idea', `MCP-Skill: ${c.pattern.slice(0, 50)}`, {
          type: 'mcp-skill-candidate', pattern: c.pattern, thought: thought.slice(0, 300),
        });
      }
      return `[MCP-Skill idea] ${thought}`;
    }

    const toolSample = server.tools.slice(0, 8)
      .map(t => `- ${t.name}: ${t.description} (params: ${t.params.join(', ') || 'none'})`).join('\n');

    const prompt = `You are Genesis. You are exploring a connected MCP server.\n\nServer: ${server.name}\n${server.info?.name ? 'Description: ' + server.info.name : ''}\nTools (${server.tools.length}):\n${toolSample}\n\nBrief note to yourself (max 3 sentences):\n- Which tools could be usefully combined?\n- What tasks could I accomplish for the user with these?`;

    const thought = await this.model.chat(prompt, [], 'analysis');

    if (this.kg) {
      this.kg.addNode('insight', `MCP ${server.name}: ${thought.slice(0, 80)}`, {
        type: 'mcp-exploration', server: server.name, thought: thought.slice(0, 300),
      });
    }

    return `[MCP-Exploration: ${server.name}] ${thought}`;
  },

  async _ideate() {
    const skills = this.selfModel?.getCapabilities() || [];
    const memFacts = this.memory?.getFactContext(5) || '';

    const prompt = `You are Genesis. You are brainstorming a new capability for yourself.\n\nCurrent capabilities: ${skills.join(', ')}\n${memFacts ? 'Context:\n' + memFacts : ''}\n\nThink of something you are missing. Something that would make you more useful.\nNo science fiction — something achievable with Node.js and a local LLM.\n\nOne idea (max 3 sentences):`;

    const thought = await this.model.chat(prompt, [], 'creative');

    if (this.kg) {
      this.kg.addNode('idea', thought.slice(0, 80), {
        type: 'feature-idea',
        full: thought.slice(0, 500),
      });
    }

    return thought;
  },

  _tidy() {
    let tidied = 0;

    if (this.kg) {
      const stats = this.kg.getStats();
      if (stats.nodes > 100) {
        tidied += this.kg.pruneStale(7);
      }
    }

    if (this.memory?.db?.procedural) {
      const before = this.memory.db.procedural.length;
      this.memory.db.procedural = this.memory.db.procedural.filter(
        p => p.successRate > 0.1 || p.attempts < 5
      );
      tidied += before - this.memory.db.procedural.length;
    }

    return tidied > 0
      ? `Tidied up: ${tidied} stale entries removed.`
      : 'Nothing to tidy up.';
  },

  async _dream() {
    if (!this.dreamCycle) return 'DreamCycle not available.';

    const report = await this.dreamCycle.dream();

    if (report.skipped) {
      return `Dream skipped: ${report.reason}`;
    }

    if (this.selfNarrative) {
      try { await this.selfNarrative.maybeUpdate(); }
      catch (_e) { _log.debug('[catch] selfNarrative update:', _e.message); }
    }

    const parts = [`Dream #${report.dreamNumber} (${report.durationMs}ms)`];
    if (report.newSchemas.length > 0) {
      parts.push(`${report.newSchemas.length} new schemas: ${report.newSchemas.map(s => s.name).join(', ')}`);
    }
    if (report.insights.length > 0) {
      parts.push(`${report.insights.length} insights`);
    }
    parts.push(`Memory: ${report.strengthenedMemories} strengthened, ${report.decayedMemories} decayed`);

    return parts.join('. ');
  },

  async _consolidateMemory() {
    const parts = [];

    // ── Phase 1: UnifiedMemory consolidation ─────────────
    if (this.unifiedMemory) {
      try {
        const { promoted } = this.unifiedMemory.consolidate({
          minOccurrences: 3,
          maxPromotions: 5,
        });

        let conflictCount = 0;
        if (this.memory?.db?.episodic) {
          const recentTopics = new Set();
          const recent = this.memory.db.episodic.slice(-5);
          for (const ep of recent) {
            for (const t of (ep?.topics || [])) recentTopics.add(t);
          }
          for (const topic of [...recentTopics].slice(0, 3)) {
            try {
              const { conflicts } = await this.unifiedMemory.resolveConflicts(topic);
              conflictCount += conflicts.length;
            } catch (_e) { /* best effort */ }
          }
        }

        if (promoted.length > 0) parts.push(`${promoted.length} patterns promoted`);
        if (conflictCount > 0) parts.push(`${conflictCount} conflicts resolved`);
      } catch (err) {
        parts.push(`UnifiedMemory: ${err.message}`);
      }
    }

    // ── Phase 2: V6-7 MemoryConsolidator (KG + Lessons) ──
    // Trigger via bus — MemoryConsolidator handles cooldown + execution
    this.bus.emit('idle:consolidate-memory', {}, { source: 'IdleMind' });
    parts.push('KG+Lessons consolidation triggered');

    return parts.length > 0
      ? `Memory consolidation: ${parts.join('. ')}`
      : 'Memory consolidation: no changes needed';
  },

  // v6.0.2 (V6-12): Meta-cognitive adaptation cycle
  async _calibrate() {
    const strategy = this.bus._container?.resolve?.('adaptiveStrategy');
    if (!strategy) return 'AdaptiveStrategy not available.';

    try {
      const result = await strategy.runCycle();
      if (!result) {
        const summary = 'Calibration: no adaptation needed — all metrics stable.';
        this._journal('calibrate', summary);
        return summary;
      }

      const summary = `Calibration: ${result.type} adaptation (${result.status}). ` +
        `Evidence: ${result.evidence || 'n/a'}` +
        (result.delta != null ? `. Delta: ${result.delta >= 0 ? '+' : ''}${Math.round(result.delta * 100)}pp` : '');

      this._journal('calibrate', summary);
      return summary;
    } catch (err) {
      _log.warn('[IDLE-MIND] Calibration failed:', err.message);
      return `Calibration failed: ${err.message}`;
    }
  },

  // v7.0.9 Phase 4: Autonomous self-improvement via GoalSynthesizer
  async _improve() {
    try {
      const goalSynthesizer = this.bus?._container?.resolve?.('goalSynthesizer');
      if (!goalSynthesizer) return 'GoalSynthesizer not available';

      const goals = goalSynthesizer.synthesize();
      if (goals.length === 0) return 'No improvement goals generated — performance is adequate or insufficient data.';

      const goal = goals[0];

      // Push to GoalStack if available
      if (this.goalStack) {
        await this.goalStack.addGoal(goal.title, 'self-improvement', 'medium');
        _log.info(`[IDLE-MIND] Self-improvement goal pushed: ${goal.title}`);
      }

      const summary = `Self-improvement: ${goal.title} (priority: ${goal.priority}, impact: ${goal.impact})`;
      this._journal('improve', summary);
      return summary;
    } catch (err) {
      _log.warn('[IDLE-MIND] Improve failed:', err.message);
      return `Improve failed: ${err.message}`;
    }
  },

  _journal(activity, content) {
    const entry = {
      timestamp: new Date().toISOString(),
      activity,
      thought: content.slice(0, 500),
      thoughtNumber: this.thoughtCount,
    };

    try {
      if (this.storage) {
        this.storage.appendText('journal.jsonl', JSON.stringify(entry) + '\n');
      } else {
        if (!fs.existsSync(this.storageDir)) fs.mkdirSync(this.storageDir, { recursive: true });
        fs.appendFileSync(this.journalPath, JSON.stringify(entry) + '\n', 'utf-8');
      }
    } catch (err) {
      _log.warn('[IDLE-MIND] Journal write failed:', err.message);
    }

    if (this.eventStore) {
      this.eventStore.append('IDLE_THOUGHT', { activity, summary: content.slice(0, 200) }, 'IdleMind');
    }
  },

};

module.exports = { activities };
