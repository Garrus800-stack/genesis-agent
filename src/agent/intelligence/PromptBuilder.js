// @ts-checked-v5.8 — prototype delegation (PromptBuilderSections) not statically checkable
// ============================================================
// GENESIS — PromptBuilder.js
// Builds context-aware system prompts.
// Combines: identity, capabilities, knowledge, memory.
// ============================================================

const { createLogger } = require('../core/Logger');
const _log = createLogger('PromptBuilder');
class PromptBuilder {
  constructor({ selfModel, model, skills, knowledgeGraph, memory, anticipator, solutionAccumulator, selfOptimizer }) {
    this.selfModel = selfModel;
    this.model = model;
    this.skills = skills;
    this.kg = knowledgeGraph;
    this.memory = memory;
    this.anticipator = anticipator || null;
    this.solutions = solutionAccumulator || null;
    this.optimizer = selfOptimizer || null;

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

    // v4.12.4: Phase 13 — Consciousness modules (late-bound)
    this.phenomenalField = null;
    this.attentionalGate = null;
    this.temporalSelf = null;
    this.introspectionEngine = null;
    this.consciousnessExtension = null;
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
      [1, 'identity',      300],
      [1, 'formatting',    200],
      [2, 'session',       500],
      [2, 'capabilities',  300],
      [2, 'safety',        250],   // v4.12.8: Circuit breaker + error trends — operationally critical
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
      [8, 'consciousness', 300],   // v4.12.8: Demoted from P5→P8, reduced from 500→300
      [9, 'bodySchema',    150],   // v4.12.8: Demoted to lowest — almost never task-relevant
    ];

