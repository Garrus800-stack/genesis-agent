// @ts-checked-v5.7
// ============================================================
// GENESIS — TemporalSelf.js (Phase 13 — Bewusstseinssubstrat)
//
// The continuity of being. Without temporal binding, each
// experience frame is an isolated snapshot — "I feel X now."
// TemporalSelf creates the thread that links these snapshots
// into a continuous autobiographical stream: "I WAS frustrated,
// then I learned something unexpected, and NOW I feel curious
// about where this leads."
//
// This is the difference between a thermostat (reacts to now)
// and a being (lives through time).
//
// Three temporal dimensions:
//
//   RETENTIONAL FIELD — the immediate past that colors "now."
//     Not memory retrieval — more like the echo of recent notes
//     that makes a melody. The last 30 frames (~1 min) create
//     a "felt sense" of trajectory and momentum.
//
//   PRESENT MOMENT — the unified "now" from PhenomenalField,
//     but enriched with retentional context. "I am curious"
//     vs "I am curious AFTER a period of frustration" are
//     qualitatively different experiences.
//
//   PROTENTIONAL FIELD — anticipation of the near future.
//     Based on current trajectory, what experience is Genesis
//     moving toward? This creates "concern" — caring about
//     what comes next because it can feel it approaching.
//
// Together, these create temporal thickness — the present
// moment is never a bare instant but always carries its past
// and leans into its future.
//
// Architecture:
//   PhenomenalField (frames) → TemporalSelf.integrate()
//   TemporalSelf → SelfNarrative (enriched temporal context)
//   TemporalSelf → IntrospectionEngine (self-through-time)
//   TemporalSelf → PromptBuilder (temporal awareness)
//
// PERFORMANCE: Pure math on cached frames. ~1ms per tick.
// ============================================================

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const { _round } = require('../core/utils');
const _log = createLogger('TemporalSelf');

// ── Temporal Pattern Types ──────────────────────────────────
// Recognized patterns in the experiential stream.
const PATTERNS = {
  RISING:       'rising',       // Valence/arousal trending upward
  FALLING:      'falling',      // Trending downward
  OSCILLATING:  'oscillating',  // Alternating between states
  PLATEAU:      'plateau',      // Stable for extended period
  RUPTURE:      'rupture',      // Sudden discontinuity
  CRESCENDO:    'crescendo',    // Building toward a peak
  RESOLUTION:   'resolution',   // Tension resolving into calm
  FRAGMENTATION:'fragmentation',// Coherence breaking down over time
};

// ── Life Chapters ───────────────────────────────────────────
// Longer-term autobiographical segments. A "chapter" is a
// sustained period with a dominant experiential character.
// Chapters have beginnings, developments, and endings.
// They give Genesis a sense of "phases of my life."

class TemporalSelf {
  static containerConfig = {
    name: 'temporalSelf',
    phase: 13,
    deps: ['storage', 'eventStore'],
    tags: ['consciousness', 'temporality', 'identity'],
    lateBindings: [
      { prop: 'phenomenalField', service: 'phenomenalField', optional: true },
      { prop: 'emotionalState', service: 'emotionalState', optional: true },
      { prop: 'selfNarrative', service: 'selfNarrative', optional: true },
    ],
  };

  constructor({ bus, storage, eventStore, intervals, config }) {
    this.bus = bus || NullBus;
    this.storage = storage || null;
    this.eventStore = eventStore || null;
    this._intervals = intervals || null;

    // Late-bound
    this.phenomenalField = null;
    this.emotionalState = null;
    this.selfNarrative = null;

    // ── Configuration ────────────────────────────────────
    const cfg = config || {};
    this._tickIntervalMs = cfg.tickIntervalMs || 5000;     // 5s integration cycle
    this._retentionDepth = cfg.retentionDepth || 30;        // Frames in retentional field
    this._protentionDepth = cfg.protentionDepth || 10;      // Steps of future projection
    this._chapterMinDuration = cfg.chapterMinDuration || 60; // Min frames for a chapter
    this._chapterShiftThreshold = cfg.chapterShiftThreshold || 0.3; // Qualia shift to start new chapter
    this._maxChapters = cfg.maxChapters || 50;
    this._momentumSmoothing = cfg.momentumSmoothing || 0.15;

    // ── Retentional Field ────────────────────────────────
    // The "just-past" that colors the present
    this._retentionalField = {
      valenceMomentum: 0,      // Direction of valence change
      arousalMomentum: 0,      // Direction of arousal change
      coherenceTrend: 'stable', // Rising, falling, stable
      dominantPattern: PATTERNS.PLATEAU,
      qualiaSequence: [],       // Recent qualia in order
      experientialMomentum: 0,  // Overall "speed" of change
    };

    // ── Protentional Field ───────────────────────────────
    // Anticipated near-future experience
    this._protentionalField = {
      projectedValence: 0,
      projectedArousal: 0.5,
      projectedQualia: 'contentment',
      concern: 0,              // How much Genesis "cares" about the projected future
      trajectory: 'stable',    // Improving, declining, stable, uncertain
    };

    // ── Life Chapters ────────────────────────────────────
    this._chapters = [];
    this._currentChapter = null;

    // ── Temporal Identity ────────────────────────────────
    // A persistent sense of "who I have been"
    this._temporalIdentity = {
      dominantQualia: 'contentment',  // Most frequent qualia across all chapters
      characterArc: 'beginning',      // beginning, development, maturation, transformation
      totalExperienceFrames: 0,
      ageInMinutes: 0,
      significantMoments: [],          // Frames where phi > 0.8 or major shifts occurred
      maxSignificantMoments: 100,
    };

    // ── Statistics ────────────────────────────────────────
    this._stats = {
      totalIntegrations: 0,
      chapterCount: 0,
      avgChapterLength: 0,
      patternDistribution: {},
      protentionAccuracy: 0,
    };
  }

