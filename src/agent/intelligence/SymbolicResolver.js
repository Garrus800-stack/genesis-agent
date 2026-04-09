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
  DIRECT: 'direct',   // Execute without LLM
  GUIDED: 'guided',   // LLM with directive injection
  PASS:   'pass',     // Normal flow
});

// ── Thresholds ───────────────────────────────────────────────
const DEFAULTS = Object.freeze({
  /** Minimum confidence for DIRECT resolution */
  directThreshold: 0.85,
  /** Minimum useCount for DIRECT resolution */
  directMinUses: 3,
  /** Maximum age in days for DIRECT resolution */
  directMaxAgeDays: 7,
  /** Minimum confidence for GUIDED resolution */
  guidedThreshold: 0.50,
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
  }

  // ════════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════════

  /**
   * Attempt to resolve a step without (or with reduced) LLM usage.
   *
   * @param {string} stepType    — ANALYZE, CODE, SHELL, etc.
   * @param {string} description - Step description from FormalPlanner
   * @param {string} [target]    - Target file or command
   * @param {object} [context]   - Additional context { model, error, goalId }
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

    // ── GUIDED: inject as directive ────────────────────────
    const directive = this._buildDirective(bestLesson, bestSchema);
    this._stats.guidedHits++;

    _log.info(`[SYMBOLIC] GUIDED "${stepType}" — ${bestSource?.insight?.slice(0, 60) || bestSource?.name || '?'} (conf=${(bestConf * 100).toFixed(0)}%)`);

    this.bus.emit('symbolic:resolved', {
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
   * @param {string} level    — 'direct' or 'guided'
   * @param {string} lessonId — The lesson that was used
   * @param {boolean} success — Did it work?
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

    this._stats.directHits++;

    _log.info(`[SYMBOLIC] DIRECT "${stepType}" — ${lesson.insight?.slice(0, 60)} (uses=${lesson.useCount}, conf=${(lesson.confidence * 100).toFixed(0)}%)`);

    this.bus.emit('symbolic:resolved', {
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
      // @ts-ignore
      directive: undefined,
      confidence: lesson.confidence,
    };
  }

  /** @private — Build a directive string for GUIDED mode */
  _buildDirective(lesson, schema) {
    const parts = [];

    if (lesson?.insight) {
      parts.push(`IMPORTANT — A proven approach for this type of task:`);
      parts.push(`  "${lesson.insight}"`);
      if (lesson.strategy?.promptStyle) {
        parts.push(`  Recommended style: ${lesson.strategy.promptStyle}`);
      }
      if (lesson.strategy?.command) {
        parts.push(`  Known working command: ${lesson.strategy.command}`);
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
      this.bus.emit('symbolic:fallback', {
        reason,
        stepType,
      }, { source: 'SymbolicResolver' });
    }

    return { level: LEVEL.PASS, confidence: 0, directive: '' };
  }
}

module.exports = { SymbolicResolver, LEVEL };
