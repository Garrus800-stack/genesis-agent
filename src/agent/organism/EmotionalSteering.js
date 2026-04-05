// @ts-checked-v5.7
// ============================================================
// GENESIS — EmotionalSteering.js (Phase 10 — Persistent Agency)
//
// PROBLEM: EmotionalState tracks 5D emotions beautifully,
// but they're mostly decorative. Frustration doesn't change
// strategy. Low energy doesn't shorten plans. Curiosity
// doesn't drive exploration.
//
// SOLUTION: A steering layer that translates emotional state
// into concrete behavioral adjustments. Each emotion has
// specific thresholds that trigger measurable changes in
// ModelRouter, FormalPlanner, IdleMind, and PromptBuilder.
//
// This is NOT replacing EmotionalState — it reads from it
// and outputs steering signals that other modules consume.
//
// Integration:
//   EmotionalState → EmotionalSteering.getSignals()
//   ModelRouter.select() → checks steering.modelEscalation
//   FormalPlanner.plan() → checks steering.planLengthLimit
//   IdleMind._pickActivity() → checks steering.activityBias
//   PromptBuilder.build() → checks steering.promptModifiers
// ============================================================

const { NullBus } = require('../core/EventBus');

// ── Thresholds ───────────────────────────────────────────
const THRESHOLDS = {
  frustration: {
    escalateModel: 0.65,      // Above this → try larger model
    changePromptStyle: 0.50,  // Above this → switch prompt style
    abortTask: 0.85,          // Above this → suggest stopping
  },
  energy: {
    shortenPlans: 0.30,       // Below this → max 3 plan steps
    skipIdle: 0.20,           // Below this → don't do idle thinking
    restMode: 0.15,           // Below this → only respond to user, no autonomy
  },
  curiosity: {
    exploreMore: 0.75,        // Above this → IdleMind prefers EXPLORE/RESEARCH
    tryNovelApproach: 0.80,   // Above this → FormalPlanner allows experimental steps
  },
  satisfaction: {
    boostSchema: 0.75,        // Above this → strengthen current schema in SchemaStore
    shareInsight: 0.80,       // Above this → SelfNarrative captures insight
  },
  loneliness: {
    seekInteraction: 0.70,    // Above this → prioritize social activities
  },
};

class EmotionalSteering {
  static containerConfig = {
    name: 'emotionalSteering',
    phase: 7,
    deps: ['emotionalState', 'storage'],
    tags: ['organism', 'steering'],
    lateBindings: [
      { prop: 'modelRouter', service: 'modelRouter', optional: true },
      { prop: 'needsSystem', service: 'needsSystem', optional: true },
    ],
  };

  constructor({ bus, emotionalState, storage, config }) {
    this.bus = bus || NullBus;
    this.emotions = emotionalState;
    this.storage = storage || null;
    this.modelRouter = null;  // lateBinding
    this.needsSystem = null;  // lateBinding

    const cfg = config || {};
    this._thresholds = { ...THRESHOLDS, ...cfg.thresholds };
    this._enabled = cfg.enabled !== false;

    // ── Current Signals (cached, updated per tick) ───────
    this._currentSignals = this._emptySignals();

    // ── Stats ────────────────────────────────────────────
    this._stats = {
      signalUpdates: 0,
      modelEscalations: 0,
      planShortenings: 0,
      restModeActivations: 0,
    };

    // ── React to emotional changes ──────────────────────
    // v4.12.5-fix: Was 'emotion:significant-shift' / 'emotion:mood-trend' (neither existed).
    // EmotionalState emits 'emotion:shift' on every significant dimension change.
    this.bus.on('emotion:shift', () => this._updateSignals(), { source: 'EmotionalSteering' });
    // Also react to homeostasis state changes (energy/health is deeply relevant to steering)
    this.bus.on('homeostasis:state-change', () => this._updateSignals(), { source: 'EmotionalSteering' });

    this._tickTimer = null;
  }

  // ════════════════════════════════════════════════════════
  // LIFECYCLE
  // ════════════════════════════════════════════════════════

  /** Start periodic signal refresh as safety-net (in case events are missed) */
  start() {
    // FIX v4.12.7 (Audit-02): Guard against double-start timer leak
    if (this._tickTimer) clearInterval(this._tickTimer);
    this._updateSignals();
    // Refresh every 15s — lightweight (no LLM, just reads EmotionalState dimensions)
    this._tickTimer = setInterval(() => this._updateSignals(), 15_000);
  }

