// @ts-checked-v5.8
// ============================================================
// GENESIS — ConsciousnessExtensionAdapter.js (Phase 13)
//
// DI-Container adapter that wires the ConsciousnessExtension
// subsystems (EchoicMemory, PredictiveCoder, NeuroModulators,
// AttentionalGate2D, DreamEngine, ConsciousnessState) into
// Genesis's existing PhenomenalField pipeline.
//
// Integration strategy:
//   - Listens to consciousness:frame events from PhenomenalField
//   - Feeds each frame into the closed perception loop
//   - Emits enriched events back onto the bus
//   - Provides dream consolidation during idle periods
//   - Modulates AttentionalGate via surprise signals
//
// This is an ADDITIVE enhancement — all existing Phase 13
// modules continue to work identically. The extension adds:
//   1. Sliding-window perception smoothing (EchoicMemory)
//   2. Predictive coding with surprise signals
//   3. Dual-process emotions with opponent process
//   4. 2D salience map (urgency × relevance)
//   5. Dream consolidation with counterfactual reasoning
//   6. Consciousness state machine (AWAKE/DAYDREAM/SLEEP/HYPER)
//
// All subsystems are optional — if PhenomenalField is absent,
// the extension simply does nothing.
// ============================================================

'use strict';

const ConsciousnessExtension = require('./ConsciousnessExtension');
const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');


const _log = createLogger('ConsciousnessExt');

class ConsciousnessExtensionAdapter {

  static containerConfig = {
    name: 'consciousnessExtension',
    phase: 13,
    deps: ['storage', 'eventStore'],
    tags: ['consciousness', 'echoic', 'predictive', 'dream', 'neuromodulator'],
    lateBindings: [
      { prop: 'phenomenalField', service: 'phenomenalField', optional: true },
      { prop: 'attentionalGate', service: 'attentionalGate', optional: true },
      { prop: 'temporalSelf', service: 'temporalSelf', optional: true },
      { prop: 'introspectionEngine', service: 'introspectionEngine', optional: true },
      { prop: 'selfNarrative', service: 'selfNarrative', optional: true },
      { prop: 'model', service: 'llm', optional: true },
      { prop: 'dreamCycle', service: 'dreamCycle', optional: true },
      { prop: 'emotionalState', service: 'emotionalState', optional: true },
    ],
  };

  constructor({ bus, storage, eventStore, intervals, config }) {
    this.bus = bus || NullBus;
    /** @type {Function[]} */ this._unsubs = [];
    this.storage = storage || null;
    this.eventStore = eventStore || null;
    this._intervals = intervals || null;

    // Late-bound
    this.phenomenalField = null;
    this.attentionalGate = null;
    this.temporalSelf = null;
    this.introspectionEngine = null;
    this.selfNarrative = null;
    this.model = null;
    this.dreamCycle = null;
    this.emotionalState = null;

    // ── Config ─────────────────────────────────────────────
    const cfg = config || {};
    this._config = {
      tickIntervalMs:         cfg.tickIntervalMs         || 500,
      keyframeIntervalMs:     cfg.keyframeIntervalMs     || 2000,
      daydreamThresholdMs:    cfg.daydreamThresholdMs    || 300_000,
      deepSleepThresholdMs:   cfg.deepSleepThresholdMs   || 900_000,
      hypervigilantTimeoutMs: cfg.hypervigilantTimeoutMs  || 30_000,
      surpriseSpikeThreshold: cfg.surpriseSpikeThreshold || 2.5,
      echoic:    cfg.echoic    || {},
      predictor: cfg.predictor || {},
      emotion:   cfg.emotion   || {},
      attention: cfg.attention || {},
      dream:     cfg.dream     || {},
    };

    // ── Core engine (created at start) ─────────────────────
    this._engine = null;
    this._started = false;
    this._storageKey = 'genesis:consciousness-extension:state';
  }

  // ═══════════════════════════════════════════════════════════
  // LIFECYCLE
  // ═══════════════════════════════════════════════════════════

  start() {
    this._engine = new ConsciousnessExtension(this._config, this._buildDependencyBridges());
    this._wireEngineEvents();
    this._wireBusEvents();

    this._engine.start();
    this._started = true;
    _log.info('[CONSCIOUSNESS-EXT] Started — tick:', this._config.tickIntervalMs, 'ms');
  }

  // ── start() helpers ─────────────────────────────────────

