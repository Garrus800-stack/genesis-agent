// ============================================================
// GENESIS — SurpriseAccumulator.js (Phase 9 — Cognitive Architecture)
//
// The learning amplifier. Collects SurpriseSignals from
// ExpectationEngine.compare() and modulates how strongly
// Genesis learns from each experience.
//
// Core insight: the human brain learns most when reality
// diverges from expectation. A predicted outcome barely
// registers. A shocking outcome rewires the network.
//
// SurpriseAccumulator does this for Genesis:
//   - Low surprise (< 0.3)    → 1× learning weight (normal)
//   - Medium surprise (0.3-0.8) → 1.5× learning weight
//   - High surprise (0.8-1.5)   → 2.5× weight + episodic mark
//   - Novel surprise (≥ 1.5)    → 4× weight + reflection trigger
//
// Integration (all event-based — no direct coupling):
//   'expectation:compared'      → _processSurprise() (input)
//   'surprise:amplified-learning' → MetaLearning listens (output)
//   'surprise:processed'        → EmotionalState listens (output)
//   'surprise:novel-event'      → IdleMind/DreamCycle listens (output)
// ============================================================

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const { applySubscriptionHelper } = require('../core/subscription-helper');
const _log = createLogger('SurpriseAccumulator');

class SurpriseAccumulator {
  constructor({ bus, episodicMemory, eventStore, storage, intervals, config }) {
    this.bus = bus || NullBus;
    this.episodicMemory = episodicMemory || null;
    this.eventStore = eventStore || null;
    this.storage = storage || null;
    this._intervals = intervals || null;

    // ── Configuration ────────────────────────────────────
    const cfg = config || {};
    this._noveltyThreshold = cfg.noveltyThreshold || 1.5;
    this._significantThreshold = cfg.significantThreshold || 0.8;
    this._maxBuffer = cfg.maxBuffer || 500;
    this._emaAlpha = cfg.emaAlpha || 0.1;

    // ── Learning Multipliers ─────────────────────────────
    this._multipliers = {
      low:    cfg.multiplierLow || 1.0,     // surprise < 0.3
      medium: cfg.multiplierMedium || 1.5,  // 0.3 ≤ surprise < 0.8
      high:   cfg.multiplierHigh || 2.5,    // 0.8 ≤ surprise < 1.5
      novel:  cfg.multiplierNovel || 4.0,   // surprise ≥ 1.5
    };

    // ── Surprise Buffer (rolling window) ─────────────────
    this._buffer = [];

    // ── Running Statistics ────────────────────────────────
    this._stats = {
      totalSignals: 0,
      avgSurprise: 0.5,         // EMA of totalSurprise
      avgPositiveSurprise: 0.3, // EMA of positive surprises
      avgNegativeSurprise: 0.5, // EMA of negative surprises
      surpriseTrend: 'stable',  // rising | falling | stable
      novelEventCount: 0,
      highSurpriseCount: 0,
    };

    // ── Rate Limiting ────────────────────────────────────
    // Prevent event storms during rapid execution
    this._lastEventAt = 0;
    this._minEventIntervalMs = 200; // Max ~5 events/sec

    // v7.3.6 patch: track bus subscriptions for clean shutdown
    this._unsubs = [];
  }

  // ════════════════════════════════════════════════════════
  // LIFECYCLE
  // ════════════════════════════════════════════════════════

  async asyncLoad() {
    if (!this.storage) return;
    try {
      const data = this.storage.readJSON('surprise-stats.json', null);
      if (data && data.stats) {
        this._stats = { ...this._stats, ...data.stats };
      }
    } catch (_e) { _log.debug('[catch] surprise stats load:', _e.message); }
  }

  start() {
    this._sub('expectation:compared', (signal) => {
      this._processSurprise(signal);
    }, { source: 'SurpriseAccumulator' });
  }

  stop() {
    // v7.3.6 patch: unsubscribe tracked bus listeners
    this._unsubAll();
    // FIX D-1: Sync write on shutdown.
    this._saveSync();
  }

  // ════════════════════════════════════════════════════════
  // CORE PROCESSING
  // ════════════════════════════════════════════════════════

