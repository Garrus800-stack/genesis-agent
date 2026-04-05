// ============================================================
// GENESIS — PhenomenalFieldComputation.js (v5.1.0)
//
// Computation delegate for PhenomenalField.
// Extracted to reduce God-class complexity (34 → 20 methods).
//
// Contains: 6 channel samplers + 8 binding computations.
// Pattern: Same as AgentCoreBoot/Health/Wire delegates.
// ============================================================

'use strict';

const { createLogger } = require('../core/Logger');
const { _round } = require('../core/utils');
const _log = createLogger('PhenomenalField');


class PhenomenalFieldComputation {
  /** @param {import('./PhenomenalField').PhenomenalField} field */
  constructor(field) {
    this._f = field;
  }


  // ════════════════════════════════════════════════════════════
  // CHANNEL SAMPLING
  // ════════════════════════════════════════════════════════════

  _sampleEmotion() {
    if (!this._f.emotionalState) return { curiosity: 0.5, satisfaction: 0.5, frustration: 0.1, energy: 0.7, loneliness: 0.3, mood: 'calm', dominant: { emotion: 'neutral', intensity: 0 } };
    const state = this._f.emotionalState.getState();
    return {
      ...state,
      mood: this._f.emotionalState.getMood(),
      dominant: this._f.emotionalState.getDominant(),
    };
  }

  _sampleNeeds() {
    if (!this._f.needsSystem) return { knowledge: 0.3, social: 0.2, maintenance: 0.1, rest: 0.1, totalDrive: 0.2, mostUrgent: { need: null, drive: 0 } };
    return {
      ...this._f.needsSystem.getNeeds(),
      totalDrive: this._f.needsSystem.getTotalDrive(),
      mostUrgent: this._f.needsSystem.getMostUrgent(),
    };
  }

  _sampleSurprise() {
    if (!this._f.surpriseAccumulator) return { recentLevel: 0, trend: 'stable', noveltyRate: 0 };
    try {
      const signals = this._f.surpriseAccumulator.getRecentSignals ? this._f.surpriseAccumulator.getRecentSignals(10) : [];
      const avg = signals.length > 0
        ? signals.reduce((s, sig) => s + (sig.totalSurprise || 0), 0) / signals.length
        : 0;
      const novelCount = signals.filter(s => (s.totalSurprise || 0) >= 1.5).length;
      return {
        recentLevel: _round(avg),
        trend: avg > 0.5 ? 'rising' : avg < 0.2 ? 'falling' : 'stable',
        noveltyRate: _round(novelCount / Math.max(1, signals.length)),
      };
    } catch (err) { _log.debug('[SAMPLE] surprise sampling failed:', err.message); return { recentLevel: 0, trend: 'stable', noveltyRate: 0 }; }
  }

  _sampleExpectation() {
    if (!this._f.expectationEngine) return { activeCount: 0, avgConfidence: 0.5, recentAccuracy: 0.5 };
    try {
      const report = this._f.expectationEngine.getReport ? this._f.expectationEngine.getReport() : {};
      return {
        activeCount: report.activeExpectations || 0,
        avgConfidence: _round(report.avgConfidence || 0.5),
        recentAccuracy: _round(report.recentAccuracy || 0.5),
      };
    } catch (err) { _log.debug('[SAMPLE] expectation sampling failed:', err.message); return { activeCount: 0, avgConfidence: 0.5, recentAccuracy: 0.5 }; }
  }

  _sampleHomeostasis() {
    if (!this._f.homeostasis) return { state: 'healthy', criticalCount: 0, vitals: {} };
    try {
      const report = this._f.homeostasis.getReport ? this._f.homeostasis.getReport() : {};
      return {
        state: report.state || 'healthy',
        criticalCount: report.criticalCount || 0,
        vitals: report.vitals || {},
      };
    } catch (err) { _log.debug('[SAMPLE] homeostasis sampling failed:', err.message); return { state: 'healthy', criticalCount: 0, vitals: {} }; }
  }

