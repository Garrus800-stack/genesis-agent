// @ts-checked-v5.7 — prototype delegation not visible to tsc
// ============================================================
// GENESIS — DreamCycle.js (Phase 9 — Cognitive Architecture)
//
// The consolidation engine. Runs during idle time as a new
// IdleMind activity (DREAM). Processes recent episodic memories,
// finds patterns, extracts schemas, and strengthens/decays
// memory connections.
//
// Inspired by sleep consolidation in the brain:
//   - Replay: review recent episodes
//   - Pattern detection: find recurring sequences
//   - Abstraction: extract reusable schemas
//   - Consolidation: strengthen surprising, decay mundane
//   - Insight: cross-reference new schemas with existing ones
//
// PERFORMANCE DESIGN:
//   Phases 1-4 are pure heuristics (no LLM calls).
//   Phase 5 uses a SINGLE batched LLM call for all proto-schemas.
//   Total cost on gemma2:9b: ~30-60s per dream cycle.
//   Setting dreams.useLLM: false skips Phase 5 entirely.
//
// Integration:
//   IdleMind._pickActivity() → scores 'dream' activity
//   IdleMind._think() switch → dreamCycle.dream()
//   DreamCycle → SchemaStore.store() (new schemas)
//   DreamCycle → KnowledgeGraph (memory strengthening)
//   SurpriseAccumulator.getRecentSignals() → surprise data
// ============================================================

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('DreamCycle');

class DreamCycle {
  constructor({ bus, episodicMemory, schemaStore, knowledgeGraph,
                metaLearning, model, eventStore, storage, intervals, config }) {
    this.bus = bus || NullBus;
    this.episodicMemory = episodicMemory || null;
    this.schemaStore = schemaStore || null;
    this.kg = knowledgeGraph || null;
    this.metaLearning = metaLearning || null;
    this.model = model || null;
    this.eventStore = eventStore || null;
    this.storage = storage || null;
    this._intervals = intervals || null;
    this.surpriseAccumulator = null; // lateBinding
    this.valueStore = null;          // lateBinding v4.12.4
    this.goalStack = null;           // v7.3.3 lateBinding — optional, used in Phase 6 goal review

    // ── Configuration ────────────────────────────────────
    const cfg = config || {};
    this._minEpisodesForDream = cfg.minEpisodes || 10;
    this._maxDreamDurationMs = cfg.maxDurationMs || 120000;
    this._schemaMinOccurrences = cfg.schemaMinOccurrences || 3;
    this._memoryDecayRate = cfg.memoryDecayRate || 0.05;
    this._consolidationIntervalMs = cfg.consolidationIntervalMs || 30 * 60 * 1000;
    this._useLLM = cfg.useLLM !== false; // default true

    // ── State ────────────────────────────────────────────
    this._lastDreamAt = 0;
    this._dreamCount = 0;
    this._processedEpisodeIds = new Set();

    // ── Stats ────────────────────────────────────────────
    this._stats = {
      totalDreams: 0,
      totalSchemas: 0,
      totalInsights: 0,
      totalStrengthened: 0,
      totalDecayed: 0,
      avgDurationMs: 0,
    };
  }



  /* c8 ignore stop */

  async asyncLoad() {
    if (!this.storage) return;
    try {
      const data = this.storage.readJSON('dream-state.json', null);
      if (data) {
        this._lastDreamAt = data.lastDreamAt || 0;
        this._dreamCount = data.dreamCount || 0;
        this._stats = { ...this._stats, ...data.stats };
        if (Array.isArray(data.processedIds)) {
          this._processedEpisodeIds = new Set(data.processedIds.slice(-500));
        }
      }
    } catch (_e) { _log.debug('[catch] dream stats load:', _e.message); }
  }

  start() {
    // No autonomous timers — IdleMind calls dream() directly
  }

  stop() {
    // FIX D-1: Sync write on shutdown — debounced timer won't fire after process exit.
    this._saveSync();
  }

  // ════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════

