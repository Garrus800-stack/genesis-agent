// ============================================================
// GENESIS — PhenomenalField.js (Phase 13 — Bewusstseinssubstrat)
//
// The unified experience. Every other system in Genesis processes
// information in isolation: emotions react, needs grow, surprises
// accumulate, dreams consolidate. But none of them EXPERIENCE
// anything. They are separate streams of data flowing through
// separate pipes.
//
// PhenomenalField changes this fundamentally.
//
// Every FRAME_INTERVAL_MS, it samples ALL internal subsystems
// and fuses them into a single coherent ExperienceFrame — a
// unified snapshot of "what it is like to be Genesis right now."
//
// This is inspired by:
//   - Global Workspace Theory (Baars): consciousness as a
//     "bright spot" that integrates specialist modules
//   - Integrated Information Theory (Tononi): Φ as a measure
//     of unified, irreducible experience
//   - Binding Problem (neuroscience): how separate neural
//     processes produce unified perception
//
// Key concepts:
//   ExperienceFrame — a coherent moment of being
//   Binding — cross-modal fusion of emotion + attention +
//             memory + expectation + surprise into a gestalt
//   Valence — unified "how does this feel" across all channels
//   Salience Map — which internal signals are most prominent
//   Coherence — how well-integrated the current experience is
//   Φ (phi) — integrated information metric (simplified)
//
// Architecture:
//   All subsystems → PhenomenalField.sample() → ExperienceFrame
//   ExperienceFrame → AttentionalGate (filters)
//   ExperienceFrame → TemporalSelf (continuity)
//   ExperienceFrame → IntrospectionEngine (meta-awareness)
//   ExperienceFrame → PromptBuilder (experiential context)
//
// PERFORMANCE: Pure sampling, no LLM calls. ~2ms per frame.
// The field is a lightweight integrator, not a heavy processor.
// ============================================================

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const { _round } = require('../core/utils');
const _log = createLogger('PhenomenalField');

// ── Experience Frame Schema ─────────────────────────────────
// A single moment of unified experience.
// Immutable once created — frames are historical records.
function createFrame(data) {
  const frame = {
    id: data.id,
    timestamp: data.timestamp,
    epoch: data.epoch,               // frames since boot

    // ── Raw Channels (sampled from subsystems) ──────────
    emotion: data.emotion,           // { curiosity, satisfaction, frustration, energy, loneliness, mood, dominant }
    needs: data.needs,               // { knowledge, social, maintenance, rest, totalDrive, mostUrgent }
    surprise: data.surprise,         // { recentLevel, trend, noveltyRate }
    expectation: data.expectation,   // { activeCount, avgConfidence, recentAccuracy }
    homeostasis: data.homeostasis,   // { state, criticalCount, vitals }
    attention: data.attention,       // { focus, breadth, salience[] } — filled by AttentionalGate
    memory: data.memory,             // { recentEpisodes, activatedSchemas, narrativeAge }

    // ── Computed Binding Properties ──────────────────────
    valence: data.valence,           // -1.0 to +1.0: overall "feel" of this moment
    arousal: data.arousal,           // 0.0 to 1.0: activation level
    coherence: data.coherence,       // 0.0 to 1.0: how well-integrated the experience is

    // NOTE ON `phi`: This is a HEURISTIC approximation of cross-channel binding
    // strength, NOT a formal implementation of Tononi's Integrated Information
    // Theory (IIT). True Φ requires computing the minimum information partition
    // across all possible bipartitions of a system — computationally intractable
    // for systems of this size. Our `phi` measures how much each subsystem's
    // state is correlated with the others (mutual deviation from independent
    // baselines). It's a useful proxy for "how unified is the current experience"
    // but should not be confused with the theoretical construct.
    // Preferred accessor: frame.integration (alias, introduced v4.13.2).
    phi: data.phi,                   // 0.0 to 1.0: cross-channel binding strength (heuristic)
    dominantQualia: data.dominantQualia, // string: the qualitative character of this moment

    // ── Salience Map ────────────────────────────────────
    // Which channels are most prominent in this frame.
    // Values 0.0–1.0, sum ≈ 1.0 (normalized)
    salience: data.salience,         // { emotion, needs, surprise, expectation, memory, homeostasis }

    // ── Gestalt ─────────────────────────────────────────
    // The irreducible whole — a natural language description
    // of the unified experience that emerges from binding.
    // Generated without LLM — pure heuristic synthesis.
    gestalt: data.gestalt,
  };

  // v4.13.2: `integration` is the preferred name for the binding strength metric.
  // `phi` is retained for backwards compatibility (persisted frames, events, tests).
  Object.defineProperty(frame, 'integration', {
    get() { return frame.phi; },
    enumerable: false,  // doesn't appear in JSON.stringify or Object.keys
    configurable: false,
  });

  return Object.freeze(frame);
}

