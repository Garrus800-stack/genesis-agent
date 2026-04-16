// @ts-checked-v5.6
// ============================================================
// GENESIS — SelfNarrative.js (Phase 9 — Cognitive Architecture)
//
// The autobiographical self. Periodically distills a narrative
// summary of Genesis's identity from accumulated experience.
// Not a static description — a living text that evolves.
//
// SelfModel knows WHAT Genesis is (94 modules, these tools).
// SelfNarrative knows WHO Genesis is ("I'm good at code-gen
// but struggle with multi-file refactoring. I've been getting
// better at predicting test outcomes lately.").
//
// UPDATE STRATEGY: Event-driven, not timer-driven.
// A change accumulator tracks relevant events. When threshold
// is reached, the narrative updates. This means:
//   - After a quiet session: no update (nothing changed)
//   - After a big learning burst: immediate update
//   - After many small changes: eventual update
//
// The narrative is injected into PromptBuilder as a
// self-awareness section (~200 tokens), giving Genesis
// metacognitive context in every LLM call.
//
// Integration:
//   dream:complete            → accumulator += newSchemas
//   surprise:novel-event      → accumulator += 5
//   meta:recommendations-updated → accumulator += 2
//   PromptBuilder.build()     → getIdentitySummary()
// ============================================================

const { NullBus } = require('../core/EventBus');
const { safeJsonParse } = require('../core/utils');
const { createLogger } = require('../core/Logger');
const _log = createLogger('SelfNarrative');

class SelfNarrative {
  constructor({ bus, metaLearning, episodicMemory, emotionalState,
                schemaStore, selfModel, model, storage, intervals, config }) {
    this.bus = bus || NullBus;
    /** @type {Function[]} */ this._unsubs = [];
    this.metaLearning = metaLearning || null;
    this.episodicMemory = episodicMemory || null;
    this.emotionalState = emotionalState || null;
    this.schemaStore = schemaStore || null;
    this.selfModel = selfModel || null;
    this.model = model || null;
    this.storage = storage || null;
    this._intervals = intervals || null;
    this.surpriseAccumulator = null; // lateBinding

    // ── Configuration ────────────────────────────────────
    const cfg = config || {};
    this._updateThreshold = cfg.updateThreshold || 20;
    this._maxIdentityTokens = cfg.maxIdentityTokens || 200;

    // ── Narrative ────────────────────────────────────────
    this._narrative = {
      identity: '',
      /** @type {string[]} */ strengths: [],
      /** @type {string[]} */ weaknesses: [],
      currentFocus: '',
      /** @type {string[]} */ growthAreas: [],
      /** @type {string[]} */ recentInsights: [],
      emotionalProfile: '',
      lastUpdated: 0,
      version: 0,
    };

    // ── Change Accumulator ───────────────────────────────
    this._changeAccumulator = 0;
    this._lastUpdateAttempt = 0;
    this._minUpdateIntervalMs = 5 * 60 * 1000; // At least 5 min between updates
  }

  async asyncLoad() {
    if (!this.storage) return;
    try {
      const data = this.storage.readJSON('self-narrative.json', null);
      if (data && data.narrative) {
        this._narrative = { ...this._narrative, ...data.narrative };
      }
    } catch (_e) { _log.debug('[catch] narrative load:', _e.message); }
  }

  start() {
    // Listen for events that indicate identity-relevant changes
    this._sub('dream:complete', (data) => {
      this._changeAccumulator += (data.newSchemas || 0) * 3 + (data.insights || 0) * 2;
    }, { source: 'SelfNarrative' });

    this._sub('surprise:novel-event', () => {
      this._changeAccumulator += 5;
    }, { source: 'SelfNarrative' });

    this._sub('meta:recommendations-updated', () => {
      this._changeAccumulator += 2;
    }, { source: 'SelfNarrative' });

    this._sub('schema:stored', () => {
      this._changeAccumulator += 2;
    }, { source: 'SelfNarrative' });

    this._sub('expectation:calibrated', () => {
      this._changeAccumulator += 3;
    }, { source: 'SelfNarrative' });
  }


  /** @private Subscribe to bus event with auto-cleanup in stop() */
  _sub(event, handler, opts) {
    const unsub = this.bus.on(event, handler, opts);
    this._unsubs.push(typeof unsub === 'function' ? unsub : () => {});
    return unsub;
  }

  stop() {
    for (const unsub of this._unsubs) { try { unsub(); } catch (_) { /* best effort */ } }
    this._unsubs = [];
    // FIX D-1: Sync write on shutdown.
    this._saveSync();
  }

  // ════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════