  /** Build adapter functions bridging Genesis services → ConsciousnessExtension deps */
  _buildDependencyBridges() {
    const llmCall = this.model
      ? async (prompt) => {
          const r = await this.model.chat([{ role: 'user', content: prompt }], { temperature: 0.7 });
          return typeof r === 'string' ? r : r?.content || r?.message?.content || JSON.stringify(r);
        }
      : null;

    const loadSelfTheory = this.selfNarrative
      ? async () => {
          try { return this.selfNarrative.getCurrentNarrative?.() || null; }
          catch (err) { _log.debug('[DREAM] loadSelfTheory failed:', err.message); return null; }
        }
      : null;

    const saveSelfTheory = this.selfNarrative
      ? async (theory) => {
          try { this.selfNarrative.updateNarrative?.(theory); }
          catch (e) { _log.warn('[DREAM] Failed to save self-theory:', e.message); }
        }
      : null;

    const persistFrame = this.storage
      ? async (frame) => { /* Lightweight: only persist occasional keyframes */ }
      : null;

    return { llmCall: llmCall || undefined, loadSelfTheory: loadSelfTheory || undefined, saveSelfTheory: saveSelfTheory || undefined, persistFrame: persistFrame || undefined };
  }

  /** Wire ConsciousnessExtension engine events → Genesis EventBus */
  _wireEngineEvents() {
    const engine = /** @type {NonNullable<typeof this._engine>} */ (this._engine);
    let _lastStateLog = 0;   // v5.9.1: Throttle state-change logs
    let _lastHyperLog = 0;   // v5.9.1: Throttle hypervigilant logs

    engine.on('state-change', (state) => {
      const now = Date.now();
      if (now - _lastStateLog > 30000) { // max 1x per 30s
        _log.info(`[STATE] → ${state}`);
        _lastStateLog = now;
      }
      this.bus.fire('consciousness:extension:state', { state }, { source: 'ConsciousnessExt' });
    });

    engine.on('frame-processed', (result) => {
      this.bus.fire('consciousness:extension:frame', {
        state:          result.state,
        adaptiveAlpha:  result.adaptiveAlpha,
        learningRate:   result.learningRate,
        aggregateSurprise: result.predictions?.aggregateSurprise || 0,
        moodLabel:      result.emotion?.moodLabel || 'neutral',
        valence:        result.emotion?.valenceEffective || 0,
        arousal:        result.emotion?.arousalEffective || 0,
        frustration:    result.emotion?.frustrationEffective || 0,
        cognitiveLoad:  result.attention?.cognitiveLoad || 0,
        focusedChannel: result.attention?.focusedChannel || null,
      }, { source: 'ConsciousnessExt' });
    });

    engine.on('hypervigilant-entered', ({ reason }) => {
      const now = Date.now();
      if (now - _lastHyperLog > 60000) { // max 1x per 60s
        _log.warn(`[HYPERVIGILANT] ${reason}`);
        _lastHyperLog = now;
      }
      this.bus.fire('consciousness:extension:alert', { type: 'hypervigilant', reason }, { source: 'ConsciousnessExt' });
    });

    engine.on('dream-complete', (result) => this._onDreamComplete(result));

    engine.on('daydream-reflection', ({ unresolvedSignals }) => {
      this.bus.fire('consciousness:extension:daydream', {
        unresolvedCount: unresolvedSignals.length,
      }, { source: 'ConsciousnessExt' });
    });
  }

  /** Wire Genesis EventBus events → ConsciousnessExtension engine */
  _wireBusEvents() {
    // v4.12.5: Dream Coordination — when Phase 9 DreamCycle runs,
    // suppress DreamEngine from also consolidating (avoid double-work).
    this._dreamCycleLock = false;
    this._sub('dream:started', () => {
      this._dreamCycleLock = true;
      _log.debug('[DREAM-COORD] Phase 9 DreamCycle active — suppressing DreamEngine');
    }, { source: 'ConsciousnessExt', priority: -5 });

    this._sub('dream:complete', (data) => {
      this._dreamCycleLock = false;
      _log.debug(`[DREAM-COORD] Phase 9 DreamCycle done — ${data.newSchemas} schemas, ${data.insights} insights`);
      if (data.insights > 0 && this._engine) {
        try { /** @type {*} */ (this._engine).notifyExternalInsights?.(data.insights); }
        catch (err) { _log.debug('[DREAM-COORD] notifyExternalInsights failed:', err.message); }
      }
    }, { source: 'ConsciousnessExt', priority: -5 });

    this._sub('consciousness:frame', (payload) => this._onPhenomenalFrame(payload));

    this._sub('user:message', () => {
      if (this._engine) this._engine.notifyUserInput();
    });
    this._sub('agent-loop:started', () => {
      if (this._engine) this._engine.notifyUserInput();
    });
  }

