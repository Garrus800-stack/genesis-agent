// ============================================================
// GENESIS — proactiveSelfExpression/Scoring.js (v7.7.9 Phase 2)
//
// Score a candidate thought from InnerSpeech: would publishing it as a
// self-initiated chat message be worth Garrus's attention right now?
//
// The score is a weighted sum of internal signals only. By design,
// nothing here is a function of user reactions — no "did Garrus reply
// to the last self-message", no "is Garrus typing", no engagement-
// optimizer term. The CI guard (v779-anti-pattern-guard) enforces this
// at file-content level: words like `replied`, `engagement`, `retention`,
// `dwell`, `session_length` cause the build to fail.
//
// PSE does NOT condition on user reactions. Genesis writes from
// internal state, not to please. (Cheng et al. 2025: systems
// optimized for user-satisfaction reduce prosocial behaviour and
// increase dependency. We refuse to optimize for that signal.)
// ============================================================

'use strict';

// ── Weights ────────────────────────────────────────────────
//
// Sum of positive weights = 1.00; negatives are dampeners that pull score
// down when the same kind has fired recently or the daily volume is high.
const W = {
  significance:        0.40,
  novelty:             0.25,
  emotionalIntensity:  0.20,
  timeBoost:           0.15,
  perKindRecency:     -0.20,
  dailyCount:         -0.05,
};

// Time-boost cap: an old thought should not boost forever. Four hours
// is enough for a recent plan-failure to keep some weight; older than
// that, it has aged out of relevance.
const TIME_BOOST_CAP_MS = 4 * 60 * 60 * 1000;
const TIME_BOOST_HALF_LIFE_MS = 30 * 60 * 1000;  // 30 min

// Per-kind recency dampener: if the same kind fired N minutes ago, this
// term goes from 1.0 (just now) to 0.0 (older than this window).
const PER_KIND_RECENCY_WINDOW_MS = 90 * 60 * 1000;  // 90 min

/**
 * Compute emotional intensity from an emotionalSnapshot.
 *
 * Intensity is "how much is something happening internally" — high
 * curiosity + high frustration both count, even though they pull in
 * opposite valences. The score is meant to surface when Genesis is
 * stirred, not when he is in a particular mood.
 *
 * Returns a value in [0, 1].
 */
function computeEmotionalIntensity(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return 0;
  const dims = ['curiosity', 'frustration', 'satisfaction', 'energy'];
  let sumSq = 0;
  let count = 0;
  for (const d of dims) {
    const v = snapshot[d];
    if (typeof v === 'number' && Number.isFinite(v)) {
      // Center around 0.5 (neutral) and square — distance from neutral
      // either way registers.
      const delta = (v - 0.5) * 2;  // [-1, 1]
      sumSq += delta * delta;
      count++;
    }
  }
  if (count === 0) return 0;
  // Average squared deviation, sqrt back, clamp to [0, 1].
  const intensity = Math.sqrt(sumSq / count);
  return Math.min(1, Math.max(0, intensity));
}

/**
 * Compute time-boost: how recent is this thought? Newer thoughts get
 * a boost up to TIME_BOOST_CAP_MS; older than that → 0.
 */
function computeTimeBoost(thoughtTimestamp, now = Date.now()) {
  if (typeof thoughtTimestamp !== 'number') return 0;
  const ageMs = Math.max(0, now - thoughtTimestamp);
  if (ageMs >= TIME_BOOST_CAP_MS) return 0;
  // Exponential decay with 30-min half-life, capped to the cap.
  return Math.exp(-ageMs / TIME_BOOST_HALF_LIFE_MS);
}

/**
 * Compute per-kind recency dampener: how recently did the same kind fire
 * a self-message?  1.0 = just now, 0.0 = older than the window.
 */
function computePerKindRecency(lastFireOfKindMs, now = Date.now()) {
  if (typeof lastFireOfKindMs !== 'number') return 0;
  const ageMs = Math.max(0, now - lastFireOfKindMs);
  if (ageMs >= PER_KIND_RECENCY_WINDOW_MS) return 0;
  return 1 - (ageMs / PER_KIND_RECENCY_WINDOW_MS);
}

/**
 * Compute daily count dampener: penalize each additional self-message
 * fired today.  Each message adds 0.05 penalty; capped so total
 * dampener never exceeds the weight.
 */
function computeDailyCountDampener(dailyCount) {
  const c = typeof dailyCount === 'number' ? Math.max(0, dailyCount) : 0;
  return Math.min(1, c * 0.5);  // 2 messages today → full penalty
}

/**
 * Score a thought.
 *
 * @param {object} thought — InnerSpeech thought with significance, novelty, emotionalSnapshot, timestamp
 * @param {object} context — { now, lastFireOfKindMs?, dailyCount? }
 * @returns {{ score: number, components: object }} — components for /proactive-status logging
 */
function scoreThought(thought, context = {}) {
  const now = context.now || Date.now();

  const sig = clamp01(thought?.significance);
  const nov = clamp01(thought?.novelty);
  const emo = computeEmotionalIntensity(thought?.emotionalSnapshot);
  const tBoost = computeTimeBoost(thought?.timestamp, now);
  const kindRecency = computePerKindRecency(context.lastFireOfKindMs, now);
  const dailyDampen = computeDailyCountDampener(context.dailyCount);

  const positive =
    W.significance * sig +
    W.novelty * nov +
    W.emotionalIntensity * emo +
    W.timeBoost * tBoost;

  const negative =
    W.perKindRecency * kindRecency +    // negative weight, so this subtracts
    W.dailyCount * dailyDampen;          // ditto

  const score = positive + negative;

  return {
    score: clamp01(score),
    components: {
      significance: sig,
      novelty: nov,
      emotionalIntensity: emo,
      timeBoost: tBoost,
      perKindRecency: kindRecency,
      dailyDampen,
      raw: score,
    },
  };
}

function clamp01(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

module.exports = {
  scoreThought,
  computeEmotionalIntensity,
  computeTimeBoost,
  computePerKindRecency,
  computeDailyCountDampener,
  WEIGHTS: W,
};
