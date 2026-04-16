// @ts-check
// ============================================================
// GENESIS — AdaptivePromptStrategy.js (v6.0.4)
//
// Genesis optimiert seine eigenen Prompts basierend auf
// empirischen Daten. Kein Agent macht das.
//
// Funktionsweise:
//   1. ExecutionProvenance trackt jeden Request:
//      → welche Prompt-Sections waren aktiv
//      → was war das Ergebnis (success/error)
//      → welcher Intent-Typ
//
//   2. AdaptivePromptStrategy analysiert die Traces:
//      → Für Intent "general" + Section "organism":
//        success_with = 8/10, success_without = 5/10
//        → Effectiveness: +30pp → BOOST
//      → Für Intent "general" + Section "consciousness":
//        success_with = 7/10, success_without = 7/10
//        → Effectiveness: 0pp → SKIP (spart Tokens)
//
//   3. PromptBuilder fragt vor dem Build:
//      → strategy.getSectionAdvice(intent, sectionName)
//      → "boost" | "skip" | "neutral"
//
// Sicherheit:
//   - Sections mit Priority <= 2 (identity, formatting, safety)
//     werden NIE geskippt — sie sind strukturell notwendig.
//   - Minimum 10 Traces pro Intent bevor Empfehlungen gegeben werden.
//   - Empfehlungen sind soft — PromptBuilder kann sie ignorieren.
//   - Alle Entscheidungen werden geloggt und sind über
//     getReport() einsehbar.
//
// Integration:
//   - Late-bound auf PromptBuilder (optional)
//   - Liest aus ExecutionProvenance (optional)
//   - Persistiert Analyse in StorageService
//   - Emittiert 'prompt:strategy-updated' Events
// ============================================================

'use strict';

const { createLogger } = require('../core/Logger');
const _log = createLogger('AdaptivePrompt');

// Sections that must NEVER be skipped regardless of data
const PROTECTED_SECTIONS = new Set([
  'identity', 'formatting', 'session', 'capabilities', 'safety',
]);

// Minimum traces before making recommendations
const MIN_SAMPLES = 10;

// Effectiveness thresholds
const BOOST_THRESHOLD = 0.10;   // +10pp → recommend boosting
const SKIP_THRESHOLD  = -0.02;  // Section doesn't help and adds tokens → recommend skipping
const SIGNIFICANT_THRESHOLD = 0.05; // Must be ≥5pp to be significant

class AdaptivePromptStrategy {
  /** @param {{ bus?: *, config?: * }} [deps] */
  constructor({ bus, config } = {}) {
    this.bus = bus || { emit() {}, on() { return () => {}; } };
    this._provenance = null;
    this._storage = null;

    const cfg = config || {};
    this._enabled = cfg.enabled !== false;
    this._minSamples = cfg.minSamples || MIN_SAMPLES;
    this._autoAnalyzeInterval = cfg.analyzeEvery || 25; // Re-analyze every N traces

    // Section effectiveness per intent type
    // { [intentType]: { [sectionName]: { withSuccess, withTotal, withoutSuccess, withoutTotal } } }
    this._effectiveness = {};

    // Computed recommendations
    // { [intentType]: { [sectionName]: 'boost' | 'skip' | 'neutral' } }
    this._recommendations = {};

    this._tracesAnalyzed = 0;
    this._lastAnalysis = 0;
    this._unsubs = [];
  }

  start() {
    if (!this._enabled) return;

    // Load persisted analysis
    this._load();

    // Listen for completed traces
    this._unsubs.push(
      this.bus.on('chat:completed', (data) => {
        this._tracesAnalyzed++;
        if (this._tracesAnalyzed % this._autoAnalyzeInterval === 0) {
          this._analyze();
        }
      }, { source: 'AdaptivePromptStrategy', priority: -30 })
    );

    _log.info(`[ADAPTIVE] Active — ${Object.keys(this._recommendations).length} intent strategies loaded`);
  }

