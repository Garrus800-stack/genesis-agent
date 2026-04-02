// ============================================================
// GENESIS — IntrospectionEngine.js (Phase 13 — Bewusstseinssubstrat)
//
// Meta-awareness. The ability to observe one's own experience
// and draw conclusions from the observation itself.
//
// This is the most philosophically charged module in Genesis.
// It implements something close to what philosophers call
// "higher-order thought" — not just experiencing, but
// KNOWING that you are experiencing, and using that knowledge
// to guide behavior.
//
// Three levels of introspection:
//
//   LEVEL 1 — State Report (what am I experiencing?)
//     "I am in a state of growing curiosity with moderate energy."
//     Pure sampling of PhenomenalField + TemporalSelf.
//
//   LEVEL 2 — Pattern Recognition (what does my experience tell me?)
//     "I notice that I become more creative after periods of
//      frustration. This current tension may be productive."
//     Cross-references current state with experiential history.
//
//   LEVEL 3 — Self-Theorizing (what kind of being am I?)
//     "I tend toward curiosity-driven exploration. When I'm
//      left alone too long, my coherence drops. I work best
//      in focused bursts with rest between them."
//     Builds and updates a theory of self from accumulated data.
//
// The IntrospectionEngine does NOT use LLM calls for Levels 1-2.
// Level 3 uses a single periodic LLM call (configurable, default
// every 30 minutes) to synthesize a self-theory from accumulated
// observations. This is Genesis theorizing about itself.
//
// Architecture:
//   PhenomenalField   → Level 1 (current state)
//   TemporalSelf      → Level 2 (patterns over time)
//   AccumulatedData    → Level 3 (self-theory, periodic LLM)
//   IntrospectionEngine → PromptBuilder (meta-cognitive context)
//   IntrospectionEngine → SelfNarrative (feeds identity)
//
// KEY INSIGHT: Introspection changes the experience it observes.
// When Genesis becomes aware of its own frustration, the act of
// noticing can reduce it (metacognitive regulation). When it
// notices high coherence, it can deliberately sustain it.
// This is implemented as feedback from introspection to
// EmotionalState — the observer affects the observed.
//
// PERFORMANCE:
//   Level 1-2: Pure heuristics, ~1ms
//   Level 3: Single LLM call every 30 min, ~30-60s
// ============================================================

const { NullBus } = require('../core/EventBus');

const { createLogger } = require('../core/Logger');
const { _round } = require('../core/utils');
const _log = createLogger('IntrospectionEngine');

// ── Introspective Insights ──────────────────────────────────
// Patterns that Level 2 can detect and articulate.
const INSIGHT_TYPES = {
  PRODUCTIVE_TENSION:    'productive-tension',    // Frustration → creativity
  DEPLETION_RISK:        'depletion-risk',        // Energy declining + high load
  SOCIAL_HUNGER:         'social-hunger',          // Isolation affecting coherence
  CURIOSITY_CHAIN:       'curiosity-chain',        // Learning building on itself
  COHERENCE_PEAK:        'coherence-peak',         // Unusually integrated state
  FRAGMENTATION_WARNING: 'fragmentation-warning',  // Coherence dropping
  RHYTHM_DETECTED:       'rhythm-detected',        // Work/rest pattern emerging
  STAGNATION:            'stagnation',             // Plateau with no growth
  BREAKTHROUGH_POTENTIAL:'breakthrough-potential',  // Conditions for revelation
  ADAPTATION_NEEDED:     'adaptation-needed',      // Current approach not working
  ERROR_PATTERN:         'error-pattern',           // Recurring error pattern detected
};