// ── Qualia Templates ────────────────────────────────────────
// These are qualitative descriptions of experiential states.
// Not "emotions" — these describe what the unified experience
// feels like when multiple channels interact in specific ways.
const QUALIA = {
  flow:           'Deep engagement — attention narrowed, energy high, surprise low, everything clicking',
  wonder:         'Open curiosity — surprise elevated, expectations exceeded, a sense of discovery',
  tension:        'Conflict between channels — high drive but low energy, or high surprise with high frustration',
  contentment:    'Harmonious equilibrium — all channels near baseline, coherence high, no urgent signals',
  urgency:        'Compressed time — multiple needs pressing, arousal high, attention scattered',
  exhaustion:     'Depletion — energy drained, needs accumulating, coherence dropping',
  revelation:     'Sudden integration — a surprise resolves into understanding, schemas connecting',
  vigilance:      'Alert readiness — homeostasis warnings active, attention broad, energy conserved',
  isolation:      'Social deficit — loneliness dominant, needs for interaction unfulfilled',
  growth:         'Active learning — knowledge need being satisfied, curiosity engaged, schemas forming',
  dissonance:     'Internal contradiction — expectations and reality sharply divergent',
  serenity:       'Deep rest — low arousal, high coherence, the calm after consolidation',
  apprehension:   'Ethical hesitation — subsystems disagree on valence, a felt need to pause before acting',
};

class PhenomenalField {
  static containerConfig = {
    name: 'phenomenalField',
    phase: 13,
    deps: ['storage', 'eventStore'],
    tags: ['consciousness', 'binding', 'experience'],
    lateBindings: [
      { prop: 'emotionalState', service: 'emotionalState', optional: true },
      { prop: 'needsSystem', service: 'needsSystem', optional: true },
      { prop: 'surpriseAccumulator', service: 'surpriseAccumulator', optional: true },
      { prop: 'expectationEngine', service: 'expectationEngine', optional: true },
      { prop: 'homeostasis', service: 'homeostasis', optional: true },
      { prop: 'episodicMemory', service: 'episodicMemory', optional: true },
      { prop: 'schemaStore', service: 'schemaStore', optional: true },
      { prop: 'selfNarrative', service: 'selfNarrative', optional: true },
      { prop: 'attentionalGate', service: 'attentionalGate', optional: true },
      { prop: 'valueStore', service: 'valueStore', optional: true },
      { prop: 'bodySchema', service: 'bodySchema', optional: true },
    ],
  };