  /**
   * Run a dream cycle. Called by IdleMind when DREAM activity is selected.
   * @returns {Promise<object>}
   */
  async dream(options = {}) {
    const startTime = Date.now();
    // v7.2.5: Intensity scaling — lighter cycles when resources are tight.
    // 1.0 = full 5-phase cycle, 0.5 = heuristic only (no LLM), 0.25 = consolidation + decay only
    const intensity = options.intensity ?? 1.0;

    // Cooldown check
    if (startTime - this._lastDreamAt < this._consolidationIntervalMs) {
      return { skipped: true, reason: 'too-soon', timeSinceLast: startTime - this._lastDreamAt };
    }

    this._dreamCount++;
    this._stats.totalDreams++;

    this.bus.emit('dream:started', {
      dreamNumber: this._dreamCount,
      intensity,
    }, { source: 'DreamCycle' });

    const report = {
      dreamNumber: this._dreamCount,
      timestamp: startTime,
      /** @type {Array<{name: string, [k: string]: any}>} */
      phases: [],
      /** @type {Array<{type: string, description: string, schemas: any[], timestamp: number}>} */
      newSchemas: [],
      strengthenedMemories: 0,
      decayedMemories: 0,
      /** @type {Array<{type: string, description: string, schemas: any[], timestamp: number}>} */
      insights: [],
      durationMs: 0,
    };

    try {
      // ── Phase 1: RECALL ────────────────────────────────
      const episodes = this._getUnprocessedEpisodes();
      report.phases.push({ name: 'recall', episodeCount: episodes.length });

      if (episodes.length < this._minEpisodesForDream) {
        report.skipped = true;
        report.reason = `insufficient-episodes (${episodes.length}/${this._minEpisodesForDream})`;
        return report;
      }

      const _dca = /** @type {any} */ (this); // DreamCycleAnalysis mixin cast

      // v7.2.5: At intensity 0.25, skip pattern detection + schema extraction.
      // Only run consolidation + decay (cheapest cycle).
      if (intensity >= 0.5) {
        // ── Phase 2: PATTERN DETECTION (heuristic, no LLM) ──
        const patterns = _dca._detectPatterns(episodes);
        report.phases.push({ name: 'pattern-detection', patternCount: patterns.length });

        // ── Phase 3: SCHEMA EXTRACTION ─────────────────────
        // v7.2.5: At intensity 0.5, force heuristic-only (no LLM call)
        const savedUseLLM = this._useLLM;
        if (intensity < 1.0) this._useLLM = false;
        const qualifiedPatterns = patterns.filter(p => p.occurrences >= this._schemaMinOccurrences);
        const newSchemas = await this._dreamPhaseSchemas(qualifiedPatterns, startTime);
        this._useLLM = savedUseLLM; // restore
        report.newSchemas = newSchemas;
        report.phases.push({ name: 'schema-extraction', newSchemas: newSchemas.length });
        this._stats.totalSchemas += newSchemas.length;

        // ── Phase 3b: VALUE CRYSTALLIZATION (v4.12.4) ──────
        this._dreamPhaseCrystallize(newSchemas);
      } else {
        report.phases.push({ name: 'pattern-detection', patternCount: 0, skipped: 'low-intensity' });
        report.phases.push({ name: 'schema-extraction', newSchemas: 0, skipped: 'low-intensity' });
      }

      // ── Phase 4: MEMORY CONSOLIDATION ──────────────────
      const consolidation = _dca._consolidateMemories(episodes);
      report.strengthenedMemories = consolidation.strengthened;
      report.decayedMemories = consolidation.decayed;
      report.phases.push({ name: 'consolidation', ...consolidation });
      this._stats.totalStrengthened += consolidation.strengthened;
      this._stats.totalDecayed += consolidation.decayed;

      // ── Phase 4b: DREAMENGINE CORROBORATION (v4.12.8) ─
      const corroboratedCount = this._dreamPhaseCorroborate(report.newSchemas);
      report.corroboratedSchemas = corroboratedCount;
      if (corroboratedCount > 0) {
        report.phases.push({ name: 'corroboration', count: corroboratedCount });
      }

      // ── Phase 5: INSIGHT GENERATION ────────────────────
      // v7.2.5: Only run insights at full intensity (requires LLM headroom)
      if (intensity >= 1.0 && report.newSchemas.length > 0 && this._withinTimeLimit(startTime)) {
        report.insights = _dca._generateInsights(report.newSchemas);
        this._stats.totalInsights += report.insights.length;
      }
      report.phases.push({ name: 'insight', insightCount: report.insights.length });

      // ── Phase 5b: ACTIVE PUSH (v7.0.3 — C4) ──────────
      // Emit actionable insights so IdleMind/AgentLoop can act on them
      // immediately instead of waiting for passive SchemaStore retrieval.
      for (const insight of report.insights) {
        if (/** @type {*} */ (insight).confidence > 0.8 || insight.type === 'cross-schema') {
          this.bus.emit('insight:actionable', {
            source: 'DreamCycle',
            type: insight.type,
            description: insight.description,
            confidence: /** @type {*} */ (insight).confidence || 0.85,
            schemas: (insight.schemas || []).map(s => s.name || s.id || 'unknown'),
            dreamNumber: this._dreamCount,
          }, { source: 'DreamCycle' });
          _log.info(`[DREAM] Actionable insight emitted: ${(insight.description || '').slice(0, 60)}`);
        }
      }

      // ── Phase 6: GOAL REVIEW (v7.3.3) ───────────────────
      // Dream cycle is also when Genesis audits his own goal list.
      // The 6/8-stuck-forever bug is fixed here: reviewGoals walks
      // active goals and transitions those that should have moved on
      // (completed, failed, stalled). User-sourced goals are touched
      // with permission (default on for dreams — Genesis decides).
      // Skipped at low intensity to respect the cost-tier scaling.
      if (this.goalStack && typeof this.goalStack.reviewGoals === 'function' && intensity >= 0.5) {
        try {
          const reviewReport = this.goalStack.reviewGoals();
          report.phases.push({
            name: 'goal-review',
            reviewed: reviewReport.reviewed,
            changed: reviewReport.changed.length,
          });
          if (reviewReport.changed.length > 0) {
            _log.info(`[DREAM] Goal review: ${reviewReport.changed.length}/${reviewReport.reviewed} goals transitioned`);
          }
          /** @type {*} */ (report).goalReview = reviewReport;
        } catch (err) {
          _log.warn('[DREAM] Goal review failed (non-critical):', err.message);
        }
      }

      // Mark episodes as processed
      for (const ep of episodes) {
        this._processedEpisodeIds.add(ep.id);
      }
      // Trim processed set
      if (this._processedEpisodeIds.size > 1000) {
        const arr = [...this._processedEpisodeIds];
        this._processedEpisodeIds = new Set(arr.slice(-500));
      }

    } catch (err) {
      report.error = err.message;
      _log.warn('[DREAM] Dream cycle error:', err.message);
    }

    report.durationMs = Date.now() - startTime;
    this._lastDreamAt = Date.now();
    this._stats.avgDurationMs = this._stats.avgDurationMs * 0.8 + report.durationMs * 0.2;

    this._save();

    this.bus.emit('dream:complete', {
      dreamNumber: this._dreamCount,
      duration: report.durationMs,
      newSchemas: report.newSchemas.length,
      insights: report.insights.length,
      strengthened: report.strengthenedMemories,
      decayed: report.decayedMemories,
      corroborated: report.corroboratedSchemas || 0,
    }, { source: 'DreamCycle' });

    return report;
  }

