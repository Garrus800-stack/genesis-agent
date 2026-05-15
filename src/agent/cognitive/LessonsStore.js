// @ts-checked-v5.6
// GENESIS — LessonsStore.js
// Cross-project persistent learning in ~/.genesis-lessons/. Lessons:
// category, insight, strategy, evidence, tags, useCount, lastUsed.
// Subscribers: OnlineLearner, PromptBuilder, AgentLoop, DreamCycle.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { createLogger } = require('../core/Logger');
const { atomicWriteFileSync } = require('../core/utils');
const { NullBus } = require('../core/EventBus');
const _log = createLogger('LessonsStore');

// ── Constants ───────────────────────────────────────────────

const GLOBAL_DIR = path.join(os.homedir(), '.genesis-lessons');
const LESSONS_FILE = 'lessons.json';
const MAX_LESSONS = 500;
const RELEVANCE_DECAY_DAYS = 90;   // Lessons unused for 90 days lose relevance
const MIN_EVIDENCE_SCORE = 0.3;    // Minimum surprise/confidence to create a lesson

class LessonsStore {
  /**
   * @param {object} deps
   * @param {object} deps.bus           - EventBus (required)
   * @param {string} [deps.globalDir]   - Override global dir (for testing)
   * @param {object} [deps.config]      - Override thresholds
   * @param {object} [deps.embeddingService] - Optional, enables semantic recall (v7.8.8)
   * @param {object} [deps.intervalManager]  - Optional, manages backfill timer (v7.8.8)
   */
  constructor({ bus, globalDir, config = {}, embeddingService, intervalManager }) {
    this.bus = bus || NullBus;
    this._globalDir = globalDir || GLOBAL_DIR;
    this._maxLessons = config.maxLessons || MAX_LESSONS;
    this._decayDays = config.decayDays || RELEVANCE_DECAY_DAYS;

    // v7.8.8: Semantic-recall dependencies (both optional — graceful fallback to TF-IDF mode)
    this._embeddingService = embeddingService || null;
    this._intervalManager = intervalManager || null;
    this._embedInFlight = new Set();           // lesson IDs currently being embedded — race-condition guard
    this._backfillIntervalMs = config.backfillIntervalMs || 60_000;  // 60s default
    this._backfillBatchSize = config.backfillBatchSize || 10;
    this._backfillTimer = null;

    /** @type {Array<{id: string, insight: string, strategy: object, evidence: {confidence: number, [k:string]: any}, category: string, source: string, useCount: number, lastUsed: number, embedding?: number[]|null, quarantined?: boolean, [k:string]: any}>} */
    this._lessons = [];
    this._dirty = false;
    this._stats = { lessonsCreated: 0, lessonsRecalled: 0, lessonsDecayed: 0, autoCaptures: 0, embeddingsBackfilled: 0, quarantined: 0 };
  }

  // ════════════════════════════════════════════════════════
  // LIFECYCLE
  // ════════════════════════════════════════════════════════

  start() {
    this._ensureDir();
    this._load();
    // Auto-capture hooks live in LessonsAutoCapture (v7.8.8)
    _log.info(`[LESSONS] Active - ${this._lessons.length} lessons loaded from ${this._globalDir}`);

    // v7.8.8: Semantic-recall: embedding:ready listener + periodic backfill (if intervalManager wired).
    // Without IntervalManager, lazy embed-on-first-retrieve and the embedding:ready listener
    // still handle backfill on their own — no raw setInterval fallback.
    if (this._embeddingService) {
      this._unsub8 = this.bus.on('embedding:ready', () => this._scheduleBackfillTick(), { source: 'LessonsStore' });
      if (this._intervalManager && typeof this._intervalManager.set === 'function') {
        this._backfillTimer = this._intervalManager.set('lessons-embedding-backfill',
          () => this._scheduleBackfillTick(), this._backfillIntervalMs);
      }
      this._scheduleBackfillTick();  // fire once in case service is already up
    }
  }

  stop() {
    this._unsub8?.();
    if (this._backfillTimer && this._intervalManager && typeof this._intervalManager.clear === 'function') {
      this._intervalManager.clear('lessons-embedding-backfill');
    }
    this._backfillTimer = null;
    if (this._dirty) this._save();
    _log.info(`[LESSONS] Stopped - ${this._stats.lessonsCreated} created, ${this._stats.lessonsRecalled} recalled`);
  }

  // ════════════════════════════════════════════════════════
  // CORE API
  // ════════════════════════════════════════════════════════