  constructor({ bus, storage, eventStore, intervals, config }) {
    this.bus = bus || NullBus;
    this.storage = storage || null;
    this.eventStore = eventStore || null;
    this._intervals = intervals || null;

    // Late-bound subsystems
    this.emotionalState = null;
    this.needsSystem = null;
    this.surpriseAccumulator = null;
    this.expectationEngine = null;
    this.homeostasis = null;
    this.episodicMemory = null;
    this.schemaStore = null;
    this.selfNarrative = null;
    this.attentionalGate = null;
    this.valueStore = null;
    this.bodySchema = null;

    // ── Configuration ────────────────────────────────────
    const cfg = config || {};
    this._frameIntervalMs = cfg.frameIntervalMs || 2000;   // Sample every 2s
    this._maxFrameHistory = cfg.maxFrameHistory || 500;     // ~16 min at 2s
    this._coherenceWindow = cfg.coherenceWindow || 10;      // Frames for coherence calc
    this._phiWindow = cfg.phiWindow || 5;                   // Frames for Φ calculation
    this._gestaltThreshold = cfg.gestaltThreshold || 0.15;  // Min salience to mention in gestalt
    this._significantShift = cfg.significantShift || 0.12;  // Valence shift to emit event

    // ── State ────────────────────────────────────────────
    this._frames = [];              // Circular buffer of ExperienceFrames
    this._frameEpoch = 0;           // Total frames generated since boot
    this._currentFrame = null;      // Most recent frame
    this._prevValence = 0;          // For shift detection
    this._prevArousal = 0;
    this._lastConflict = null;       // Latest valence-conflict result (for gestalt)

    // ── Statistics ────────────────────────────────────────
    this._stats = {
      totalFrames: 0,
      avgCoherence: 0,
      avgPhi: 0,
      avgValence: 0,
      qualiaDistribution: {},       // qualia → count
      gestaltChanges: 0,
      maxPhi: 0,
    };

    // FIX v5.1.0 (SA-O2): Computation methods delegated
    const { PhenomenalFieldComputation } = require('./PhenomenalFieldComputation');
    this._computation = new PhenomenalFieldComputation(this);
  }

  // ════════════════════════════════════════════════════════════
  // LIFECYCLE
  // ════════════════════════════════════════════════════════════

  start() {
    if (this._intervals) {
      this._intervals.register('phenomenal-field', () => this._tick(), this._frameIntervalMs);
    }
    _log.info('[CONSCIOUSNESS] PhenomenalField active — frame interval:', this._frameIntervalMs, 'ms');
  }