  _processSurprise(signal) {
    if (!signal || typeof signal.totalSurprise !== 'number') return;

    // Add to buffer
    this._buffer.push({
      totalSurprise: signal.totalSurprise,
      valence: signal.valence,
      actionType: signal.actionType,
      timestamp: signal.timestamp || Date.now(),
    });
    if (this._buffer.length > this._maxBuffer) {
      this._buffer = this._buffer.slice(-this._maxBuffer);
    }

    this._stats.totalSignals++;

    // Update EMAs
    this._stats.avgSurprise = this._ema(this._stats.avgSurprise, signal.totalSurprise);
    if (signal.valence === 'positive') {
      this._stats.avgPositiveSurprise = this._ema(this._stats.avgPositiveSurprise, signal.totalSurprise);
    } else {
      this._stats.avgNegativeSurprise = this._ema(this._stats.avgNegativeSurprise, signal.totalSurprise);
    }

    // Calculate learning multiplier
    const multiplier = this._getMultiplier(signal.totalSurprise);

    // ── 1. Emit amplified learning signal ────────────────
    if (multiplier > this._multipliers.low && this._canEmit()) {
      this.bus.emit('surprise:amplified-learning', {
        actionType: signal.actionType || 'unknown',
        model: signal.model || 'unknown',
        multiplier,
        valence: signal.valence,
        surprise: signal.totalSurprise,
      }, { source: 'SurpriseAccumulator' });
    }

    // ── 2. Mark episodic memory for significant surprises ──
    if (signal.totalSurprise >= this._significantThreshold) {
      this._stats.highSurpriseCount++;
      this._markEpisodicMemory(signal, multiplier);
    }

    // ── 3. Trigger reflection for truly novel events ─────
    if (signal.totalSurprise >= this._noveltyThreshold) {
      this._stats.novelEventCount++;
      this._triggerNoveltyReflection(signal);
    }

    // ── 4. Update surprise trend ─────────────────────────
    this._updateTrend();

    // ── 5. Emit processed signal ─────────────────────────
    if (this._canEmit()) {
      this.bus.emit('surprise:processed', {
        totalSurprise: signal.totalSurprise,
        valence: signal.valence,
        multiplier,
        trend: this._stats.surpriseTrend,
        actionType: signal.actionType,
      }, { source: 'SurpriseAccumulator' });
    }

    // Periodic save
    if (this._stats.totalSignals % 50 === 0) {
      this._save();
    }
  }

  // ════════════════════════════════════════════════════════
  // LEARNING MULTIPLIER
  // ════════════════════════════════════════════════════════

  _getMultiplier(totalSurprise) {
    if (totalSurprise >= this._noveltyThreshold) return this._multipliers.novel;
    if (totalSurprise >= this._significantThreshold) return this._multipliers.high;
    if (totalSurprise >= 0.3) return this._multipliers.medium;
    return this._multipliers.low;
  }

  // ════════════════════════════════════════════════════════
  // EPISODIC MEMORY INTEGRATION
  // ════════════════════════════════════════════════════════

  _markEpisodicMemory(signal, multiplier) {
    if (!this.episodicMemory) return;

    try {
      const expected = signal.expected || {};
      const actual = signal.actual || {};

      this.episodicMemory.recordEpisode({
        type: 'surprise',
        summary: `${signal.valence} surprise during ${signal.actionType || 'action'}: ` +
                 `expected ${((expected.successProb || 0) * 100).toFixed(0)}% success, ` +
                 `got ${actual.success ? 'success' : 'failure'} ` +
                 `(surprise: ${signal.totalSurprise.toFixed(2)}, ×${multiplier})`,
        emotionalWeight: Math.min(signal.totalSurprise / 2, 1.0),
        tags: ['surprise', signal.valence, signal.actionType].filter(Boolean),
        metadata: {
          surprise: signal.totalSurprise,
          multiplier,
          valence: signal.valence,
          actionType: signal.actionType,
          expected: expected.successProb,
          actual: actual.success,
        },
      });
    } catch (err) {
      _log.debug('[SURPRISE] Failed to record episode:', err.message);
    }
  }

  // ════════════════════════════════════════════════════════
  // NOVELTY REFLECTION
  // ════════════════════════════════════════════════════════

