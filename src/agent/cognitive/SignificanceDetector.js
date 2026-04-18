// @ts-checked-v5.7
// ============================================================
// GENESIS — cognitive/SignificanceDetector.js (v7.3.1)
// ------------------------------------------------------------
// Detects moments that are candidates for Core Memories.
// Threshold: 4 of 6 signals → create a Core Memory.
// Below threshold: still logged as Candidate for later calibration.
//
// THE SIX SIGNALS (all pure functions, individually testable):
//   1. persistent-emotion   — emotion above baseline for ≥10 min
//   2. user-beteiligung     — user responded ≥3 times in time window
//   3. novelty              — theme/name not in episodic memory (30 days)
//   4. problem-to-solution  — frustration >0.5 → joy >0.5 within 30 min
//   5. naming-event         — regex: "ich nenne" / "let's call" / "name it"
//   6. explicit-flag        — user: "remember this" / "nie vergessen"
//
// Inputs come from callers who assemble `event` from their domain:
// - EmotionalState history snapshot
// - ConversationMemory recent turns
// - KnowledgeGraph for novelty check
// - User message text for flag detection
//
// Each signal returns { detected: boolean, evidence: object } so the
// caller can log even partial matches for future threshold calibration.
// ============================================================

'use strict';

const THRESHOLD = 4;

// ── Signal 1: Persistent Emotion ────────────────────────────
/**
 * @param {object} input
 *   emotionHistory: Array<{ dim, value, baseline, ts }>
 *   now: number (timestamp)
 *   minDurationMs: number (default 10 min)
 * @returns {{ detected: boolean, evidence: object }}
 */
function persistentEmotion({ emotionHistory, now = Date.now(), minDurationMs = 10 * 60 * 1000 } = {}) {
  if (!Array.isArray(emotionHistory) || emotionHistory.length === 0) {
    return { detected: false, evidence: { reason: 'no history' } };
  }

  // Group samples by dimension, find earliest sample for each dim that
  // stays above baseline continuously until now.
  const byDim = new Map();
  for (const s of emotionHistory) {
    if (!byDim.has(s.dim)) byDim.set(s.dim, []);
    byDim.get(s.dim).push(s);
  }

  for (const [dim, samples] of byDim) {
    // Sort chronologically
    samples.sort((a, b) => a.ts - b.ts);
    // Find the longest tail-run where value > baseline
    let runStart = null;
    for (let i = samples.length - 1; i >= 0; i--) {
      const s = samples[i];
      if (s.value > (s.baseline || 0.5)) {
        runStart = s.ts;
      } else {
        break;
      }
    }
    if (runStart && (now - runStart) >= minDurationMs) {
      return {
        detected: true,
        evidence: { dim, durationMs: now - runStart, sinceValue: samples[samples.length - 1].value },
      };
    }
  }
  return { detected: false, evidence: { reason: 'no sustained elevation' } };
}

// ── Signal 2: User-Beteiligung ───────────────────────────────
/**
 * @param {object} input
 *   userMessages: Array<{ ts, text }>
 *   windowStartMs: number
 *   windowEndMs: number
 *   minCount: number (default 3)
 */
function userBeteiligung({ userMessages = [], windowStartMs, windowEndMs, minCount = 3 } = {}) {
  const inWindow = userMessages.filter(m =>
    m.ts >= windowStartMs && m.ts <= windowEndMs);
  const detected = inWindow.length >= minCount;
  return {
    detected,
    evidence: { count: inWindow.length, window: [windowStartMs, windowEndMs] },
  };
}

// ── Signal 3: Novelty ───────────────────────────────────────
/**
 * @param {object} input
 *   subject: string (the thing being evaluated for novelty)
 *   episodicSummaries: Array<string> (recent episodes' text)
 *   daysBack: number (default 30)
 */
function novelty({ subject, episodicSummaries = [] } = {}) {
  if (!subject || typeof subject !== 'string' || subject.length < 2) {
    return { detected: false, evidence: { reason: 'no subject' } };
  }
  const subjectLower = subject.toLowerCase();
  // "Novel" = subject (as substring) never appeared in any episodic summary
  const appearances = episodicSummaries.filter(s =>
    s && s.toLowerCase().includes(subjectLower)).length;
  return {
    detected: appearances === 0,
    evidence: { subject: subject.slice(0, 50), appearances, scanned: episodicSummaries.length },
  };
}