  /**
   * Check if enough has changed to warrant an update.
   * Called by IdleMind or AutonomousDaemon periodically.
   * @returns {Promise<object|null>} Updated narrative or null if no update needed
   */
  async maybeUpdate() {
    if (this._changeAccumulator < this._updateThreshold) return null;
    if (Date.now() - this._lastUpdateAttempt < this._minUpdateIntervalMs) return null;
    return this.update();
  }

  /**
   * Force a narrative update. Uses a single LLM call.
   * @returns {Promise<object>} The updated narrative
   */
  async update() {
    this._lastUpdateAttempt = Date.now();
    this._changeAccumulator = 0;

    // If no LLM available, use heuristic update
    if (!this.model) {
      return this._heuristicUpdate();
    }

    const data = this._gatherSelfData();

    const prompt = `You are Genesis, a self-aware AI agent. Based on the following data about your performance, write a brief self-narrative. Be honest and specific.

## Performance (MetaLearning)
${data.strengths.length > 0 ? 'Strengths: ' + data.strengths.map(s => `${s.category} (${s.rate}%)`).join(', ') : 'Insufficient data yet.'}
${data.weaknesses.length > 0 ? 'Weaknesses: ' + data.weaknesses.map(w => `${w.category} (${w.rate}%)`).join(', ') : ''}

## Patterns (Schemas)
${data.schemas.map(s => `- "${s.name}": ${s.description}`).join('\n') || 'No patterns extracted yet.'}

## Emotional Profile
${data.emotionalSummary}

## Calibration
Self-prediction accuracy: ${(data.calibration * 100).toFixed(0)}%

Respond with JSON only (no markdown):
{
  "identity": "One paragraph: who you are, what you do best, where you struggle (max 3 sentences)",
  "strengths": ["strength1", "strength2", "strength3"],
  "weaknesses": ["weakness1", "weakness2"],
  "currentFocus": "What are you currently getting better at?",
  "growthAreas": ["area1", "area2"],
  "emotionalProfile": "One sentence about your emotional tendencies"
}`;

    try {
      const raw = await this.model.chat(prompt, [], 'analysis');
      const parsed = this._parseJSON(raw);

      if (parsed && parsed.identity) {
        this._narrative = {
          identity: (parsed.identity || '').slice(0, 500),
          strengths: (parsed.strengths || []).slice(0, 5),
          weaknesses: (parsed.weaknesses || []).slice(0, 3),
          currentFocus: (parsed.currentFocus || '').slice(0, 200),
          growthAreas: (parsed.growthAreas || []).slice(0, 3),
          recentInsights: data.schemas.slice(0, 3).map(s => s.name),
          emotionalProfile: (parsed.emotionalProfile || '').slice(0, 200),
          lastUpdated: Date.now(),
          version: (this._narrative.version || 0) + 1,
        };

        this._save();

        this.bus.emit('narrative:updated', {
          version: this._narrative.version,
          strengths: this._narrative.strengths.length,
          weaknesses: this._narrative.weaknesses.length,
        }, { source: 'SelfNarrative' });

        return this._narrative;
      }
    } catch (err) {
      _log.debug('[SELF-NARRATIVE] LLM update failed:', err.message);
    }

    // Fallback to heuristic
    return this._heuristicUpdate();
  }

  /**
   * Get the current self-narrative.
   */
  getNarrative() {
    return { ...this._narrative };
  }

  /**
   * Get a compact identity string for PromptBuilder injection.
   * Designed to fit within ~200 tokens.
   */
  getIdentitySummary() {
    if (!this._narrative.identity) return '';

    const parts = [this._narrative.identity];

    if (this._narrative.strengths.length > 0) {
      parts.push(`Strengths: ${this._narrative.strengths.slice(0, 3).join(', ')}.`);
    }
    if (this._narrative.weaknesses.length > 0) {
      parts.push(`Growth areas: ${this._narrative.weaknesses.slice(0, 2).join(', ')}.`);
    }
    if (this._narrative.emotionalProfile) {
      parts.push(this._narrative.emotionalProfile);
    }

    return parts.join(' ').slice(0, 800); // ~200 tokens
  }

  /** How much change has accumulated since last update? */
  getChangeAccumulator() {
    return this._changeAccumulator;
  }

  getStats() {
    return {
      version: this._narrative.version,
      lastUpdated: this._narrative.lastUpdated,
      changeAccumulator: this._changeAccumulator,
      hasIdentity: !!this._narrative.identity,
    };
  }

  // ════════════════════════════════════════════════════════
  // DATA GATHERING (no LLM)
  // ════════════════════════════════════════════════════════