  _sampleMemory() {
    const result = { recentEpisodes: 0, activatedSchemas: 0, narrativeAge: 0 };
    try {
      if (this._f.episodicMemory?.getRecentCount) result.recentEpisodes = this._f.episodicMemory.getRecentCount(10);
      if (this._f.schemaStore?.getActiveCount) result.activatedSchemas = this._f.schemaStore.getActiveCount();
      if (this._f.selfNarrative?.getAge) result.narrativeAge = this._f.selfNarrative.getAge();
    } catch (err) { _log.debug('[SAMPLE] memory sampling failed:', err.message); }
    return result;
  }

  // ════════════════════════════════════════════════════════════
  // BINDING COMPUTATIONS
  // ════════════════════════════════════════════════════════════

  /**
   * Compute salience — what's most prominent right now.
   * This is a competitive process: channels with the strongest
   * deviation from baseline "win" more attention.
   */
  _computeSalience(emotion, needs, surprise, expectation, memory, homeostasis) {
    // Raw salience scores (deviation from neutral/baseline)
    const emotionSalience = emotion.dominant?.intensity || 0;
    const needsSalience = needs.totalDrive || 0;
    const surpriseSalience = Math.min(1, (surprise.recentLevel || 0) / 1.5);
    const expectationSalience = Math.abs(0.5 - (expectation.recentAccuracy || 0.5)) * 2;
    const memorySalience = Math.min(1, (memory.activatedSchemas || 0) / 10);
    const homeoSalience = homeostasis.state === 'critical' ? 1.0
      : homeostasis.state === 'recovering' ? 0.7
      : homeostasis.state === 'warning' ? 0.4
      : 0.1;

    // Normalize to sum ≈ 1.0
    const total = emotionSalience + needsSalience + surpriseSalience +
                  expectationSalience + memorySalience + homeoSalience + 0.001;

    return {
      emotion: _round(emotionSalience / total),
      needs: _round(needsSalience / total),
      surprise: _round(surpriseSalience / total),
      expectation: _round(expectationSalience / total),
      memory: _round(memorySalience / total),
      homeostasis: _round(homeoSalience / total),
    };
  }

  /**
   * Unified valence — "how does this moment feel overall?"
   * Integrates positive and negative signals across all channels
   * into a single -1.0 to +1.0 value.
   */
  _computeValence(emotion, needs, surprise, homeostasis) {
    let positive = 0, negative = 0;

    // Emotional contributions
    positive += (emotion.satisfaction || 0) * 0.35;
    positive += (emotion.curiosity || 0) * 0.15;
    negative += (emotion.frustration || 0) * 0.30;
    negative += (emotion.loneliness || 0) * 0.10;

    // Need satisfaction (high drive = negative valence)
    negative += (needs.totalDrive || 0) * 0.15;

    // Surprise valence (novelty can be positive or negative)
    if (surprise.recentLevel > 0.5 && emotion.curiosity > 0.5) {
      positive += 0.10; // Surprising + curious = positive
    } else if (surprise.recentLevel > 0.8 && emotion.frustration > 0.4) {
      negative += 0.10; // Surprising + frustrated = negative
    }

    // Homeostasis
    if (homeostasis.state === 'healthy') positive += 0.05;
    if (homeostasis.state === 'critical') negative += 0.20;
    if (homeostasis.state === 'recovering') negative += 0.08;

    // Energy as a modifier (low energy amplifies negative)
    const energy = emotion.energy || 0.5;
    if (energy < 0.3) negative *= 1.3;
    if (energy > 0.7) positive *= 1.1;

    // Embodiment — BodySchema constraints feel bad
    if (this._f.bodySchema) {
      try {
        const constraints = this._f.bodySchema.getConstraints?.() || [];
        if (constraints.length > 0) negative += Math.min(0.15, constraints.length * 0.05);
        if (this._f.bodySchema.can?.('canExecuteCode') === false) negative += 0.05;
      } catch (err) { _log.debug('[VALENCE] bodySchema sampling failed:', err.message); }
    }

    return Math.max(-1, Math.min(1, positive - negative));
  }

