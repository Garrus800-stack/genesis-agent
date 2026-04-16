// @ts-checked-v5.8
// ============================================================
// GENESIS — EmotionalFrontier.js (v7.1.5 — Emotional Continuity)
//
// Cross-layer bridge: lives in /organism/, boots in Phase 8.
// Bridges the gap between FEELING and ACTING.
//
// Three responsibilities:
//   A. Frontier Emotion Writer   — writes EMOTIONAL_IMPRINT
//      nodes to KnowledgeGraph frontier at session end.
//   B. Boot Emotion Restore      — shifts EmotionalState
//      start values from persisted imprints at boot.
//   C. Imprint Query API         — provides recent imprints
//      for IdleMind activity targeting.
//
// WHY Phase 8 (not Phase 7)?
//   EmotionalState is Phase 7, KnowledgeGraph is Phase 1 —
//   both are resolved before Phase 8. SessionPersistence
//   (also Phase 8) is the primary caller of writeImprint().
//   If this were Phase 7, SessionPersistence would need a
//   late-binding race at session:ending. Phase 8 deps are
//   all satisfied, and the cross-layer tag documents the
//   intentional layer breach.
//
// Design principles:
//   - Additive: all callers check `if (this._emotionalFrontier)`
//   - Dampened: RESTORE_FACTOR = 0.15 (vague dream recall)
//   - Organically forgetting: decay 0.5/boot, prune < 0.05
//   - Deterministic: zero LLM calls, pure heuristics
//   - Self-aware: imprints visible in PromptBuilder + Dashboard
// ============================================================

'use strict';

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('EmotionalFrontier');

class EmotionalFrontier {
  // NOTE: containerConfig is informational only — registered via phase8 manifest.
  // Real lateBindings (_sessionPersistence, _idleMind) declared in manifest.
  /**
   * @param {object} opts
   * @param {*} opts.bus - EventBus
   * @param {*} opts.emotionalState - EmotionalState instance
   * @param {*} opts.knowledgeGraph - KnowledgeGraph instance
   * @param {*} opts.storage - StorageService instance
   * @param {object} [opts.config] - Tunables from Settings.organism.emotionalFrontier
   */
  constructor({ bus, emotionalState, knowledgeGraph, storage, config }) {
    this.bus = bus || NullBus;
    this._es = emotionalState;
    this._kg = knowledgeGraph;
    this._storage = storage || null;

    // Late-bound (Phase 8 peers)
    this._sessionPersistence = null;
    this._idleMind = null;

    // ── Configuration (overridable via Settings) ────────
    const cfg = config || {};
    this._restoreFactor = cfg.restoreFactor ?? 0.15;
    this._peakThreshold = cfg.peakThreshold ?? 0.3;
    this._sustainedThreshold = cfg.sustainedThreshold ?? 0.6;
    this._sustainedRatio = cfg.sustainedRatio ?? 0.6; // 60% of history above threshold
    this._maxImprints = cfg.maxImprints ?? 10;
    this._decayRelation = 'EMOTIONAL_IMPRINT';

    // ── Cache for getRecentImprints() ───────────────────
    this._imprintCache = null;
    this._imprintCacheTs = 0;
    this._imprintCacheTtl = cfg.cacheTtlMs ?? 5 * 60 * 1000; // 5 minutes

    // ── Stats ───────────────────────────────────────────
    this._stats = {
      imprintsWritten: 0,
      imprintsRestored: 0,
      peaksFound: 0,
      sustainedFound: 0,
    };
  }

  // ════════════════════════════════════════════════════════
  // A. FRONTIER EMOTION WRITER
  // ════════════════════════════════════════════════════════

