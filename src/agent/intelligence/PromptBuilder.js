// @ts-checked-v5.8 — prototype delegation (PromptBuilderSections) not statically checkable
// ============================================================
// GENESIS — PromptBuilder.js
// Builds context-aware system prompts.
// Combines: identity, capabilities, knowledge, memory.
// ============================================================

const { createLogger } = require('../core/Logger');
const _log = createLogger('PromptBuilder');
class PromptBuilder {
  constructor({ selfModel, model, skills, knowledgeGraph, memory, anticipator, solutionAccumulator, selfOptimizer, storage }) {
    this.selfModel = selfModel;
    this.model = model;
    this.skills = skills;
    this.kg = knowledgeGraph;
    this.memory = memory;
    this.anticipator = anticipator || null;
    this.solutions = solutionAccumulator || null;
    this.optimizer = selfOptimizer || null;
    this._storage = storage || null; // v7.2.0: reads self-identity.json

    // v2.8.1: Late-bound by AgentCore._wireAndStart() — declared here for clarity
    this.mcpClient = null;
    this.learningService = null;
    this.unifiedMemory = null;

    // v3.5.0: Organism modules (late-bound)
    this.emotionalState = null;
    this.homeostasis = null;
    this.needsSystem = null;

    // v3.5.0: Revolution modules (late-bound)
    this.sessionPersistence = null;
    this.vectorMemory = null;

    // v3.5.0: Metacognitive layer (late-bound)
    this.cognitiveMonitor = null;

    // AwarenessPort (late-bound) — replaces 5 consciousness services
    this.awareness = null;
    // v5.7.0 (SA-P3): Architecture self-reflection
    this.architectureReflection = null;
    // v5.7.0: Project intelligence
    this.projectIntelligence = null;

    // v4.12.4: ValueStore — learned principles/preferences (late-bound)
    this.valueStore = null;

    // v4.12.4: UserModel — theory of mind (late-bound)
    this.userModel = null;

    // v4.12.4: BodySchema — embodiment awareness (late-bound)
    this.bodySchema = null;

    // v4.12.5: Organism steering + immune context (late-bound)
    this.emotionalSteering = null;
    this.immuneSystem = null;

    // v5.9.7 (V6-11): TaskOutcomeTracker — empirical performance data (late-bound)
    this.taskOutcomeTracker = null;

    // v7.0.4: DisclosurePolicy — information sovereignty (late-bound)
    this.disclosurePolicy = null;

    // v4.12.8: Safety context — selfmod circuit breaker + error trends
    this.selfModPipeline = null;
    this.errorAggregator = null;

    // v5.0.0: Genome + Metabolism (late-bound)
    this._genome = null;
    this._metabolism = null;

    // v5.2.0: Prompt Evolution (late-bound)
    this.promptEvolution = null;

    // v5.3.0: LessonsStore (late-bound)
    this.lessonsStore = null;

    // v4.0: SelfNarrative (late-bound)
    this.selfNarrative = null;

    // v4.0: WorldState + EpisodicMemory (late-bound)
    this.worldState = null;
    this.episodicMemory = null;

    this._recentQuery = '';
    // v6.0.4: Adaptive prompt strategy — optimizes sections based on provenance data
    this._currentIntent = 'general';
    /** @type {*} */ this._adaptiveStrategy = null; // late-bound
    /** @type {*} */ this._cognitiveBudget = null;  // late-bound
    this._currentBudget = null; // set per-request by ChatOrchestrator

    // FIX v3.5.0: Token budget prevents prompt bloat.
    // For 9B local models with ~4K effective context, system prompt
    // shouldn't exceed ~1200 tokens (~4800 chars). Each section has
    // a priority (lower = more important) and max char budget.
    this._tokenBudget = 4800; // ~1200 tokens (4 chars ≈ 1 token)
    this._sectionPriority = [
      // priority, name, maxChars
      // v4.12.8: Reorganized priorities. P1-P4 are essential for task quality.
      // P5-P7 are nice-to-have context. P8+ are dropped first on budget pressure.
      // Removed bodySchema from default (no measurable task impact).
      // v6.0.2: formatting + capabilities expanded for code-gen workflow + conversation quality
      [1, 'identity',      500],   // v7.0.4: Expanded — model identity separation + version
      [1, 'formatting',    1200],
      [2, 'session',       500],
      [2, 'capabilities',  1300],
      [2, 'safety',        250],   // v4.12.8: Circuit breaker + error trends — operationally critical
      [2, 'disclosure',    400],   // v7.0.4: Information sovereignty — what to share with whom
      [2, 'introspection', 600],   // v7.1.7: Verified self-data — prevents hallucinated metrics
      [3, 'version',       900],   // v7.0.4: Changelog self-awareness — Genesis knows its own history
      [3, 'mcp',           400],
      [3, 'project',       300],   // v5.7.0: Project intelligence — stack, conventions, quality
      [3, 'taskPerformance', 250],  // v5.9.7: Empirical task success rates — self-awareness
      [3, 'vectorMemory',  500],
      [4, 'knowledge',     600],
      [4, 'memory',        600],
      [5, 'learning',      300],
      [5, 'solutions',     300],
      [5, 'metacognition', 300],
      [6, 'anticipator',   200],
      [6, 'optimizer',     200],
      [6, 'values',        200],
      [6, 'userModel',     250],
      [7, 'selfAwareness', 200],   // v4.12.8: Demoted — rarely affects task quality
      [7, 'architecture',  200],   // v5.7.0 SA-P3: Architecture self-reflection for self-mod
      [7, 'organism',      300],   // v4.12.8: Reduced from 400 — emotions are context, not instructions
      [7, 'autonomy',      200],   // v7.2.7: Autonomous activity report
      [8, 'consciousness', 300],   // v4.12.8: Demoted from P5→P8, reduced from 500→300
      [9, 'bodySchema',    150],   // v4.12.8: Demoted to lowest — almost never task-relevant
    ];

    // v5.9.9: A/B testing — disable prompt sections via env or settings.
    // GENESIS_AB_MODE=baseline → disables organism, consciousness, selfAwareness, bodySchema
    // GENESIS_AB_MODE=no-organism → disables organism, bodySchema only
    // GENESIS_AB_MODE=no-consciousness → disables consciousness only
    // GENESIS_DISABLED_SECTIONS=organism,consciousness → explicit list
    this._disabledSections = new Set();
    this._modelGatingApplied = false; // v6.0.7: track model-gating state for re-enable on failover
    const abMode = process.env.GENESIS_AB_MODE || '';
    if (abMode === 'baseline') {
      ['organism', 'consciousness', 'selfAwareness', 'bodySchema', 'taskPerformance', 'autonomy'].forEach(s => this._disabledSections.add(s));
    } else if (abMode === 'no-organism') {
      ['organism', 'bodySchema'].forEach(s => this._disabledSections.add(s));
    } else if (abMode === 'no-consciousness') {
      this._disabledSections.add('consciousness');
    }
    const explicit = process.env.GENESIS_DISABLED_SECTIONS;
    if (explicit) {
      explicit.split(',').map(s => s.trim()).filter(Boolean).forEach(s => this._disabledSections.add(s));
    }
    if (this._disabledSections.size > 0) {
      _log.info(`[PROMPT] A/B mode: disabled sections: ${[...this._disabledSections].join(', ')}`);
    }
  }