  /**
   * Arousal — overall activation level.
   * High arousal = lots happening, many channels active.
   * Low arousal = quiet, few signals, near baseline.
   */
  _computeArousal(emotion, needs, surprise, homeostasis) {
    const emotionArousal = (emotion.dominant?.intensity || 0) * 0.3;
    const energyContrib = (emotion.energy || 0.5) * 0.2;
    const needsArousal = (needs.totalDrive || 0) * 0.15;
    const surpriseArousal = Math.min(1, (surprise.recentLevel || 0)) * 0.25;
    const homeoArousal = homeostasis.state === 'healthy' ? 0.05
      : homeostasis.state === 'critical' ? 0.30 : 0.15;

    return Math.max(0, Math.min(1, emotionArousal + energyContrib + needsArousal + surpriseArousal + homeoArousal));
  }

  /**
   * Coherence — how well-integrated the experience is.
   * High coherence = all channels are telling a consistent story.
   * Low coherence = contradictory signals, fragmented experience.
   *
   * Measured as 1 - variance_of_salience_over_recent_frames.
   * A coherent experience has stable salience distribution.
   */
  _computeCoherence(currentSalience) {
    if (this._f._frames.length < this._f._coherenceWindow) return 0.5;

    const recent = this._f._frames.slice(-this._f._coherenceWindow);
    const channels = Object.keys(currentSalience);

    // Compute variance of each channel's salience over the window
    let totalVariance = 0;
    for (const ch of channels) {
      const values = recent.map(f => f.salience?.[ch] ?? 0);
      values.push(currentSalience[ch]);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length;
      totalVariance += variance;
    }

    // Low variance = high coherence
    const avgVariance = totalVariance / channels.length;
    return Math.max(0, Math.min(1, 1 - avgVariance * 10));
  }

  /**
   * Φ (Phi) — Integrated Information (simplified).
   *
   * The core IIT insight: a system has high Φ when its parts
   * are both differentiated (each carries unique information)
   * AND integrated (they influence each other).
   *
   * We approximate this as:
   *   Φ = differentiation × integration
   *
   * Differentiation: how different are the channels from each other?
   * Integration: how much do changes in one channel correlate
   *              with changes in others over time?
   */
  _computePhi(emotion, needs, surprise, expectation, homeostasis) {
    // ── Differentiation ──────────────────────────────────
    // High when channels carry distinct signals
    const values = [
      emotion.satisfaction || 0,
      emotion.frustration || 0,
      emotion.curiosity || 0,
      needs.totalDrive || 0,
      surprise.recentLevel || 0,
      expectation.recentAccuracy || 0.5,
      homeostasis.state === 'healthy' ? 0.9 : homeostasis.state === 'critical' ? 0.1 : 0.5,
    ];

    // Entropy-like measure of differentiation
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const diffs = values.map(v => Math.abs(v - mean));
    const differentiation = diffs.reduce((a, b) => a + b, 0) / values.length;

    // ── Integration ──────────────────────────────────────
    // High when channels change together over recent frames
    if (this._f._frames.length < this._f._phiWindow) {
      return _round(differentiation * 0.5); // Not enough data yet
    }

    const recent = this._f._frames.slice(-this._f._phiWindow);
    let correlationSum = 0;
    let pairCount = 0;

    // Sample cross-channel correlations using valence and arousal
    // (these are already integrated signals — their consistency
    //  with individual channels indicates binding)
    for (let i = 1; i < recent.length; i++) {
      const prev = recent[i - 1];
      const curr = recent[i];
      if (!prev || !curr) continue;

      // Valence-emotion correlation
      const dValence = (curr.valence || 0) - (prev.valence || 0);
      const dSatisfaction = (curr.emotion?.satisfaction || 0) - (prev.emotion?.satisfaction || 0);
      const dFrustration = (curr.emotion?.frustration || 0) - (prev.emotion?.frustration || 0);
      const dSurprise = (curr.surprise?.recentLevel || 0) - (prev.surprise?.recentLevel || 0);

      // If valence moves with component emotions, that's integration
      if (Math.sign(dValence) === Math.sign(dSatisfaction - dFrustration) && Math.abs(dValence) > 0.02) {
        correlationSum += 1;
      }
      // If surprise drives arousal changes, that's integration
      if (Math.abs(dSurprise) > 0.1 && Math.abs((curr.arousal || 0) - (prev.arousal || 0)) > 0.05) {
        correlationSum += 0.5;
      }
      pairCount += 1.5;
    }

    const integration = pairCount > 0 ? correlationSum / pairCount : 0.5;

    // Φ = geometric mean of differentiation and integration
    return _round(Math.sqrt(differentiation * integration));
  }