  /**
   * Extract emotional peaks and sustained states from the current
   * session's mood history, then write an EMOTIONAL_IMPRINT node
   * to the KnowledgeGraph frontier.
   *
   * Called by SessionPersistence at session:ending.
   *
   * @param {string} sessionId - Current session identifier
   * @param {object} [sessionContext] - Optional context (topics, errors)
   * @returns {{ peaks: Array, sustained: Array, dominantMood: string } | null}
   */
  writeImprint(sessionId, sessionContext) {
    if (!this._es || !this._kg) return null;

    const peaks = this._extractPeaks();
    const sustained = this._extractSustained();

    // Skip if nothing emotionally noteworthy happened
    if (peaks.length === 0 && sustained.length === 0) {
      _log.debug('[EF] No emotional peaks or sustained states — skipping imprint');
      return null;
    }

    // Enforce max-imprint limit (weakest-first eviction)
    this._enforceMaxImprints();

    const dominantMood = this._es.getMood ? this._es.getMood() : 'unknown';
    const label = `imprint-${sessionId}`;

    const props = {
      peaks,
      sustained,
      dominant_mood: dominantMood,
      session_id: sessionId,
      created: Date.now(),
    };

    // Add context if available (topics, errors — for IdleMind targeting)
    if (sessionContext) {
      if (sessionContext.topics) props.topics = sessionContext.topics.slice(0, 10);
      if (sessionContext.errors) props.error_count = sessionContext.errors.length;
    }

    try {
      this._kg.connectToFrontier(
        this._decayRelation, label, 1.0,
        'emotional_imprint', props
      );
      this._stats.imprintsWritten++;
      this._stats.peaksFound += peaks.length;
      this._stats.sustainedFound += sustained.length;

      // Invalidate cache
      this._imprintCache = null;

      _log.info(`[EF] Imprint written: ${label} (${peaks.length} peaks, ${sustained.length} sustained, mood: ${dominantMood})`);
      this.bus.emit('emotional-frontier:imprint-written', {
        sessionId, peaks: peaks.length, sustained: sustained.length, dominantMood,
      }, { source: 'EmotionalFrontier' });

      return { peaks, sustained, dominantMood };
    } catch (err) {
      _log.debug('[EF] Failed to write imprint:', err.message);
      return null;
    }
  }

  /**
   * Extract emotional peaks: dimensions that spiked > threshold
   * above their baseline during this session.
   *
   * Uses EmotionalState._moodHistory — verified to exist as
   * Array<{ curiosity, satisfaction, frustration, energy, loneliness, mood, ts }>.
   *
   * @returns {Array<{ dim: string, value: number, trigger: string }>}
   */
  _extractPeaks() {
    const history = this._getMoodHistory();
    if (history.length === 0) return [];

    const dims = this._es.dimensions;
    const peaks = [];

    for (const [dimName, dimConfig] of Object.entries(dims)) {
      const baseline = dimConfig.baseline;
      let maxValue = baseline;
      let maxTs = 0;

      for (const snapshot of history) {
        const val = snapshot[dimName];
        if (typeof val === 'number' && (val - baseline) > this._peakThreshold) {
          if (val > maxValue) {
            maxValue = val;
            maxTs = snapshot.ts || 0;
          }
        }
      }

      if (maxValue > baseline + this._peakThreshold) {
        peaks.push({
          dim: dimName,
          value: Math.round(maxValue * 1000) / 1000,
          baseline: Math.round(baseline * 1000) / 1000,
          ts: maxTs,
          trigger: this._inferTrigger(dimName, maxTs),
        });
      }
    }

    // Sort by deviation descending
    peaks.sort((a, b) => (b.value - b.baseline) - (a.value - a.baseline));
    return peaks.slice(0, 5); // Max 5 peaks per imprint
  }

  /**
   * Extract sustained emotional states: dimensions that stayed
   * above a threshold for a significant portion of the session.
   *
   * @returns {Array<{ dim: string, avg: number, ratio: number }>}
   */
  _extractSustained() {
    const history = this._getMoodHistory();
    if (history.length < 5) return []; // Not enough data

    const dims = this._es.dimensions;
    const sustained = [];

    for (const [dimName, dimConfig] of Object.entries(dims)) {
      const baseline = dimConfig.baseline;
      const threshold = baseline + (this._sustainedThreshold - baseline) * 0.5;
      // Count how many snapshots were above threshold
      let aboveCount = 0;
      let totalValue = 0;

      for (const snapshot of history) {
        const val = snapshot[dimName];
        if (typeof val === 'number') {
          if (val > threshold) aboveCount++;
          totalValue += val;
        }
      }

      const ratio = aboveCount / history.length;
      if (ratio >= this._sustainedRatio) {
        sustained.push({
          dim: dimName,
          avg: Math.round((totalValue / history.length) * 1000) / 1000,
          ratio: Math.round(ratio * 100) / 100,
        });
      }
    }

    return sustained;
  }

  /**
   * Infer what triggered an emotional peak based on recent events.
   * Best-effort heuristic — checks EventBus context near the timestamp.
   * @param {string} dimName - Dimension name
   * @param {number} ts - Timestamp of peak
   * @returns {string} Human-readable trigger description
   */
  _inferTrigger(dimName, ts) {
    // Simple heuristic: map dimension to likely triggers
    // In a future version, this could check EventStore near ts
    const triggers = {
      frustration: 'error or failure during task',
      curiosity: 'novel topic or exploration',
      satisfaction: 'successful task completion',
      energy: 'sustained activity',
      loneliness: 'extended idle period',
    };
    return triggers[dimName] || 'unknown';
  }