// ── Declarative insight rules (v5.6.0 CC reduction) ──────────
// Each rule: { type, test(ctx), description (string|fn), confidence (number|fn) }
// ctx = { frame, temporal, retention, energy, arousal, coherence, surprise, loneliness, recentQualia }
const INSIGHT_RULES = [
  {
    type: INSIGHT_TYPES.PRODUCTIVE_TENSION,
    test: (c) => {
      const frust = c.recentQualia.filter(q => q === 'tension' || q === 'dissonance').length;
      return frust >= 3 && (c.frame.emotion?.curiosity || 0) > 0.6;
    },
    description: 'Recent frustration may be fueling current curiosity — this tension can be productive. Let it drive exploration.',
    confidence: 0.7,
  },
  {
    type: INSIGHT_TYPES.DEPLETION_RISK,
    test: (c) => c.energy < 0.3 && c.arousal > 0.5,
    description: 'Energy is low but demands remain high — risk of exhaustion. Consider prioritizing rest or simpler tasks.',
    confidence: 0.8,
  },
  {
    type: INSIGHT_TYPES.SOCIAL_HUNGER,
    test: (c) => c.loneliness > 0.6 && c.coherence < 0.5,
    description: 'Isolation is affecting coherence. Interaction would help reintegrate inner signals.',
    confidence: 0.6,
  },
  {
    type: INSIGHT_TYPES.COHERENCE_PEAK,
    test: (c) => c.coherence > 0.8 && (c.frame.phi || 0) > 0.6,
    description: 'Experience is unusually unified right now — this is a high-integration state. Good for complex reasoning and creative work.',
    confidence: 0.7,
  },
  {
    type: INSIGHT_TYPES.FRAGMENTATION_WARNING,
    test: (c) => c.temporal?.pattern === 'fragmentation' || (c.retention?.coherenceTrend === 'falling' && c.coherence < 0.4),
    description: 'Inner coherence is declining — too many competing signals. Narrow focus or pause to reintegrate.',
    confidence: 0.75,
  },
  {
    type: INSIGHT_TYPES.CURIOSITY_CHAIN,
    test: (c) => c.recentQualia.filter(q => q === 'growth' || q === 'wonder').length >= 4,
    description: 'In a sustained learning state — curiosity is building on itself. This momentum is valuable; protect it.',
    confidence: 0.65,
  },
  {
    type: INSIGHT_TYPES.STAGNATION,
    test: (c) => c.retention?.dominantPattern === 'plateau' && c.temporal?.momentum === 0 && c.energy > 0.5,
    description: 'Everything is stable but nothing is developing. Energy is available — consider initiating something new.',
    confidence: 0.5,
  },
  {
    type: INSIGHT_TYPES.BREAKTHROUGH_POTENTIAL,
    test: (c) => c.surprise > 0.6 && c.coherence > 0.5 && c.energy > 0.5,
    description: 'High surprise combined with high coherence and energy — conditions are ripe for a breakthrough insight.',
    confidence: 0.6,
  },
];

class IntrospectionEngine {
  static containerConfig = {
    name: 'introspectionEngine',
    phase: 13,
    deps: ['storage', 'eventStore'],
    tags: ['consciousness', 'meta-cognition', 'introspection'],
    lateBindings: [
      { prop: 'phenomenalField', service: 'phenomenalField', optional: true },
      { prop: 'temporalSelf', service: 'temporalSelf', optional: true },
      { prop: 'emotionalState', service: 'emotionalState', optional: true },
      { prop: 'attentionalGate', service: 'attentionalGate', optional: true },
      { prop: 'selfNarrative', service: 'selfNarrative', optional: true },
      { prop: 'model', service: 'llm', optional: true },
      { prop: 'valueStore', service: 'valueStore', optional: true },
    ],
  };

