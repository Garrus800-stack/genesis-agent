// ============================================================
// GENESIS — SymbolicResolver.js (v6.0.8 — The Learning Flywheel)
//
// PROBLEM: Every task goes through model.chat(), even when Genesis
// has solved the exact same problem before. LessonsStore has
// structured solutions, SchemaStore has abstracted patterns —
// but both are only injected as prompt context, never used as
// direct decision sources.
//
// SOLUTION: Before every AgentLoop step calls the LLM, check
// if existing knowledge can resolve it. Three levels:
//
//   DIRECT  — High confidence (>0.85), proven fix, safe action.
//             Execute without LLM. Instant. Zero tokens.
//
//   GUIDED  — Medium confidence (>0.5), relevant insight.
//             Call LLM but inject lesson as DIRECTIVE (not context).
//             "IMPORTANT: This approach worked before: [insight]"
//
//   PASS    — No match or low confidence. Normal LLM pipeline.
//
// This creates the learning flywheel:
//   Task → LLM solves it → LessonsStore captures
//   Same task again → SymbolicResolver finds it → skip LLM
//   If bypass fails → confidence drops → falls back to GUIDED → PASS
//
// Integration:
//   AgentLoopSteps._executeStep() → symbolicResolver.resolve()
//   LessonsStore + SchemaStore → data sources (no new storage)
//   EarnedAutonomy → gates DIRECT execution
//   Events: symbolic:resolved, symbolic:fallback
// ============================================================

'use strict';

const { createLogger } = require('../core/Logger');
const { NullBus } = require('../core/EventBus');
const _log = createLogger('SymbolicResolver');

// ── Resolution levels ────────────────────────────────────────
const LEVEL = Object.freeze({
  DIRECT:   'direct',    // Execute without LLM
  INFERRED: 'inferred',  // v7.0.9: Deterministic inference answered — no LLM needed
  GUIDED:   'guided',    // LLM with directive injection
  PASS:     'pass',      // Normal flow
});

// ── Thresholds ───────────────────────────────────────────────
const DEFAULTS = Object.freeze({
  /** Minimum confidence for DIRECT resolution */
  directThreshold: 0.85,
  /** Minimum useCount for DIRECT resolution */
  directMinUses: 3,
  /** Maximum age in days for DIRECT resolution */
  directMaxAgeDays: 7,
  /** Minimum confidence for GUIDED resolution.
   *  v7.9.9 Fix 2: raised 0.50 → 0.75. The v7.9.8 Win trace showed every
   *  step picking up the same `plan-failure-reflection` lesson at ~60% confidence
   *  ("Goal X failed (structural)") and routing it as AVOID-past-failure into
   *  unrelated current goals. 0.50 admits noise; 0.75 keeps only strong
   *  matches that genuinely apply to the current context. */
  guidedThreshold: 0.75,
  /** Maximum age in days for any GUIDED lesson — older lessons go stale.
   *  v7.9.9 Fix 2: anything older than 14 days is auto-discarded. */
  guidedMaxAgeDays: 14,
  /** Maximum AVOID-past-failure lessons that may be injected per pursuit.
   *  v7.9.9 Fix 2: cap at 1. Pre-fix, every step (ANALYZE → SEARCH → CODE_GENERATE
   *  → CODE) received its own AVOID warning, six in a row, which paralysed the
   *  LLM into producing no code-block at all. One warning per pursuit is enough. */
  maxAvoidLessonsPerPursuit: 1,
  /** Action types that can NEVER be DIRECT (too risky) */
  neverDirect: ['CODE', 'SELF_MODIFY', 'DELEGATE', 'SANDBOX'],
  /** Action types eligible for DIRECT execution */
  directEligible: ['ANALYZE', 'SHELL', 'SEARCH'],
});

// ── Category mapping from step types ─────────────────────────
const STEP_TO_CATEGORY = {
  'ANALYZE': 'analysis',
  'CODE': 'code-gen',
  'SHELL': 'debug',
  'SANDBOX': 'code-gen',
  'SEARCH': 'analysis',
  'DELEGATE': 'code-gen',
};