  /**
   * Enforce maximum imprint count on frontier.
   * If >= _maxImprints, evict the weakest (lowest weight after decay).
   */
  _enforceMaxImprints() {
    const imprints = this._getActiveImprintEdges();
    if (imprints.length < this._maxImprints) return;

    // Sort by weight ascending — weakest first
    imprints.sort((a, b) => (a.weight || 0) - (b.weight || 0));

    // Remove weakest until under limit
    const toRemove = imprints.length - this._maxImprints + 1; // +1 for the new one
    for (let i = 0; i < toRemove; i++) {
      const edge = imprints[i];
      const target = this._kg.getNode(edge.target);
      if (target) {
        this._kg.disconnectFromFrontier(target.label);
        _log.debug(`[EF] Evicted old imprint: ${target.label} (weight: ${edge.weight})`);
      }
    }
  }

  // ════════════════════════════════════════════════════════
  // B. BOOT EMOTION RESTORE
  // ════════════════════════════════════════════════════════

  /**
   * At boot, restore a dampened emotional shift from the most
   * recent EMOTIONAL_IMPRINT in the frontier.
   *
   * RESTORE_FACTOR = 0.15: a frustration peak of 0.82 with
   * baseline 0.1 → delta = (0.82 - 0.1) * 0.15 = 0.108.
   * Subtle enough to influence, not enough to dominate.
   *
   * The shift is applied to the current VALUE, not the baseline.
   * It decays naturally over 2-3 EmotionalState decay cycles.
   *
   * Called by SessionPersistence.asyncLoad() after frontier
   * edge decay has already run.
   */
  restoreAtBoot() {
    if (!this._es || !this._kg) return;

    const imprints = this.getRecentImprints(1);
    if (imprints.length === 0) return;

    const latest = imprints[0];
    let shifted = 0;

    // Restore from peaks
    if (latest.peaks && Array.isArray(latest.peaks)) {
      for (const peak of latest.peaks) {
        const dim = this._es.dimensions[peak.dim];
        if (!dim) continue;

        const delta = (peak.value - dim.baseline) * this._restoreFactor;
        if (Math.abs(delta) < 0.01) continue; // Skip negligible shifts

        const oldValue = dim.value;
        dim.value = Math.max(dim.min, Math.min(dim.max, dim.value + delta));
        shifted++;

        _log.debug(`[EF] Boot restore: ${peak.dim} ${oldValue.toFixed(3)} → ${dim.value.toFixed(3)} (delta: ${delta.toFixed(3)})`);
      }
    }

    // Restore from sustained states (at half the factor — sustained is background, not spike)
    if (latest.sustained && Array.isArray(latest.sustained)) {
      for (const sus of latest.sustained) {
        const dim = this._es.dimensions[sus.dim];
        if (!dim) continue;

        const delta = (sus.avg - dim.baseline) * this._restoreFactor * 0.5;
        if (Math.abs(delta) < 0.01) continue;

        dim.value = Math.max(dim.min, Math.min(dim.max, dim.value + delta));
        shifted++;
      }
    }

    if (shifted > 0) {
      this._stats.imprintsRestored++;
      _log.info(`[EF] Boot restore complete: ${shifted} dimension(s) shifted from imprint`);
      this.bus.emit('emotional-frontier:boot-restored', {
        shifted, imprintId: latest.session_id,
      }, { source: 'EmotionalFrontier' });
    }
  }

  // ════════════════════════════════════════════════════════
  // C. IMPRINT QUERY API (for IdleMind + PromptBuilder)
  // ════════════════════════════════════════════════════════

  /**
   * Get the N most recent EMOTIONAL_IMPRINT nodes from the frontier.
   * Cached for _imprintCacheTtl (default 5 min) to avoid repeated
   * KG traversals during idle ticks.
   *
   * @param {number} count - Max imprints to return (default 3)
   * @returns {Array<{ peaks: Array, sustained: Array, dominant_mood: string, session_id: string, weight: number }>}
   */
  getRecentImprints(count = 3) {
    // Check cache
    if (this._imprintCache && (Date.now() - this._imprintCacheTs) < this._imprintCacheTtl) {
      return this._imprintCache.slice(0, count);
    }

    const edges = this._getActiveImprintEdges();
    if (edges.length === 0) {
      this._imprintCache = [];
      this._imprintCacheTs = Date.now();
      return [];
    }

    // Sort by weight descending (most recent/strongest first)
    edges.sort((a, b) => (b.weight || 0) - (a.weight || 0));

    const result = [];
    for (const edge of edges.slice(0, count)) {
      const node = this._kg.getNode(edge.target);
      if (node && node.properties) {
        result.push({
          ...node.properties,
          weight: edge.weight || 0,
          nodeId: node.id,
          label: node.label,
        });
      }
    }

    this._imprintCache = result;
    this._imprintCacheTs = Date.now();
    return result.slice(0, count);
  }