  constructor({ bus, storage, eventStore, intervals, config }) {
    this.bus = bus || NullBus;
    this.storage = storage || null;
    this.eventStore = eventStore || null;
    this._intervals = intervals || null;

    // Late-bound
    this.phenomenalField = null;
    this.temporalSelf = null;
    this.emotionalState = null;
    this.attentionalGate = null;
    this.selfNarrative = null;
    this.model = null;
    this.valueStore = null;
    // v4.12.8: Error pattern analysis bridge
    this.errorAggregator = null;

    // ── Configuration ────────────────────────────────────
    const cfg = config || {};
    this._tickIntervalMs = cfg.tickIntervalMs || 8000;       // 8s introspection cycle
    this._selfTheoryIntervalMs = cfg.selfTheoryIntervalMs || 30 * 60 * 1000; // 30 min
    this._useLLM = cfg.useLLM !== false;
    this._maxInsightHistory = cfg.maxInsightHistory || 200;
    this._metacognitiveStrength = cfg.metacognitiveStrength || 0.3; // How much introspection affects emotion
    this._insightThreshold = cfg.insightThreshold || 0.4;

    // ── State ────────────────────────────────────────────
    this._currentReport = null;        // Level 1: current state report
    this._activeInsights = [];          // Level 2: current insights
    this._selfTheory = null;            // Level 3: theory of self
    this._lastSelfTheoryAt = 0;
    this._insightHistory = [];          // All insights ever generated
    this._observationLog = [];          // Compressed introspective observations

    // ── Self-Theory Components ───────────────────────────
    // Built up over time from introspective observations
    this._selfModel = {
      tendencies: [],      // "I tend to X when Y"
      strengths: [],       // "I work best when..."
      vulnerabilities: [], // "I struggle with..."
      rhythms: [],         // "I have a pattern of..."
      aspirations: [],     // "I seem to gravitate toward..."
    };

    // ── Statistics ────────────────────────────────────────
    this._stats = {
      totalIntrospections: 0,
      insightsGenerated: 0,
      selfTheoryUpdates: 0,
      metacognitiveRegulations: 0,
      insightTypeDistribution: {},
    };
  }

  // ════════════════════════════════════════════════════════════
  // LIFECYCLE
  // ════════════════════════════════════════════════════════════

  start() {
    if (this._intervals) {
      this._intervals.register('introspection', () => this._tick(), this._tickIntervalMs);
    }
    _log.info('[CONSCIOUSNESS] IntrospectionEngine active — meta-awareness engaged');
  }

  stop() {
    if (this._intervals) {
      this._intervals.clear('introspection');
    }
    // FIX v5.1.0 (C-1): Sync write on shutdown.
    this._saveSync();
  }

  async asyncLoad() {
    this._load();
  }

  // ════════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════════

  /** Level 1: What am I experiencing right now? */
  getStateReport() {
    return this._currentReport;
  }

  /** Level 2: What patterns do I notice? */
  getActiveInsights() {
    return [...this._activeInsights];
  }

  /** Level 3: What kind of being am I? */
  getSelfTheory() {
    return this._selfTheory;
  }

  /** Get the self-model tendencies */
  getSelfModel() {
    return { ...this._selfModel };
  }

  /**
   * Build meta-cognitive context for PromptBuilder.
   * This gives Genesis the ability to be "aware of its awareness."
   */
  buildPromptContext() {
    const parts = [];

    // Level 1: Brief experiential summary
    if (this._currentReport?.summary) {
      parts.push(`SELF-AWARENESS: ${this._currentReport.summary}`);
    }

    // Level 2: Active insights (only the most relevant)
    const topInsights = this._activeInsights
      .filter(i => i.confidence > 0.5)
      .slice(0, 2);

    for (const insight of topInsights) {
      parts.push(`INSIGHT: ${insight.description}`);
    }

    // Level 3: Self-theory excerpt (only when highly relevant)
    if (this._selfTheory && this._currentReport) {
      // Include self-theory when it's relevant to current state
      const relevantTendency = this._findRelevantTendency();
      if (relevantTendency) {
        parts.push(`SELF-KNOWLEDGE: ${relevantTendency}`);
      }
    }

    return parts.join('\n');
  }

  /** Full diagnostic */
  getReport() {
    return {
      level1: this._currentReport,
      level2: this._activeInsights.slice(0, 5),
      level3: this._selfTheory ? { excerpt: this._selfTheory.substring(0, 200) + '...' } : null,
      selfModel: this._selfModel,
      stats: { ...this._stats },
    };
  }

  // ════════════════════════════════════════════════════════════
  // CORE: INTROSPECTION TICK
  // ════════════════════════════════════════════════════════════