  /** Set the most recent user query (for context relevance) */
  setQuery(query) {
    this._recentQuery = query;
  }

  /**
   * v6.0.4: Set the current intent type for adaptive prompt optimization.
   * Called by ChatOrchestrator before build().
   * @param {string} intentType
   */
  setIntent(intentType) {
    this._currentIntent = intentType || 'general';
  }

  /**
   * v6.0.4: Set the cognitive budget for proportional prompt assembly.
   * Trivial requests skip organism/consciousness sections entirely.
   * @param {{ tier: object, tierName: string }} budget
   */
  setBudget(budget) {
    this._currentBudget = budget || null;
  }

  /**
   * Estimate token budget based on active model.
   * Cloud models get larger budgets than local 9B models.
   */
  _getTokenBudget() {
    const modelName = this.model?.activeModel || '';
    if (modelName.includes('claude') || modelName.includes('gpt')) return 8000; // Cloud: ~2000 tokens
    if (modelName.includes('70b') || modelName.includes('72b')) return 6400;    // Large local
    return this._tokenBudget; // Default: small local (9B)
  }

  /**
   * v6.0.7: Model-aware prompt section gating.
   *
   * Benchmark data (v6.0.7 A/B on qwen2.5:7b):
   *   Full prompt:     avg 43277ms/task, 100% success
   *   Without organism: avg 10548ms/task, 100% success → 4x faster, same quality
   *
   * For local models (≤16K context), organism/consciousness/selfAwareness/bodySchema
   * are auto-disabled. These sections consume ~800-1200 chars of prompt budget
   * that could be used for task-relevant context (knowledge, perception, memory).
   *
   * Cloud models (Claude, GPT) keep everything — their large context windows
   * make these sections negligible in cost.
   *
   * The services themselves keep running (EventBus, DreamCycle, etc.) —
   * only the prompt injection is suppressed. Dashboard and CLI still work.
   */
  _applyModelGating() {
    const modelName = this.model?.activeModel || '';
    if (!modelName) return; // No model configured (test mode) — don't gate

    // v7.0.3: Recognize :cloud suffix as cloud model (e.g. kimi-k2.5:cloud)
    const hasCloudSuffix = /:cloud\b/i.test(modelName);
    const isCloud = hasCloudSuffix || modelName.includes('claude') || modelName.includes('gpt')
      || modelName.includes('anthropic') || modelName.includes('openai');
    // v6.0.7: Only gate known local model patterns. Unknown models are NOT gated.
    // FIX v6.1.1: Also gate Ollama-served local models — consciousness
    // sections add noise without improving response quality for small models.
    // FIX v7.0.3: Models with :cloud suffix are NOT local, even if name matches local patterns.
    const isLocal = !hasCloudSuffix && /\b(llama|qwen|gemma|mistral|phi|deepseek|codellama|yi-|solar|vicuna|orca|wizardcoder|starcoder|ollama|mannix)\b/i.test(modelName);

    if (isLocal && !this._modelGatingApplied) {
      const gated = ['organism', 'consciousness', 'selfAwareness', 'bodySchema', 'metacognition', 'values', 'anticipator', 'optimizer', 'autonomy'];
      for (const s of gated) this._disabledSections.add(s);
      this._modelGatingApplied = true;
      _log.info(`[PROMPT] Model-gated: local model "${modelName}" → skipping ${gated.join(', ')}`);
    } else if ((isCloud || !isLocal) && this._modelGatingApplied) {
      // Cloud or unknown model detected → re-enable
      for (const s of ['organism', 'consciousness', 'selfAwareness', 'bodySchema', 'metacognition', 'values', 'anticipator', 'optimizer', 'autonomy']) {
        this._disabledSections.delete(s);
      }
      this._modelGatingApplied = false;
      _log.info(`[PROMPT] Model-gated: model "${modelName}" → all sections enabled`);
    }
  }