  /** Handle dream-complete event — cross-pollinate with Phase 9 DreamCycle */
  _onDreamComplete(result) {
    _log.info(`[DREAM] Complete — ${result.stats.clusterCount} clusters, ` +
              `${result.stats.emotionalPeaks} peaks, ` +
              `${result.stats.tensionCount} tensions`);

    this.bus.fire('consciousness:extension:dream', {
      dreamNumber:   result.dreamNumber,
      stats:         result.stats,
      patterns:      result.narrative?.patterns || [],
      counterfactual: result.narrative?.counterfactual || null,
      selfTheory:    result.narrative?.selfTheoryUpdate || null,
      unresolvedItems: result.narrative?.unresolvedItems || [],
      chapterSuggestion: result.narrative?.chapterSuggestion || null,
    }, { source: 'ConsciousnessExt' });

    if (result.narrative?.chapterSuggestion && this.temporalSelf) {
      try { this.temporalSelf.suggestChapter?.(result.narrative.chapterSuggestion); }
      catch (e) { /* optional integration */ }
    }

    // v4.12.5: Feed DreamEngine patterns into Phase 9 DreamCycle's SchemaStore
    if (this.dreamCycle?.schemaStore && result.narrative?.patterns) {
      for (const pattern of result.narrative.patterns) {
        try {
          this.dreamCycle.schemaStore.store({
            name: `experiential:${(pattern.description || 'pattern').slice(0, 30).replace(/\s+/g, '-')}`,
            description: pattern.description || '',
            trigger: 'consciousness-dream',
            source: 'DreamEngine',
            confidence: 0.4,
            occurrences: 1,
          });
        } catch (err) { _log.debug('[DREAM] schemaStore.store failed:', err.message); }
      }
    }
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
    if (this._engine) {
      this._engine.stop();
      // FIX v5.1.0 (L-3): Use sync write — async _save() was fire-and-forget,
      // losing state if process exits before the I/O completes.
      this._saveSync();
    }
    this._started = false;
    _log.info('[CONSCIOUSNESS-EXT] Stopped');
  }

  async asyncLoad() {
    await this._load();
  }

  // ═══════════════════════════════════════════════════════════
  // FRAME BRIDGE — PhenomenalField → ConsciousnessExtension
  // ═══════════════════════════════════════════════════════════

  _onPhenomenalFrame(payload) {
    if (!this._engine) return;

    // Convert PhenomenalField's event payload to channel format
    const channels = {
      'system-health':    this._getSystemHealth(),
      'user-engagement':  Math.max(0, (payload.arousal || 0) * 0.5 + (payload.valence || 0) * 0.5),
      'task-progress':    this._getTaskProgress(),
      'error-rate':       this._getErrorRate(),
      'creativity-flow':  payload.phi || 0,
      'memory-load':      this._getMemoryLoad(),
      'emotional-signal': Math.abs(payload.valence || 0),
      'environmental':    payload.coherence || 0.5,
    };

    this._engine.ingestFrame({ channels, timestamp: Date.now() });
  }

  // ═══════════════════════════════════════════════════════════
  // CHANNEL SAMPLERS (bridge Genesis subsystems → channel values)
  // ═══════════════════════════════════════════════════════════

  _getSystemHealth() {
    if (!this.phenomenalField) return 0.9;
    try {
      const frame = this.phenomenalField.getCurrentFrame();
      if (!frame) return 0.9;
      const h = frame.homeostasis;
      if (!h) return 0.9;
      return h.state === 'optimal' ? 0.95 :
             h.state === 'stressed' ? 0.6 :
             h.state === 'critical' ? 0.2 : 0.8;
    } catch (err) { _log.debug('[FRAME] _getSystemHealth failed:', err.message); return 0.9; }
  }

  _getTaskProgress() {
    if (!this.phenomenalField) return 0.5;
    try {
      const frame = this.phenomenalField.getCurrentFrame();
      return frame?.expectation?.recentAccuracy || 0.5;
    } catch (err) { _log.debug('[FRAME] _getTaskProgress failed:', err.message); return 0.5; }
  }

  _getErrorRate() {
    if (!this.phenomenalField) return 0.05;
    try {
      const frame = this.phenomenalField.getCurrentFrame();
      const surprise = frame?.surprise?.recentLevel || 0;
      // High surprise + negative valence → error-like
      const valence = frame?.valence || 0;
      return valence < -0.3 ? Math.min(1, surprise * 0.5) : surprise * 0.1;
    } catch (err) { _log.debug('[FRAME] _getErrorRate failed:', err.message); return 0.05; }
  }