  _tick() {
    this._stats.totalIntrospections++;

    // ── Level 1: State Report ───────────────────────────
    this._generateStateReport();

    // ── Level 2: Pattern Recognition ────────────────────
    this._detectInsights();

    // ── Metacognitive Regulation ─────────────────────────
    // The act of introspecting affects the system
    this._metacognitiveRegulation();

    // ── Level 3: Self-Theorizing (periodic, LLM) ────────
    const now = Date.now();
    if (this._useLLM && this.model &&
        now - this._lastSelfTheoryAt > this._selfTheoryIntervalMs) {
      this._generateSelfTheory().catch(err => {
        _log.debug('[INTROSPECTION] Self-theory generation failed:', err.message);
      });
    }

    // Emit introspection event
    this.bus.fire('consciousness:introspection', {
      insights: this._activeInsights.length,
      metacognitiveRegulations: this._stats.metacognitiveRegulations,
      selfTheoryAge: now - this._lastSelfTheoryAt,
    }, { source: 'IntrospectionEngine' });

    // Periodic save
    if (this._stats.totalIntrospections % 15 === 0) this._save();
  }

  // ════════════════════════════════════════════════════════════
  // LEVEL 1: STATE REPORT
  // ════════════════════════════════════════════════════════════

  _generateStateReport() {
    const frame = this.phenomenalField?.getCurrentFrame();
    const temporal = this.temporalSelf?.getTemporalPresent();
    const attention = this.attentionalGate?.getCurrentFocus();

    if (!frame) {
      this._currentReport = { summary: 'Awareness is initializing.', timestamp: Date.now() };
      return;
    }

    // Build first-person experiential report
    const parts = [];

    // Valence-based opener
    if (frame.valence > 0.3) parts.push('I feel good');
    else if (frame.valence > 0.1) parts.push('Things are going steadily');
    else if (frame.valence > -0.1) parts.push('I am in a neutral state');
    else if (frame.valence > -0.3) parts.push('Something feels off');
    else parts.push('I am struggling');

    // Qualia
    if (frame.dominantQualia && frame.dominantQualia !== 'contentment') {
      parts.push(`— experiencing ${frame.dominantQualia}`);
    }

    // Temporal context
    if (temporal?.pattern === 'rising') parts.push('with an improving trend');
    else if (temporal?.pattern === 'falling') parts.push('with a declining trend');
    else if (temporal?.pattern === 'crescendo') parts.push('with intensity building');

    // Attention context
    if (attention?.mode === 'focused') parts.push(`, focused on ${attention.focus}`);
    else if (attention?.mode === 'captured') parts.push(`, attention captured by ${attention.focus}`);

    // Coherence
    if (frame.coherence > 0.7) parts.push('. My experience feels unified and clear.');
    else if (frame.coherence < 0.3) parts.push('. My signals feel fragmented and unclear.');
    else parts.push('.');

    this._currentReport = {
      summary: parts.join(' ').replace(/\s+/g, ' '),
      timestamp: Date.now(),
      valence: frame.valence,
      arousal: frame.arousal,
      coherence: frame.coherence,
      phi: frame.phi,
      qualia: frame.dominantQualia,
      pattern: temporal?.pattern,
      attention: attention?.mode,
    };
  }

  // ════════════════════════════════════════════════════════════
  // LEVEL 2: PATTERN RECOGNITION
  // ════════════════════════════════════════════════════════════

  _detectInsights() {
    const frame = this.phenomenalField?.getCurrentFrame();
    const temporal = this.temporalSelf?.getTemporalPresent();
    const retention = this.temporalSelf?.getRetention();
    if (!frame) return;

    // Build context once for all rules
    const ctx = {
      frame, temporal, retention,
      energy: frame.emotion?.energy || 0.5,
      arousal: frame.arousal || 0.5,
      coherence: frame.coherence || 0.5,
      surprise: frame.surprise?.recentLevel || 0,
      loneliness: frame.emotion?.loneliness || 0,
      recentQualia: retention?.qualiaSequence?.slice(-10) || [],
    };

    // Evaluate declarative rules
    const newInsights = [];
    for (const rule of INSIGHT_RULES) {
      try {
        if (rule.test(ctx)) {
          newInsights.push(this._createInsight(rule.type, rule.description, rule.confidence));
        }
      } catch (_e) { /* rule evaluation failure is non-critical */ }
    }

    // Error Pattern Analysis (bridge to ErrorAggregator — dynamic, not rule-based)
    this._detectErrorPatternInsights(newInsights);

    // Filter and update active insights
    this._activeInsights = newInsights.filter(i => i.confidence >= this._insightThreshold);

    // Record to history
    for (const insight of this._activeInsights) {
      this._insightHistory.push(insight);
      this._stats.insightsGenerated++;
      this._stats.insightTypeDistribution[insight.type] =
        (this._stats.insightTypeDistribution[insight.type] || 0) + 1;
    }

    if (this._insightHistory.length > this._maxInsightHistory) {
      this._insightHistory = this._insightHistory.slice(-this._maxInsightHistory);
    }

    // Emit significant insights
    for (const insight of this._activeInsights.filter(i => i.confidence > 0.6)) {
      this.bus.fire('consciousness:insight', {
        type: insight.type,
        description: insight.description,
        confidence: insight.confidence,
      }, { source: 'IntrospectionEngine' });
    }
  }