  /**
   * Build a prompt context string for PromptBuilder.
   * Shows the current emotional memory so Genesis knows why
   * it feels a certain way at boot.
   *
   * @returns {string} Prompt section or empty string
   */
  buildPromptContext() {
    const imprints = this.getRecentImprints(2);
    if (imprints.length === 0) return '';

    const parts = ['EMOTIONAL MEMORY (from recent sessions):'];
    for (const imp of imprints) {
      const age = this._imprintAge(imp);
      const peakSummary = (imp.peaks || [])
        .map(p => `${p.dim}=${p.value}`)
        .join(', ');
      const sustainedSummary = (imp.sustained || [])
        .map(s => `${s.dim} sustained at ${s.avg}`)
        .join(', ');

      const line = [
        `${age}:`,
        imp.dominant_mood ? `mood=${imp.dominant_mood}` : null,
        peakSummary ? `peaks[${peakSummary}]` : null,
        sustainedSummary ? `sustained[${sustainedSummary}]` : null,
        imp.weight ? `(${Math.round(imp.weight * 100)}% strength)` : null,
      ].filter(Boolean).join(' ');

      parts.push(`  - ${line}`);
    }

    return parts.join('\n');
  }

  /**
   * Build a one-liner for the dashboard Organism panel.
   * Format: "frustrated @ multi-file refactor (3 sessions ago, 12% weight)"
   * @returns {string|null}
   */
  getDashboardLine() {
    const imprints = this.getRecentImprints(1);
    if (imprints.length === 0) return null;

    const imp = imprints[0];
    const age = this._imprintAge(imp);
    const mood = imp.dominant_mood || 'unknown';
    const topPeak = (imp.peaks || [])[0];
    const context = topPeak ? topPeak.trigger : '';
    const weight = Math.round((imp.weight || 0) * 100);

    return `${mood}${context ? ' @ ' + context : ''} (${age}, ${weight}% weight)`;
  }

  // ════════════════════════════════════════════════════════
  // DIAGNOSTICS
  // ════════════════════════════════════════════════════════

  getReport() {
    return {
      stats: { ...this._stats },
      config: {
        restoreFactor: this._restoreFactor,
        peakThreshold: this._peakThreshold,
        maxImprints: this._maxImprints,
      },
      activeImprints: this._getActiveImprintEdges().length,
      latestImprint: this.getRecentImprints(1)[0] || null,
      dashboardLine: this.getDashboardLine(),
    };
  }

  // ════════════════════════════════════════════════════════
  // INTERNAL HELPERS
  // ════════════════════════════════════════════════════════

  /**
   * Get mood history from EmotionalState.
   * Accesses the verified _moodHistory array.
   * @returns {Array<{ curiosity: number, satisfaction: number, frustration: number, energy: number, loneliness: number, ts: number }>}
   */
  _getMoodHistory() {
    if (!this._es) return [];
    // Direct access to verified field (EmotionalState.js:56)
    return this._es._moodHistory || [];
  }

  /**
   * Get all active EMOTIONAL_IMPRINT edges from the frontier.
   * @returns {Array<{ id: string, source: string, target: string, relation: string, weight: number }>}
   */
  _getActiveImprintEdges() {
    if (!this._kg || !this._kg.graph || !this._kg.graph.edges) return [];

    const frontier = this._kg.graph.findNode('frontier');
    if (!frontier) return [];

    const result = [];
    for (const [, edge] of this._kg.graph.edges) {
      if (edge.source === frontier.id && edge.relation === this._decayRelation) {
        result.push(edge);
      }
    }
    return result;
  }

  /**
   * Human-readable age of an imprint.
   * @param {object} imp - Imprint with created timestamp
   * @returns {string}
   */
  _imprintAge(imp) {
    if (!imp.created) return 'unknown age';
    const ageMs = Date.now() - imp.created;
    const hours = Math.round(ageMs / (1000 * 60 * 60));
    if (hours < 1) return 'this session';
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    return `${days} day${days > 1 ? 's' : ''} ago`;
  }
}

module.exports = { EmotionalFrontier };