  /** Build the full system prompt with token budget */
  build() {
    // v6.0.7: Model-aware section gating — local models (≤16K context)
    // get organism/consciousness stripped automatically. Benchmarks show
    // these sections cause 4x latency with 0% quality gain on Ollama.
    // Cloud models keep everything (128K+ context makes them negligible).
    this._applyModelGating();

    return this._buildWithBudget([
      ['identity',       this._identity()],
      ['formatting',     this._formatting()],
      ['session',        this._sessionContext()],
      ['frontier',       this._frontierContext()],
      ['capabilities',   this._capabilities()],
      ['mcp',            this._mcpContext()],
      ['knowledge',      this._knowledgeContext()],
      ['memory',         this._memoryContext()],
      ['episodic',       this._episodicContext()],
      ['perception',     this._perceptionContext()],
      ['learning',       this._learningContext()],
      ['lessons',        this._lessonsContext()],
      ['solutions',      this._solutionContext()],
      ['anticipator',    this._anticipatorContext()],
      ['optimizer',      this._optimizerContext()],
      ['metacognition',  this._metacognitiveContext()],
      ['selfAwareness',  this._selfAwarenessContext()],
      ['consciousness',  this._consciousnessContext()],
      ['values',         this._valuesContext()],
      ['userModel',      this._userModelContext()],
      ['bodySchema',     this._bodySchemaContext()],
      ['organism',       this._organismContext()],
      ['taskPerformance', this._taskPerformanceContext()],
      ['safety',         this._safetyContext()],
      ['disclosure',     this._disclosureContext()],
      ['version',        this._versionContext()],
    ]);
  }