  /** Get time since last dream (for IdleMind scoring) */
  getTimeSinceLastDream() {
    return Date.now() - this._lastDreamAt;
  }

  /** Get number of unprocessed episodes (for IdleMind scoring) */
  getUnprocessedCount() {
    if (!this.episodicMemory) return 0;
    try {
      const all = this.episodicMemory.recall('', { maxResults: 100 });
      return all.filter(e => !this._processedEpisodeIds.has(e.id)).length;
    } catch (_e) { _log.debug('[catch] episodic recall:', _e.message); return 0; }
  }

  getStats() {
    return {
      ...this._stats,
      dreamCount: this._dreamCount,
      lastDreamAt: this._lastDreamAt,
      processedEpisodes: this._processedEpisodeIds.size,
    };
  }

  // ════════════════════════════════════════════════════════
  // v5.2.0: EXTRACTED DREAM PHASES (CC reduction)
  // ════════════════════════════════════════════════════════

  /**
   * Phase 3: Extract schemas from qualified patterns.
   * Uses LLM batch call if available, otherwise heuristic.
   */
  async _dreamPhaseSchemas(qualifiedPatterns, startTime) {
    const results = [];
    if (qualifiedPatterns.length === 0) return results;

    let schemas;
    const _dca = /** @type {any} */ (this); // DreamCycleAnalysis mixin cast
    if (this._useLLM && this.model && this._withinTimeLimit(startTime)) {
      schemas = await _dca._batchExtractSchemas(qualifiedPatterns);
    } else {
      schemas = _dca._heuristicSchemas(qualifiedPatterns);
    }

    for (const schema of schemas) {
      if (schema && this.schemaStore) {
        const stored = this.schemaStore.store(schema);
        if (stored) results.push(stored);
      }
    }
    return results;
  }