  _triggerNoveltyReflection(signal) {
    this.bus.emit('surprise:novel-event', {
      summary: `Highly unexpected ${signal.valence} outcome ` +
               `for ${signal.actionType || 'action'} ` +
               `(surprise: ${signal.totalSurprise.toFixed(2)})`,
      surprise: signal.totalSurprise,
      valence: signal.valence,
      actionType: signal.actionType,
    }, { source: 'SurpriseAccumulator' });

    // Log to EventStore for DreamCycle to pick up later
    if (this.eventStore) {
      this.eventStore.append('SURPRISE_NOVEL', {
        surprise: signal.totalSurprise,
        valence: signal.valence,
        actionType: signal.actionType,
      }, 'SurpriseAccumulator');
    }
  }

  // ════════════════════════════════════════════════════════
  // TREND DETECTION
  // ════════════════════════════════════════════════════════

  _updateTrend() {
    if (this._buffer.length < 10) {
      this._stats.surpriseTrend = 'stable';
      return;
    }

    // Compare last 10 vs previous 10
    const recent = this._buffer.slice(-10);
    const previous = this._buffer.slice(-20, -10);

    if (previous.length < 5) {
      this._stats.surpriseTrend = 'stable';
      return;
    }

    const recentAvg = recent.reduce((s, b) => s + b.totalSurprise, 0) / recent.length;
    const prevAvg = previous.reduce((s, b) => s + b.totalSurprise, 0) / previous.length;

    const delta = recentAvg - prevAvg;
    if (delta > 0.2) {
      this._stats.surpriseTrend = 'rising';
    } else if (delta < -0.2) {
      this._stats.surpriseTrend = 'falling';
    } else {
      this._stats.surpriseTrend = 'stable';
    }
  }

  // ════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════

  /** Current calibration proxy — delegates to ExpectationEngine if wired */
  getCalibration() {
    // This is available via the ExpectationEngine directly.
    // SurpriseAccumulator tracks trend, not calibration.
    return this._stats.avgSurprise < 0.5 ? 0.8 : 0.5; // rough proxy
  }

  /** Is Genesis in a high-surprise period? */
  isHighSurprisePeriod() {
    return this._stats.avgSurprise > this._significantThreshold;
  }

  /** Get the learning multiplier for the current average surprise level */
  getCurrentMultiplier() {
    return this._getMultiplier(this._stats.avgSurprise);
  }

  /** Get current surprise trend */
  getTrend() {
    return this._stats.surpriseTrend;
  }

  /** Get buffer size (for DreamCycle to know if there's material to process) */
  getBufferSize() {
    return this._buffer.length;
  }

  /** Get recent buffer entries (for DreamCycle analysis) */
  getRecentSignals(count = 20) {
    return this._buffer.slice(-count);
  }

  getStats() {
    return {
      ...this._stats,
      bufferSize: this._buffer.length,
      currentMultiplier: this.getCurrentMultiplier(),
    };
  }

  // ════════════════════════════════════════════════════════
  // UTILITIES
  // ════════════════════════════════════════════════════════

  _ema(current, newValue) {
    return current * (1 - this._emaAlpha) + newValue * this._emaAlpha;
  }

  _canEmit() {
    const now = Date.now();
    if (now - this._lastEventAt < this._minEventIntervalMs) return false;
    this._lastEventAt = now;
    return true;
  }

  _save() {
    if (!this.storage) return;
    try {
      this.storage.writeJSONDebounced('surprise-stats.json', this._saveData(), 5000);
    } catch (_e) { _log.debug('[catch] surprise persist:', _e.message); }
  }

  /** FIX D-1: Sync write for shutdown path. */
  _saveSync() {
    if (!this.storage) return;
    try {
      this.storage.writeJSON('surprise-stats.json', this._saveData());
    } catch (_e) { _log.debug('[catch] surprise sync persist:', _e.message); }
  }

  /** @private Shared payload for both save paths. */
  _saveData() {
    return {
      stats: this._stats,
      savedAt: Date.now(),
    };
  }
}

// v7.3.6 patch: apply subscription-helper mixin
applySubscriptionHelper(SurpriseAccumulator, { defaultSource: 'SurpriseAccumulator' });

module.exports = { SurpriseAccumulator };