  /**
   * Budget-aware prompt assembly.
   * Sections are included in priority order. If total exceeds budget,
   * lower-priority sections are truncated or dropped entirely.
   */
  _buildWithBudget(sections) {
    const budget = this._getTokenBudget();
    const priorityMap = new Map(this._sectionPriority.map(([p, n, m]) => [n, { priority: p, maxChars: m }]));

    // v6.0.4: Adaptive prompt strategy — skip/boost sections based on provenance data
    const strategy = this._adaptiveStrategy;
    const cogBudget = this._cognitiveBudget;
    const intent = this._currentIntent || 'general';
    const skippedByStrategy = [];
    const skippedByBudget = [];
    const boostedByStrategy = [];

    // Sort sections by priority (lower number = higher priority)
    const sorted = sections
      .filter(([name, content]) => {
        if (!content) return false;
        if (this._disabledSections.has(name)) return false;
        // v6.0.4: CognitiveBudget — skip organism/consciousness for trivial requests
        if (cogBudget && this._currentBudget) {
          if (!cogBudget.shouldIncludeSection(name, this._currentBudget)) {
            skippedByBudget.push(name);
            return false;
          }
        }
        // v6.0.4: AdaptivePromptStrategy — skip/boost based on provenance data
        if (strategy) {
          const advice = strategy.getSectionAdvice(intent, name);
          if (advice === 'skip') { skippedByStrategy.push(name); return false; }
          if (advice === 'boost') { boostedByStrategy.push(name); }
        }
        return true;
      })
      .sort((a, b) => {
        const pa = Number(priorityMap.get(a[0])?.priority) || 99;
        const pb = Number(priorityMap.get(b[0])?.priority) || 99;
        // Boosted sections get priority -1 (promoted one tier)
        const paAdj = boostedByStrategy.includes(a[0]) ? pa - 1 : pa;
        const pbAdj = boostedByStrategy.includes(b[0]) ? pb - 1 : pb;
        return paAdj - pbAdj;
      });

    if (skippedByStrategy.length > 0) {
      _log.debug(`[PROMPT] Adaptive skip for "${intent}": ${skippedByStrategy.join(', ')}`);
    }
    if (skippedByBudget.length > 0) {
      _log.debug(`[PROMPT] Budget skip (${this._currentBudget?.tierName || '?'}): ${skippedByBudget.join(', ')}`);
    }

    const parts = [];
    let totalChars = 0;
    const activeSections = [];
    const droppedByBudget = [];

    for (const [name, content] of sorted) {
      const maxChars = priorityMap.get(name)?.maxChars || 400;
      const truncated = content.length > maxChars ? content.slice(0, maxChars) + '...' : content;

      if (totalChars + truncated.length > budget) {
        droppedByBudget.push(name);
        continue;
      }

      parts.push(truncated);
      totalChars += truncated.length;
      activeSections.push(name);
    }

    // v6.0.4: Store last build metadata for provenance recording
    this._lastBuildMeta = {
      active: activeSections,
      skipped: [...skippedByBudget, ...skippedByStrategy, ...droppedByBudget],
      boosted: boostedByStrategy,
      totalTokens: Math.ceil(totalChars / 4),
      tier: this._currentBudget?.tierName || null,
    };

    return parts.join('\n\n');
  }