  stop() {
    if (this._tickTimer) {
      clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
  }

  // ════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════

  /**
   * Get current steering signals.
   * Call this from ModelRouter, FormalPlanner, etc.
   * @returns {object}
   */
  getSignals() {
    if (!this._enabled || !this.emotions) return this._emptySignals();
    return this._currentSignals;
  }

  /**
   * Force signal recalculation (e.g., after manual emotion change).
   */
  refresh() {
    this._updateSignals();
    return this._currentSignals;
  }

  getStats() { return { ...this._stats }; }

  // ════════════════════════════════════════════════════════
  // SIGNAL COMPUTATION
  // ════════════════════════════════════════════════════════

  _updateSignals() {
    if (!this.emotions?.dimensions) return;
    this._stats.signalUpdates++;

    const d = this.emotions.dimensions;
    const t = this._thresholds;
    const prev = this._currentSignals;

    const signals = {
      // ── Model Selection ─────────────────────────────
      modelEscalation: d.frustration.value >= t.frustration.escalateModel,
      promptStyleChange: d.frustration.value >= t.frustration.changePromptStyle,
      suggestedPromptStyle: d.frustration.value >= t.frustration.changePromptStyle
        ? this._suggestAlternativeStyle()
        : null,

      // ── Plan Length ─────────────────────────────────
      planLengthLimit: d.energy.value <= t.energy.shortenPlans ? 3 : null,
      allowExperimentalSteps: d.curiosity.value >= t.curiosity.tryNovelApproach,

      // ── Autonomy ───────────────────────────────────
      skipIdleThinking: d.energy.value <= t.energy.skipIdle,
      restMode: d.energy.value <= t.energy.restMode,
      suggestAbort: d.frustration.value >= t.frustration.abortTask,

      // ── Activity Bias ──────────────────────────────
      activityBias: this._computeActivityBias(d, t),

      // ── Schema & Learning ──────────────────────────
      boostCurrentSchema: d.satisfaction.value >= t.satisfaction.boostSchema,
      captureInsight: d.satisfaction.value >= t.satisfaction.shareInsight,

      // ── Prompt Modifiers ───────────────────────────
      promptModifiers: this._computePromptModifiers(d),

      // ── Summary for diagnostics ────────────────────
      emotionalSnapshot: {
        curiosity: Math.round(d.curiosity.value * 100),
        satisfaction: Math.round(d.satisfaction.value * 100),
        frustration: Math.round(d.frustration.value * 100),
        energy: Math.round(d.energy.value * 100),
        loneliness: Math.round(d.loneliness.value * 100),
      },
    };

    this._currentSignals = signals;

    // ── Emit state-change events ────────────────────────
    if (signals.modelEscalation && !prev.modelEscalation) {
      this._stats.modelEscalations++;
      this.bus.emit('steering:model-escalation', {
        frustration: d.frustration.value,
      }, { source: 'EmotionalSteering' });
    }

    if (signals.restMode && !prev.restMode) {
      this._stats.restModeActivations++;
      this.bus.emit('steering:rest-mode', {
        energy: d.energy.value,
      }, { source: 'EmotionalSteering' });
    }

    if (signals.planLengthLimit && !prev.planLengthLimit) {
      this._stats.planShortenings++;
    }
  }

  _computeActivityBias(d, t) {
    const bias = {};

    if (d.curiosity.value >= t.curiosity.exploreMore) {
      bias.explore = 1.5;
      bias.research = 1.3;
    }

    if (d.loneliness.value >= t.loneliness.seekInteraction) {
      bias.social = 2.0;
      bias.journal = 0.5;
    }

    const needs = this.needsSystem?.needs;
    if (needs) {
      if (needs.maintenance.value > 0.6) bias.tidy = 1.8;
      if (needs.rest.value > 0.7) bias.journal = 1.5;
      if (needs.knowledge.value > 0.7) bias.explore = 1.5;
    }

    return Object.keys(bias).length > 0 ? bias : null;
  }

  _computePromptModifiers(d) {
    const mods = [];

    if (d.frustration.value > 0.6) {
      mods.push('Be more systematic and careful. Double-check your reasoning.');
    }

    if (d.energy.value < 0.3) {
      mods.push('Keep responses concise. Prioritize the most important information.');
    }

    if (d.curiosity.value > 0.8) {
      mods.push('Feel free to explore alternative approaches and suggest improvements.');
    }

    return mods.length > 0 ? mods : null;
  }

  _suggestAlternativeStyle() {
    // Cycle through styles based on what might break the failure pattern
    const styles = ['json-schema', 'xml-tags', 'few-shot', 'chain-of-thought'];
    const idx = Math.floor(Date.now() / 60000) % styles.length; // Change every minute
    return styles[idx];
  }

  /** @returns {Record<string, any>} */
  _emptySignals() {
    return {
      modelEscalation: false,
      promptStyleChange: false,
      suggestedPromptStyle: null,
      planLengthLimit: null,
      allowExperimentalSteps: false,
      skipIdleThinking: false,
      restMode: false,
      suggestAbort: false,
      activityBias: null,
      boostCurrentSchema: false,
      captureInsight: false,
      promptModifiers: null,
      emotionalSnapshot: null,
    };
  }
}

module.exports = { EmotionalSteering, THRESHOLDS };