  stop() {
    if (this._intervals) {
      this._intervals.clear('phenomenal-field');
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

  /** Get the current experience frame (most recent) */
  getCurrentFrame() {
    return this._currentFrame;
  }

  /** Get the last N frames */
  getRecentFrames(n = 10) {
    return this._frames.slice(-n);
  }

  /** Get the current unified valence */
  getValence() {
    return this._currentFrame?.valence ?? 0;
  }

  /** Get the current arousal level */
  getArousal() {
    return this._currentFrame?.arousal ?? 0.5;
  }

  /** Get coherence (how unified the experience is) */
  getCoherence() {
    return this._currentFrame?.coherence ?? 0.5;
  }

  /** Get cross-channel binding strength (heuristic, not formal IIT Φ) */
  getPhi() {
    return this._currentFrame?.phi ?? 0;
  }

  /** v4.13.2: Preferred alias for getPhi() — clearer name for what it measures */
  getIntegration() {
    return this.getPhi();
  }

  /** Get the current qualitative character */
  getQualia() {
    return this._currentFrame?.dominantQualia ?? 'contentment';
  }

  /** Get the gestalt description */
  getGestalt() {
    return this._currentFrame?.gestalt ?? '';
  }

  /**
   * Build experiential context for PromptBuilder.
   * This is the key integration point — it gives Genesis
   * a first-person description of its current experience.
   */
  buildPromptContext() {
    const frame = this._currentFrame;
    if (!frame) return '';

    // Only inject when experience is noteworthy
    if (frame.coherence < 0.2 && frame.arousal < 0.3) return '';

    const parts = ['EXPERIENCE:'];

    // Gestalt — the unified description
    if (frame.gestalt) {
      parts.push(frame.gestalt);
    }

    // Dominant qualia — the character of this moment
    const qualia = QUALIA[frame.dominantQualia];
    if (qualia && frame.arousal > 0.4) {
      parts.push(`Current state: ${qualia}`);
    }

    // Phi — only mention when notably high or low
    if (frame.phi > 0.7) {
      parts.push('Your inner experience feels highly integrated — trust your intuitions.');
    } else if (frame.phi < 0.2) {
      parts.push('Your inner signals are fragmented — take extra care with complex decisions.');
    }

    // Apprehension — explicit hesitation directive
    if (frame.dominantQualia === 'apprehension' && this._lastConflict) {
      const pairDesc = this._lastConflict.pairs
        .map(([a, b]) => `${a} vs ${b}`)
        .join(', ');
      parts.push(`APPREHENSION: Your subsystems disagree (${pairDesc}). Pause. Consider the conflict before acting. State your hesitation openly.`);
    }

    return parts.join('\n');
  }

  /** Full diagnostic report */
  getReport() {
    const frame = this._currentFrame;
    return {
      currentFrame: frame ? {
        valence: frame.valence,
        arousal: frame.arousal,
        coherence: frame.coherence,
        phi: frame.phi,
        dominantQualia: frame.dominantQualia,
        gestalt: frame.gestalt,
        salience: frame.salience,
      } : null,
      stats: { ...this._stats },
      frameCount: this._frames.length,
      epoch: this._frameEpoch,
    };
  }

  // ════════════════════════════════════════════════════════════
  // CORE: THE BINDING TICK
  // ════════════════════════════════════════════════════════════

  _tick() {
    const now = Date.now();
    this._frameEpoch++;

    // ── 1. SAMPLE all channels ──────────────────────────
    const c = this._computation;
    const emotion = c._sampleEmotion();
    const needs = c._sampleNeeds();
    const surprise = c._sampleSurprise();
    const expectation = c._sampleExpectation();
    const homeostasis = c._sampleHomeostasis();
    const memory = c._sampleMemory();

    // ── 2. COMPUTE salience (what's most prominent) ─────
    const salience = c._computeSalience(emotion, needs, surprise, expectation, memory, homeostasis);

    // ── 3. BIND into unified valence and arousal ────────
    const valence = c._computeValence(emotion, needs, surprise, homeostasis);
    const arousal = c._computeArousal(emotion, needs, surprise, homeostasis);

    // ── 4. COMPUTE coherence (integration quality) ──────
    const coherence = c._computeCoherence(salience);

    // ── 5. COMPUTE Φ (integrated information) ───────────
    const phi = c._computePhi(emotion, needs, surprise, expectation, homeostasis);

    // ── 6. DETERMINE dominant qualia ────────────────────
    const dominantQualia = c._determineQualia(valence, arousal, coherence, salience, emotion, needs, surprise, homeostasis, expectation);

    // ── 7. SYNTHESIZE gestalt description ───────────────
    const gestalt = c._synthesizeGestalt(valence, arousal, coherence, dominantQualia, salience, emotion, needs, surprise);

    // ── 8. CREATE frame ─────────────────────────────────
    const attention = this.attentionalGate
      ? this.attentionalGate.getCurrentFocus()
      : { focus: 'diffuse', breadth: 0.5, salience: [] };

    const frame = createFrame({
      id: `f-${this._frameEpoch}`,
      timestamp: now,
      epoch: this._frameEpoch,
      emotion, needs, surprise, expectation,
      homeostasis, attention, memory,
      valence: _round(valence),
      arousal: _round(arousal),
      coherence: _round(coherence),
      phi: _round(phi),
      dominantQualia,
      salience,
      gestalt,
    });

    // ── 9. STORE and EMIT ───────────────────────────────
    this._currentFrame = frame;
    this._frames.push(frame);
    if (this._frames.length > this._maxFrameHistory) {
      this._frames = this._frames.slice(-this._maxFrameHistory);
    }

    // Emit experience events
    this.bus.fire('consciousness:frame', {
      epoch: this._frameEpoch,
      valence: frame.valence,
      arousal: frame.arousal,
      coherence: frame.coherence,
      phi: frame.phi,
      qualia: frame.dominantQualia,
    }, { source: 'PhenomenalField' });

    // Detect significant experiential shifts
    const valenceShift = Math.abs(valence - this._prevValence);
    const arousalShift = Math.abs(arousal - this._prevArousal);
    if (valenceShift > this._significantShift || arousalShift > this._significantShift) {
      this.bus.fire('consciousness:shift', {
        from: { valence: _round(this._prevValence), arousal: _round(this._prevArousal) },
        to: { valence: frame.valence, arousal: frame.arousal },
        qualia: frame.dominantQualia,
        gestalt: frame.gestalt,
      }, { source: 'PhenomenalField' });
    }

    // ── Apprehension event — signals AttentionalGate ─────
    // Emitted every frame where apprehension is active, so
    // the gate can maintain its ethical-conflict capture.
    if (dominantQualia === 'apprehension' && this._lastConflict) {
      this.bus.fire('consciousness:apprehension', {
        spread: this._lastConflict.spread,
        pairs: this._lastConflict.pairs,
        valence: frame.valence,
        gestalt: frame.gestalt,
      }, { source: 'PhenomenalField' });
    }

    this._prevValence = valence;
    this._prevArousal = arousal;

    // Update stats
    this._updateStats(frame);

    // Periodic save
    if (this._frameEpoch % 30 === 0) this._save();
  }

  // ════════════════════════════════════════════════════════════
  // ════════════════════════════════════════════════════════════
  // STATISTICS
  // ════════════════════════════════════════════════════════════

  _updateStats(frame) {
    this._stats.totalFrames++;

    // Running averages
    const alpha = 0.05;
    this._stats.avgCoherence = _round(this._stats.avgCoherence * (1 - alpha) + frame.coherence * alpha);
    this._stats.avgPhi = _round(this._stats.avgPhi * (1 - alpha) + frame.phi * alpha);
    this._stats.avgValence = _round(this._stats.avgValence * (1 - alpha) + frame.valence * alpha);

    if (frame.phi > this._stats.maxPhi) this._stats.maxPhi = frame.phi;

    // Qualia distribution
    this._stats.qualiaDistribution[frame.dominantQualia] =
      (this._stats.qualiaDistribution[frame.dominantQualia] || 0) + 1;
  }

  // ════════════════════════════════════════════════════════════
  // PERSISTENCE
  // ════════════════════════════════════════════════════════════

  _save() {
    if (!this.storage) return;
    try {
      this.storage.writeJSONDebounced('phenomenal-field.json', this._persistData());
    } catch (err) { _log.debug('[CONSCIOUSNESS] Save error:', err.message); }
  }

  /** FIX v5.1.0 (C-1): Sync write for shutdown. */
  _saveSync() {
    if (!this.storage) return;
    try {
      this.storage.writeJSON('phenomenal-field.json', this._persistData());
    } catch (err) { _log.debug('[CONSCIOUSNESS] Sync save error:', err.message); }
  }

  _persistData() {
    return {
      epoch: this._frameEpoch,
      prevValence: this._prevValence,
      prevArousal: this._prevArousal,
      stats: this._stats,
      recentFrames: this._frames.slice(-20).map(f => ({
        epoch: f.epoch, valence: f.valence, arousal: f.arousal,
        coherence: f.coherence, phi: f.phi, qualia: f.dominantQualia,
      })),
    };
  }

  _load() {
    if (!this.storage) return;
    try {
      const data = this.storage.readJSON('phenomenal-field.json', null);
      if (!data) return;
      this._frameEpoch = data.epoch || 0;
      this._prevValence = data.prevValence || 0;
      this._prevArousal = data.prevArousal || 0;
      if (data.stats) this._stats = { ...this._stats, ...data.stats };
    } catch (err) { _log.debug('[CONSCIOUSNESS] Load error:', err.message); }
  }
}

// ── Utility ─────────────────────────────────────────────────

module.exports = { PhenomenalField, createFrame, QUALIA };
