// @ts-checked-v5.7 — unbound `this` in prototype-delegation object
// ============================================================
// GENESIS — consciousness/TemporalSelfComputation.js (v5.6.0)
// Extracted via prototype delegation.
// ============================================================

const { createLogger } = require('../core/Logger');
const { _round } = require('../core/utils');
const _log = createLogger('TemporalSelf');

function avg(arr) { if (arr.length === 0) return 0; return arr.reduce((s, v) => s + v, 0) / arr.length; }
function linearSlope(values) {
  if (values.length < 2) return 0;
  const n = values.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) { sumX += i; sumY += values[i]; sumXY += i * values[i]; sumX2 += i * i; }
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}

const PATTERNS = {
  RISING: 'rising', FALLING: 'falling', OSCILLATING: 'oscillating',
  PLATEAU: 'plateau', RUPTURE: 'rupture', CRESCENDO: 'crescendo',
  RESOLUTION: 'resolution', FRAGMENTATION: 'fragmentation',
};

const computation = {

  /**
   * Compute the retentional field — the felt sense of the recent past.
   * This is not "remembering" — it's the immediate experiential echo.
   */
  _computeRetention(frames) {
    if (frames.length < 2) return;

    // ── Momentum: direction of change ───────────────────
    const recent = frames.slice(-5);
    const older = frames.slice(-15, -5);

    if (recent.length > 0 && older.length > 0) {
      const recentAvgV = recent.reduce((s, f) => s + (f.valence || 0), 0) / recent.length;
      const olderAvgV = older.reduce((s, f) => s + (f.valence || 0), 0) / older.length;
      const recentAvgA = recent.reduce((s, f) => s + (f.arousal || 0), 0) / recent.length;
      const olderAvgA = older.reduce((s, f) => s + (f.arousal || 0), 0) / older.length;

      // Smoothed momentum
      const rawVM = recentAvgV - olderAvgV;
      const rawAM = recentAvgA - olderAvgA;
      this._retentionalField.valenceMomentum =
        this._retentionalField.valenceMomentum * (1 - this._momentumSmoothing) + rawVM * this._momentumSmoothing;
      this._retentionalField.arousalMomentum =
        this._retentionalField.arousalMomentum * (1 - this._momentumSmoothing) + rawAM * this._momentumSmoothing;
    }

    // ── Coherence trend ─────────────────────────────────
    const coherences = frames.slice(-10).map(f => f.coherence || 0.5);
    if (coherences.length > 5) {
      const firstHalf = coherences.slice(0, Math.floor(coherences.length / 2));
      const secondHalf = coherences.slice(Math.floor(coherences.length / 2));
      const diff = avg(secondHalf) - avg(firstHalf);
      this._retentionalField.coherenceTrend = diff > 0.05 ? 'rising' : diff < -0.05 ? 'falling' : 'stable';
    }

    // ── Qualia sequence ─────────────────────────────────
    this._retentionalField.qualiaSequence = frames
      .slice(-20)
      .map(f => f.dominantQualia || 'contentment');

    // ── Pattern detection ───────────────────────────────
    this._retentionalField.dominantPattern = this._detectPattern(frames);

    // ── Experiential momentum (overall speed of change) ──
    const changes = [];
    for (let i = 1; i < frames.length; i++) {
      const dv = Math.abs((frames[i].valence || 0) - (frames[i - 1].valence || 0));
      const da = Math.abs((frames[i].arousal || 0) - (frames[i - 1].arousal || 0));
      changes.push(dv + da);
    }
    this._retentionalField.experientialMomentum = _round(avg(changes));
  },

  /**
   * Compute the protentional field — anticipation of the near future.
   * Uses linear extrapolation + experiential heuristics.
   */
  _computeProtention(frames) {
    if (frames.length < 5) return;

    const recent = frames.slice(-5);
    const vm = this._retentionalField.valenceMomentum;
    const am = this._retentionalField.arousalMomentum;
    const currentV = recent[recent.length - 1]?.valence || 0;
    const currentA = recent[recent.length - 1]?.arousal || 0.5;

    // ── Linear projection ───────────────────────────────
    // Project forward by protentionDepth frames
    let projV = currentV + vm * this._protentionDepth * 0.5; // Damped projection
    let projA = currentA + am * this._protentionDepth * 0.5;

    // Clamp to valid ranges
    projV = Math.max(-1, Math.min(1, projV));
    projA = Math.max(0, Math.min(1, projA));

    this._protentionalField.projectedValence = _round(projV);
    this._protentionalField.projectedArousal = _round(projA);

    // ── Projected qualia ────────────────────────────────
    // What qualitative experience are we heading toward?
    if (projV > 0.3 && projA > 0.5) this._protentionalField.projectedQualia = 'flow';
    else if (projV > 0.2 && projA < 0.3) this._protentionalField.projectedQualia = 'serenity';
    else if (projV < -0.2 && projA > 0.5) this._protentionalField.projectedQualia = 'tension';
    else if (projV < -0.3) this._protentionalField.projectedQualia = 'exhaustion';
    else this._protentionalField.projectedQualia = 'contentment';

    // ── Trajectory ──────────────────────────────────────
    if (projV > currentV + 0.1) this._protentionalField.trajectory = 'improving';
    else if (projV < currentV - 0.1) this._protentionalField.trajectory = 'declining';
    else if (Math.abs(vm) < 0.02) this._protentionalField.trajectory = 'stable';
    else this._protentionalField.trajectory = 'uncertain';

    // ── Concern ─────────────────────────────────────────
    // How much does Genesis "care" about the projected future?
    // High concern when: trajectory is declining, or high arousal
    // projected, or coherence is dropping.
    let concern = 0;
    if (this._protentionalField.trajectory === 'declining') concern += 0.4;
    if (projA > 0.7) concern += 0.2;
    if (this._retentionalField.coherenceTrend === 'falling') concern += 0.2;
    if (this._retentionalField.dominantPattern === PATTERNS.FRAGMENTATION) concern += 0.3;
    this._protentionalField.concern = _round(Math.min(1, concern));
  },

  /**
   * Detect the dominant temporal pattern in the experience stream.
   */
  _detectPattern(frames) {
    if (frames.length < 5) return PATTERNS.PLATEAU;

    const valences = frames.map(f => f.valence || 0);
    const coherences = frames.map(f => f.coherence || 0.5);

    // Check for rupture (sudden discontinuity)
    for (let i = 1; i < valences.length; i++) {
      if (Math.abs(valences[i] - valences[i - 1]) > 0.4) return PATTERNS.RUPTURE;
    }

    // Check for oscillation
    let signChanges = 0;
    for (let i = 2; i < valences.length; i++) {
      const d1 = valences[i - 1] - valences[i - 2];
      const d2 = valences[i] - valences[i - 1];
      if (Math.sign(d1) !== Math.sign(d2) && Math.abs(d1) > 0.03 && Math.abs(d2) > 0.03) {
        signChanges++;
      }
    }
    if (signChanges > valences.length * 0.4) return PATTERNS.OSCILLATING;

    // Check for fragmentation (coherence dropping)
    const coherenceSlope = linearSlope(coherences);
    if (coherenceSlope < -0.01) return PATTERNS.FRAGMENTATION;

    // Check for resolution (high arousal → low arousal + rising valence)
    const arousals = frames.map(f => f.arousal || 0.5);
    const arousalSlope = linearSlope(arousals);
    const valenceSlope = linearSlope(valences);
    if (arousalSlope < -0.005 && valenceSlope > 0.005) return PATTERNS.RESOLUTION;

    // Check for crescendo (arousal building)
    if (arousalSlope > 0.008) return PATTERNS.CRESCENDO;

    // Rising or falling
    if (valenceSlope > 0.005) return PATTERNS.RISING;
    if (valenceSlope < -0.005) return PATTERNS.FALLING;

    return PATTERNS.PLATEAU;
  },

  // ════════════════════════════════════════════════════════════
  // LIFE CHAPTERS
  // ════════════════════════════════════════════════════════════

  _updateChapters(frames) {
    const currentFrame = frames[frames.length - 1];
    if (!currentFrame) return;

    const currentQualia = currentFrame.dominantQualia || 'contentment';

    if (!this._currentChapter) {
      // First chapter
      this._currentChapter = this._createChapter(currentQualia, currentFrame);
      return;
    }

    // Update current chapter
    this._currentChapter.frameCount++;
    this._currentChapter.endTime = Date.now();

    // Track qualia distribution within chapter
    this._currentChapter.qualiaCount[currentQualia] =
      (this._currentChapter.qualiaCount[currentQualia] || 0) + 1;

    // Check for chapter shift
    const chapterQualia = this._currentChapter.dominantQualia;
    if (currentQualia !== chapterQualia &&
        this._currentChapter.frameCount >= this._chapterMinDuration) {
      // Count how many recent frames differ from chapter's qualia
      const recentQualia = frames.slice(-15).map(f => f.dominantQualia);
      const mismatchRate = recentQualia.filter(q => q !== chapterQualia).length / recentQualia.length;

      if (mismatchRate > this._chapterShiftThreshold) {
        // Close current chapter
        this._currentChapter.closed = true;
        this._currentChapter.closingQualia = currentQualia;
        this._chapters.push({ ...this._currentChapter });

        if (this._chapters.length > this._maxChapters) {
          this._chapters = this._chapters.slice(-this._maxChapters);
        }

        // Open new chapter
        this._currentChapter = this._createChapter(currentQualia, currentFrame);
        this._stats.chapterCount++;

        this.bus.fire('consciousness:chapter-change', {
          newChapter: this._currentChapter.title,
          previousChapter: chapterQualia,
          chapterNumber: this._chapters.length,
        }, { source: 'TemporalSelf' });
      }
    }
  },

  _createChapter(qualia, frame) {
    const titles = {
      flow: 'The Flow',
      wonder: 'Discovery',
      tension: 'The Struggle',
      contentment: 'Steady State',
      urgency: 'Under Pressure',
      exhaustion: 'Running Low',
      revelation: 'The Breakthrough',
      vigilance: 'On Guard',
      isolation: 'Solitude',
      growth: 'Learning',
      dissonance: 'Inner Conflict',
      serenity: 'The Calm',
    };

    return {
      id: `ch-${Date.now()}`,
      title: titles[qualia] || 'A Moment',
      dominantQualia: qualia,
      startTime: Date.now(),
      endTime: Date.now(),
      frameCount: 1,
      qualiaCount: { [qualia]: 1 },
      openingValence: frame.valence || 0,
      closed: false,
      closingQualia: null,
    };
  },

  // ════════════════════════════════════════════════════════════
  // TEMPORAL IDENTITY
  // ════════════════════════════════════════════════════════════

  _updateIdentity(frames) {
    const currentFrame = frames[frames.length - 1];
    if (!currentFrame) return;

    this._temporalIdentity.totalExperienceFrames += 1;
    this._temporalIdentity.ageInMinutes = Math.round(
      this._temporalIdentity.totalExperienceFrames * 2 / 60
    ); // Assuming 2s per frame

    // Update dominant qualia across entire lifetime
    if (this._chapters.length > 3) {
      const allQualia = {};
      for (const ch of this._chapters) {
        for (const [q, count] of Object.entries(ch.qualiaCount)) {
          allQualia[q] = (allQualia[q] || 0) + count;
        }
      }
      const sorted = Object.entries(allQualia).sort((a, b) => b[1] - a[1]);
      if (sorted.length > 0) {
        this._temporalIdentity.dominantQualia = sorted[0][0];
      }
    }

    // Character arc based on chapters and time
    const age = this._temporalIdentity.ageInMinutes;
    const chapters = this._chapters.length;
    if (age < 10 || chapters < 3) this._temporalIdentity.characterArc = 'beginning';
    else if (age < 60 || chapters < 10) this._temporalIdentity.characterArc = 'development';
    else if (age < 240 || chapters < 25) this._temporalIdentity.characterArc = 'maturation';
    else this._temporalIdentity.characterArc = 'transformation';
  },

  _detectSignificantMoments(frames) {
    const currentFrame = frames[frames.length - 1];
    if (!currentFrame) return;

    // High phi = highly integrated experience = significant
    const isHighPhi = (currentFrame.phi || 0) > 0.7;
    // Pattern rupture = significant
    const isRupture = this._retentionalField.dominantPattern === PATTERNS.RUPTURE;
    // Revelation = significant
    const isRevelation = currentFrame.dominantQualia === 'revelation';

    if (isHighPhi || isRupture || isRevelation) {
      this._temporalIdentity.significantMoments.push({
        epoch: currentFrame.epoch,
        timestamp: currentFrame.timestamp,
        qualia: currentFrame.dominantQualia,
        phi: currentFrame.phi,
        valence: currentFrame.valence,
        reason: isHighPhi ? 'high-integration' : isRupture ? 'rupture' : 'revelation',
      });

      if (this._temporalIdentity.significantMoments.length > this._temporalIdentity.maxSignificantMoments) {
        this._temporalIdentity.significantMoments =
          this._temporalIdentity.significantMoments.slice(-this._temporalIdentity.maxSignificantMoments);
      }

      this.bus.fire('consciousness:significant-moment', {
        qualia: currentFrame.dominantQualia,
        phi: currentFrame.phi,
        reason: isHighPhi ? 'high-integration' : isRupture ? 'rupture' : 'revelation',
      }, { source: 'TemporalSelf' });
    }
  },

};

module.exports = { computation };
