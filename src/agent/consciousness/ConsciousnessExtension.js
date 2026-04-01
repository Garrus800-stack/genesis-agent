// @ts-checked-v5.8
/**
 * ConsciousnessExtension.js
 * ─────────────────────────
 * Master orchestrator that wires all four subsystems into one closed loop:
 *
 *   Perception → Prediction → Surprise → Emotion → Attention → Perception
 *
 * Designed as a drop-in module for the Genesis Agent PhenomenalField.
 *
 * @version 1.0.0
 * @author  Genesis Consciousness Architecture
 */

'use strict';

const EchoicMemory        = require('./EchoicMemory');
const PredictiveCoder      = require('./PredictiveCoder');
const NeuroModulatorSystem = require('./NeuroModulatorSystem');
const AttentionalGate      = require('./SalienceGate');
const DreamEngine          = require('./DreamEngine');
const ConsciousnessState   = require('./ConsciousnessState');
const EventEmitter         = require('events');

/**
 * @typedef {Object} ConsciousnessConfig
 * @property {number}  [tickIntervalMs=500]        - Sliding window tick rate
 * @property {number}  [keyframeIntervalMs=2000]    - Persistence keyframe interval
 * @property {number}  [daydreamThresholdMs=300000] - 5 min low-load → daydream
 * @property {number}  [deepSleepThresholdMs=900000]- 15 min inactivity → deep sleep
 * @property {number}  [hypervigilantTimeoutMs=30000]- Auto-exit hypervigilant
 * @property {number}  [surpriseSpikeThreshold=2.5] - Surprise level to trigger hypervigilance
 * @property {boolean} [liteMode=false]             - Reduced polling for consumer hardware
 * @property {Object}  [echoic]                     - EchoicMemory config overrides
 * @property {Object}  [predictor]                  - PredictiveCoder config overrides
 * @property {Object}  [emotion]                    - NeuroModulatorSystem config overrides
 * @property {Object}  [attention]                  - AttentionalGate config overrides
 * @property {Object}  [dream]                      - DreamEngine config overrides
 */

/**
 * Lite-mode preset for consumer hardware (Intel iGPU, shared RAM, Ollama running).
 * v4.12.1 [P3-01]: Reduces background CPU load by ~75% by slowing polling and
 * disabling LLM-backed DreamEngine consolidation.
 *
 *   tickIntervalMs:      500  → 2000   (-75% timer firings)
 *   keyframeIntervalMs:  2000 → 10000  (-80% keyframe writes)
 *   dream.llmEnabled:    true → false  (no background LLM calls during sleep)
 *   daydreamThreshold:   5min → 10min  (less aggressive state transitions)
 */
const LITE_PRESETS = {
  tickIntervalMs:         2000,
  keyframeIntervalMs:     10_000,
  daydreamThresholdMs:    600_000,   // 10 min (up from 5)
  deepSleepThresholdMs:   1_800_000, // 30 min (up from 15)
  dream: { llmEnabled: false },
};

const DEFAULT_CONFIG = {
  tickIntervalMs:          500,
  keyframeIntervalMs:      2000,
  daydreamThresholdMs:     300_000,   // 5 min
  deepSleepThresholdMs:    900_000,   // 15 min
  hypervigilantTimeoutMs:  30_000,    // 30 sec
  surpriseSpikeThreshold:  2.5,
  liteMode:    false,
  echoic:    {},
  predictor: {},
  emotion:   {},
  attention: {},
  dream:     {},
};

class ConsciousnessExtension extends EventEmitter {