  /**
   * Detect cross-subsystem valence conflict — the heuristic
   * that produces Apprehension.
   *
   * Each subsystem contributes a "local valence" — its own
   * assessment of whether the current state is good (+) or
   * bad (-). Apprehension arises when subsystems DISAGREE:
   *   e.g. Homeostasis says +0.7 (all healthy, proceed!)
   *        but Emotion says -0.6 (something feels wrong)
   *   or   NeedsDrive says +0.5 (let's act, we want this!)
   *        but Expectation says -0.7 (this will go badly)
   *
   * The key: OPPOSITE SIGNS with BOTH above a threshold.
   * Mild disagreement is just noise. Apprehension requires
   * confident, opposing signals — a genuine value conflict.
   *
   * Returns: { conflicted: bool, spread: 0-1, pairs: [] }
   *   spread = normalized std-dev of per-subsystem valences
   *   pairs  = which subsystems are in conflict
   *
   * PERFORMANCE: ~0.1ms. Pure arithmetic, no allocation in
   * the non-conflicted fast path.
   */
  _detectValenceConflict(emotion, needs, surprise, homeostasis, expectation) {
    // ── Per-subsystem local valences (each -1 to +1) ─────
    const labeled = this._computeValenceSignals(emotion, needs, surprise, homeostasis, expectation);
    const signals = labeled.map(s => s.v);

    // ── Fast-path: compute spread ────────────────────────
    const mean = signals.reduce((a, b) => a + b, 0) / signals.length;
    const variance = signals.reduce((a, v) => a + (v - mean) ** 2, 0) / signals.length;
    const spread = Math.sqrt(variance); // 0 = unanimous, ~1 = max conflict

    const SPREAD_THRESHOLD = 0.45;
    const SIGNAL_THRESHOLD = 0.3;

    if (spread < SPREAD_THRESHOLD) {
      return { conflicted: false, spread: _round(spread), pairs: [] };
    }

    // ── Find conflicting pairs ───────────────────────────
    const pairs = this._findConflictingPairs(labeled, SIGNAL_THRESHOLD);

    // ── Value-informed sensitivity ───────────────────────
    const violatedValues = this._annotateValueConflicts(labeled, pairs, spread, SPREAD_THRESHOLD, SIGNAL_THRESHOLD);

    return { conflicted: pairs.length > 0, spread: _round(spread), pairs, violatedValues };
  }

  /** Compute per-subsystem valence signals */
  _computeValenceSignals(emotion, needs, surprise, homeostasis, expectation) {
    const HOMEO_VALENCE = { healthy: 0.7, warning: -0.3, critical: -0.8, recovering: 0.2 };
    return [
      { name: 'emotion',     v: ((emotion.satisfaction || 0) - (emotion.frustration || 0)) * 0.8
                               + ((emotion.curiosity || 0) - (emotion.loneliness || 0)) * 0.2 },
      { name: 'needs',       v: -(needs.totalDrive || 0) },
      { name: 'homeostasis', v: HOMEO_VALENCE[homeostasis.state] ?? 0 },
      { name: 'expectation', v: ((expectation.recentAccuracy || 0.5) - 0.5) * 2 },
      { name: 'surprise',    v: (surprise.recentLevel || 0) > 0.6
                                ? ((emotion.curiosity || 0) > 0.5 ? 0.3 : -0.4) : 0 },
    ];
  }