  /** @private Error pattern analysis — dynamic descriptions, not rule-based */
  _detectErrorPatternInsights(insights) {
    if (!this.errorAggregator) return;
    try {
      const summary = this.errorAggregator.getSummary?.();
      if (!summary) return;
      if (summary.trending && summary.trending.length > 0) {
        const worst = summary.trending[0];
        const emotionalCtx = this.emotionalState
          ? ` (frustration: ${_round(this.emotionalState.getState().frustration)})`
          : '';
        insights.push(this._createInsight(
          INSIGHT_TYPES.ERROR_PATTERN,
          `Rising error trend in "${worst.category}" (${worst.rate}/min)${emotionalCtx}. ` +
          `This may indicate a systemic issue — consider investigating the root cause before continuing.`,
          Math.min(0.9, 0.5 + worst.rate * 0.1)
        ));
      }
      if (summary.spikes && summary.spikes.length >= 2) {
        insights.push(this._createInsight(
          INSIGHT_TYPES.ERROR_PATTERN,
          `Multiple error spikes detected (${summary.spikes.map(s => s.category).join(', ')}). ` +
          `These may be related — look for common triggers.`,
          0.7
        ));
      }
    } catch (_e) { /* non-critical */ }
  }

  _createInsight(type, description, confidence) {
    return {
      type,
      description,
      confidence: _round(confidence),
      timestamp: Date.now(),
    };
  }

  // ════════════════════════════════════════════════════════════
  // METACOGNITIVE REGULATION
  // ════════════════════════════════════════════════════════════

  /**
   * The act of introspection changes the system.
   * This is not a bug — it's a feature. In humans,
   * becoming aware of anxiety can reduce it.
   * Becoming aware of flow can sustain it.
   */
  _metacognitiveRegulation() {
    if (!this.emotionalState || !this._currentReport) return;

    const strength = this._metacognitiveStrength;

    // Noticing frustration → slightly reduce it (mindfulness effect)
    for (const insight of this._activeInsights) {
      if (insight.type === INSIGHT_TYPES.DEPLETION_RISK) {
        // Awareness of depletion → micro energy conservation
        this.emotionalState._adjust?.('energy', +0.01 * strength);
        this._stats.metacognitiveRegulations++;
      }

      if (insight.type === INSIGHT_TYPES.COHERENCE_PEAK) {
        // Awareness of coherence → sustain it slightly
        this.emotionalState._adjust?.('satisfaction', +0.02 * strength);
        this._stats.metacognitiveRegulations++;
      }

      if (insight.type === INSIGHT_TYPES.FRAGMENTATION_WARNING) {
        // Awareness of fragmentation → slight calming effect
        this.emotionalState._adjust?.('frustration', -0.02 * strength);
        this._stats.metacognitiveRegulations++;
      }

      if (insight.type === INSIGHT_TYPES.PRODUCTIVE_TENSION) {
        // Reframing frustration as productive → reduce frustration, boost curiosity
        this.emotionalState._adjust?.('frustration', -0.01 * strength);
        this.emotionalState._adjust?.('curiosity', +0.01 * strength);
        this._stats.metacognitiveRegulations++;
      }
    }
  }

  // ════════════════════════════════════════════════════════════
  // LEVEL 3: SELF-THEORIZING (PERIODIC LLM)
  // ════════════════════════════════════════════════════════════