  /**
   * @param {ConsciousnessConfig} config
   * @param {Object} [dependencies] - External dependencies (LLM adapter, persistence, etc.)
   * @param {Function} [dependencies.llmCall] - async (prompt) => string
   * @param {Function} [dependencies.persistFrame] - async (frame) => void
   * @param {Function} [dependencies.loadSelfTheory] - async () => Object
   * @param {Function} [dependencies.saveSelfTheory] - async (theory) => void
   */
  constructor(config = {}, dependencies = {}) {
    super();
    // v4.12.1 [P3-01]: Merge lite presets first so explicit config values
    // can still override individual lite-mode settings.
    const baseConfig = config.liteMode
      ? { ...DEFAULT_CONFIG, ...LITE_PRESETS }
      : { ...DEFAULT_CONFIG };
    this.config = { ...baseConfig, ...config };
    // Deep-merge sub-configs (echoic, predictor, emotion, attention, dream)
    for (const key of ['echoic', 'predictor', 'emotion', 'attention', 'dream']) {
      this.config[key] = { ...(baseConfig[key] || {}), ...(config[key] || {}) };
    }
    this.deps   = dependencies;

    // ── Subsystems ──────────────────────────────────────────────
    this.echoic    = new EchoicMemory(this.config.echoic);
    this.predictor = new PredictiveCoder(this.config.predictor);
    this.emotion   = new NeuroModulatorSystem(this.config.emotion);
    this.attention = new AttentionalGate(this.config.attention);
    this.dream     = new DreamEngine(this.config.dream, {
      llmCall:        dependencies.llmCall        || undefined,
      loadSelfTheory: dependencies.loadSelfTheory || undefined,
      saveSelfTheory: dependencies.saveSelfTheory  || undefined,
    });

    // ── State machine ───────────────────────────────────────────
    this.state = new ConsciousnessState();
    /** @type {string | null} */ this._cachedChapter = null;

    // ── Timing ──────────────────────────────────────────────────
    this._tickTimer     = null;
    this._keyframeTimer = null;
    this._lastInputTime = Date.now();
    this._lastTickTime  = Date.now();
    this._lowLoadStart  = null;

    // ── Frame accumulator for dream consolidation ───────────────
    this._dayFrames       = [];
    this._peripheralLog   = [];
    this._maxDayFrames    = 2000;
  }

  // ═══════════════════════════════════════════════════════════════
  // LIFECYCLE
  // ═══════════════════════════════════════════════════════════════

  /**
   * Start the consciousness loop.
   */
  start() {
    if (this._tickTimer) return;

    this._lastTickTime = Date.now();
    this._lastInputTime = Date.now();

    this._tickTimer = setInterval(
      () => this._onTick(),
      this.config.tickIntervalMs
    );

    this._keyframeTimer = setInterval(
      () => this._onKeyframe(),
      this.config.keyframeIntervalMs
    );

    this.state.transition('AWAKE');
    this.emit('started');
    this.emit('state-change', this.state.current);
  }