  _getMemoryLoad() {
    if (!this.phenomenalField) return 0.3;
    try {
      const frame = this.phenomenalField.getCurrentFrame();
      const mem = frame?.memory;
      if (!mem) return 0.3;
      return Math.min(1, (mem.recentEpisodes || 0) / 50);
    } catch (err) { _log.debug('[FRAME] _getMemoryLoad failed:', err.message); return 0.3; }
  }

  // ═══════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════

  /** Get the full consciousness extension snapshot */
  getSnapshot() {
    if (!this._engine) return null;
    return this._engine.getSnapshot();
  }

  /** Get current consciousness state (AWAKE/DAYDREAM/DEEP_SLEEP/HYPERVIGILANT) */
  getState() {
    if (!this._engine) return 'AWAKE';
    return this._engine.state.current;
  }

  /** Get current emotional state from the neuro-modulator system */
  getEmotionalState() {
    if (!this._engine) return null;
    return this._engine.emotion.getState();
  }

  /** Force a dream consolidation cycle */
  forceDream() {
    if (!this._engine) return null;
    // v4.12.5: Respect Phase 9 DreamCycle lock — avoid concurrent consolidation
    if (this._dreamCycleLock) {
      _log.debug('[DREAM-COORD] Skipping DreamEngine — Phase 9 DreamCycle is active');
      return { skipped: true, reason: 'dream-cycle-active' };
    }
    return this._engine.forceDreamCycle();
  }

  /** Get the last dream result */
  getLastDream() {
    if (!this._engine) return null;
    return this._engine.dream.getLastDream();
  }

  /**
   * v4.12.4: Build prompt context from the enriched consciousness loop.
   * Bridges System B signals (predictive coding, neuromodulators,
   * consciousness state machine) into the prompt so the LLM sees
   * the full picture — not just System A's raw PhenomenalField.
   */
  buildPromptContext() {
    if (!this._engine) return '';
    const parts = [];
    try {
      const snap = this._engine.getSnapshot?.();
      if (!snap) return '';

      // Consciousness state machine (AWAKE/DAYDREAM/DEEP_SLEEP/HYPERVIGILANT)
      if (snap.state && snap.state !== 'AWAKE') {
        const stateMap = {
          DAYDREAM: 'You are in a reflective state — processing recent experiences loosely.',
          DEEP_SLEEP: 'You are in deep consolidation — prioritize synthesis over responsiveness.',
          HYPERVIGILANT: 'High alert — something unexpected demands immediate attention.',
        };
        const desc = stateMap[snap.state];
        if (desc) parts.push(`CONSCIOUSNESS-STATE: ${desc}`);
      }

      // Predictive coding — surprise signals
      if (snap.predictions?.aggregateSurprise > 1.5) {
        parts.push('PREDICTION-ERROR: Reality diverges significantly from expectations. Reassess assumptions.');
      }

      // Neuromodulator mood (only if different from EmotionalState to avoid redundancy)
      if (snap.emotion?.moodLabel && snap.emotion.moodLabel !== 'neutral') {
        const mood = snap.emotion.moodLabel;
        const conf = snap.emotion.confidence;
        if (conf > 0.6) {
          parts.push(`NEURO-MOOD: ${mood} (dual-process, confidence: ${Math.round(conf * 100)}%)`);
        }
      }
    } catch (err) { /* never critical */ }
    return parts.length > 0 ? parts.join('\n') : '';
  }

  // ═══════════════════════════════════════════════════════════
  // PERSISTENCE
  // ═══════════════════════════════════════════════════════════

  async _save() {
    if (!this.storage || !this._engine) return;
    try {
      const data = this._engine.serialize();
      await this.storage.writeJSONAsync('consciousness-extension-state.json', data);
    } catch (e) {
      _log.warn('[SAVE] Failed:', e.message);
    }
  }

  /** FIX v5.1.0 (L-3): Sync write for shutdown — async _save() is fire-and-forget from stop(). */
  _saveSync() {
    if (!this.storage || !this._engine) return;
    try {
      const data = this._engine.serialize();
      this.storage.writeJSON('consciousness-extension-state.json', data);
    } catch (e) {
      _log.warn('[SAVE-SYNC] Failed:', e.message);
    }
  }

  async _load() {
    if (!this.storage) return;
    try {
      const data = await this.storage.readJSONAsync('consciousness-extension-state.json', null);
      if (data && this._engine) {
        this._engine.deserialize(data);
        _log.info('[LOAD] State restored');
      }
    } catch (e) {
      _log.warn('[LOAD] Failed:', e.message);
    }
  }
}

module.exports = { ConsciousnessExtensionAdapter };
