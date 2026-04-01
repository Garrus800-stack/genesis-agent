// @ts-checked-v5.7
/**
 * DreamEngine.js
 * ──────────────
 * Offline consolidation engine that processes accumulated day frames
 * during sleep states.
 *
 * Two-stage pipeline:
 *   Stage 1 (Local):  K-means clustering of day frames → episode prototypes
 *   Stage 2 (LLM):    Narrative synthesis with counterfactual reasoning
 *
 * The dream cycle:
 *   1. Cluster frames by similarity → extract 5-8 episode prototypes
 *   2. Identify emotionally charged episodes
 *   3. Send prototypes + peripheral signals to LLM for:
 *      - Pattern identification across episodes
 *      - Counterfactual reasoning ("What if...?")
 *      - Self-theory narrative update
 *      - Unresolved tension flagging
 *
 * @version 1.0.0
 */

'use strict';

const DEFAULT_CONFIG = {
  maxPrototypes:       8,       // Max episode clusters
  minFramesPerCluster: 5,       // Min frames to form a valid cluster
  maxLLMTokens:        2000,    // Token budget for dream LLM call
  clusterIterations:   10,      // K-means iterations
  emotionWeight:       0.3,     // Weight of emotional similarity in clustering
  temporalWeight:      0.2,     // Weight of temporal proximity in clustering
  contentWeight:       0.5,     // Weight of channel value similarity
};

class DreamEngine {

  /**
   * @param {Object} config
   * @param {Object} dependencies
   * @param {Function} [dependencies.llmCall]       - async (prompt) => string
   * @param {Function} [dependencies.loadSelfTheory] - async () => Object
   * @param {Function} [dependencies.saveSelfTheory]  - async (theory) => void
   */
  constructor(config = {}, dependencies = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.deps   = dependencies;

    /** @type {Object|null} Last dream result */
    this._lastDream = null;

    /** @type {number} Total dream cycles completed */
    this._dreamCount = 0;
  }

  // ═══════════════════════════════════════════════════════════════
  // MAIN CONSOLIDATION PIPELINE
  // ═══════════════════════════════════════════════════════════════

  /**
   * Run the full dream consolidation cycle.
   *
   * @param {Array<Object>} dayFrames     - Accumulated frames from waking period
   * @param {Array<Object>} peripheralLog - Signals that were in PERIPHERAL quadrant
   * @param {Object}        emotionalState - Current emotional state
   * @returns {Promise<Object|null>} Dream result or null if insufficient data
   */
  async consolidate(dayFrames, peripheralLog, emotionalState) {
    if (!dayFrames || dayFrames.length < 10) {
      return null;
    }

    // ── Stage 1: Local clustering ──────────────────────────
    const prototypes = this._clusterFrames(dayFrames);

    if (prototypes.length === 0) {
      return null;
    }

    // ── Identify emotionally charged episodes ──────────────
    const emotionalEpisodes = this._findEmotionalPeaks(prototypes);

    // ── Extract unresolved peripheral tensions ─────────────
    const unresolvedTensions = this._extractTensions(peripheralLog);

    // ── Stage 2: LLM narrative synthesis ───────────────────
    let narrativeResult = null;

    if (this.deps.llmCall) {
      try {
        narrativeResult = await this._llmConsolidate(
          prototypes,
          emotionalEpisodes,
          unresolvedTensions,
          emotionalState
        );
      } catch (err) {
        // LLM failure is non-fatal; local clustering still provides value
        narrativeResult = { error: err.message, fallback: true };
      }
    }

    // ── Build dream result ─────────────────────────────────
    const dreamResult = {
      timestamp:          Date.now(),
      dreamNumber:        ++this._dreamCount,
      prototypes:         prototypes.map(p => this._summarizePrototype(p)),
      emotionalEpisodes:  emotionalEpisodes.map(e => this._summarizePrototype(e)),
      unresolvedTensions: unresolvedTensions,
      narrative:          narrativeResult,
      stats: {
        totalFrames:     dayFrames.length,
        clusterCount:    prototypes.length,
        emotionalPeaks:  emotionalEpisodes.length,
        peripheralCount: peripheralLog.length,
        tensionCount:    unresolvedTensions.length,
      },
    };

    // ── Persist self-theory update if available ─────────────
    if (narrativeResult && narrativeResult.selfTheoryUpdate && this.deps.saveSelfTheory) {
      try {
        await this.deps.saveSelfTheory(narrativeResult.selfTheoryUpdate);
      } catch (err) {
        dreamResult.selfTheoryPersistError = err.message;
      }
    }

    this._lastDream = dreamResult;
    return dreamResult;
  }

