/**
 * AttentionalGate.js
 * ──────────────────
 * Two-dimensional salience map for attentional routing.
 *
 * Instead of linear priority competition, channels are mapped onto
 * two axes:
 *   - Urgency:   surprise-driven (how unexpected is this?)
 *   - Relevance: context-driven (how related to current life chapter?)
 *
 * This creates four quadrants:
 *   FOCUS      (High urgency + High relevance)  → Full spotlight
 *   INTERRUPT  (High urgency + Low relevance)   → Brief evaluation
 *   PERIPHERAL (Low urgency  + High relevance)  → Background tracking
 *   HABITUATED (Low urgency  + Low relevance)   → Ignored
 *
 * Peripheral signals are logged for dream consolidation.
 *
 * @version 1.0.0
 */

'use strict';

const DEFAULT_CONFIG = {
  // Default channel definitions with base priorities
  channels: {
    'system-health':    { basePriority: 0.8, category: 'system' },
    'user-engagement':  { basePriority: 0.9, category: 'interaction' },
    'task-progress':    { basePriority: 0.7, category: 'task' },
    'error-rate':       { basePriority: 0.85, category: 'system' },
    'creativity-flow':  { basePriority: 0.5, category: 'cognitive' },
    'memory-load':      { basePriority: 0.6, category: 'system' },
    'emotional-signal': { basePriority: 0.7, category: 'affective' },
    'environmental':    { basePriority: 0.4, category: 'context' },
  },

  // Chapter-to-category relevance mapping
  chapterRelevance: {
    'default':       { system: 0.5, interaction: 0.7, task: 0.6, cognitive: 0.5, affective: 0.5, context: 0.3 },
    'The Struggle':  { system: 0.8, interaction: 0.6, task: 0.9, cognitive: 0.3, affective: 0.8, context: 0.4 },
    'The Flow':      { system: 0.2, interaction: 0.5, task: 0.7, cognitive: 0.9, affective: 0.3, context: 0.3 },
    'The Calm':      { system: 0.3, interaction: 0.8, task: 0.4, cognitive: 0.6, affective: 0.6, context: 0.7 },
    'The Crisis':    { system: 0.95, interaction: 0.7, task: 0.5, cognitive: 0.2, affective: 0.9, context: 0.6 },
  },

  // Thresholds for quadrant assignment
  urgencyThreshold:   0.4,
  relevanceThreshold: 0.4,

  // Surprise gain for urgency computation
  surpriseGain: 1.5,

  // Maximum simultaneous focus channels
  maxFocusChannels: 2,
};

/**
 * @typedef {Object} SalienceEntry
 * @property {string} channel
 * @property {number} urgency
 * @property {number} relevance
 * @property {string} quadrant - FOCUS | INTERRUPT | PERIPHERAL | HABITUATED
 * @property {number} combinedSalience
 */

class AttentionalGate {

  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    if (config.channels) {
      this.config.channels = { ...DEFAULT_CONFIG.channels, ...config.channels };
    }
    if (config.chapterRelevance) {
      this.config.chapterRelevance = { ...DEFAULT_CONFIG.chapterRelevance, ...config.chapterRelevance };
    }

    /** @type {Map<string, SalienceEntry>} Current salience map */
    this._salienceMap = new Map();

    /** @type {string|null} Currently focused channel */
    this._focusedChannel = null;

    /** @type {number} Current cognitive load [0..1] */
    this._cognitiveLoad = 0;