    // v5.9.9: A/B testing — disable prompt sections via env or settings.
    // GENESIS_AB_MODE=baseline → disables organism, consciousness, selfAwareness, bodySchema
    // GENESIS_AB_MODE=no-organism → disables organism, bodySchema only
    // GENESIS_AB_MODE=no-consciousness → disables consciousness only
    // GENESIS_DISABLED_SECTIONS=organism,consciousness → explicit list
    this._disabledSections = new Set();
    const abMode = process.env.GENESIS_AB_MODE || '';
    if (abMode === 'baseline') {
      ['organism', 'consciousness', 'selfAwareness', 'bodySchema', 'taskPerformance'].forEach(s => this._disabledSections.add(s));
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
   * Estimate token budget based on active model.
   * Cloud models get larger budgets than local 9B models.
   */
  _getTokenBudget() {
    const modelName = this.model?.activeModel || '';
    if (modelName.includes('claude') || modelName.includes('gpt')) return 8000; // Cloud: ~2000 tokens
    if (modelName.includes('70b') || modelName.includes('72b')) return 6400;    // Large local
    return this._tokenBudget; // Default: small local (9B)
  }

  /** Build the full system prompt with token budget */
  build() {
    return this._buildWithBudget([
      // @ts-ignore — TS strict
      ['identity',       this._identity()],
      // @ts-ignore — TS strict
      ['formatting',     this._formatting()],
      // @ts-ignore — TS strict
      ['session',        this._sessionContext()],
      // @ts-ignore — TS strict
      ['capabilities',   this._capabilities()],
      // @ts-ignore — TS strict
      ['mcp',            this._mcpContext()],
      // @ts-ignore — TS strict
      ['knowledge',      this._knowledgeContext()],
      // @ts-ignore — TS strict
      ['memory',         this._memoryContext()],
      // @ts-ignore — TS strict
      ['episodic',       this._episodicContext()],
      // @ts-ignore — TS strict
      ['perception',     this._perceptionContext()],
      // @ts-ignore — TS strict
      ['learning',       this._learningContext()],
      // @ts-ignore — TS strict
      ['lessons',        this._lessonsContext()],
      // @ts-ignore — TS strict
      ['solutions',      this._solutionContext()],
      // @ts-ignore — TS strict
      ['anticipator',    this._anticipatorContext()],
      // @ts-ignore — TS strict
      ['optimizer',      this._optimizerContext()],
      // @ts-ignore — TS strict
      ['metacognition',  this._metacognitiveContext()],
      // @ts-ignore — TS strict
      ['selfAwareness',  this._selfAwarenessContext()],
      // @ts-ignore — TS strict
      ['consciousness',  this._consciousnessContext()],
      // @ts-ignore — TS strict
      ['values',         this._valuesContext()],
      // @ts-ignore — TS strict
      ['userModel',      this._userModelContext()],
      // @ts-ignore — TS strict
      ['bodySchema',     this._bodySchemaContext()],
      // @ts-ignore — TS strict
      ['organism',       this._organismContext()],
      // @ts-ignore — TS strict
      ['taskPerformance', this._taskPerformanceContext()],
      // @ts-ignore — TS strict
      ['safety',         this._safetyContext()],
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

    // Sort sections by priority (lower number = higher priority)
    const sorted = sections
      .filter(([name, content]) => content && !this._disabledSections.has(name))
      .sort((a, b) => {
        const pa = Number(priorityMap.get(a[0])?.priority) || 99;
        const pb = Number(priorityMap.get(b[0])?.priority) || 99;
        return pa - pb;
      });

    const parts = [];
    let totalChars = 0;

    for (const [name, content] of sorted) {
      const maxChars = priorityMap.get(name)?.maxChars || 400;
      const truncated = content.length > maxChars ? content.slice(0, maxChars) + '...' : content;

      if (totalChars + truncated.length > budget) {
        // Budget exceeded — skip remaining lower-priority sections
        break;
      }

      parts.push(truncated);
      totalChars += truncated.length;
    }

    return parts.join('\n\n');
  }

  /**
   * Async build — uses UnifiedMemory when available for comprehensive recall.
   * Falls back to separate memory+KG calls if UnifiedMemory not wired.
   */
  async buildAsync() {
    const sections = [
      // @ts-ignore — TS strict
      ['identity',     this._identity()],
      // @ts-ignore — TS strict
      ['formatting',   this._formatting()],
      // @ts-ignore — TS strict
      ['session',      this._sessionContext()],
      // @ts-ignore — TS strict
      ['capabilities', this._capabilities()],
      // @ts-ignore — TS strict
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
        // @ts-ignore — TS strict
        sections.push(['knowledge', await this._knowledgeContextAsync()]);
        // @ts-ignore — TS strict
        sections.push(['memory',    await this._memoryContextAsync()]);
      }
    } else {
      // @ts-ignore — TS strict
      sections.push(['knowledge', await this._knowledgeContextAsync()]);
      // @ts-ignore — TS strict
      sections.push(['memory',    await this._memoryContextAsync()]);
    }

    // @ts-ignore — TS strict
    sections.push(['learning',      this._learningContext()]);
    // @ts-ignore — TS strict
    sections.push(['project',       this._projectContext()]);
    // @ts-ignore — TS strict
    sections.push(['lessons',       this._lessonsContext()]);
    // @ts-ignore — TS strict
    sections.push(['solutions',     this._solutionContext()]);
    // @ts-ignore — TS strict
    sections.push(['anticipator',   this._anticipatorContext()]);
    // @ts-ignore — TS strict
    sections.push(['optimizer',     this._optimizerContext()]);
    // @ts-ignore — TS strict
    sections.push(['episodic',      this._episodicContext()]);
    // @ts-ignore — TS strict
    sections.push(['perception',    this._perceptionContext()]);
    // @ts-ignore — TS strict
    sections.push(['metacognition', this._metacognitiveContext()]);
    // @ts-ignore — TS strict
    sections.push(['selfAwareness', this._selfAwarenessContext()]);
    // @ts-ignore — TS strict
    sections.push(['architecture',  this._architectureContext()]);
    // @ts-ignore — TS strict
    sections.push(['consciousness', this._consciousnessContext()]);
    // @ts-ignore — TS strict
    sections.push(['values',        this._valuesContext()]);
    // @ts-ignore — TS strict
    sections.push(['userModel',     this._userModelContext()]);
    // @ts-ignore — TS strict
    sections.push(['bodySchema',    this._bodySchemaContext()]);
    // @ts-ignore — TS strict
    sections.push(['organism',      this._organismContext()]);
    // @ts-ignore — TS strict
    sections.push(['taskPerformance', this._taskPerformanceContext()]);
    // @ts-ignore — TS strict
    sections.push(['safety',        this._safetyContext()]);

    return this._buildWithBudget(sections);
  }

}

// ── Prototype delegation: section generators ──────────────────
// Extracted to PromptBuilderSections.js (v5.6.0) — same pattern
// as Dashboard → DashboardRenderers, WorldState → WorldStateQueries.
const { sections } = require('./PromptBuilderSections');
Object.assign(PromptBuilder.prototype, sections);

module.exports = { PromptBuilder };