class SymbolicResolver {
  /**
   * @param {{ bus?: *, lessonsStore?: *, schemaStore?: *, config?: object }} deps
   */
  constructor({ bus, lessonsStore, schemaStore, config } = {}) {
    this.bus = bus || NullBus;
    this.lessonsStore = lessonsStore || null;
    this.schemaStore = schemaStore || null;
    this._config = { ...DEFAULTS, ...config };

    this._stats = {
      queries: 0,
      directHits: 0,
      guidedHits: 0,
      passes: 0,
      directSuccesses: 0,
      directFailures: 0,
    };

    // v7.9.9 Fix 1: per-pursuit AVOID-lesson counter. Pre-fix every step in
    // a pursuit got its own AVOID warning from the same stale plan-failure-
    // reflection lesson, paralysing the LLM. Reset on every pursuit-start
    // event. Counter is consulted in resolve() — if already at the cap
    // (DEFAULTS.maxAvoidLessonsPerPursuit), further AVOID lessons are dropped.
    this._avoidCountThisPursuit = 0;
    if (this.bus && typeof this.bus.on === 'function') {
      try {
        this.bus.on('agent-loop:starting-pursuit', () => {
          this._avoidCountThisPursuit = 0;
        }, { source: 'SymbolicResolver' });
      } catch (_e) { /* event subscription optional */ }
    }
  }

  // ════════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════════

  /**
   * v7.9.9 Fix 1: tokenise a goal description for affinity matching.
   * Mirrors the tokeniser in activities/Plan.js — same stopwords, same
   * minimum length. Used to compare currentGoal vs lesson.strategy.goalDescription.
   * @private
   * @param {string} s
   * @returns {Set<string>}
   */
  _tokenise(s) {
    const STOPWORDS = new Set([
      'activity', 'activities', 'error', 'errors', 'improve', 'improvement',
      'handle', 'handling', 'system', 'method', 'feature', 'function',
      'process', 'general', 'better', 'support', 'enable', 'allow',
      'with', 'from', 'into', 'goal', 'failed', 'add', 'check',
    ]);
    return new Set(String(s || '').toLowerCase()
      .replace(/[^a-z0-9äöüß]+/g, ' ').split(/\s+/)
      .filter(t => t.length >= 4 && !STOPWORDS.has(t)));
  }