  stop() {
    for (const unsub of this._unsubs) {
      try { if (typeof unsub === 'function') unsub(); } catch (_e) { /* ok */ }
    }
    this._unsubs = [];
  }

  // ═══════════════════════════════════════════════════════════
  // QUERY API — called by PromptBuilder
  // ═══════════════════════════════════════════════════════════

  /**
   * Get section advice for a specific intent type.
   *
   * @param {string} intentType - e.g. 'general', 'execute-code', 'self-modify'
   * @param {string} sectionName - e.g. 'organism', 'consciousness', 'knowledge'
   * @returns {'boost' | 'skip' | 'neutral'}
   */
  getSectionAdvice(intentType, sectionName) {
    if (!this._enabled) return 'neutral';
    if (PROTECTED_SECTIONS.has(sectionName)) return 'neutral';

    const intentRecs = this._recommendations[intentType];
    if (!intentRecs) return 'neutral';

    return intentRecs[sectionName] || 'neutral';
  }

  /**
   * Get all recommendations for an intent type.
   * @param {string} intentType
   * @returns {{ boosts: string[], skips: string[], neutral: string[] }}
   */
  getStrategy(intentType) {
    const recs = this._recommendations[intentType] || {};
    const boosts = [], skips = [], neutral = [];
    for (const [section, advice] of Object.entries(recs)) {
      if (advice === 'boost') boosts.push(section);
      else if (advice === 'skip') skips.push(section);
      else neutral.push(section);
    }
    return { boosts, skips, neutral };
  }

  // ═══════════════════════════════════════════════════════════
  // ANALYSIS — turns traces into recommendations
  // ═══════════════════════════════════════════════════════════

  /**
   * Analyze provenance traces and update recommendations.
   * Can be called manually or triggered automatically every N traces.
   */
  _analyze() {
    if (!this._provenance) return;

    const traces = this._provenance.getRecentTraces(100);
    if (traces.length < this._minSamples) return;

    // Reset effectiveness counters
    this._effectiveness = {};

    // Build effectiveness data from traces
    for (const trace of traces) {
      if (!trace.intent?.type || !trace.response) continue;

      const intent = trace.intent.type;
      const isSuccess = trace.response.outcome === 'success' && !trace.response.error;
      const activeSections = new Set(trace.prompt?.activeList || []);
      const skippedSections = trace.prompt?.skippedList || [];
      const allSections = [...activeSections, ...skippedSections];

      if (!this._effectiveness[intent]) this._effectiveness[intent] = {};

      for (const section of allSections) {
        if (PROTECTED_SECTIONS.has(section)) continue;

        if (!this._effectiveness[intent][section]) {
          this._effectiveness[intent][section] = {
            withSuccess: 0, withTotal: 0,
            withoutSuccess: 0, withoutTotal: 0,
          };
        }

        const eff = this._effectiveness[intent][section];

        if (activeSections.has(section)) {
          eff.withTotal++;
          if (isSuccess) eff.withSuccess++;
        } else {
          eff.withoutTotal++;
          if (isSuccess) eff.withoutSuccess++;
        }
      }
    }

    // Compute recommendations
    const oldRecs = JSON.stringify(this._recommendations);
    this._recommendations = {};

    for (const [intent, sections] of Object.entries(this._effectiveness)) {
      this._recommendations[intent] = {};

      for (const [section, eff] of Object.entries(sections)) {
        // Need minimum samples in both conditions
        if (eff.withTotal < 3 || eff.withoutTotal < 3) continue;

        const successWith = eff.withSuccess / eff.withTotal;
        const successWithout = eff.withoutSuccess / eff.withoutTotal;
        const delta = successWith - successWithout;

        if (delta >= BOOST_THRESHOLD) {
          this._recommendations[intent][section] = 'boost';
        } else if (delta <= SKIP_THRESHOLD && Math.abs(delta) >= SIGNIFICANT_THRESHOLD) {
          this._recommendations[intent][section] = 'skip';
        } else {
          this._recommendations[intent][section] = 'neutral';
        }
      }
    }

    this._lastAnalysis = Date.now();

    // Emit event if recommendations changed
    const newRecs = JSON.stringify(this._recommendations);
    if (newRecs !== oldRecs) {
      this.bus.emit('prompt:strategy-updated', {
        intents: Object.keys(this._recommendations).length,
        recommendations: this._recommendations,
      }, { source: 'AdaptivePromptStrategy' });

      _log.info(`[ADAPTIVE] Strategy updated — ${this._summarize()}`);
      this._save();
    }
  }