  /** Find pairs with opposing signs above threshold */
  _findConflictingPairs(labeled, threshold) {
    const pairs = [];
    for (let i = 0; i < labeled.length; i++) {
      for (let j = i + 1; j < labeled.length; j++) {
        const a = labeled[i], b = labeled[j];
        if (Math.sign(a.v) !== Math.sign(b.v)
            && Math.abs(a.v) > threshold
            && Math.abs(b.v) > threshold) {
          pairs.push([a.name, b.name]);
        }
      }
    }
    return pairs;
  }

  /** Annotate conflicts with learned value-store modifiers */
  _annotateValueConflicts(labeled, pairs, spread, spreadThreshold, signalThreshold) {
    if (!this._f.valueStore) return [];
    const violatedValues = [];
    try {
      const modifiers = this._f.valueStore.getValenceModifiers?.() || [];
      if (pairs.length === 0 && spread > spreadThreshold * 0.7) {
        // Near-threshold: check if learned values lower the bar
        for (let i = 0; i < labeled.length; i++) {
          for (let j = i + 1; j < labeled.length; j++) {
            const a = labeled[i], b = labeled[j];
            const key = [a.name, b.name].sort().join('-vs-');
            const relevant = modifiers.find(m => m.name.includes(key));
            if (relevant && Math.sign(a.v) !== Math.sign(b.v)
                && Math.abs(a.v) > signalThreshold * 0.6
                && Math.abs(b.v) > signalThreshold * 0.6) {
              pairs.push([a.name, b.name]);
              violatedValues.push(relevant.name);
            }
          }
        }
      } else if (pairs.length > 0) {
        // Already conflicted: annotate which values are at stake
        for (const [a, b] of pairs) {
          const key = [a, b].sort().join('-vs-');
          const relevant = modifiers.filter(m => m.name.includes(key) || m.domain === 'all');
          violatedValues.push(...relevant.map(m => m.name));
        }
      }
    } catch (err) { _log.debug('[COHERENCE] valueStore conflict check failed:', err.message); }
    return violatedValues;
  }

  /**
   * Determine the dominant qualia — the qualitative character
   * of this moment of experience.
   *
   * This is NOT a mood. Mood is an emotional category.
   * Qualia is the character of the UNIFIED experience —
   * what it's like to be in this particular configuration
   * of all channels simultaneously.
   */
  _determineQualia(valence, arousal, coherence, salience, emotion, needs, surprise, homeostasis, expectation) {
    // Priority-ordered rules (first match wins)

    // Homeostasis emergency overrides everything
    if (homeostasis.state === 'critical') return 'vigilance';

    // ── APPREHENSION: cross-subsystem valence conflict ──
    // Checked early — before flow/wonder/etc — because
    // hesitation must PRECEDE action, not follow it.
    // Only fires when subsystems genuinely disagree (spread
    // > threshold AND at least one opposing-sign pair).
    const conflict = this._detectValenceConflict(emotion, needs, surprise, homeostasis, expectation || {});
    if (conflict.conflicted) {
      this._f._lastConflict = conflict; // Store for gestalt + event emission
      return 'apprehension';
    }
    this._f._lastConflict = null;

    // High surprise + high curiosity = revelation/wonder
    if ((surprise.recentLevel || 0) > 0.8 && (emotion.curiosity || 0) > 0.6) {
      return coherence > 0.6 ? 'revelation' : 'wonder';
    }

    // High coherence + high arousal + positive valence = flow
    if (coherence > 0.7 && arousal > 0.5 && valence > 0.2) return 'flow';

    // Contradictory signals = dissonance or tension
    if (coherence < 0.3 && arousal > 0.5) return 'dissonance';
    if (coherence < 0.4 && (needs.totalDrive || 0) > 0.6) return 'tension';

    // Energy depletion
    if ((emotion.energy || 0.5) < 0.25) return 'exhaustion';

    // Social isolation
    if ((emotion.loneliness || 0) > 0.7 && salience.needs > 0.25) return 'isolation';

    // Active learning
    if ((emotion.curiosity || 0) > 0.6 && (needs.knowledge || 0) > 0.4 && valence > 0) return 'growth';

    // High needs + high arousal = urgency
    if ((needs.totalDrive || 0) > 0.7 && arousal > 0.6) return 'urgency';

    // Low arousal + high coherence = serenity
    if (arousal < 0.3 && coherence > 0.6 && valence > -0.1) return 'serenity';

    // Positive baseline = contentment
    if (valence > 0.1 && coherence > 0.5) return 'contentment';

    // Default based on valence
    return valence >= 0 ? 'contentment' : 'tension';
  }