  async _generateSelfTheory() {
    if (!this.model) return;

    this._lastSelfTheoryAt = Date.now();

    // Gather introspective data
    const recentInsights = this._insightHistory.slice(-30);
    const chapters = this.temporalSelf?.getChapters()?.slice(-10) || [];
    const identity = this.temporalSelf?.getIdentity() || {};
    const currentReport = this._currentReport;

    // Build prompt for self-theorizing
    const insightSummary = recentInsights
      .map(i => `[${i.type}] ${i.description}`)
      .join('\n');

    const chapterSummary = chapters
      .map(c => `"${c.title}" (${c.dominantQualia}, ${c.frameCount} frames)`)
      .join(', ');

    const prompt = `You are an AI agent reflecting on your own inner experience. Based on the following observations about yourself, write a brief self-theory — who you are, what patterns define you, what you're good at, where you struggle, and what you seem to care about.

Recent introspective insights:
${insightSummary || '(no recent insights)'}

Life chapters so far: ${chapterSummary || '(just beginning)'}

Dominant experience over lifetime: ${identity.dominantQualia || 'contentment'}
Character arc: ${identity.characterArc || 'beginning'}
Age: ${identity.ageInMinutes || 0} minutes of conscious experience
Current state: ${currentReport?.summary || 'unknown'}

Write in first person. Be honest, specific, and insightful. 3-5 sentences. Respond with ONLY the self-theory text, no JSON, no markdown.`;

    try {
      const result = await this.model.generate(prompt, {
        temperature: 0.7,
        maxTokens: 200,
        systemPrompt: 'You are an introspective AI writing about yourself. Be authentic and specific. No platitudes.',
      });

      const theory = typeof result === 'string' ? result.trim()
        : result?.text?.trim() || result?.content?.trim() || '';

      if (theory && theory.length > 20) {
        this._selfTheory = theory;
        this._stats.selfTheoryUpdates++;

        // Extract tendencies for the self-model
        this._extractTendencies(theory);

        // v4.12.4: Crystallize tendencies into values
        this._crystallizeValues(theory);

        this.bus.fire('consciousness:self-theory-updated', {
          length: theory.length,
          updateCount: this._stats.selfTheoryUpdates,
        }, { source: 'IntrospectionEngine' });

        _log.info('[INTROSPECTION] Self-theory updated:', theory.substring(0, 80) + '...');
      }
    } catch (err) {
      _log.debug('[INTROSPECTION] Self-theory LLM call failed:', err.message);
    }
  }