  /**
   * Attempt to resolve a step without (or with reduced) LLM usage.
   *
   * @param {string} stepType    - ANALYZE, CODE, SHELL, etc.
   * @param {string} description - Step description from FormalPlanner
   * @param {string} [target]    - Target file or command
   * @param {object} [context]   - Additional context { model, error, goalId, goalDescription }
   * @returns {{ level: string, lesson?: object, schema?: object, directive?: string, confidence: number }}
   */
  resolve(stepType, description, target, context = {}) {
    this._stats.queries++;

    if (!this.lessonsStore && !this.schemaStore) {
      return this._pass('no knowledge stores available', stepType);
    }

    const category = STEP_TO_CATEGORY[stepType] || 'general';
    const tags = [stepType, context.model].filter(Boolean);

    // ── Query both stores ──────────────────────────────────
    const lessons = this._queryLessons(category, description, tags);
    const schemas = this._querySchemas(stepType, description, target);

    // ── Pick best match ────────────────────────────────────
    const bestLesson = lessons[0] || null;
    const bestSchema = schemas[0] || null;

    // Use whichever has higher confidence
    const lessonConf = bestLesson?.confidence || 0;
    const schemaConf = bestSchema?.confidence || 0;
    const bestConf = Math.max(lessonConf, schemaConf);
    const bestSource = lessonConf >= schemaConf ? bestLesson : bestSchema;

    if (bestConf < this._config.guidedThreshold) {
      return this._pass('confidence below guided threshold', stepType);
    }

    // ── Check for DIRECT eligibility ───────────────────────
    if (bestConf >= this._config.directThreshold && bestLesson) {
      const directResult = this._checkDirect(stepType, bestLesson);
      if (directResult) return directResult;
    }

    // ── v7.0.9 Phase 2: INFERRED — deterministic inference ──
    // If InferenceEngine can answer without LLM, use it
    if (this._inferenceEngine) {
      try {
        const inferred = this._inferenceEngine.infer({
          from: target || description,
          relation: 'caused',
        });
        if (inferred.length > 0 && inferred[0].confidence >= this._minConfidence) {
          this._stats.inferredHits = (this._stats.inferredHits || 0) + 1;
          const inferredDirective = `INFERRED: ${inferred.map(i => `${i.source} → ${i.target} (${i.relation}, conf ${(i.confidence * 100).toFixed(0)}%)`).join('; ')}`;

          _log.info(`[SYMBOLIC] INFERRED "${stepType}" — ${inferred.length} inference(s) (rule: ${inferred[0].rule})`);

          this.bus.fire('symbolic:resolved', {
            level: LEVEL.INFERRED,
            stepType,
            confidence: Math.round(inferred[0].confidence * 100),
            source: 'inference-engine',
            rule: inferred[0].rule,
          }, { source: 'SymbolicResolver' });

          return {
            level: LEVEL.INFERRED,
            directive: inferredDirective,
            confidence: inferred[0].confidence,
            inferences: inferred,
          };
        }
      } catch (err) {
        _log.debug('[SYMBOLIC] Inference failed:', err.message);
      }
    }

    // ── GUIDED: inject as directive ────────────────────────
    // v7.9.9 Fix 1: classify and filter BEFORE building the directive.
    // AVOID-class lessons need (a) goal-affinity to the current pursuit
    // and (b) the per-pursuit counter to be below the cap. Without these
    // gates, every step in every pursuit received the same stale failure-
    // lesson as an AVOID warning, paralysing the LLM.
    const isPredictionLesson = bestLesson && (
      bestLesson.source === 'plan-failure-reflection' ||
      ['structural', 'execution', 'external', 'user-action', 'unclassified', 'causal-suspicion'].includes(bestLesson.strategy?.classification)
    );

    if (isPredictionLesson) {
      // (a) Recency gate — drop lessons older than guidedMaxAgeDays.
      const ageDays = (Date.now() - (bestLesson.lastUsed || bestLesson.createdAt || 0)) / (1000 * 60 * 60 * 24);
      if (ageDays > this._config.guidedMaxAgeDays) {
        return this._pass(`avoid-lesson stale (${ageDays.toFixed(0)} days old)`, stepType);
      }
      // (b) Goal-affinity gate — only apply this lesson if the current
      //     goal shares ≥2 non-stopword tokens with the lesson's original
      //     goal-description. Otherwise it's a cross-goal contamination.
      const currentGoalDesc = context.goalDescription || '';
      const lessonGoalDesc = bestLesson.strategy?.goalDescription || '';
      if (currentGoalDesc && lessonGoalDesc) {
        const currentTokens = this._tokenise(currentGoalDesc);
        const lessonTokens = this._tokenise(lessonGoalDesc);
        let overlap = 0;
        for (const t of currentTokens) if (lessonTokens.has(t)) overlap++;
        if (overlap < 2) {
          return this._pass(`avoid-lesson goal-affinity too low (${overlap} tokens overlap)`, stepType);
        }
      }
      // (c) Per-pursuit counter — only the first N AVOID-lessons pass.
      if (this._avoidCountThisPursuit >= this._config.maxAvoidLessonsPerPursuit) {
        return this._pass(`avoid-lesson cap reached (${this._avoidCountThisPursuit} this pursuit)`, stepType);
      }
      this._avoidCountThisPursuit++;
    }

    const directive = this._buildDirective(bestLesson, bestSchema);
    this._stats.guidedHits++;

    // v7.9.8 Fix 8: GUIDED log marker — AVOID-past-failure vs proven-approach.
    const lessonMarker = isPredictionLesson ? 'AVOID-past-failure' : 'proven-approach';
    const insightSnippet = bestSource?.insight?.slice(0, 60) || bestSource?.name || '?';
    _log.info(`[SYMBOLIC] GUIDED "${stepType}" [${lessonMarker}] — ${insightSnippet} (conf=${(bestConf * 100).toFixed(0)}%)`);

    this.bus.fire('symbolic:resolved', {
      level: LEVEL.GUIDED,
      stepType,
      confidence: Math.round(bestConf * 100),
      source: bestLesson ? 'lesson' : 'schema',
    }, { source: 'SymbolicResolver' });

    return {
      level: LEVEL.GUIDED,
      lesson: bestLesson,
      schema: bestSchema,
      directive,
      confidence: bestConf,
    };
  }