  /**
   * Record a lesson manually or from auto-capture.
   *
   * @param {object} lesson
   * @param {string} lesson.category   - Task category (code-gen, analysis, refactor, debug, shell, etc.)
   * @param {string} lesson.insight    - Human-readable description of the lesson
   * @param {object} [lesson.strategy] - What worked or failed ({ promptStyle, temperature, model })
   * @param {object} [lesson.evidence] - How strong the evidence is ({ surprise, successRate, sampleSize })
   * @param {string[]} [lesson.tags]   - Searchable tags (model name, language, project type)
   * @param {string} [lesson.source]   - Where this lesson came from (streak, escalation, dream, manual)
   * @returns {string} Lesson ID
   */
  record(lesson) {
    const id = `lesson_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    const entry = {
      id,
      category: lesson.category || 'general',
      insight: lesson.insight || '',
      strategy: lesson.strategy || null,
      evidence: {
        surprise: lesson.evidence?.surprise ?? 0,
        successRate: lesson.evidence?.successRate ?? 0,
        sampleSize: lesson.evidence?.sampleSize ?? 1,
        confidence: lesson.evidence?.confidence ?? 0.5,
      },
      tags: lesson.tags || [],
      source: lesson.source || 'manual',
      createdAt: Date.now(),
      lastUsed: Date.now(),
      useCount: 0,
      // v7.8.8: semantic-recall fields. embedding stays null until backfill or first-recall fills it.
      embedding: null,
      quarantined: false,
    };

    // Deduplicate - don't store near-identical lessons
    const duplicate = this._findDuplicate(entry);
    if (duplicate) {
      // Strengthen existing lesson instead
      duplicate.evidence.sampleSize += entry.evidence.sampleSize;
      duplicate.evidence.confidence = Math.min(1, duplicate.evidence.confidence + 0.1);
      duplicate.lastUsed = Date.now();
      this._dirty = true;
      return duplicate.id;
    }

    this._lessons.push(entry);
    this._stats.lessonsCreated++;
    this._dirty = true;

    // Enforce capacity limit
    if (this._lessons.length > this._maxLessons) {
      this._evictLeastValuable();
    }

    this.bus.fire('lessons:recorded', {
      id, category: entry.category, insight: entry.insight.slice(0, 100),
    }, { source: 'LessonsStore' });

    // Periodic save
    if (this._stats.lessonsCreated % 5 === 0) {
      this._save();
    }

    return id;
  }

  /**
   * Recall relevant lessons for a task.
   * Boosts useCount and lastUsed on recalled lessons.
   *
   * @param {string} category      - Task category to match
   * @param {object} [context]     - Additional context for relevance scoring
   * @param {string} [context.model]       - Current model
   * @param {string} [context.projectType] - Type of project (node, python, etc.)
   * @param {string[]} [context.tags]      - Additional tags to match
   * @param {number} [limit=5]     - Max lessons to return
   * @returns {Array<{ insight: string, strategy: object, confidence: number, relevance: number }>}
   */
  recall(category, context = {}, limit = 5) {
    if (this._lessons.length === 0) return [];

    // v7.8.8: Get cached query embedding; if missing, schedule background embed
    // (this recall scores without it, next will use it).
    let queryEmbedding = null;
    if (this._embeddingService && this._embeddingService.isAvailable && this._embeddingService.isAvailable()) {
      const queryText = context.query || context.queryText;
      if (queryText && typeof queryText === 'string' && queryText.length > 0) {
        queryEmbedding = this._tryGetCachedQueryEmbedding(queryText);
        if (queryEmbedding == null) this._scheduleQueryEmbedFireAndForget(queryText);
      } else if (context.queryEmbedding && Array.isArray(context.queryEmbedding)) {
        queryEmbedding = context.queryEmbedding;
      }
    }

    const enrichedContext = { ...context, queryEmbedding };
    const serviceReady = !!(this._embeddingService && this._embeddingService.isAvailable && this._embeddingService.isAvailable());

    const scored = this._lessons
      .filter(lesson => !lesson.quarantined)   // v7.8.8: quarantine filter
      .map(lesson => {
        // v7.8.8: lazy embed-on-first-retrieve (fire-and-forget) — populates lesson.embedding for next recall.
        if (serviceReady && lesson.embedding == null) this._scheduleLessonEmbedFireAndForget(lesson);
        return { lesson, relevance: this._scoreRelevance(lesson, category, enrichedContext) };
      })
      .filter(s => s.relevance > 0.1)
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, limit);

    // Boost recalled lessons
    for (const { lesson } of scored) {
      lesson.useCount++;
      lesson.lastUsed = Date.now();
    }

    if (scored.length > 0) {
      this._stats.lessonsRecalled += scored.length;
      this._dirty = true;
    }

    const results = scored.map(({ lesson, relevance }) => ({
      id: lesson.id,
      insight: lesson.insight,
      strategy: lesson.strategy,
      confidence: lesson.evidence.confidence,
      relevance,
      category: lesson.category,
      source: lesson.source,
      useCount: lesson.useCount || 0,
      lastUsed: lesson.lastUsed || 0,
    }));

    // v7.1.6: Emit lesson:applied for each recalled lesson (frontier tracking)
    for (const r of results) {
      this.bus.fire('lesson:applied', {
        id: r.id, category: r.category, insight: r.insight,
      }, { source: 'LessonsStore' });
    }

    return results;
  }

  /**
   * v7.1.6: Temporarily boost relevance of recently applied lessons.
   * Called by SessionPersistence at boot from LESSON_APPLIED frontier data.
   * Boosted lessons score higher in the next recall() until natural decay.
   *
   * @param {string[]} lessonIds - IDs of lessons to boost
   * @returns {number} - Number of lessons found and boosted
   */
  boostRecent(lessonIds) {
    if (!lessonIds || lessonIds.length === 0) return 0;
    const idSet = new Set(lessonIds);
    let boosted = 0;
    for (const lesson of this._lessons) {
      if (idSet.has(lesson.id)) {
        lesson.lastUsed = Date.now(); // Recency boost in _scoreRelevance
        lesson.useCount = Math.min((lesson.useCount || 0) + 1, 100); // v7.1.6: Cap at 100
        boosted++;
      }
    }
    if (boosted > 0) this._dirty = true;
    return boosted;
  }

  /**
   * Update a lesson's confidence based on outcome feedback.
   * Public API for SymbolicResolver and other consumers.
   *
   * @param {string} lessonId  - Lesson to update
   * @param {boolean} success  - Whether the lesson application succeeded
   * @param {{ confBoost?: number, confPenalty?: number }} [opts]
   * @returns {boolean} Whether the lesson was found and updated
   */
  updateLessonOutcome(lessonId, success, opts = {}) {
    const lesson = this._lessons.find(l => l.id === lessonId);
    if (!lesson) return false;

    const boost = opts.confBoost ?? 0.05;
    const penalty = opts.confPenalty ?? 0.15;

    // v7.1.7: Track confirmed/contradicted counts for Frontier + GoalSynthesizer
    if (success) {
      lesson.confirmed = (lesson.confirmed || 0) + 1;
      lesson.useCount = (lesson.useCount || 0) + 1;
      lesson.lastUsed = Date.now();
      lesson.evidence.confidence = Math.min(lesson.evidence.confidence + boost, 0.99);
      this.bus.fire('lesson:confirmed', {
        id: lessonId, category: lesson.category, confirmed: lesson.confirmed,
      }, { source: 'LessonsStore' });
    } else {
      lesson.contradicted = (lesson.contradicted || 0) + 1;
      lesson.evidence.confidence = Math.max(lesson.evidence.confidence - penalty, 0.1);
      this.bus.fire('lesson:contradicted', {
        id: lessonId, category: lesson.category, contradicted: lesson.contradicted,
        insight: (lesson.insight || '').slice(0, 80),
      }, { source: 'LessonsStore' });
    }

    // v7.8.8: Quarantine chronically wrong lessons. contradicted≥3 AND confirmed≤1 means
    // a lesson has failed in application multiple times without ever helping — pull it
    // from recall results. Flag is persisted; Reflector may rehabilitate it later.
    const contradicted = lesson.contradicted || 0;
    const confirmed = lesson.confirmed || 0;
    if (!lesson.quarantined && contradicted >= 3 && confirmed <= 1) {
      lesson.quarantined = true;
      this._stats.quarantined++;
      _log.info(`[LESSONS] Quarantined: ${lessonId} (contradicted=${contradicted}, confirmed=${confirmed})`);
      this.bus.fire('lesson:quarantined', {
        id: lessonId, category: lesson.category, contradicted, confirmed,
        insight: (lesson.insight || '').slice(0, 80),
      }, { source: 'LessonsStore' });
    }

    this._dirty = true;
    return true;
  }

  /**
   * Build a prompt-ready context string with relevant lessons.
   * Used by PromptBuilder.
   *
   * @param {string} category
   * @param {object} [context]
   * @param {number} [maxItems=3]
   * @returns {string}
   */
  buildContext(category, context = {}, maxItems = 3) {
    const lessons = this.recall(category, context, maxItems);
    if (lessons.length === 0) return '';

    const lines = lessons.map(l => {
      const conf = Math.round(l.confidence * 100);
      const strat = l.strategy
        ? ` (${l.strategy.promptStyle || ''}${l.strategy.temperature ? ' @' + l.strategy.temperature : ''})`
        : '';
      return `  - ${l.insight}${strat} [${conf}% confidence]`;
    });

    return `LESSONS FROM PAST PROJECTS (${lessons.length}):\n${lines.join('\n')}`;
  }


  // ════════════════════════════════════════════════════════
  // RELEVANCE SCORING
  // ════════════════════════════════════════════════════════

  _scoreRelevance(lesson, category, context) {
    let score = 0;

    // Category match (strongest signal) — skipped when category=null (v7.8.8 semantic mode)
    if (category !== null && category !== undefined) {
      if (lesson.category === category) score += 0.4;
      else if (lesson.category === 'general') score += 0.1;
    }

    // Tag overlap
    if (context.tags && lesson.tags.length > 0) {
      const overlap = lesson.tags.filter(t => context.tags.includes(t)).length;
      score += Math.min(0.3, overlap * 0.1);
    }

    // Model match
    if (context.model && lesson.tags.includes(context.model)) {
      score += 0.15;
    }

    // v7.8.8: Semantic embedding component — only when both query- and lesson-embedding present.
    // Floor τ=0.6 (below that, treat as no signal). Cross-category dampening when an explicit
    // category was requested but doesn't match. Effective-confidence multiplier penalizes
    // low-sample-size, low-confidence lessons even if semantically near.
    if (context.queryEmbedding && Array.isArray(lesson.embedding) && lesson.embedding.length > 0) {
      const cos = this._cosineSim(context.queryEmbedding, lesson.embedding);
      if (cos >= 0.6) {
        let embeddingComponent = cos * 0.5;
        // Cross-category dampening — only when category was explicitly requested
        if (category !== null && category !== undefined && lesson.category !== category) {
          embeddingComponent *= 0.7;
        }
        // Effective confidence: confidence × (1 − exp(−sampleSize/5)) avoids over-trusting n=1 lessons.
        // trustFactor maps [0..1] → [0.5..1.0] so even untrusted lessons keep half their semantic match.
        const conf = lesson.evidence?.confidence ?? 0.5;
        const sampleSize = lesson.evidence?.sampleSize ?? 1;
        const effectiveConf = conf * (1 - Math.exp(-sampleSize / 5));
        const trustFactor = 0.5 + 0.5 * effectiveConf;
        embeddingComponent *= trustFactor;
        score += embeddingComponent;
      }
    }

    // Evidence strength
    score += lesson.evidence.confidence * 0.1;

    // Recency boost (lessons used recently are more relevant)
    const daysSinceUse = (Date.now() - lesson.lastUsed) / (86400000);
    if (daysSinceUse < 7) score += 0.1;
    else if (daysSinceUse > this._decayDays) score *= 0.5; // Decay old lessons

    // Use frequency boost
    if (lesson.useCount > 3) score += 0.05;

    return Math.min(1, score);
  }

  /**
   * v7.8.8: Cosine similarity between two equal-length vectors. Returns 0 on length mismatch
   * or zero-norm input (defensive). Inline to avoid pulling EmbeddingService into _scoreRelevance.
   */
  _cosineSim(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  // ════════════════════════════════════════════════════════
  // SEMANTIC RECALL — embedding backfill (v7.8.8)
  // ════════════════════════════════════════════════════════

  /**
   * v7.8.8: Schedule a backfill tick. Picks up to _backfillBatchSize lessons without
   * embeddings, embeds them via the service's batch API. Fire-and-forget; errors logged
   * at debug level.
   */
  _scheduleBackfillTick() {
    if (!this._embeddingService || !this._embeddingService.isAvailable || !this._embeddingService.isAvailable()) return;
    const pending = this._lessons
      .filter(l => l.embedding == null && !l.quarantined && !this._embedInFlight.has(l.id))
      .slice(0, this._backfillBatchSize);
    if (pending.length === 0) return;

    for (const l of pending) this._embedInFlight.add(l.id);

    Promise.resolve(this._embeddingService.embedBatch(pending.map(l => l.insight || '')))
      .then(vectors => {
        if (!Array.isArray(vectors)) return;
        for (let i = 0; i < pending.length; i++) {
          const vec = vectors[i];
          if (vec && Array.isArray(vec) && vec.length > 0) {
            pending[i].embedding = vec;
            this._stats.embeddingsBackfilled++;
          }
          this._embedInFlight.delete(pending[i].id);
        }
        this._dirty = true;
      })
      .catch(err => {
        for (const l of pending) this._embedInFlight.delete(l.id);
        _log.debug('[LESSONS] backfill batch failed:', err.message);
      });
  }

  // v7.8.8: Try to compute embedding for a single lesson if not already in flight. Called from recall() lazy-path. Fire-and-forget.
  _scheduleLessonEmbedFireAndForget(lesson) {
    if (!this._embeddingService || !this._embeddingService.isAvailable || !this._embeddingService.isAvailable()) return;
    if (this._embedInFlight.has(lesson.id)) return;
    this._embedInFlight.add(lesson.id);
    Promise.resolve(this._embeddingService.embed(lesson.insight || ''))
      .then(vec => {
        if (vec && Array.isArray(vec) && vec.length > 0) {
          lesson.embedding = vec;
          this._stats.embeddingsBackfilled++;
          this._dirty = true;
        }
        this._embedInFlight.delete(lesson.id);
      })
      .catch(err => {
        this._embedInFlight.delete(lesson.id);
        _log.debug('[LESSONS] lazy embed failed:', err.message);
      });
  }

  // v7.8.8: Per-recall query-embedding cache. Same query reused in a hot loop
  // (e.g. multiple recall calls with same goal description) hits the cache rather than re-embedding. Bounded to last 32 entries.
  _tryGetCachedQueryEmbedding(queryText) {
    if (!this._queryEmbedCache) return null;
    return this._queryEmbedCache.get(queryText) || null;
  }

  _scheduleQueryEmbedFireAndForget(queryText) {
    if (!this._queryEmbedCache) this._queryEmbedCache = new Map();
    if (this._queryEmbedCache.has(queryText)) return;     // already cached or in flight
    this._queryEmbedCache.set(queryText, null);            // mark in flight (placeholder)
    Promise.resolve(this._embeddingService.embed(queryText))
      .then(vec => {
        if (vec && Array.isArray(vec) && vec.length > 0) {
          this._queryEmbedCache.set(queryText, vec);
        } else {
          this._queryEmbedCache.delete(queryText);
        }
        // Bound cache size
        if (this._queryEmbedCache.size > 32) {
          const firstKey = this._queryEmbedCache.keys().next().value;
          this._queryEmbedCache.delete(firstKey);
        }
      })
      .catch(err => {
        this._queryEmbedCache.delete(queryText);
        _log.debug('[LESSONS] query embed failed:', err.message);
      });
  }

  // ════════════════════════════════════════════════════════
  // DEDUPLICATION & EVICTION
  // ════════════════════════════════════════════════════════

  _findDuplicate(newLesson) {
    return this._lessons.find(existing =>
      existing.category === newLesson.category &&
      existing.source === newLesson.source &&
      this._similarity(existing.insight, newLesson.insight) > 0.7
    );
  }

  _similarity(a, b) {
    if (!a || !b) return 0;
    const wordsA = new Set(a.toLowerCase().split(/\s+/));
    const wordsB = new Set(b.toLowerCase().split(/\s+/));
    const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
    return intersection / Math.max(wordsA.size, wordsB.size);
  }

  _evictLeastValuable() {
    // Score each lesson by value (confidence × recency × use)
    const scored = this._lessons.map((l, i) => {
      const daysSinceUse = (Date.now() - l.lastUsed) / 86400000;
      const recency = Math.max(0, 1 - daysSinceUse / (this._decayDays * 2));
      const value = l.evidence.confidence * 0.4 + recency * 0.4 + Math.min(l.useCount / 10, 0.2);
      return { index: i, value };
    });

    scored.sort((a, b) => a.value - b.value);

    // Remove bottom 10%
    const removeCount = Math.ceil(this._lessons.length * 0.1);
    const toRemove = new Set(scored.slice(0, removeCount).map(s => s.index));
    this._lessons = this._lessons.filter((_, i) => !toRemove.has(i));
    this._stats.lessonsDecayed += removeCount;
  }

  // ════════════════════════════════════════════════════════
  // PERSISTENCE (global, not project-local)
  // ════════════════════════════════════════════════════════

  _ensureDir() {
    try {
      if (!fs.existsSync(this._globalDir)) {
        fs.mkdirSync(this._globalDir, { recursive: true });
      }
    } catch (err) {
      _log.warn('[LESSONS] Could not create global dir:', err.message);
    }
  }

  _load() {
    try {
      const filePath = path.join(this._globalDir, LESSONS_FILE);
      if (!fs.existsSync(filePath)) return;
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (Array.isArray(data.lessons)) {
        this._lessons = data.lessons;
      }
      if (data.stats) {
        this._stats = { ...this._stats, ...data.stats };
      }
    } catch (err) {
      _log.warn('[LESSONS] Load error:', err.message);
    }
  }

  _save() {
    try {
      const filePath = path.join(this._globalDir, LESSONS_FILE);
      const data = JSON.stringify({
        version: '1.0',
        savedAt: new Date().toISOString(),
        stats: this._stats,
        lessons: this._lessons,
      }, null, 2);
      // FIX v7.4.1: atomic write — prevents half-written lessons on crash
      atomicWriteFileSync(filePath, data);
      this._dirty = false;
    } catch (err) {
      _log.warn('[LESSONS] Save error:', err.message);
    }
  }

  /**
   * Public flush — forces a save to disk. v7.7.9 (post-Phase-3c):
   * NetworkSentinel called `.flush?.()` but the method didn't exist;
   * silent skip meant a shutdown could lose up-to-5 pending writes
   * (periodic save fires every 5 creates). Idempotent.
   */
  async flush() {
    if (this._dirty) this._save();
    return true;
  }

  // ════════════════════════════════════════════════════════
  // DIAGNOSTICS
  // ════════════════════════════════════════════════════════

  getStats() {
    const byCategory = {};
    const bySource = {};
    for (const l of this._lessons) {
      byCategory[l.category] = (byCategory[l.category] || 0) + 1;
      bySource[l.source] = (bySource[l.source] || 0) + 1;
    }

    return {
      ...this._stats,
      totalLessons: this._lessons.length,
      maxLessons: this._maxLessons,
      globalDir: this._globalDir,
      byCategory,
      bySource,
      avgConfidence: this._lessons.length > 0
        ? this._lessons.reduce((s, l) => s + l.evidence.confidence, 0) / this._lessons.length
        : 0,
    };
  }

  // ════════════════════════════════════════════════════════
  // STRUCTURAL PATTERN MATCHING (v7.0.9 Phase 3)
  // ════════════════════════════════════════════════════════

  /**
   * Find lessons by structural pattern similarity.
   * Falls back to text-based recall if PatternMatcher unavailable.
   * @param {object} currentPattern - The current problem's structural pattern
   * @param {{ minScore?: number, limit?: number }} [opts]
   * @returns {Array<{ lesson: object, score: number }>}
   */
  findByStructure(currentPattern, opts = {}) {
    const minScore = opts.minScore || 0.6;
    const limit = opts.limit || 5;

    if (!this._patternMatcher || !currentPattern) {
      return [];
    }

    const results = [];
    for (const lesson of this._lessons) {
      if (!lesson.structuralPattern) continue;
      const score = this._patternMatcher.compare(currentPattern, lesson.structuralPattern);
      if (score >= minScore) {
        results.push({ lesson, score });
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * Get lessons that need structural pattern extraction.
   * @returns {Array<{ lessonId: string, text: string, category: string }>}
   */
  getPendingAbstractions() {
    return this._lessons
      .filter(l => !l.structuralPattern && l.patternStatus !== 'obsolete' && l.patternStatus !== 'contradiction')
      .map(l => ({ lessonId: l.id, text: l.insight, category: l.category }));
  }

  /**
   * Set the structural pattern for a lesson.
   * @param {string} lessonId
   * @param {object} pattern
   * @param {string} [status='extracted']
   */
  setStructuralPattern(lessonId, pattern, status = 'extracted') {
    const lesson = this._lessons.find(l => l.id === lessonId);
    if (!lesson) return;
    lesson.structuralPattern = pattern;
    lesson.patternStatus = status;
    this._dirty = true;
  }

  /** Get all lessons (for debug/export) */
  getAll() {
    return [...this._lessons];
  }

  /** Clear all lessons (for testing) */
  clear() {
    const count = this._lessons.length;
    this._lessons = [];
    this._dirty = true;
    this._save();
    return count;
  }
}

module.exports = { LessonsStore };
