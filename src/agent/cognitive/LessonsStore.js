// @ts-checked-v5.6
// ============================================================
// GENESIS - LessonsStore.js (v5.3.0 - SA-P7)
//
// Cross-project persistent learning.
//
// PROBLEM: Genesis learns within a project session - MetaLearning
// tracks success rates, OnlineLearner reacts in real-time,
// PromptEvolution A/B tests prompts. But when Genesis switches
// to a new project, all of this is lost. It starts from zero
// every time.
//
// SOLUTION: A global lessons database stored in the user's home
// directory (~/.genesis-lessons/), not in the project's .genesis/.
// Lessons are distilled insights captured from significant events:
//   - High-surprise successes ("this unusual approach worked")
//   - Resolved failure streaks ("switching to X fixed it")
//   - Calibration corrections ("model Y overestimates on Z tasks")
//   - Promoted prompt variants ("step-by-step beats free-text for code")
//
// Each lesson has:
//   - category (code-gen, analysis, refactor, debug, etc.)
//   - insight (human-readable description)
//   - strategy (the approach that worked/failed)
//   - evidence (surprise score, success rate, sample size)
//   - tags (model, language, project type, action type)
//   - useCount + lastUsed (frequently recalled = more valuable)
//
// Integration:
//   - OnlineLearner → auto-captures on streak resolution + escalation
//   - PromptBuilder → injects relevant lessons into LLM context
//   - AgentLoop → queries lessons before goal planning
//   - DreamCycle → consolidation hook creates lessons from patterns
//
// Not stored here: raw MetaLearning records (too granular),
// conversation history (project-specific), episodic memory
// (project-specific). Only distilled, reusable insights.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { createLogger } = require('../core/Logger');
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
   */
  constructor({ bus, globalDir, config = {} }) {
    this.bus = bus || NullBus;
    this._globalDir = globalDir || GLOBAL_DIR;
    this._maxLessons = config.maxLessons || MAX_LESSONS;
    this._decayDays = config.decayDays || RELEVANCE_DECAY_DAYS;

    /** @type {Array<{id: string, insight: string, strategy: object, evidence: {confidence: number, [k:string]: any}, category: string, source: string, useCount: number, lastUsed: number, [k:string]: any}>} */
    this._lessons = [];
    this._dirty = false;

    this._stats = {
      lessonsCreated: 0,
      lessonsRecalled: 0,
      lessonsDecayed: 0,
      autoCaptures: 0,
    };
  }

  // ════════════════════════════════════════════════════════
  // LIFECYCLE
  // ════════════════════════════════════════════════════════

  start() {
    this._ensureDir();
    this._load();

    // ── Auto-capture from OnlineLearner events ──────────
    this._unsub1 = this.bus.on('online-learning:streak-detected', (data) => {
      this._captureStreakLesson(data);
    }, { source: 'LessonsStore' });

    this._unsub2 = this.bus.on('online-learning:escalation-needed', (data) => {
      this._captureEscalationLesson(data);
    }, { source: 'LessonsStore' });

    this._unsub3 = this.bus.on('online-learning:temp-adjusted', (data) => {
      this._captureTempLesson(data);
    }, { source: 'LessonsStore' });

    // ── Auto-capture from high-surprise consolidation ───
    this._unsub4 = this.bus.on('workspace:consolidate', (data) => {
      this._captureWorkspaceLesson(data);
    }, { source: 'LessonsStore' });

    // ── Auto-capture from prompt evolution promotions ────
    this._unsub5 = this.bus.on('prompt-evolution:promoted', (data) => {
      this._capturePromptLesson(data);
    }, { source: 'LessonsStore' });

    // FIX v6.1.1: Learn from shell command outcomes
    this._unsub6 = this.bus.on('shell:outcome', (data) => {
      if (!data.command) return;
      this.record({
        category: data.success ? 'shell-success' : 'shell-failure',
        insight: data.success
          ? `Command "${data.command}" works on ${data.platform}`
          : `Command "${data.command}" failed on ${data.platform}: ${data.error || 'unknown'}`,
        strategy: { command: data.command, platform: data.platform },
        tags: ['shell', data.platform, data.success ? 'works' : 'fails'],
        source: 'shell-outcome',
        evidence: { successRate: data.success ? 1 : 0, confidence: 0.8, sampleSize: 1 },
      });
    }, { source: 'LessonsStore' });

    // FIX v6.1.1: Wire dream insights into lessons — dreams are no longer an attrappe
    this._unsub7 = this.bus.on('dream:complete', (data) => {
      if (data.insights > 0 || data.newSchemas > 0) {
        this.record({
          category: 'dream-insight',
          insight: `Dream #${data.dreamNumber}: ${data.insights} insights, ${data.newSchemas} new schemas, ${data.strengthened} strengthened memories`,
          tags: ['dream', 'autonomous'],
          source: 'dream-cycle',
          evidence: { confidence: 0.5, sampleSize: 1, successRate: 0.5 },
        });
      }
    }, { source: 'LessonsStore' });

    _log.info(`[LESSONS] Active - ${this._lessons.length} lessons loaded from ${this._globalDir}`);
  }

  stop() {
    this._unsub1?.();
    this._unsub2?.();
    this._unsub3?.();
    this._unsub4?.();
    this._unsub5?.();
    this._unsub6?.();
    this._unsub7?.();
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

    this.bus.emit('lessons:recorded', {
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

    const scored = this._lessons
      .map(lesson => ({
        lesson,
        relevance: this._scoreRelevance(lesson, category, context),
      }))
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
      this.bus.emit('lesson:applied', {
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
   * @param {string[]} lessonIds — IDs of lessons to boost
   * @returns {number} — Number of lessons found and boosted
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
   * @param {string} lessonId  — Lesson to update
   * @param {boolean} success  — Whether the lesson application succeeded
   * @param {{ confBoost?: number, confPenalty?: number }} [opts]
   * @returns {boolean} Whether the lesson was found and updated
   */
  updateLessonOutcome(lessonId, success, opts = {}) {
    const lesson = this._lessons.find(l => l.id === lessonId);
    if (!lesson) return false;

    const boost = opts.confBoost ?? 0.05;
    const penalty = opts.confPenalty ?? 0.15;

    if (success) {
      lesson.useCount = (lesson.useCount || 0) + 1;
      lesson.lastUsed = Date.now();
      lesson.evidence.confidence = Math.min(lesson.evidence.confidence + boost, 0.99);
    } else {
      lesson.evidence.confidence = Math.max(lesson.evidence.confidence - penalty, 0.1);
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
  // AUTO-CAPTURE: Convert events to lessons
  // ════════════════════════════════════════════════════════

  _captureStreakLesson(data) {
    if (!data?.suggestion) return;
    this._stats.autoCaptures++;

    this.record({
      category: data.actionType || 'general',
      insight: `After ${data.consecutiveFailures} failures on ${data.actionType}, switching to "${data.suggestion.promptStyle}" at temperature ${data.suggestion.temperature?.toFixed(2)} resolved the issue`,
      strategy: {
        promptStyle: data.suggestion.promptStyle,
        temperature: data.suggestion.temperature,
        trigger: 'failure-streak',
      },
      evidence: {
        surprise: 0.6,
        successRate: 0,
        sampleSize: data.consecutiveFailures,
        confidence: 0.5,
      },
      tags: [data.actionType, 'streak-recovery'],
      source: 'streak',
    });
  }

  _captureEscalationLesson(data) {
    if (!data?.actionType) return;
    this._stats.autoCaptures++;

    this.record({
      category: data.actionType,
      insight: `Model "${data.currentModel}" insufficient for ${data.actionType} tasks - high surprise (${data.surprise?.toFixed(2)}) indicates capability gap`,
      strategy: {
        model: data.currentModel,
        trigger: 'escalation',
      },
      evidence: {
        surprise: data.surprise || 0.7,
        confidence: 0.6,
      },
      tags: [data.actionType, data.currentModel, 'model-limit'],
      source: 'escalation',
    });
  }

  _captureTempLesson(data) {
    if (!data?.actionType) return;
    this._stats.autoCaptures++;

    const direction = data.newTemp > data.oldTemp ? 'raised' : 'lowered';
    this.record({
      category: data.actionType,
      insight: `Temperature ${direction} from ${data.oldTemp?.toFixed(2)} to ${data.newTemp?.toFixed(2)} for ${data.actionType} (success rate: ${Math.round((data.successRate || 0) * 100)}%)`,
      strategy: {
        temperature: data.newTemp,
        previousTemp: data.oldTemp,
        model: data.model,
      },
      evidence: {
        successRate: data.successRate || 0,
        sampleSize: data.windowSize || 10,
        confidence: 0.4,
      },
      tags: [data.actionType, data.model, 'temperature'],
      source: 'temp-tuning',
    });
  }

  _captureWorkspaceLesson(data) {
    if (!data?.items || data.items.length === 0) return;

    // Only capture the top item by salience
    const top = data.items[0];
    if (top.salience < 0.6) return;

    this._stats.autoCaptures++;
    this.record({
      category: 'goal-execution',
      insight: `Key insight during goal "${data.goalId}": ${typeof top.value === 'string' ? top.value.slice(0, 150) : JSON.stringify(top.value).slice(0, 150)}`,
      evidence: {
        surprise: top.salience,
        confidence: Math.min(top.salience, 0.7),
      },
      tags: ['workspace', top.key],
      source: 'workspace-consolidation',
    });
  }

  _capturePromptLesson(data) {
    if (!data?.section || !data?.variant) return;
    this._stats.autoCaptures++;

    this.record({
      category: 'prompt-optimization',
      insight: `Prompt section "${data.section}" improved ${Math.round((data.improvement || 0) * 100)}% with variant "${data.variant}" after ${data.trials || 0} trials`,
      strategy: {
        promptStyle: data.variant,
        section: data.section,
      },
      evidence: {
        successRate: data.improvement || 0,
        sampleSize: data.trials || 25,
        confidence: 0.7,
      },
      tags: ['prompt-evolution', data.section],
      source: 'prompt-evolution',
    });
  }

  // ════════════════════════════════════════════════════════
  // RELEVANCE SCORING
  // ════════════════════════════════════════════════════════

  _scoreRelevance(lesson, category, context) {
    let score = 0;

    // Category match (strongest signal)
    if (lesson.category === category) score += 0.4;
    else if (lesson.category === 'general') score += 0.1;

    // Tag overlap
    if (context.tags && lesson.tags.length > 0) {
      const overlap = lesson.tags.filter(t => context.tags.includes(t)).length;
      score += Math.min(0.3, overlap * 0.1);
    }

    // Model match
    if (context.model && lesson.tags.includes(context.model)) {
      score += 0.15;
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
      fs.writeFileSync(filePath, data, 'utf-8');
      this._dirty = false;
    } catch (err) {
      _log.warn('[LESSONS] Save error:', err.message);
    }
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