  /**
   * Record the outcome of a symbolic resolution.
   * Feeds back into LessonsStore confidence.
   *
   * @param {string} level    - 'direct' or 'guided'
   * @param {string} lessonId - The lesson that was used
   * @param {boolean} success - Did it work?
   */
  recordOutcome(level, lessonId, success) {
    if (level === LEVEL.DIRECT) {
      if (success) this._stats.directSuccesses++;
      else this._stats.directFailures++;
    }

    // Boost or penalize lesson confidence via public LessonsStore API
    if (this.lessonsStore?.updateLessonOutcome && lessonId) {
      this.lessonsStore.updateLessonOutcome(lessonId, success);
    }
  }

  getStats() { return { ...this._stats }; }

  // ════════════════════════════════════════════════════════════
  // INTERNAL
  // ════════════════════════════════════════════════════════════

  /** @private */
  _queryLessons(category, description, tags) {
    if (!this.lessonsStore) return [];
    try {
      return this.lessonsStore.recall(category, { tags, query: description }, 3);
    } catch (_e) { return []; }
  }

  /** @private */
  _querySchemas(stepType, description, target) {
    if (!this.schemaStore) return [];
    try {
      return this.schemaStore.match(
        { type: stepType, description, target },
        {}
      );
    } catch (_e) { return []; }
  }

  /** @private — Check if DIRECT execution is safe and warranted */
  _checkDirect(stepType, lesson) {
    // Never DIRECT for risky actions
    if (this._config.neverDirect.includes(stepType)) return null;
    if (!this._config.directEligible.includes(stepType)) return null;

    // Minimum use count — don't trust a one-off success
    if ((lesson.useCount || 0) < this._config.directMinUses) return null;

    // Recency check — old lessons may be stale
    const ageDays = (Date.now() - (lesson.lastUsed || 0)) / (1000 * 60 * 60 * 24);
    if (ageDays > this._config.directMaxAgeDays) return null;

    // Must have an actionable strategy
    if (!lesson.strategy) return null;

    // v7.9.20 (B1): a STRING strategy is not DIRECT-eligible — only an OBJECT
    // strategy carries something DIRECT can actually apply (`{command,...}` from
    // LessonsAutoCapture, or the already-filtered `{classification,...}` from
    // failure reflections). Field trace: a manually-seeded lesson
    // ("step by step decomposition works best", strategy: 'step-by-step
    // decomposition', useCount 180, conf 0.99, source 'manual') passed every
    // existing gate and fired DIRECT on ANALYZE steps — but a string strategy
    // has no `.command`, so it landed in the non-shell DIRECT branch that
    // "returns the insight as the analysis", i.e. emitted the boilerplate
    // insight in place of a real analysis and bypassed _stepAnalyze (so no
    // agent-loop-analysis node was written). Every in-code lesson producer sets
    // an OBJECT strategy; only manual/external lessons can be a bare string, so
    // this gate is surgical. Such a lesson may still GUIDE (directive to the
    // LLM); it just no longer REPLACES the LLM.
    if (typeof lesson.strategy === 'string') return null;

    // v7.9.7 P1: filter PREDICTION-class lessons. AgentLoopPursuitReflection
    // writes "Goal failed (structural): ..." records with source
    // 'plan-failure-reflection' and strategy.classification ∈ {structural,
    // execution, external, user-action, unclassified}. Those describe what
    // FAILED, not what worked — passing them through to DIRECT would have
    // Genesis short-circuit a fresh task with a recall of last time's
    // failure as if it were the answer. Live-Befund v7.9.7 outpost trace:
    // SymbolicResolver returned DIRECT with uses=14→19→32→117→122 on a
    // lesson whose insight was the literal error string "Cannot find
    // module ...". Both the explicit source marker and the classification
    // field gate this — either alone is sufficient.
    if (lesson.source === 'plan-failure-reflection') return null;
    const cls = lesson.strategy?.classification;
    if (cls && ['structural', 'execution', 'external', 'user-action', 'unclassified', 'causal-suspicion'].includes(cls)) {
      return null;
    }

    this._stats.directHits++;

    _log.info(`[SYMBOLIC] DIRECT "${stepType}" — ${lesson.insight?.slice(0, 60)} (uses=${lesson.useCount}, conf=${(lesson.confidence * 100).toFixed(0)}%)`);

    this.bus.fire('symbolic:resolved', {
      level: LEVEL.DIRECT,
      stepType,
      confidence: Math.round(lesson.confidence * 100),
      source: 'lesson',
      lessonId: lesson.id,
    }, { source: 'SymbolicResolver' });

    return {
      level: LEVEL.DIRECT,
      lesson,
      schema: null,
      directive: undefined,
      confidence: lesson.confidence,
    };
  }