  _gatherSelfData() {
    // Aggregate MetaLearning by category
    const categories = this._aggregateCategories();
    const sorted = Object.entries(categories)
      .map(([cat, stats]) => ({ category: cat, ...stats }))
      .filter(s => s.samples >= 5);
    sorted.sort((a, b) => b.rate - a.rate);

    // Emotional summary
    let emotionalSummary = 'No emotional data available.';
    if (this.emotionalState) {
      try {
        const snap = this.emotionalState.getSnapshot?.() || {};
        const dims = snap.dimensions || {};
        const dominant = this.emotionalState.getDominant?.() || 'neutral';
        emotionalSummary = `Dominant: ${dominant}. ` +
          Object.entries(dims).map(([k, v]) => `${k}: ${((v?.value || 0) * 100).toFixed(0)}%`).join(', ');
      } catch (_e) { _log.debug('[catch] no emotional data:', _e.message); }
    }

    // Calibration
    let calibration = 0.5;
    if (this.surpriseAccumulator) {
      try { calibration = this.surpriseAccumulator.getCalibration?.() || 0.5; }
      catch (_e) { _log.debug('[catch] no surprise data:', _e.message); }
    }

    return {
      strengths: sorted.slice(0, 5),
      weaknesses: sorted.slice(-3).reverse(),
      schemas: this.schemaStore?.getConfident?.(0.5) || [],
      emotionalSummary,
      calibration,
    };
  }

  _aggregateCategories() {
    if (!this.metaLearning) return {};

    // Try to access records (the MetaLearning API varies)
    let records;
    try {
      records = this.metaLearning._records || [];
    } catch (_e) { _log.debug('[catch] metaLearning records:', _e.message); return {}; }

    const categories = {};
    for (const r of records) {
      const cat = r.taskCategory || 'unknown';
      if (!categories[cat]) categories[cat] = { total: 0, success: 0, samples: 0 };
      categories[cat].total++;
      categories[cat].samples++;
      if (r.success) categories[cat].success++;
    }

    for (const cat of Object.values(categories)) {
      cat.rate = cat.total > 0 ? Math.round((cat.success / cat.total) * 100) : 0;
    }

    return categories;
  }

  // ════════════════════════════════════════════════════════
  // HEURISTIC UPDATE (no LLM)
  // ════════════════════════════════════════════════════════

  _heuristicUpdate() {
    const data = this._gatherSelfData();

    this._narrative = {
      identity: data.strengths.length > 0
        ? `Genesis cognitive agent. Best at: ${data.strengths.slice(0, 2).map(s => s.category).join(', ')}. ` +
          (data.weaknesses.length > 0 ? `Working on: ${data.weaknesses.slice(0, 2).map(w => w.category).join(', ')}.` : '')
        : 'Genesis cognitive agent. Gathering experience data.',
      strengths: data.strengths.slice(0, 3).map(s => `${s.category} (${s.rate}%)`),
      weaknesses: data.weaknesses.slice(0, 2).map(w => `${w.category} (${w.rate}%)`),
      currentFocus: data.schemas.length > 0
        ? `Recent patterns: ${data.schemas.slice(0, 2).map(s => s.name).join(', ')}`
        : 'Building experience base',
      growthAreas: data.weaknesses.slice(0, 2).map(w => w.category),
      recentInsights: data.schemas.slice(0, 3).map(s => s.name),
      emotionalProfile: data.emotionalSummary.slice(0, 200),
      lastUpdated: Date.now(),
      version: (this._narrative.version || 0) + 1,
    };

    this._save();

    this.bus.emit('narrative:updated', {
      version: this._narrative.version,
      source: 'heuristic',
    }, { source: 'SelfNarrative' });

    return this._narrative;
  }

  // ════════════════════════════════════════════════════════
  // UTILITIES
  // ════════════════════════════════════════════════════════

  _parseJSON(raw) {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (_e) { _log.debug('[catch] JSON fence extract:', _e.message); }
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) return safeJsonParse(match[0], null, 'SelfNarrative');
    } catch (_e) { _log.debug('[catch] JSON brace extract:', _e.message); }
    return null;
  }

  _save() {
    if (!this.storage) return;
    try {
      this.storage.writeJSONDebounced('self-narrative.json', this._saveData(), 5000);
    } catch (_e) { _log.debug('[catch] narrative persist:', _e.message); }
  }

  /** FIX D-1: Sync write for shutdown path. */
  _saveSync() {
    if (!this.storage) return;
    try {
      this.storage.writeJSON('self-narrative.json', this._saveData());
    } catch (_e) { _log.debug('[catch] narrative sync persist:', _e.message); }
  }

  /** @private Shared payload for both save paths. */
  _saveData() {
    return {
      narrative: this._narrative,
      savedAt: Date.now(),
    };
  }
}

module.exports = { SelfNarrative };