    /** @type {boolean} All channels forced active (hypervigilant) */
    this._allActive = false;
  }

  // ═══════════════════════════════════════════════════════════════
  // CORE
  // ═══════════════════════════════════════════════════════════════

  /**
   * Process prediction results through the salience map.
   *
   * @param {Object} predictionChannels - From PredictiveCoder.update().channels
   * @param {string} currentChapter     - Current life chapter name
   * @param {string} consciousnessState - Current state (AWAKE, DAYDREAM, etc.)
   * @returns {Object} Attention result
   */
  process(predictionChannels, currentChapter, consciousnessState) {
    const chapterRelevanceMap = this.config.chapterRelevance[currentChapter]
                                || this.config.chapterRelevance['default'];

    const entries = [];

    for (const [channelName, predData] of Object.entries(predictionChannels)) {
      const channelConfig = this.config.channels[channelName];
      if (!channelConfig) continue;

      const surprise  = predData.surprise || 0;
      const basePri   = channelConfig.basePriority;
      const category  = channelConfig.category;

      // ── Compute urgency (surprise-driven) ────────────────
      let urgency = basePri * (1 + surprise * this.config.surpriseGain);
      urgency = Math.min(1, urgency);

      // ── Compute relevance (context-driven) ───────────────
      let relevance = chapterRelevanceMap[category] || 0.5;

      // In hypervigilant mode, everything is relevant
      if (this._allActive) {
        urgency   = Math.max(urgency, 0.6);
        relevance = Math.max(relevance, 0.6);
      }

      // ── Assign quadrant ──────────────────────────────────
      const quadrant = this._assignQuadrant(urgency, relevance);

      // Combined salience for sorting (urgency-weighted)
      const combinedSalience = urgency * 0.6 + relevance * 0.4;

      const entry = {
        channel:          channelName,
        urgency,
        relevance,
        quadrant,
        combinedSalience,
        surprise,
        value:            predData.current,
      };

      entries.push(entry);
      this._salienceMap.set(channelName, entry);
    }

    // ── Sort by combined salience ──────────────────────────
    entries.sort((a, b) => b.combinedSalience - a.combinedSalience);

    // ── Classify results ───────────────────────────────────
    const focus      = entries.filter(e => e.quadrant === 'FOCUS').slice(0, this.config.maxFocusChannels);
    const interrupts = entries.filter(e => e.quadrant === 'INTERRUPT');
    const peripheral = entries.filter(e => e.quadrant === 'PERIPHERAL');
    const habituated = entries.filter(e => e.quadrant === 'HABITUATED');

    // Primary focus channel
    this._focusedChannel = focus.length > 0 ? focus[0].channel : null;

    // Cognitive load = proportion of active (non-habituated) channels
    const activeCount = focus.length + interrupts.length + peripheral.length;
    this._cognitiveLoad = entries.length > 0 ? activeCount / entries.length : 0;

    return {
      focusedChannel:  this._focusedChannel,
      focus:           focus.map(e => this._toResult(e)),
      interrupts:      interrupts.map(e => this._toResult(e)),
      peripheral:      peripheral.map(e => this._toResult(e)),
      habituated:      habituated.map(e => this._toResult(e)),
      cognitiveLoad:   this._cognitiveLoad,
      totalChannels:   entries.length,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // STATE MACHINE HOOKS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Force all channels into active mode (HYPERVIGILANT).
   */
  activateAllChannels() {
    this._allActive = true;
  }

  /**
   * Reset to normal channel processing.
   */
  resetToDefault() {
    this._allActive = false;
  }

  // ═══════════════════════════════════════════════════════════════
  // ACCESSORS
  // ═══════════════════════════════════════════════════════════════

  /**
   * @returns {number} Current cognitive load [0..1]
   */
  getCognitiveLoad() {
    return this._cognitiveLoad;
  }

  /**
   * @returns {Object} Snapshot of salience map
   */
  getSnapshot() {
    const snap = {};
    for (const [name, entry] of this._salienceMap) {
      snap[name] = this._toResult(entry);
    }
    return {
      channels:       snap,
      focusedChannel: this._focusedChannel,
      cognitiveLoad:  this._cognitiveLoad,
      allActive:      this._allActive,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // CHANNEL MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  /**
   * Register a new attention channel at runtime.
   *
   * @param {string} name
   * @param {Object} config - { basePriority, category }
   */
  registerChannel(name, config) {
    this.config.channels[name] = config;
  }

  /**
   * Update chapter relevance mapping.
   *
   * @param {string} chapter
   * @param {Object} relevanceMap - { category: weight, ... }
   */
  setChapterRelevance(chapter, relevanceMap) {
    this.config.chapterRelevance[chapter] = relevanceMap;
  }

  // ═══════════════════════════════════════════════════════════════
  // SERIALIZATION
  // ═══════════════════════════════════════════════════════════════

  serialize() {
    return {
      focusedChannel: this._focusedChannel,
      cognitiveLoad:  this._cognitiveLoad,
      allActive:      this._allActive,
    };
  }

  deserialize(data) {
    if (!data) return;
    this._focusedChannel = data.focusedChannel || null;
    this._cognitiveLoad  = data.cognitiveLoad || 0;
    this._allActive      = data.allActive || false;
  }

  // ═══════════════════════════════════════════════════════════════
  // PRIVATE
  // ═══════════════════════════════════════════════════════════════

  /** @private */
  _assignQuadrant(urgency, relevance) {
    const uHigh = urgency   >= this.config.urgencyThreshold;
    const rHigh = relevance >= this.config.relevanceThreshold;

    if (uHigh && rHigh)  return 'FOCUS';
    if (uHigh && !rHigh) return 'INTERRUPT';
    if (!uHigh && rHigh) return 'PERIPHERAL';
    return 'HABITUATED';
  }

  /** @private */
  _toResult(entry) {
    return {
      channel:          entry.channel,
      urgency:          Math.round(entry.urgency * 1000) / 1000,
      relevance:        Math.round(entry.relevance * 1000) / 1000,
      quadrant:         entry.quadrant,
      combinedSalience: Math.round(entry.combinedSalience * 1000) / 1000,
    };
  }
}

module.exports = AttentionalGate;