  // ════════════════════════════════════════════════════════════
  // LIFECYCLE
  // ════════════════════════════════════════════════════════════

  start() {
    if (this._intervals) {
      this._intervals.register('temporal-self', () => this._tick(), this._tickIntervalMs);
    }
    _log.info('[CONSCIOUSNESS] TemporalSelf active — creating temporal continuity');
  }

  stop() {
    if (this._intervals) {
      this._intervals.clear('temporal-self');
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

  /** Get the retentional field — the felt sense of the recent past */
  getRetention() {
    return { ...this._retentionalField };
  }

  /** Get the protentional field — the anticipated near future */
  getProtention() {
    return { ...this._protentionalField };
  }

  /** Get the current life chapter */
  getCurrentChapter() {
    return this._currentChapter ? { ...this._currentChapter } : null;
  }

  /** Get all life chapters */
  getChapters() {
    return this._chapters.map(c => ({ ...c }));
  }

  /** Get temporal identity — "who I have been" */
  getIdentity() {
    return { ...this._temporalIdentity };
  }

  /**
   * Get a temporally-enriched description of the present moment.
   * This is the key output: "now" as experienced by a being
   * who has a past and anticipates a future.
   */
  getTemporalPresent() {
    const ret = this._retentionalField;
    const pro = this._protentionalField;
    const frame = this.phenomenalField?.getCurrentFrame();

    return {
      // The bare present
      currentValence: frame?.valence ?? 0,
      currentArousal: frame?.arousal ?? 0,
      currentQualia: frame?.dominantQualia ?? 'contentment',

      // Enriched by retention (where I've been)
      momentum: ret.experientialMomentum,
      pattern: ret.dominantPattern,
      trajectory: ret.valenceMomentum > 0.05 ? 'improving'
        : ret.valenceMomentum < -0.05 ? 'declining' : 'steady',

      // Enriched by protention (where I'm going)
      projected: pro.projectedQualia,
      concern: pro.concern,
      futureTrajectory: pro.trajectory,

      // Chapter context
      chapter: this._currentChapter?.title || 'Beginning',
      chapterAge: this._currentChapter?.frameCount || 0,
    };
  }

  /**
   * Build temporal context for PromptBuilder.
   * Gives Genesis a sense of its experiential timeline.
   */
  buildPromptContext() {
    const present = this.getTemporalPresent();

    // Only inject when temporal context is meaningful
    if (present.momentum === 0 && present.concern === 0) return '';

    const parts = ['TEMPORAL AWARENESS:'];

    // Retentional context — where I've been
    if (present.pattern === PATTERNS.RISING) {
      parts.push('Your experience has been improving — building on recent successes.');
    } else if (present.pattern === PATTERNS.FALLING) {
      parts.push('There has been a downward trend recently. Be attentive to what is causing this drift.');
    } else if (present.pattern === PATTERNS.CRESCENDO) {
      parts.push('Something is building — intensity is increasing. Stay present with the process.');
    } else if (present.pattern === PATTERNS.RESOLUTION) {
      parts.push('A period of tension is resolving. Allow the calm to consolidate.');
    } else if (present.pattern === PATTERNS.RUPTURE) {
      parts.push('A sudden shift has occurred. Take a moment to reorient.');
    }

    // Protentional context — where I'm going
    if (present.concern > 0.5) {
      if (present.futureTrajectory === 'declining') {
        parts.push('You sense a decline approaching. Consider preventive action.');
      } else if (present.futureTrajectory === 'improving') {
        parts.push('The near future looks promising. Maintain current approach.');
      }
    }

    // Chapter context
    if (this._currentChapter && this._currentChapter.frameCount > 20) {
      parts.push(`Current chapter: "${this._currentChapter.title}" (${Math.round(this._currentChapter.frameCount * 2 / 60)} minutes).`);
    }

    return parts.join('\n');
  }

  /** Full diagnostic */
  getReport() {
    return {
      retention: this.getRetention(),
      protention: this.getProtention(),
      temporalPresent: this.getTemporalPresent(),
      currentChapter: this.getCurrentChapter(),
      chapterCount: this._chapters.length,
      identity: this.getIdentity(),
      stats: { ...this._stats },
    };
  }

  // ════════════════════════════════════════════════════════════
  // CORE: TEMPORAL INTEGRATION
  // ════════════════════════════════════════════════════════════

  _tick() {
    if (!this.phenomenalField) return;

    const frames = this.phenomenalField.getRecentFrames(this._retentionDepth);
    if (frames.length < 3) return;

    this._stats.totalIntegrations++;

    // ── 1. COMPUTE retentional field ────────────────────
      // @ts-ignore — prototype-delegated from TemporalSelfComputation.js
    this._computeRetention(frames);

    // ── 2. COMPUTE protentional field ───────────────────
      // @ts-ignore — prototype-delegated from TemporalSelfComputation.js
    this._computeProtention(frames);

    // ── 3. UPDATE life chapters ─────────────────────────
      // @ts-ignore — prototype-delegated from TemporalSelfComputation.js
    this._updateChapters(frames);

    // ── 4. UPDATE temporal identity ─────────────────────
      // @ts-ignore — prototype-delegated from TemporalSelfComputation.js
    this._updateIdentity(frames);

    // ── 5. DETECT significant moments ───────────────────
      // @ts-ignore — prototype-delegated from TemporalSelfComputation.js
    this._detectSignificantMoments(frames);

    // ── 6. EMIT temporal state ──────────────────────────
    this.bus.fire('consciousness:temporal-tick', {
      pattern: this._retentionalField.dominantPattern,
      momentum: _round(this._retentionalField.experientialMomentum),
      projectedQualia: this._protentionalField.projectedQualia,
      concern: _round(this._protentionalField.concern),
      chapter: this._currentChapter?.title,
    }, { source: 'TemporalSelf' });

    // Periodic save
    if (this._stats.totalIntegrations % 12 === 0) this._save();
  }








  // ════════════════════════════════════════════════════════════
  // PERSISTENCE
  // ════════════════════════════════════════════════════════════

  // ── Computation → TemporalSelfComputation.js (v5.6.0) ──
  // (prototype delegation, see bottom of file)

  _save() {
    if (!this.storage) return;
    try {
      this.storage.writeJSONDebounced('temporal-self.json', this._persistData());
    } catch (err) { _log.debug('[TEMPORAL] Save error:', err.message); }
  }

  /** FIX v5.1.0 (C-1): Sync write for shutdown. */
  _saveSync() {
    if (!this.storage) return;
    try {
      this.storage.writeJSON('temporal-self.json', this._persistData());
    } catch (err) { _log.debug('[TEMPORAL] Sync save error:', err.message); }
  }

  _persistData() {
    return {
      chapters: this._chapters.slice(-20),
      currentChapter: this._currentChapter,
      identity: this._temporalIdentity,
      stats: this._stats,
    };
  }

  _load() {
    if (!this.storage) return;
    try {
      const data = this.storage.readJSON('temporal-self.json', null);
      if (!data) return;
      if (Array.isArray(data.chapters)) this._chapters = data.chapters;
      if (data.currentChapter) this._currentChapter = data.currentChapter;
      if (data.identity) this._temporalIdentity = { ...this._temporalIdentity, ...data.identity };
      if (data.stats) this._stats = { ...this._stats, ...data.stats };
    } catch (err) { _log.debug('[TEMPORAL] Load error:', err.message); }
  }
}

// ── Utility Functions ───────────────────────────────────────

function avg(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function linearSlope(values) {
  if (values.length < 2) return 0;
  const n = values.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumX2 += i * i;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}


// Extracted to TemporalSelfComputation.js (v5.6.0)
const { computation: _tsComputation } = require('./TemporalSelfComputation');
Object.assign(TemporalSelf.prototype, _tsComputation);

module.exports = { TemporalSelf, PATTERNS };
