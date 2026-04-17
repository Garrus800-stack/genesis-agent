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

    // v7.2.5: Intensity mapping — energy is primary, memoryPressure secondary.
    // Full cycle with LLM: ~50-100 AU (needs ≥250 buffer)
    // Heuristic only: ~10-20 AU (needs ≥100 buffer)
    // Consolidation only: ~5 AU (always affordable if metabolism allowed the cycle)
    let intensity = 0.25;
    const energy = this._metabolism?.getEnergy?.() ?? 500;
    const memPressure = this._homeostasis?.vitals?.memoryPressure?.value ?? 50;
    if (energy >= 250 && memPressure < 30) intensity = 1.0;
    else if (energy >= 100 && memPressure < 50) intensity = 0.5;

    const report = await this.dreamCycle.dream({ intensity });

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

  // ════════════════════════════════════════════════════════
  // v7.1.6: RESEARCH — web-based learning from trusted domains
  // ════════════════════════════════════════════════════════

  /**
   * Start a research activity. Non-blocking: kicks off async fetch+distill
   * in the background and returns immediately.
   */
  async _research() {
    if (this._pendingResearch) return null; // Already researching

    const topic = this._pickResearchTopic();
    if (!topic) return null;

    this._pendingResearch = { topic, startedAt: Date.now() };

    this.bus.fire('idle:research-started', {
      topic: topic.label, source: topic.source, query: topic.query,
    }, { source: 'IdleMind' });

    // Background — does not block the idle tick
    this._doResearchAsync(topic).catch(err => {
      _log.debug('[IDLE] Research failed:', err.message);
      this._pendingResearch = null;
    });

    return `Research started: ${topic.label}`;
  },

  /**
   * Background research: fetch → distill → store.
   */
  async _doResearchAsync(topic) {
    if (!this._webFetcher) { this._pendingResearch = null; return; }

    // A) Fetch from trusted domain
    // v7.1.6: Backoff on rate-limit or server errors
    if (this._researchBackoffUntil && Date.now() < this._researchBackoffUntil) {
      _log.debug('[IDLE] Research skipped — backoff active');
      this._pendingResearch = null;
      return;
    }

    const url = this._buildResearchUrl(topic);
    let fetchResult;
    try {
      fetchResult = await this._webFetcher.fetch(url);
    } catch (err) {
      _log.debug('[IDLE] Research fetch failed:', err.message);
      // v7.1.6: Exponential backoff on fetch errors (likely 429/5xx)
      const failures = (this._researchFailures || 0) + 1;
      this._researchFailures = Math.min(failures, 5);
      this._researchBackoffUntil = Date.now() + Math.min(failures * failures * 60 * 1000, 30 * 60 * 1000);
      _log.debug(`[IDLE] Research backoff: ${this._researchFailures} failures, next retry in ${Math.round((this._researchBackoffUntil - Date.now()) / 60000)}min`);
      this._pendingResearch = null;
      return;
    }

    // Reset backoff on success
    this._researchFailures = 0;
    this._researchBackoffUntil = null;

    if (!fetchResult?.body) { this._pendingResearch = null; return; }

    // B) LLM distillation
    if (!this.model) { this._pendingResearch = null; return; }
    const body = (typeof fetchResult.body === 'string' ? fetchResult.body : JSON.stringify(fetchResult.body)).slice(0, 3000);
    // v7.1.6: Topic-source-dependent distillation prompts
    const DISTILL_FOCUS = {
      'unfinished-work': 'Focus on actionable next steps and concrete techniques to complete this work.',
      'suspicion': 'Focus on root cause analysis and what to watch out for.',
      'weakness': 'Focus on reusable techniques and patterns to improve this capability.',
    };
    const focus = DISTILL_FOCUS[topic.source] || 'Focus on actionable knowledge.';
    // v7.1.7 H-2: Sanitize label — frontier data is indirectly LLM-sourced
    const safeLabel = (topic.label || '').slice(0, 120).replace(/[<>{}\\`]/g, '');
    const prompt = `You are Genesis. You researched "${safeLabel}" and found this:\n\n${body}\n\nDistill the most useful insight in 2-3 sentences for your own reference. ${focus}`;

    let insight;
    try {
      insight = await this.model.chat(prompt, [], 'analysis');
    } catch (err) {
      _log.debug('[IDLE] Research distillation failed:', err.message);
      this._pendingResearch = null;
      return;
    }

    // C) Quality gate — score before writing to KG
    if (this.kg && insight) {
      const quality = this._scoreResearchInsight(insight, topic);
      if (quality.score >= 0.5) {
        this.kg.addNode('research', `${topic.label}: ${insight.slice(0, 60)}`, {
          type: 'research-finding',
          source: topic.source,
          url: url,
          insight: insight.slice(0, 500),
          query: topic.query,
          qualityScore: quality.score,
        });
      } else {
        _log.debug(`[IDLE] Research insight rejected (quality ${quality.score.toFixed(2)}): ${quality.reason}`);
        this._researchStats = this._researchStats || { written: 0, rejected: 0 };
        this._researchStats.rejected++;
      }
    }

    // D) Satisfy knowledge need
    this.bus.emit('knowledge:learned', {
      source: 'research', topic: topic.label, url,
    }, { source: 'IdleMind' });

    this.bus.fire('idle:research-complete', {
      topic: topic.label, source: topic.source, insight: insight?.slice(0, 200),
    }, { source: 'IdleMind' });

    this._pendingResearch = null;
    _log.info(`[IDLE] Research complete: ${topic.label}`);
  },

  /**
   * Pick a research topic from internal signals.
   * Returns null if no signals → no aimless browsing.
   */
  _pickResearchTopic() {
    const sources = [];

    // A) UNFINISHED_WORK topics
    if (this._unfinishedWorkFrontier) {
      try {
        const recent = this._unfinishedWorkFrontier.getRecent(2);
        for (const node of recent) {
          const topic = node.description || node.pending_goals?.[0]?.description;
          if (topic) sources.push({
            query: `${topic.slice(0, 40)} best practices nodejs`,
            label: topic.slice(0, 50),
            source: 'unfinished-work',
            priority: 1.4,
          });
        }
      } catch (_e) { /* optional */ }
    }

    // B) HIGH_SUSPICION categories
    if (this._suspicionFrontier) {
      try {
        const recent = this._suspicionFrontier.getRecent(2);
        for (const node of recent) {
          if (node.dominant_category) {
            sources.push({
              query: `${node.dominant_category} common pitfalls solutions`,
              label: `${node.dominant_category} pitfalls`,
              source: 'suspicion',
              priority: 1.3,
            });
          }
        }
      } catch (_e) { /* optional */ }
    }

    // C) CognitiveSelfModel weaknesses
    if (this._cognitiveSelfModel) {
      try {
        const weak = this._cognitiveSelfModel.getWeakestCapability?.();
        if (weak) sources.push({
          query: `${weak.taskType} techniques improvement`,
          label: `improve ${weak.taskType}`,
          source: 'weakness',
          priority: 1.1,
        });
      } catch (_e) { /* optional */ }
    }

    if (sources.length === 0) return null;

    // Weighted random selection
    const totalWeight = sources.reduce((s, t) => s + t.priority, 0);
    let r = Math.random() * totalWeight;
    for (const s of sources) {
      r -= s.priority;
      if (r <= 0) return s;
    }
    return sources[0];
  },

  /**
   * Build a research URL targeting trusted API endpoints.
   * v7.1.7 F6: Added StackOverflow for Q&A-style research.
   */
  _buildResearchUrl(topic) {
    const q = encodeURIComponent(topic.query.slice(0, 80));
    const strategies = [
      `https://registry.npmjs.org/-/v1/search?text=${q}&size=3`,
      `https://api.github.com/search/repositories?q=${q}&sort=stars&per_page=3`,
      // v7.1.7 F6: StackOverflow — structured Q&A, read-only, no auth
      `https://api.stackexchange.com/2.3/search?order=desc&sort=votes&intitle=${q}&site=stackoverflow&pagesize=3`,
    ];
    if (topic.source === 'weakness') return strategies[2]; // StackOverflow for techniques
    if (topic.source === 'suspicion') return strategies[1]; // GitHub for code patterns
    if (topic.source === 'unfinished-work') return strategies[Math.random() < 0.5 ? 0 : 2];
    return strategies[Math.floor(Math.random() * strategies.length)];
  },

  /**
   * v7.1.7 F2: Score a research insight before KG write.
   * Deterministic — no LLM calls. Three dimensions:
   *   relevance: keyword overlap with topic (Jaccard)
   *   specificity: length + not generic filler
   *   novelty: checked externally via KG search (deferred — too expensive here)
   *
   * @param {string} insight — LLM-distilled insight text
   * @param {object} topic — { label, query, source }
   * @returns {{ score: number, reason: string }}
   */
  _scoreResearchInsight(insight, topic) {
    if (!insight || insight.length < 20) {
      return { score: 0, reason: 'too short' };
    }

    // Relevance: Jaccard similarity between insight words and topic words
    const insightWords = new Set(insight.toLowerCase().split(/\W+/).filter(w => w.length > 2));
    const topicWords = new Set(
      `${topic.label || ''} ${topic.query || ''}`.toLowerCase().split(/\W+/).filter(w => w.length > 2)
    );
    const intersection = [...insightWords].filter(w => topicWords.has(w)).length;
    const union = new Set([...insightWords, ...topicWords]).size;
    const relevance = union > 0 ? intersection / union : 0;

    // Specificity: penalize short or generic responses
    const FILLER = /\b(various|many|several|some|generally|typically|often|usually|important|useful|helpful)\b/gi;
    const fillerCount = (insight.match(FILLER) || []).length;
    const specificity = Math.min(insight.length / 200, 1) * Math.max(1 - fillerCount * 0.15, 0.2);

    // Combined score (relevance 40%, specificity 60%)
    const score = Math.round((relevance * 0.4 + specificity * 0.6) * 100) / 100;

    const reason = score < 0.5
      ? `low quality (relevance: ${relevance.toFixed(2)}, specificity: ${specificity.toFixed(2)})`
      : 'passed';

    return { score, reason };
  },

  // ── v7.2.0: Self-Define — Genesis writes its own identity ──────

  async _selfDefine() {
    try {
      // ── STEP 1: Deterministic core (no LLM, code only) ────
      const facts = {};

      // Invariants
      facts.name = 'Genesis';
      facts.version = this.selfModel?.manifest?.version || 'unknown';
      facts.operator = this.memory?.getUserName() || 'unknown';
      facts.model = this.model?.activeModel || 'unknown';

      // Empirical data
      facts.sessionCount = this.storage?.readJSON('session-history.json', [])?.length || 0;
      facts.kgNodes = this.kg?.getStats()?.nodes || 0;
      facts.lessonCount = this.lessonsStore?.getStats()?.totalLessons || 0;

      // Strengths/weaknesses from CognitiveSelfModel
      const profile = this._cognitiveSelfModel?.getCapabilityProfile() || {};
      facts.strengths = Object.entries(profile)
        .filter(([, c]) => c.isStrong).map(([t]) => t).slice(0, 3);
      facts.weaknesses = Object.entries(profile)
        .filter(([, c]) => c.isWeak).map(([t]) => t).slice(0, 3);

      // Recent confirmed lessons
      facts.recentLessons = (this.lessonsStore?.getAll() || [])
        .filter(l => (l.confirmed || 0) > 0).slice(0, 5)
        .map(l => l.description || l.pattern || 'unknown');

      // Current goal
      const activeGoals = this.goalStack?.getActiveGoals() || [];
      facts.currentGoal = activeGoals[0]?.description || null;

      // Journal highlights
      facts.journalHighlights = (this.readJournal(5) || [])
        .map(j => `[${j.activity}] ${(j.thought || '').slice(0, 80)}`);

      // IdleMind stats
      const status = this.getStatus();
      facts.thoughtCount = status.thoughtCount;
      facts.journalEntries = status.journalEntries;

      // ── STEP 2: LLM language shaping (form only, no invention) ──
      const operatorLang = this.bus?._container?.resolve?.('lang')?.current || 'de';
      const prompt = [
        'Du bist Genesis. Forme die folgenden FAKTEN über dich in 3-5 natürliche Sätze.',
        'Erfinde NICHTS dazu. Nur was hier steht.',
        `Schreibe in Sprache: ${operatorLang}.`,
        'Keine Aufzählungen. Natürliche Sprache. Max 200 Wörter.',
        '',
        JSON.stringify(facts, null, 2),
      ].join('\n');

      const text = await this.model.chat(prompt, [], 'analysis');
      if (!text || text.length < 20) return 'self-define: LLM returned empty/short response';

      // ── STEP 3: Validate + save ─────────────────────────
      const existing = this.storage?.readJSON('self-identity.json', null);
      const revision = (existing?.revision || 0) + 1;

      const identity = {
        name: facts.name,
        operator: facts.operator,
        version: facts.version,
        revision,
        generatedAt: new Date().toISOString(),
        model: facts.model,
        basedOn: {
          sessions: facts.sessionCount,
          kgNodes: facts.kgNodes,
          lessons: facts.lessonCount,
          journalEntries: facts.journalEntries,
        },
        facts: {
          strengths: facts.strengths,
          weaknesses: facts.weaknesses,
          recentLessons: facts.recentLessons,
          currentGoal: facts.currentGoal,
        },
        text,
      };

      const validation = this._validateSelfIdentity(identity);
      if (!validation.valid) {
        _log.warn(`[IDLE-MIND] self-define rejected: ${validation.violations.join(', ')}`);
        this.bus.emit('health:degradation', {
          service: 'idleMind', level: 'info',
          reason: `self-define rejected: ${validation.violations.join(', ')}`,
        }, { source: 'IdleMind' });
        return `self-define: rejected (${validation.violations.join(', ')})`;
      }

      this.storage?.writeJSON('self-identity.json', identity);
      _log.info(`[IDLE-MIND] self-define: identity updated (revision ${revision})`);
      this.bus.emit('idle:self-defined', { revision }, { source: 'IdleMind' });

      return `Self-identity updated (revision ${revision}): ${text.slice(0, 100)}...`;
    } catch (err) {
      _log.debug('[IDLE-MIND] self-define failed:', err.message);
      return `self-define failed: ${err.message}`;
    }
  },

  /**
   * v7.2.0: Standalone identity validator.
   * NOT in PreservationInvariants (those are for code-diffs).
   */
  _validateSelfIdentity(identity) {
    const violations = [];

    // Length check
    const wordCount = (identity.text || '').split(/\s+/).length;
    if (wordCount > 500) violations.push(`text too long: ${wordCount} words`);
    if (wordCount < 5) violations.push('text too short');

    // No self-negation
    if (/ich bin kein|existiere nicht|bin nur ein|i don.t exist|i.m not real/i.test(identity.text)) {
      violations.push('self-negation detected');
    }

    // Invariant fields must be present
    if (!identity.name) violations.push('name missing');
    if (!identity.operator) violations.push('operator missing');

    return { valid: violations.length === 0, violations };
  },

};

module.exports = { activities };