  /** @private — Build a directive string for GUIDED mode */
  _buildDirective(lesson, schema) {
    const parts = [];

    // v7.9.7 P1: invert framing for plan-failure-reflection (and causal-
    // suspicion) lessons. These are warnings — the LLM should see "AVOID
    // this approach", not "proven approach". Mixing the two framings in
    // GUIDED prompts was confusing the LLM into treating warnings as
    // recommendations.
    const isPredictionLesson =
      lesson?.source === 'plan-failure-reflection' ||
      ['structural', 'execution', 'external', 'user-action', 'unclassified', 'causal-suspicion'].includes(lesson?.strategy?.classification);

    if (lesson?.insight) {
      if (isPredictionLesson) {
        parts.push(`WARNING — AVOID this approach (past attempts failed for this shape of task):`);
        parts.push(`  "${lesson.insight}"`);
        if (lesson.strategy?.errorMessage) {
          parts.push(`  Past error: ${String(lesson.strategy.errorMessage).slice(0, 200)}`);
        }
        parts.push(`  Take a different approach — do NOT repeat what is described above.`);
      } else {
        parts.push(`IMPORTANT — A proven approach for this type of task:`);
        parts.push(`  "${lesson.insight}"`);
        if (lesson.strategy?.promptStyle) {
          parts.push(`  Recommended style: ${lesson.strategy.promptStyle}`);
        }
        if (lesson.strategy?.command) {
          parts.push(`  Known working command: ${lesson.strategy.command}`);
        }
      }
    }

    if (schema?.recommendation) {
      parts.push(`PATTERN MATCH — Previous experience suggests:`);
      parts.push(`  "${schema.recommendation}"`);
      if (schema.successModifier > 0.2) {
        parts.push(`  This pattern has historically improved success by ${Math.round(schema.successModifier * 100)}%.`);
      } else if (schema.successModifier < -0.2) {
        parts.push(`  WARNING: This pattern has historically reduced success by ${Math.round(Math.abs(schema.successModifier) * 100)}%. Consider an alternative approach.`);
      }
    }

    return parts.length > 0 ? parts.join('\n') : '';
  }

  /** @private */
  _pass(reason, stepType) {
    this._stats.passes++;

    if (stepType) {
      this.bus.fire('symbolic:fallback', {
        reason,
        stepType,
      }, { source: 'SymbolicResolver' });
    }

    return { level: LEVEL.PASS, confidence: 0, directive: '' };
  }
}

module.exports = { SymbolicResolver, LEVEL };