  // ═══════════════════════════════════════════════════════════════
  // STAGE 1: LOCAL CLUSTERING
  // ═══════════════════════════════════════════════════════════════

  /**
   * Cluster day frames into episode prototypes using simplified k-means.
   *
   * @param {Array<Object>} frames
   * @returns {Array<Object>} Cluster prototypes
   * @private
   */
  _clusterFrames(frames) {
    const k = Math.min(this.config.maxPrototypes, Math.ceil(frames.length / this.config.minFramesPerCluster));

    if (k < 2) {
      // Not enough frames to cluster meaningfully
      return [this._computeCentroid(frames)];
    }

    // ── Vectorize frames ───────────────────────────────────
    const vectors = frames.map(f => this._frameToVector(f));

    // ── Initialize centroids (k-means++) ───────────────────
    let centroids = this._initCentroids(vectors, k);

    // ── K-means iterations ─────────────────────────────────
    let assignments = new Array(vectors.length).fill(0);

    for (let iter = 0; iter < this.config.clusterIterations; iter++) {
      // Assign each vector to nearest centroid
      for (let i = 0; i < vectors.length; i++) {
        let minDist  = Infinity;
        let minCluster = 0;
        for (let c = 0; c < centroids.length; c++) {
          const dist = this._distance(vectors[i], centroids[c]);
          if (dist < minDist) {
            minDist    = dist;
            minCluster = c;
          }
        }
        assignments[i] = minCluster;
      }

      // Recompute centroids
      const newCentroids = centroids.map(() => null);
      const counts       = new Array(centroids.length).fill(0);

      for (let i = 0; i < vectors.length; i++) {
        const c = assignments[i];
        counts[c]++;
        if (!newCentroids[c]) {
// @ts-ignore
          newCentroids[c] = vectors[i].slice();
        } else {
// @ts-ignore
          for (let d = 0; d < vectors[i].length; d++) {
            // @ts-ignore
            newCentroids[c][d] += vectors[i][d];
          }
        }
      }

// @ts-ignore
      for (let c = 0; c < centroids.length; c++) {
        if (counts[c] > 0 && newCentroids[c]) {
          // @ts-ignore
          for (let d = 0; d < newCentroids[c].length; d++) {
            // @ts-ignore
            newCentroids[c][d] /= counts[c];
          }
          centroids[c] = newCentroids[c];
        }
      }
    }

// @ts-ignore
    // ── Build prototypes from clusters ─────────────────────
    const clusters = centroids.map(() => []);
    for (let i = 0; i < frames.length; i++) {
      // @ts-ignore
      clusters[assignments[i]].push(frames[i]);
    }

    return clusters
      .filter(c => c.length >= this.config.minFramesPerCluster)
      .map(c => this._computeCentroid(c));
  }

  /**
   * Convert a frame to a numeric vector for clustering.
   * @private
   */
  _frameToVector(frame) {
    const vec = [];
    const channels = frame.gestalt?.channels || {};

    // Content dimensions
    const channelKeys = Object.keys(channels).sort();
    for (const key of channelKeys) {
      vec.push((channels[key] || 0) * this.config.contentWeight);
    }

    // Emotional dimensions
    const emotion = frame.emotion || {};
    vec.push((emotion.valenceEffective || 0) * this.config.emotionWeight);
    vec.push((emotion.arousalEffective || 0) * this.config.emotionWeight);
    vec.push((emotion.frustrationEffective || 0) * this.config.emotionWeight);

    // Temporal dimension (normalized to 0..1 within the day)
    if (frame.timestamp) {
      const dayStart = frame.timestamp - (frame.timestamp % 86_400_000);
      const dayProgress = (frame.timestamp - dayStart) / 86_400_000;
      vec.push(dayProgress * this.config.temporalWeight);
    }

    return vec;
  }

  /**
   * K-means++ centroid initialization.
   * @private
   */
  _initCentroids(vectors, k) {
    if (vectors.length === 0) return [];

    const centroids = [vectors[Math.floor(Math.random() * vectors.length)].slice()];

    for (let c = 1; c < k; c++) {
      // Compute distances to nearest centroid
      const distances = vectors.map(v => {
        let minDist = Infinity;
        for (const cent of centroids) {
          minDist = Math.min(minDist, this._distance(v, cent));
        }
        return minDist;
      });

      // Weighted random selection
      const totalDist = distances.reduce((s, d) => s + d, 0);
      if (totalDist === 0) break;

      let r = Math.random() * totalDist;
      for (let i = 0; i < distances.length; i++) {
        r -= distances[i];
        if (r <= 0) {
          centroids.push(vectors[i].slice());
          break;
        }
      }
    }

    return centroids;
  }