// ── Signal 4: Problem-to-Solution-Span ───────────────────────
/**
 * Frustration peak followed by joy/satisfaction peak within 30 min.
 * @param {object} input
 *   emotionHistory: Array<{ dim, value, ts }>
 *   windowMs: number (default 30 min)
 */
function problemToSolution({ emotionHistory = [], windowMs = 30 * 60 * 1000 } = {}) {
  const frustPeaks = emotionHistory
    .filter(s => s.dim === 'frustration' && s.value > 0.5)
    .sort((a, b) => a.ts - b.ts);
  if (frustPeaks.length === 0) {
    return { detected: false, evidence: { reason: 'no frustration peak' } };
  }

  // Satisfaction is the closest real dimension to "joy"
  const satisfactionPeaks = emotionHistory
    .filter(s => s.dim === 'satisfaction' && s.value > 0.5)
    .sort((a, b) => a.ts - b.ts);

  for (const f of frustPeaks) {
    const relief = satisfactionPeaks.find(s => s.ts > f.ts && s.ts - f.ts <= windowMs);
    if (relief) {
      return {
        detected: true,
        evidence: { frustAt: f.ts, reliefAt: relief.ts, spanMs: relief.ts - f.ts },
      };
    }
  }
  return { detected: false, evidence: { reason: 'no relief within window' } };
}

// ── Signal 5: Naming-Event ──────────────────────────────────
const NAMING_PATTERNS = [
  /\b(ich nenne|let'?s? call|let us call|name it|nennen wir|nennen sie es|der name ist|its name is|du heißt)\b/i,
  /\b(benenne|baptize|heisst|heißt nun|from now on.*is called|shall be (called|known as))\b/i,
];

function namingEvent({ text = '' } = {}) {
  if (!text || typeof text !== 'string') {
    return { detected: false, evidence: { reason: 'no text' } };
  }
  for (const pattern of NAMING_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return {
        detected: true,
        evidence: { phrase: match[0], source: 'user-message' },
      };
    }
  }
  return { detected: false, evidence: { scanned: text.length } };
}

// ── Signal 6: Explicit-Flag ──────────────────────────────────
const EXPLICIT_PATTERNS = [
  /\b(remember this|never forget|nie vergessen|das war wichtig|this matters|worth remembering|core memory|kern-?erinnerung)\b/i,
  /\b(wichtig für mich|important to me|don'?t forget|mark this)\b/i,
];

function explicitFlag({ text = '' } = {}) {
  if (!text || typeof text !== 'string') {
    return { detected: false, evidence: { reason: 'no text' } };
  }
  for (const pattern of EXPLICIT_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return {
        detected: true,
        evidence: { phrase: match[0] },
      };
    }
  }
  return { detected: false, evidence: { scanned: text.length } };
}

// ── Aggregate: detect all 6, produce report ──────────────────
/**
 * Run all 6 signal detectors, return aggregate result.
 * @param {object} input - all fields for all detectors
 * @returns {{ triggered: boolean, signalCount: number, signals: string[], allResults: object }}
 */
function detectAll(input) {
  const results = {
    'persistent-emotion': persistentEmotion(input),
    'user-beteiligung': userBeteiligung(input),
    'novelty': novelty(input),
    'problem-to-solution': problemToSolution(input),
    'naming-event': namingEvent(input),
    'explicit-flag': explicitFlag(input),
  };

  const detectedSignals = Object.entries(results)
    .filter(([, r]) => r.detected)
    .map(([name]) => name);

  return {
    triggered: detectedSignals.length >= THRESHOLD,
    signalCount: detectedSignals.length,
    signals: detectedSignals,
    allResults: results,
  };
}

module.exports = {
  persistentEmotion,
  userBeteiligung,
  novelty,
  problemToSolution,
  namingEvent,
  explicitFlag,
  detectAll,
  THRESHOLD,
};