  /**
   * Async build — uses UnifiedMemory when available for comprehensive recall.
   * Falls back to separate memory+KG calls if UnifiedMemory not wired.
   */
  async buildAsync() {
    this._applyModelGating(); // v6.0.7

    const sections = [
      ['identity',     this._identity()],
      ['formatting',   this._formatting()],
      ['session',      this._sessionContext()],
      ['capabilities', this._capabilities()],
      ['mcp',          this._mcpContext()],
    ];

    // v3.5.0: Prefer VectorMemory for semantic search (replaces keyword-based UnifiedMemory)
    if (this.vectorMemory && this._recentQuery) {
      try {
        const vectorBlock = await this.vectorMemory.buildContextBlock(this._recentQuery, 600);
        if (vectorBlock) sections.push(['vectorMemory', vectorBlock]);
      } catch (err) { _log.debug('[PROMPT] Optional section error:', err.message); }
    }

    // v2.6: UnifiedMemory as fallback for combined context
    if (this.unifiedMemory && this._recentQuery) {
      try {
        const unifiedBlock = await this.unifiedMemory.buildContextBlock(this._recentQuery, 800);
        if (unifiedBlock) sections.push(['knowledge', unifiedBlock]);
      } catch (err) {
        sections.push(['knowledge', await this._knowledgeContextAsync()]);
        sections.push(['memory',    await this._memoryContextAsync()]);
      }
    } else {
      sections.push(['knowledge', await this._knowledgeContextAsync()]);
      sections.push(['memory',    await this._memoryContextAsync()]);
    }

    sections.push(['learning',      this._learningContext()]);
    sections.push(['project',       this._projectContext()]);
    sections.push(['lessons',       this._lessonsContext()]);
    sections.push(['solutions',     this._solutionContext()]);
    sections.push(['anticipator',   this._anticipatorContext()]);
    sections.push(['optimizer',     this._optimizerContext()]);
    sections.push(['episodic',      this._episodicContext()]);
    sections.push(['perception',    this._perceptionContext()]);
    sections.push(['metacognition', this._metacognitiveContext()]);
    sections.push(['selfAwareness', this._selfAwarenessContext()]);
    sections.push(['architecture',  this._architectureContext()]);
    sections.push(['consciousness', this._consciousnessContext()]);
    sections.push(['values',        this._valuesContext()]);
    sections.push(['userModel',     this._userModelContext()]);
    sections.push(['bodySchema',    this._bodySchemaContext()]);
    sections.push(['organism',      this._organismContext()]);
    sections.push(['autonomy',      this._autonomyContext()]);
    sections.push(['taskPerformance', this._taskPerformanceContext()]);
    sections.push(['safety',        this._safetyContext()]);
    sections.push(['disclosure',    this._disclosureContext()]);
    sections.push(['introspection', this._introspectionContext()]); // v7.1.7 F3: verified self-data
    sections.push(['version',       this._versionContext()]);

    return this._buildWithBudget(sections);
  }

}

// ── Prototype delegation: section generators ──────────────────
// Extracted to PromptBuilderSections.js (v5.6.0) — same pattern
// as Dashboard → DashboardRenderers, WorldState → WorldStateQueries.
const { sections } = require('./PromptBuilderSections');
Object.assign(PromptBuilder.prototype, sections);

module.exports = { PromptBuilder };
