#!/usr/bin/env node
// v7.7.9 Phase 2 — Scoring formula tests
//
// scoreThought composes a weighted sum of internal signals. These tests
// pin the math down so future tuning can't silently change the
// behaviour without a corresponding test update.
//
// Crucially, NONE of these tests mention user reactions. The score is
// a function of internal state only. The anti-pattern guard
// (v779-anti-pattern-guard.contract) enforces this at file-content
// level; this file enforces it via behaviour.

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');

const {
  scoreThought,
  computeEmotionalIntensity,
  computeTimeBoost,
  computePerKindRecency,
  WEIGHTS,
} = require('../../src/agent/cognitive/proactiveSelfExpression/Scoring');

describe('Scoring — sum of weights', () => {
  test('positive weights sum to 1.00', () => {
    const sum = WEIGHTS.significance + WEIGHTS.novelty
              + WEIGHTS.emotionalIntensity + WEIGHTS.timeBoost;
    assert(Math.abs(sum - 1.0) < 0.001, `expected 1.00, got ${sum}`);
  });

  test('negative weights are negative', () => {
    assert(WEIGHTS.perKindRecency < 0, 'perKindRecency must be negative');
    assert(WEIGHTS.dailyCount < 0, 'dailyCount must be negative');
  });
});

describe('Scoring — emotional intensity', () => {
  test('zero when snapshot missing', () => {
    assertEqual(computeEmotionalIntensity(null), 0);
    assertEqual(computeEmotionalIntensity(undefined), 0);
    assertEqual(computeEmotionalIntensity({}), 0);
  });

  test('zero when all skalars are neutral (0.5)', () => {
    const i = computeEmotionalIntensity({
      curiosity: 0.5, frustration: 0.5, satisfaction: 0.5, energy: 0.5,
    });
    assert(i < 0.01, `expected near-0, got ${i}`);
  });

  test('high when one skalar is strongly off-neutral', () => {
    const i = computeEmotionalIntensity({
      curiosity: 1.0, frustration: 0.5, satisfaction: 0.5, energy: 0.5,
    });
    assert(i > 0.4, `expected > 0.4, got ${i}`);
  });

  test('clamps to [0, 1]', () => {
    const i = computeEmotionalIntensity({
      curiosity: 1.0, frustration: 1.0, satisfaction: 1.0, energy: 1.0,
    });
    assert(i >= 0 && i <= 1, `expected ∈[0,1], got ${i}`);
  });
});

describe('Scoring — time boost', () => {
  test('1.0 at exact now', () => {
    const now = 1000000;
    const b = computeTimeBoost(now, now);
    assert(b > 0.99, `expected ~1.0 at now, got ${b}`);
  });

  test('decays exponentially with 30-min characteristic time', () => {
    const now = 1000000;
    // exp(-1) ≈ 0.368 at the characteristic time
    const b = computeTimeBoost(now - 30 * 60 * 1000, now);
    assert(b > 0.3 && b < 0.45, `expected ~0.37 at 30 min characteristic, got ${b}`);
  });

  test('zero past the cap (4h)', () => {
    const now = 1000000;
    const b = computeTimeBoost(now - 5 * 60 * 60 * 1000, now);
    assertEqual(b, 0);
  });

  test('zero when no timestamp given', () => {
    assertEqual(computeTimeBoost(undefined, Date.now()), 0);
  });
});

describe('Scoring — per-kind recency', () => {
  test('1.0 just after a recent fire', () => {
    const now = 1000000;
    const r = computePerKindRecency(now - 10, now);
    assert(r > 0.99, `expected ~1.0 just after, got ${r}`);
  });

  test('zero past the 90-min window', () => {
    const now = 1000000;
    const r = computePerKindRecency(now - 100 * 60 * 1000, now);
    assertEqual(r, 0);
  });

  test('zero when no last-fire given', () => {
    assertEqual(computePerKindRecency(undefined, Date.now()), 0);
  });
});

describe('Scoring — full scoreThought', () => {
  test('identifiable significant + novel thought scores high', () => {
    const now = 1000000;
    const thought = {
      significance: 0.8, novelty: 0.7,
      emotionalSnapshot: { curiosity: 0.8, frustration: 0.5, satisfaction: 0.5, energy: 0.5 },
      timestamp: now,
    };
    const r = scoreThought(thought, { now, lastFireOfKindMs: null, dailyCount: 0 });
    assert(r.score > 0.55,
      `expected > 0.55 for high-sig high-nov thought, got ${r.score}; components: ${JSON.stringify(r.components)}`);
  });

  test('uninteresting thought scores low', () => {
    const now = 1000000;
    const thought = {
      significance: 0.1, novelty: 0.1,
      emotionalSnapshot: { curiosity: 0.5, frustration: 0.5, satisfaction: 0.5, energy: 0.5 },
      timestamp: now,
    };
    const r = scoreThought(thought, { now, lastFireOfKindMs: null, dailyCount: 0 });
    assert(r.score < 0.30, `expected < 0.30 for boring thought, got ${r.score}`);
  });

  test('recent firing of same kind dampens score', () => {
    const now = 1000000;
    const thought = {
      significance: 0.7, novelty: 0.6,
      emotionalSnapshot: { curiosity: 0.7, frustration: 0.5, satisfaction: 0.5, energy: 0.5 },
      timestamp: now,
    };
    const fresh = scoreThought(thought, { now, lastFireOfKindMs: null, dailyCount: 0 });
    const stale = scoreThought(thought, { now, lastFireOfKindMs: now - 5 * 60 * 1000, dailyCount: 0 });
    assert(stale.score < fresh.score,
      `recent-fire-dampened ${stale.score} should be lower than fresh ${fresh.score}`);
  });

  test('high daily count reduces score', () => {
    const now = 1000000;
    const thought = {
      significance: 0.7, novelty: 0.6,
      emotionalSnapshot: { curiosity: 0.7, frustration: 0.5, satisfaction: 0.5, energy: 0.5 },
      timestamp: now,
    };
    const earlyDay = scoreThought(thought, { now, lastFireOfKindMs: null, dailyCount: 0 });
    const lateDay  = scoreThought(thought, { now, lastFireOfKindMs: null, dailyCount: 5 });
    assert(lateDay.score < earlyDay.score,
      `late-day ${lateDay.score} should be lower than early-day ${earlyDay.score}`);
  });

  test('result clamped to [0, 1]', () => {
    const now = 1000000;
    const r = scoreThought({
      significance: 1, novelty: 1,
      emotionalSnapshot: { curiosity: 1, frustration: 1, satisfaction: 1, energy: 1 },
      timestamp: now,
    }, { now });
    assert(r.score >= 0 && r.score <= 1, `score out of [0,1]: ${r.score}`);
  });

  test('components object is returned for /proactive-status logging', () => {
    const r = scoreThought({ significance: 0.5, novelty: 0.5, timestamp: Date.now() }, { now: Date.now() });
    assert(r.components, 'components missing');
    assert('significance' in r.components, 'significance missing in components');
    assert('novelty' in r.components, 'novelty missing in components');
    assert('timeBoost' in r.components, 'timeBoost missing in components');
  });
});

run();