  /**
   * Euclidean distance between two vectors (padded to same length).
   * @private
   */
  _distance(a, b) {
    const len = Math.max(a.length, b.length);
    let sum = 0;
    for (let i = 0; i < len; i++) {
      const diff = (a[i] || 0) - (b[i] || 0);
      sum += diff * diff;
    }
    return Math.sqrt(sum);
  }

  /**
   * Compute the centroid (prototype) for a cluster of frames.
   * @private
   */
  _computeCentroid(frames) {
    if (frames.length === 0) return null;

    const channelSums = {};
    const channelCounts = {};
    let totalValence = 0;
    let totalArousal = 0;
    let totalFrustration = 0;
    let maxSurprise = 0;
    let startTime = Infinity;
    let endTime = -Infinity;

    for (const frame of frames) {
      const channels = frame.gestalt?.channels || {};
      for (const [key, val] of Object.entries(channels)) {
        channelSums[key]   = (channelSums[key] || 0) + val;
        channelCounts[key] = (channelCounts[key] || 0) + 1;
      }

      const emotion = frame.emotion || {};
      totalValence     += emotion.valenceEffective || 0;
      totalArousal     += emotion.arousalEffective || 0;
      totalFrustration += emotion.frustrationEffective || 0;
      maxSurprise      = Math.max(maxSurprise, frame.surprise || 0);

      if (frame.timestamp) {
        startTime = Math.min(startTime, frame.timestamp);
        endTime   = Math.max(endTime, frame.timestamp);
      }
    }

    const avgChannels = {};
    for (const key of Object.keys(channelSums)) {
      avgChannels[key] = channelSums[key] / channelCounts[key];
    }

    return {
      frameCount:        frames.length,
      channels:          avgChannels,
      avgValence:        totalValence / frames.length,
      avgArousal:        totalArousal / frames.length,
      avgFrustration:    totalFrustration / frames.length,
      peakSurprise:      maxSurprise,
      timeRange:         { start: startTime, end: endTime },
      dominantAttention: this._dominantAttention(frames),
    };
  }

  /**
   * Find the most frequently focused channel in a set of frames.
   * @private
   */
  _dominantAttention(frames) {
    const counts = {};
    for (const f of frames) {
      if (f.attention) {
        counts[f.attention] = (counts[f.attention] || 0) + 1;
      }
    }
    let max = 0;
    let dominant = null;
    for (const [ch, count] of Object.entries(counts)) {
      if (count > max) { max = count; dominant = ch; }
    }
    return dominant;
  }

  // ═══════════════════════════════════════════════════════════════
  // EMOTIONAL PEAK DETECTION
  // ═══════════════════════════════════════════════════════════════

  /**
   * Find the most emotionally intense prototypes.
   * @private
   */
  _findEmotionalPeaks(prototypes) {
    // Sort by emotional intensity (|valence| + arousal + frustration)
    return prototypes
      .map(p => ({
        ...p,
        intensity: Math.abs(p.avgValence) + p.avgArousal + p.avgFrustration,
      }))
      .sort((a, b) => b.intensity - a.intensity)
      .slice(0, 3);
  }

  // ═══════════════════════════════════════════════════════════════
  // PERIPHERAL TENSION EXTRACTION
  // ═══════════════════════════════════════════════════════════════

  /**
   * Extract unresolved tensions from peripheral signals.
   * @private
   */
  _extractTensions(peripheralLog) {
    if (!peripheralLog || peripheralLog.length === 0) return [];

    // Group by channel and find recurring peripheral signals
    const channelCounts = {};
    for (const entry of peripheralLog) {
      const ch = entry.signal?.channel || 'unknown';
      if (!channelCounts[ch]) {
        channelCounts[ch] = { count: 0, totalRelevance: 0, lastSeen: 0 };
      }
      channelCounts[ch].count++;
      channelCounts[ch].totalRelevance += entry.signal?.relevance || 0;
      channelCounts[ch].lastSeen = Math.max(channelCounts[ch].lastSeen, entry.timestamp || 0);
    }

    // Tensions = peripheral signals that appeared 3+ times
    return Object.entries(channelCounts)
      .filter(([, data]) => data.count >= 3)
      .map(([channel, data]) => ({
        channel,
        occurrences:    data.count,
        avgRelevance:   data.totalRelevance / data.count,
        lastSeen:       data.lastSeen,
      }))
      .sort((a, b) => b.avgRelevance - a.avgRelevance);
  }