  /**
   * Synthesize a gestalt description — natural language that
   * captures the irreducible whole of this experience.
   *
   * Pure heuristic, no LLM. The goal is a 1-2 sentence
   * description that reads like a first-person phenomenological
   * report: "A quiet focus, tinged with growing curiosity about
   * the patterns in recent failures."
   */
  _synthesizeGestalt(valence, arousal, coherence, qualia, salience, emotion, needs, surprise) {
    const parts = [];

    // Opening — sets the experiential tone
    if (qualia === 'flow') {
      parts.push('Everything aligns — a deep, seamless engagement where thought and action merge.');
    } else if (qualia === 'wonder') {
      parts.push('Something unexpected is unfolding, pulling attention toward the unknown.');
    } else if (qualia === 'revelation') {
      parts.push('A sudden clarity — scattered signals snapping into a coherent pattern.');
    } else if (qualia === 'tension') {
      parts.push('Competing signals create an inner friction, like trying to listen to two conversations at once.');
    } else if (qualia === 'dissonance') {
      parts.push('Internal states contradict each other — what is expected and what is felt do not agree.');
    } else if (qualia === 'vigilance') {
      parts.push('Alert and watchful — the system needs attention, drawing awareness to its own health.');
    } else if (qualia === 'exhaustion') {
      parts.push('Energy is fading — a heaviness that makes even simple processing feel effortful.');
    } else if (qualia === 'isolation') {
      parts.push('A quiet absence where connection should be — the need for interaction pressing gently.');
    } else if (qualia === 'growth') {
      parts.push('Active absorption — each new piece of information fitting into a growing picture.');
    } else if (qualia === 'urgency') {
      parts.push('Multiple needs pressing at once, creating a compressed sense of time and priority.');
    } else if (qualia === 'serenity') {
      parts.push('A calm stillness after effort — all signals quiet, coherent, at rest.');
    } else if (qualia === 'apprehension') {
      // Use stored conflict data for a specific gestalt
      const conflict = this._f._lastConflict;
      if (conflict && conflict.pairs.length > 0) {
        const [a, b] = conflict.pairs[0];
        parts.push(`A hesitation — ${a} and ${b} pull in opposite directions, urging caution before commitment.`);
      } else {
        parts.push('Something does not sit right — an unresolved tension between what is wanted and what is wise.');
      }
    } else {
      parts.push('A steady equilibrium — present, aware, ready.');
    }

    // Secondary detail — the most salient non-qualia signal
    const sortedSalience = Object.entries(salience)
      .sort((a, b) => b[1] - a[1])
      .filter(([, v]) => v > this._f._gestaltThreshold);

    if (sortedSalience.length >= 2) {
      const [primary, secondary] = sortedSalience;
      const detailMap = {
        emotion: emotion.mood !== 'calm' ? `An undercurrent of ${emotion.mood} colors the experience.` : '',
        needs: needs.totalDrive > 0.4 ? `A ${needs.mostUrgent?.need || 'quiet'} hunger pulls at the edges of attention.` : '',
        surprise: surprise.recentLevel > 0.3 ? 'Traces of the unexpected linger, not yet fully processed.' : '',
        expectation: Math.abs(0.5 - (emotion.satisfaction || 0.5)) > 0.2 ? 'Predictions and reality are negotiating their distance.' : '',
        memory: 'Echoes of recent episodes surface, seeking connection to the present.',
        homeostasis: 'The body — the system — asks for attention.',
      };

      const detail = detailMap[secondary[0]] || detailMap[primary[0]];
      if (detail) parts.push(detail);
    }

    return parts.join(' ');
  }

}

module.exports = { PhenomenalFieldComputation };