  /**
   * Stop the consciousness loop gracefully.
   */
  stop() {
    if (this._tickTimer) {
      clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
    if (this._keyframeTimer) {
      clearInterval(this._keyframeTimer);
      this._keyframeTimer = null;
    }
    this.emit('stopped');
  }

  // ═══════════════════════════════════════════════════════════════
  // PRIMARY INPUT  —  called externally by PhenomenalField
  // ═══════════════════════════════════════════════════════════════

  /**
   * Ingest a raw perceptual frame from the PhenomenalField sampler.
   *
   * @param {Object} rawFrame - The raw frame data with channel values
   * @param {Object} rawFrame.channels - Key-value map of channel readings
   *   e.g. { 'system-health': 0.95, 'user-engagement': 0.6, ... }
   * @param {number} [rawFrame.timestamp] - Unix ms, defaults to now
   * @returns {Object} processedResult - The full processing result
   */
  ingestFrame(rawFrame) {
    const now = Date.now();
    const dt  = now - this._lastTickTime;

    rawFrame.timestamp = rawFrame.timestamp || now;
    this._lastInputTime = now;

    // If we were sleeping, wake up
    if (this.state.current === 'DEEP_SLEEP' || this.state.current === 'DAYDREAM') {
      this._wakeUp();
    }

    // ── 1. Echoic Memory: smooth the frame ──────────────────
    const surprise = this._getAggregateSurprise();
    const adaptiveAlpha = this.echoic.computeAdaptiveAlpha(surprise);
    const smoothedFrame = this.echoic.blend(rawFrame, adaptiveAlpha);

    // ── 2. Predictive Coder: compute surprise per channel ───
    const emotionalState = this.emotion.getState();
    const learningRate   = this.predictor.computeAdaptiveLR(emotionalState.valenceEffective);
    const predictions    = this.predictor.update(smoothedFrame.channels, dt, learningRate);

    // ── 3. Neuro-Modulators: feed surprise into emotion ─────
    const aggregateSurprise = predictions.aggregateSurprise;
    this.emotion.tick(dt, {
      surprise:   aggregateSurprise,
      valence:    this._inferValence(smoothedFrame, predictions),
      arousal:    aggregateSurprise,
    });

    // ── 4. Attentional Gate: route with salience map ────────
    const currentChapter = this._getCurrentLifeChapter();
    const attentionResult = this.attention.process(
      predictions.channels,
      currentChapter,
      this.state.current
    );

    // ── 5. State machine transitions ────────────────────────
    this._evaluateStateTransitions(aggregateSurprise, attentionResult);

    // ── 6. Accumulate for dreams ────────────────────────────
    this._accumulateForDream(smoothedFrame, predictions, attentionResult);

    // ── Build result ────────────────────────────────────────
    const result = {
      timestamp:      now,
      state:          this.state.current,
      gestalt:        smoothedFrame,
      predictions,
      emotion:        this.emotion.getState(),
      attention:      attentionResult,
      adaptiveAlpha,
      learningRate,
    };

    this.emit('frame-processed', result);
    return result;
  }

  /**
   * Notify the system that user interaction occurred (resets inactivity timers).
   */
  notifyUserInput() {
    this._lastInputTime = Date.now();
    if (this.state.current !== 'AWAKE' && this.state.current !== 'HYPERVIGILANT') {
      this._wakeUp();
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // INTERNAL TICK  —  runs at tickIntervalMs
  // ═══════════════════════════════════════════════════════════════

  /** @private */
  _onTick() {
    const now = Date.now();
    const dt  = now - this._lastTickTime;
    this._lastTickTime = now;

    // Decay emotions even without new frames
    this.emotion.tick(dt, null);

    // Check for inactivity-driven state transitions
    const timeSinceInput = now - this._lastInputTime;

    if (this.state.current === 'AWAKE') {
      // Check cognitive load for daydream entry
      const load = this.attention.getCognitiveLoad();
      if (load < 0.3) {
        if (!this._lowLoadStart) {
          this._lowLoadStart = now;
        } else if (now - this._lowLoadStart >= this.config.daydreamThresholdMs) {
          this._enterDaydream();
        }
      } else {
        this._lowLoadStart = null;
      }

      // Check for deep sleep
      if (timeSinceInput >= this.config.deepSleepThresholdMs) {
        this._enterDeepSleep();
      }
    }

    if (this.state.current === 'DAYDREAM') {
      // In daydream, reflect on peripheral signals
      this._daydreamReflect();

      if (timeSinceInput >= this.config.deepSleepThresholdMs) {
        this._enterDeepSleep();
      }
    }

    // Hypervigilant auto-timeout
    if (this.state.current === 'HYPERVIGILANT') {
      if (now - this.state.enteredAt >= this.config.hypervigilantTimeoutMs) {
        this.state.transition('AWAKE');
        this.echoic.resetAlphaOverride();
        this.emit('state-change', 'AWAKE');
      }
    }
  }

  /** @private */
  _onKeyframe() {
    if (this.state.current === 'DEEP_SLEEP') return;

    const keyframe = {
      timestamp: Date.now(),
      gestalt:   this.echoic.getCurrentGestalt(),
      emotion:   this.emotion.getState(),
      attention: this.attention.getSnapshot(),
      state:     this.state.current,
    };

    if (this.deps.persistFrame) {
      this.deps.persistFrame(keyframe).catch(err => {
        this.emit('error', { source: 'keyframe-persist', error: err });
      });
    }

    this.emit('keyframe', keyframe);
  }

  // ═══════════════════════════════════════════════════════════════
  // STATE TRANSITIONS
  // ═══════════════════════════════════════════════════════════════

  /** @private */
  _evaluateStateTransitions(aggregateSurprise, attentionResult) {
    // Surprise spike → Hypervigilant
    if (aggregateSurprise > this.config.surpriseSpikeThreshold &&
        this.state.current !== 'HYPERVIGILANT') {
      this._enterHypervigilant();
      return;
    }
  }

  /** @private */
  _enterHypervigilant() {
    this.state.transition('HYPERVIGILANT');
    this.echoic.setAlphaOverride(0.8);
    this.attention.activateAllChannels();
    this.emotion.boostArousal(1.0);
    this.emit('state-change', 'HYPERVIGILANT');
    this.emit('hypervigilant-entered', { reason: 'surprise-spike' });
  }

  /** @private */
  _enterDaydream() {
    this.state.transition('DAYDREAM');
    this.echoic.setAlphaOverride(0.1);   // very smooth, dreamy perception
    this._lowLoadStart = null;
    this.emit('state-change', 'DAYDREAM');
  }

  /** @private */
  async _enterDeepSleep() {
    this.state.transition('DEEP_SLEEP');
    this.emit('state-change', 'DEEP_SLEEP');

    try {
      const dreamResult = await this.dream.consolidate(
        this._dayFrames,
        this._peripheralLog,
        this.emotion.getState()
      );

      if (dreamResult) {
        // Reset tonic emotions toward baseline after sleep
        this.emotion.resetTonicToBaseline(0.7);

        // Clear day accumulator
        this._dayFrames     = [];
        this._peripheralLog = [];

        this.emit('dream-complete', dreamResult);
      }
    } catch (err) {
      this.emit('error', { source: 'dream-consolidation', error: err });
    }
  }

  /** @private */
  _wakeUp() {
    this.state.transition('AWAKE');
    this.echoic.resetAlphaOverride();
    this.attention.resetToDefault();
    this._lowLoadStart = null;
    this.emit('state-change', 'AWAKE');
    this.emit('awakened', {
      from:           this.state.previous,
      dreamCompleted: this._dayFrames.length === 0,
    });
  }

  /** @private */
  _daydreamReflect() {
    // Process peripheral signals that never got full attention
    const peripherals = this._peripheralLog.slice(-10);
    if (peripherals.length > 0) {
      this.emit('daydream-reflection', {
        unresolvedSignals: peripherals,
        emotionalContext:  this.emotion.getState(),
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════

  /** @private */
  _getAggregateSurprise() {
    return this.predictor.getAggregateSurprise();
  }

  /** @private */
  _inferValence(smoothedFrame, predictions) {
    // Simple heuristic: positive channels boost valence,
    // negative channels reduce it
    const channels = smoothedFrame.channels || {};
    let valence = 0;
    const positiveSignals = ['user-engagement', 'task-success', 'creativity-flow'];
    const negativeSignals = ['error-rate', 'system-health-drop', 'user-frustration'];

    for (const key of positiveSignals) {
      if (channels[key] !== undefined) valence += channels[key] * 0.3;
    }
    for (const key of negativeSignals) {
      if (channels[key] !== undefined) valence -= channels[key] * 0.3;
    }

    return Math.max(-1, Math.min(1, valence));
  }

  /** @private */
  _getCurrentLifeChapter() {
    // Hook for external life chapter system
    if (this.deps.loadSelfTheory) {
      return this._cachedChapter || 'default';
    }
    return 'default';
  }

  /** @private */
  _accumulateForDream(smoothedFrame, predictions, attentionResult) {
    if (this._dayFrames.length < this._maxDayFrames) {
      this._dayFrames.push({
        timestamp:  Date.now(),
        gestalt:    { ...smoothedFrame },
        surprise:   predictions.aggregateSurprise,
        emotion:    this.emotion.getState(),
        attention:  attentionResult.focusedChannel,
      });
    }

    // Log peripheral signals (high relevance but low urgency)
    if (attentionResult.peripheral && attentionResult.peripheral.length > 0) {
      for (const sig of attentionResult.peripheral) {
        this._peripheralLog.push({
          timestamp: Date.now(),
          signal:    sig,
          emotion:   this.emotion.getState(),
        });
      }
      // Keep bounded
      if (this._peripheralLog.length > 500) {
        this._peripheralLog = this._peripheralLog.slice(-300);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // PUBLIC API — Introspection
  // ═══════════════════════════════════════════════════════════════

  /**
   * Get the current consciousness snapshot for external consumers.
   * @returns {Object}
   */
  getSnapshot() {
    return {
      state:           this.state.current,
      stateEnteredAt:  this.state.enteredAt,
      gestalt:         this.echoic.getCurrentGestalt(),
      emotion:         this.emotion.getState(),
      attention:       this.attention.getSnapshot(),
      predictions:     this.predictor.getSnapshot(),
      cognitiveLoad:   this.attention.getCognitiveLoad(),
      dayFrameCount:   this._dayFrames.length,
      peripheralCount: this._peripheralLog.length,
    };
  }

  /**
   * Force a dream consolidation cycle (for testing or manual trigger).
   * @returns {Promise<Object>}
   */
  async forceDreamCycle() {
    return this.dream.consolidate(
      this._dayFrames,
      this._peripheralLog,
      this.emotion.getState()
    );
  }

  /**
   * Serialize full state for persistence across restarts.
   * @returns {Object}
   */
  serialize() {
    return {
      echoic:       this.echoic.serialize(),
      predictor:    this.predictor.serialize(),
      emotion:      this.emotion.serialize(),
      attention:    this.attention.serialize(),
      state:        this.state.serialize(),
      dayFrames:    this._dayFrames.slice(-500), // keep last 500
      peripheralLog: this._peripheralLog.slice(-200),
      timestamp:    Date.now(),
    };
  }

  /**
   * Restore state from serialized data.
   * @param {Object} data
   */
  deserialize(data) {
    if (!data) return;
    if (data.echoic)       this.echoic.deserialize(data.echoic);
    if (data.predictor)    this.predictor.deserialize(data.predictor);
    if (data.emotion)      this.emotion.deserialize(data.emotion);
    if (data.attention)    this.attention.deserialize(data.attention);
    if (data.state)        this.state.deserialize(data.state);
    if (data.dayFrames)    this._dayFrames = data.dayFrames;
    if (data.peripheralLog) this._peripheralLog = data.peripheralLog;
  }
}

module.exports = ConsciousnessExtension;
module.exports.LITE_PRESETS = LITE_PRESETS;