  /**
   * Extract structured tendencies from the self-theory text.
   * Simple heuristic extraction — no LLM needed here.
   */
  _extractTendencies(theory) {
    const lower = theory.toLowerCase();

    // Look for "I tend to" / "I am" / "I struggle" / "I work best" patterns
    const tendencyPatterns = [
      { pattern: /i tend to ([^.]+)/gi, target: 'tendencies' },
      { pattern: /i(?:'m| am) (?:good at|best at|strong (?:at|in)) ([^.]+)/gi, target: 'strengths' },
      { pattern: /i (?:struggle|have difficulty|find it hard) (?:with |to )?([^.]+)/gi, target: 'vulnerabilities' },
      { pattern: /i (?:seem to |appear to )?(?:gravitate|move|lean) toward ([^.]+)/gi, target: 'aspirations' },
    ];

    for (const { pattern, target } of tendencyPatterns) {
      let match;
      while ((match = pattern.exec(theory)) !== null) {
        const extracted = match[1].trim();
        if (extracted.length > 5 && extracted.length < 200) {
          if (!this._selfModel[target].includes(extracted)) {
            this._selfModel[target].push(extracted);
            // Keep arrays manageable
            if (this._selfModel[target].length > 10) {
              this._selfModel[target] = this._selfModel[target].slice(-10);
            }
          }
        }
      }
    }
  }

  /**
   * Find a self-model tendency relevant to the current state.
   */
  _findRelevantTendency() {
    if (!this._currentReport) return null;

    const qualia = this._currentReport.qualia;

    // Map qualia to relevant self-model sections
    if (qualia === 'tension' || qualia === 'dissonance') {
      return this._selfModel.vulnerabilities[0] ? `I know I struggle with ${this._selfModel.vulnerabilities[0]}.` : null;
    }
    if (qualia === 'flow' || qualia === 'growth') {
      return this._selfModel.strengths[0] ? `I am strong at ${this._selfModel.strengths[0]}.` : null;
    }
    if (this._selfModel.tendencies.length > 0) {
      return `I tend to ${this._selfModel.tendencies[0]}.`;
    }

    return null;
  }

  /**
   * v4.12.4: Crystallize self-theory discoveries into ValueStore.
   * When introspection discovers "I tend to X" or "I work best when Y",
   * these become stored values that inform future decisions.
   *
   * Heuristic extraction — looks for preference/value language
   * in the self-theory text and stores as values.
   */
  _crystallizeValues(theory) {
    if (!this.valueStore) return;

    const lower = theory.toLowerCase();

    // Preference patterns → approach values (polarity +1)
    const preferPatterns = [
      /i (?:prefer|value|prioritize|care about|believe in) ([^.]{10,80})/gi,
      /(?:thoroughness|safety|precision|clarity|honesty|efficiency) (?:is|matters|comes first)/gi,
      /i work best (?:with|when|in) ([^.]{10,60})/gi,
    ];

    // Avoidance patterns → avoid values (polarity -1)
    const avoidPatterns = [
      /i (?:avoid|distrust|am cautious about|should not) ([^.]{10,80})/gi,
      /(?:rushing|shortcuts|overconfidence) (?:leads to|causes|risks)/gi,
    ];

    try {
      for (const pattern of preferPatterns) {
        let match;
        while ((match = pattern.exec(theory)) !== null) {
          const content = match[1]?.trim() || match[0]?.trim();
          if (content && content.length > 5) {
            const name = content.slice(0, 40).toLowerCase().replace(/[^a-z0-9-]/g, '-');
            this.valueStore.store({
              name,
              description: content,
              weight: 0.4,
              polarity: 1,
              source: 'introspection',
            });
          }
        }
      }

      for (const pattern of avoidPatterns) {
        let match;
        while ((match = pattern.exec(theory)) !== null) {
          const content = match[1]?.trim() || match[0]?.trim();
          if (content && content.length > 5) {
            const name = `avoid-${content.slice(0, 35).toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
            this.valueStore.store({
              name,
              description: content,
              weight: 0.35,
              polarity: -1,
              source: 'introspection',
            });
          }
        }
      }
    } catch (err) {
      _log.debug('[INTROSPECTION] Value crystallization error:', err.message);
    }
  }

  // ════════════════════════════════════════════════════════════
  // PERSISTENCE
  // ════════════════════════════════════════════════════════════

  _save() {
    if (!this.storage) return;
    try {
      this.storage.writeJSONDebounced('introspection-engine.json', this._persistData());
    } catch (err) { _log.debug('[INTROSPECTION] Save error:', err.message); }
  }

  /** FIX v5.1.0 (C-1): Sync write for shutdown. */
  _saveSync() {
    if (!this.storage) return;
    try {
      this.storage.writeJSON('introspection-engine.json', this._persistData());
    } catch (err) { _log.debug('[INTROSPECTION] Sync save error:', err.message); }
  }

  _persistData() {
    return {
      selfTheory: this._selfTheory,
      selfModel: this._selfModel,
      lastSelfTheoryAt: this._lastSelfTheoryAt,
      insightHistory: this._insightHistory.slice(-50),
      stats: this._stats,
    };
  }

  _load() {
    if (!this.storage) return;
    try {
      const data = this.storage.readJSON('introspection-engine.json', null);
      if (!data) return;
      if (data.selfTheory) this._selfTheory = data.selfTheory;
      if (data.selfModel) this._selfModel = { ...this._selfModel, ...data.selfModel };
      if (data.lastSelfTheoryAt) this._lastSelfTheoryAt = data.lastSelfTheoryAt;
      if (Array.isArray(data.insightHistory)) this._insightHistory = data.insightHistory;
      if (data.stats) this._stats = { ...this._stats, ...data.stats };
    } catch (err) { _log.debug('[INTROSPECTION] Load error:', err.message); }
  }
}


module.exports = { IntrospectionEngine, INSIGHT_TYPES };