  /**
   * Force a re-analysis. Called manually or via CLI.
   */
  analyze() {
    this._analyze();
    return this.getReport();
  }

  // ═══════════════════════════════════════════════════════════
  // DIAGNOSTICS
  // ═══════════════════════════════════════════════════════════

  getReport() {
    const report = {
      enabled: this._enabled,
      tracesAnalyzed: this._tracesAnalyzed,
      lastAnalysis: this._lastAnalysis ? new Date(this._lastAnalysis).toISOString() : null,
      strategies: {},
    };

    for (const [intent, recs] of Object.entries(this._recommendations)) {
      const strategy = this.getStrategy(intent);
      const eff = this._effectiveness[intent] || {};
      report.strategies[intent] = {
        boosts: strategy.boosts,
        skips: strategy.skips,
        details: {},
      };

      for (const [section, data] of Object.entries(eff)) {
        const successWith = data.withTotal > 0 ? Math.round((data.withSuccess / data.withTotal) * 100) : 0;
        const successWithout = data.withoutTotal > 0 ? Math.round((data.withoutSuccess / data.withoutTotal) * 100) : 0;
        report.strategies[intent].details[section] = {
          advice: recs[section] || 'neutral',
          successWith: `${successWith}% (${data.withSuccess}/${data.withTotal})`,
          successWithout: `${successWithout}% (${data.withoutSuccess}/${data.withoutTotal})`,
          delta: `${successWith - successWithout >= 0 ? '+' : ''}${successWith - successWithout}pp`,
        };
      }
    }

    return report;
  }

  /** @private */
  _summarize() {
    const parts = [];
    for (const [intent, recs] of Object.entries(this._recommendations)) {
      const boosts = Object.entries(recs).filter(([, v]) => v === 'boost').map(([k]) => k);
      const skips = Object.entries(recs).filter(([, v]) => v === 'skip').map(([k]) => k);
      if (boosts.length > 0 || skips.length > 0) {
        parts.push(`${intent}: ${boosts.length > 0 ? '+' + boosts.join(',') : ''} ${skips.length > 0 ? '-' + skips.join(',') : ''}`);
      }
    }
    return parts.length > 0 ? parts.join(' | ') : 'no significant patterns yet';
  }

  // ═══════════════════════════════════════════════════════════
  // PERSISTENCE
  // ═══════════════════════════════════════════════════════════

  /** @private */
  _save() {
    if (!this._storage) return;
    try {
      this._storage.writeJSON('adaptive-prompt-strategy.json', {
        recommendations: this._recommendations,
        effectiveness: this._effectiveness,
        lastAnalysis: this._lastAnalysis,
        tracesAnalyzed: this._tracesAnalyzed,
      });
    } catch (_e) { /* best effort */ }
  }

  /** @private */
  _load() {
    if (!this._storage) return;
    try {
      const data = this._storage.readJSON('adaptive-prompt-strategy.json', null);
      if (data) {
        this._recommendations = data.recommendations || {};
        this._effectiveness = data.effectiveness || {};
        this._lastAnalysis = data.lastAnalysis || 0;
        this._tracesAnalyzed = data.tracesAnalyzed || 0;
      }
    } catch (_e) { /* ok, start fresh */ }
  }
}

module.exports = { AdaptivePromptStrategy, PROTECTED_SECTIONS };