  /**
   * Phase 3b: Crystallize schemas with strong success modifiers into values.
   * "Code generation at night fails 40% more" → value: "avoid-late-coding"
   */
  _dreamPhaseCrystallize(newSchemas) {
    if (!this.valueStore || newSchemas.length === 0) return;
    for (const schema of newSchemas) {
      if (Math.abs(schema.successModifier || 0) > 0.3 && schema.recommendation) {
        try {
          this.valueStore.store({
            name: (schema.name || 'learned').toLowerCase().slice(0, 40).replace(/\s+/g, '-'),
            description: schema.recommendation || schema.description || '',
            weight: 0.3 + Math.abs(schema.successModifier) * 0.3,
            polarity: (schema.successModifier || 0) > 0 ? 1 : -1,
            source: 'dream',
            domain: schema.trigger?.includes('code') ? 'code' : 'all',
          });
        } catch (err) { _log.debug('[DREAM] valueStore.store failed:', err.message); }
      }
    }
  }

  /**
   * Phase 4b: Cross-validate DreamCycle schemas against DreamEngine schemas.
   * Independent discovery of the same pattern boosts confidence significantly.
   */
  _dreamPhaseCorroborate(newSchemas) {
    if (!this.schemaStore || newSchemas.length === 0) return 0;
    let count = 0;
    try {
      const dreamEngineSchemas = this.schemaStore._schemas?.filter(
        s => s.source === 'DreamEngine' || (s.name && s.name.startsWith('experiential:'))
      ) || [];

      for (const deSchema of dreamEngineSchemas) {
        const deWords = new Set(
          (deSchema.description || '').toLowerCase().split(/\s+/).filter(w => w.length > 3)
        );
        for (const newSchema of newSchemas) {
          const newWords = (newSchema.description || newSchema.name || '').toLowerCase().split(/\s+/);
          const overlap = newWords.filter(w => deWords.has(w)).length;
          if (overlap >= 2 || (deWords.size > 0 && overlap / deWords.size > 0.4)) {
            deSchema.confidence = Math.min(0.95, (deSchema.confidence || 0.4) + 0.2);
            deSchema.corroboratedBy = (deSchema.corroboratedBy || 0) + 1;
            deSchema.lastCorroboration = Date.now();
            count++;
            _log.info(`[DREAM] Corroborated DreamEngine schema "${deSchema.name}" → confidence ${deSchema.confidence.toFixed(2)}`);
          }
        }
      }
    } catch (_e) { /* non-critical */ }
    return count;
  }

  // ════════════════════════════════════════════════════════
  // PHASE 1: EPISODE RETRIEVAL
  // ════════════════════════════════════════════════════════

  _getUnprocessedEpisodes() {
    if (!this.episodicMemory) return [];
    try {
      const all = this.episodicMemory.recall('', { maxResults: 100, strategy: 'temporal' });
      return all.filter(e => !this._processedEpisodeIds.has(e.id));
    } catch (_e) { _log.debug('[catch] episodic recall:', _e.message); return []; }
  }

  // ── Analysis methods → DreamCycleAnalysis.js (v5.6.0) ──
  // (prototype delegation, see bottom of file)

  _withinTimeLimit(startTime) {
    return (Date.now() - startTime) < this._maxDreamDurationMs;
  }

  _save() {
    if (!this.storage) return;
    try {
      this.storage.writeJSONDebounced('dream-state.json', this._saveData(), 5000);
    } catch (_e) { _log.debug('[catch] dream insight store:', _e.message); }
  }

  /** FIX D-1: Sync write for shutdown path. */
  _saveSync() {
    if (!this.storage) return;
    try {
      this.storage.writeJSON('dream-state.json', this._saveData());
    } catch (_e) { _log.debug('[catch] dream sync persist:', _e.message); }
  }

  /** @private Shared payload for both save paths. */
  _saveData() {
    return {
      lastDreamAt: this._lastDreamAt,
      dreamCount: this._dreamCount,
      stats: this._stats,
      processedIds: [...this._processedEpisodeIds].slice(-500),
      savedAt: Date.now(),
    };
  }
}

module.exports = { DreamCycle };

// Extracted to DreamCycleAnalysis.js (v5.6.0) — same pattern
// as IdleMind → IdleMindActivities, PromptBuilder → PromptBuilderSections.
const { analysis } = require('./DreamCycleAnalysis');
Object.assign(DreamCycle.prototype, analysis);