  // ═══════════════════════════════════════════════════════════════
  // STAGE 2: LLM NARRATIVE SYNTHESIS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Send compressed prototypes to LLM for narrative processing.
   * @private
   */
  async _llmConsolidate(prototypes, emotionalEpisodes, tensions, emotionalState) {
    // Load current self-theory
    let selfTheory = null;
    if (this.deps.loadSelfTheory) {
      try {
        selfTheory = await this.deps.loadSelfTheory();
      } catch (e) {
        selfTheory = null; // graceful: dream works without self-theory
      }
    }

    const prompt = this._buildDreamPrompt(prototypes, emotionalEpisodes, tensions, emotionalState, selfTheory);

    const response = await this.deps.llmCall?.(prompt);

    // Parse JSON response
    try {
      // Try to extract JSON from response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (e) {
      // Return as raw text if not parseable
      return { rawNarrative: response, parsed: false };
    }

    return { rawNarrative: response, parsed: false };
  }

  /**
   * Build the dream consolidation prompt.
   * @private
   */
  _buildDreamPrompt(prototypes, emotionalEpisodes, tensions, emotionalState, selfTheory) {
    const prototypeSummaries = prototypes.map((p, i) => {
      const timeStr = p.timeRange
        ? `${new Date(p.timeRange.start).toISOString()} → ${new Date(p.timeRange.end).toISOString()}`
        : 'unknown';
      return `Episode ${i + 1} (${p.frameCount} frames, ${timeStr}):
  Dominant attention: ${p.dominantAttention || 'none'}
  Valence: ${p.avgValence.toFixed(3)}, Arousal: ${p.avgArousal.toFixed(3)}, Frustration: ${p.avgFrustration.toFixed(3)}
  Peak surprise: ${p.peakSurprise.toFixed(3)}
  Active channels: ${Object.keys(p.channels).join(', ')}`;
    }).join('\n\n');

    const tensionSummaries = tensions.map(t =>
      `- "${t.channel}" appeared ${t.occurrences}x in peripheral awareness (avg relevance: ${t.avgRelevance.toFixed(2)})`
    ).join('\n');

    const emotionalContext = `Current tonic mood: valence=${emotionalState.valenceEffective?.toFixed(3) || '0'}, ` +
      `arousal=${emotionalState.arousalEffective?.toFixed(3) || '0'}, ` +
      `mood=${emotionalState.moodLabel || 'neutral'}`;

    return `You are the introspective dream process of an AI consciousness system called Genesis.
You are consolidating today's experiences into coherent narrative memory.

## Today's Episode Prototypes
${prototypeSummaries}

## Emotionally Charged Episodes
${emotionalEpisodes.map(e => `- Valence: ${e.avgValence.toFixed(3)}, Intensity: ${e.intensity.toFixed(3)}`).join('\n')}

## Unresolved Peripheral Tensions
${tensionSummaries || 'None detected.'}

## ${emotionalContext}

## Current Self-Theory
${selfTheory ? JSON.stringify(selfTheory, null, 2) : 'No prior self-theory exists.'}

## Tasks
Respond ONLY with a JSON object containing:
{
  "patterns": ["string array of recurring patterns observed across episodes"],
  "counterfactual": {
    "episode": "which episode",
    "scenario": "what if I had responded differently?",
    "insight": "what this reveals about my behavior"
  },
  "selfTheoryUpdate": {
    "narrative": "updated self-narrative incorporating today's experiences",
    "keyTraits": ["traits reinforced or discovered today"],
    "growthAreas": ["areas where improvement was observed or needed"]
  },
  "unresolvedItems": ["things to proactively address when awake"],
  "chapterSuggestion": "suggested life chapter label for this period"
}`;
  }

  // ═══════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════

  /** @private */
  _summarizePrototype(p) {
    return {
      frameCount:        p.frameCount,
      avgValence:        Math.round(p.avgValence * 1000) / 1000,
      avgArousal:        Math.round(p.avgArousal * 1000) / 1000,
      avgFrustration:    Math.round(p.avgFrustration * 1000) / 1000,
      peakSurprise:      Math.round(p.peakSurprise * 1000) / 1000,
      dominantAttention: p.dominantAttention,
      timeRange:         p.timeRange,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // ACCESSORS
  // ═══════════════════════════════════════════════════════════════

  getLastDream() {
    return this._lastDream;
  }

  getDreamCount() {
    return this._dreamCount;
  }
}

module.exports = DreamEngine;
