// ============================================================
// Test: v7.3.1 A4-F4 — SignificanceDetector (6 signals)
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const SD = require('../../src/agent/cognitive/SignificanceDetector');

const NOW = 1_700_000_000_000; // fixed ts for reproducibility
const MIN_AGO = 60 * 1000;
const HOUR_AGO = 60 * MIN_AGO;

describe('v7.3.1 — Signal 1: persistent-emotion', () => {
  test('detects 15min sustained elevation', () => {
    const r = SD.persistentEmotion({
      emotionHistory: [
        { dim: 'loneliness', value: 0.75, baseline: 0.3, ts: NOW - 15 * MIN_AGO },
        { dim: 'loneliness', value: 0.75, baseline: 0.3, ts: NOW - 10 * MIN_AGO },
        { dim: 'loneliness', value: 0.78, baseline: 0.3, ts: NOW - 2 * MIN_AGO },
      ],
      now: NOW,
    });
    assertEqual(r.detected, true, '15min > 10min threshold → detected');
    assertEqual(r.evidence.dim, 'loneliness');
  });

  test('returns false for short elevation', () => {
    const r = SD.persistentEmotion({
      emotionHistory: [
        { dim: 'curiosity', value: 0.8, baseline: 0.5, ts: NOW - 2 * MIN_AGO },
      ],
      now: NOW,
    });
    assertEqual(r.detected, false);
  });

  test('returns false when run broken (dip below baseline)', () => {
    const r = SD.persistentEmotion({
      emotionHistory: [
        { dim: 'frustration', value: 0.8, baseline: 0.3, ts: NOW - 20 * MIN_AGO },
        { dim: 'frustration', value: 0.2, baseline: 0.3, ts: NOW - 15 * MIN_AGO }, // dip
        { dim: 'frustration', value: 0.7, baseline: 0.3, ts: NOW - 5 * MIN_AGO },
      ],
      now: NOW,
    });
    // Tail-run starts at 5 min ago (after the dip). 5min < 10min → not detected
    assertEqual(r.detected, false, 'dip breaks the sustained run');
  });

  test('empty history returns false', () => {
    assertEqual(SD.persistentEmotion({}).detected, false);
    assertEqual(SD.persistentEmotion({ emotionHistory: [] }).detected, false);
  });
});

describe('v7.3.1 — Signal 2: user-beteiligung', () => {
  test('detects 3+ user messages in window', () => {
    const r = SD.userBeteiligung({
      userMessages: [
        { ts: NOW - 10 * MIN_AGO, text: 'a' },
        { ts: NOW - 8 * MIN_AGO, text: 'b' },
        { ts: NOW - 5 * MIN_AGO, text: 'c' },
        { ts: NOW - 2 * MIN_AGO, text: 'd' },
      ],
      windowStartMs: NOW - 15 * MIN_AGO,
      windowEndMs: NOW,
    });
    assertEqual(r.detected, true);
    assertEqual(r.evidence.count, 4);
  });

  test('returns false with too few messages in window', () => {
    const r = SD.userBeteiligung({
      userMessages: [
        { ts: NOW - 60 * MIN_AGO, text: 'old' }, // outside window
        { ts: NOW - 5 * MIN_AGO, text: 'new' },
      ],
      windowStartMs: NOW - 15 * MIN_AGO,
      windowEndMs: NOW,
    });
    assertEqual(r.detected, false);
    assertEqual(r.evidence.count, 1);
  });
});

describe('v7.3.1 — Signal 3: novelty', () => {
  test('detects novel subject not in episodic memory', () => {
    const r = SD.novelty({
      subject: 'Johnny',
      episodicSummaries: [
        'User asked about Python',
        'Genesis explained generators',
      ],
    });
    assertEqual(r.detected, true);
    assertEqual(r.evidence.appearances, 0);
  });

  test('returns false if subject appears in past episodes', () => {
    const r = SD.novelty({
      subject: 'Python',
      episodicSummaries: [
        'User asked about Python basics',
        'Genesis explained Python generators',
      ],
    });
    assertEqual(r.detected, false);
    assertEqual(r.evidence.appearances, 2);
  });

  test('case-insensitive match', () => {
    const r = SD.novelty({
      subject: 'python',
      episodicSummaries: ['I love Python'],
    });
    assertEqual(r.detected, false);
  });

  test('empty subject returns false', () => {
    assertEqual(SD.novelty({ subject: '' }).detected, false);
    assertEqual(SD.novelty({}).detected, false);
  });
});

describe('v7.3.1 — Signal 4: problem-to-solution', () => {
  test('detects frustration → satisfaction within 30min', () => {
    const r = SD.problemToSolution({
      emotionHistory: [
        { dim: 'frustration', value: 0.8, ts: NOW - 15 * MIN_AGO },
        { dim: 'satisfaction', value: 0.7, ts: NOW - 5 * MIN_AGO },
      ],
    });
    assertEqual(r.detected, true);
    assert(r.evidence.spanMs > 0);
    assert(r.evidence.spanMs < 30 * MIN_AGO);
  });

  test('no frustration peak → false', () => {
    const r = SD.problemToSolution({
      emotionHistory: [
        { dim: 'satisfaction', value: 0.9, ts: NOW - 5 * MIN_AGO },
      ],
    });
    assertEqual(r.detected, false);
  });

  test('relief too late → false', () => {
    const r = SD.problemToSolution({
      emotionHistory: [
        { dim: 'frustration', value: 0.8, ts: NOW - 60 * MIN_AGO },
        { dim: 'satisfaction', value: 0.7, ts: NOW - 5 * MIN_AGO }, // 55min later
      ],
      windowMs: 30 * MIN_AGO,
    });
    assertEqual(r.detected, false);
  });
});

describe('v7.3.1 — Signal 5: naming-event', () => {
  test('detects "Ich nenne dich Johnny"', () => {
    const r = SD.namingEvent({ text: 'Ich nenne dich Johnny ab jetzt' });
    assertEqual(r.detected, true);
  });

  test('detects English "let\'s call you Arthur"', () => {
    const r = SD.namingEvent({ text: "let's call you Arthur from now on" });
    assertEqual(r.detected, true);
  });

  test('detects "name it Helix"', () => {
    const r = SD.namingEvent({ text: 'We should name it Helix' });
    assertEqual(r.detected, true);
  });

  test('returns false for plain conversation', () => {
    const r = SD.namingEvent({ text: 'What do you think about this?' });
    assertEqual(r.detected, false);
  });

  test('handles empty input', () => {
    assertEqual(SD.namingEvent({}).detected, false);
    assertEqual(SD.namingEvent({ text: '' }).detected, false);
  });
});

describe('v7.3.1 — Signal 6: explicit-flag', () => {
  test('detects "remember this"', () => {
    const r = SD.explicitFlag({ text: 'I want you to remember this forever' });
    assertEqual(r.detected, true);
  });

  test('detects "nie vergessen"', () => {
    const r = SD.explicitFlag({ text: 'Bitte nie vergessen — das war wichtig' });
    assertEqual(r.detected, true);
  });

  test('detects "core memory"', () => {
    const r = SD.explicitFlag({ text: 'This is a core memory moment' });
    assertEqual(r.detected, true);
  });

  test('returns false for non-flagged text', () => {
    const r = SD.explicitFlag({ text: 'That was interesting' });
    assertEqual(r.detected, false);
  });
});

describe('v7.3.1 — detectAll: aggregate', () => {
  test('meets threshold when 4+ signals fire', () => {
    const r = SD.detectAll({
      // Signal 1: persistent-emotion
      emotionHistory: [
        { dim: 'satisfaction', value: 0.8, baseline: 0.5, ts: NOW - 20 * MIN_AGO },
        { dim: 'satisfaction', value: 0.8, baseline: 0.5, ts: NOW - 2 * MIN_AGO },
        { dim: 'frustration', value: 0.7, ts: NOW - 25 * MIN_AGO },
      ],
      now: NOW,
      // Signal 2: user-beteiligung
      userMessages: [
        { ts: NOW - 10 * MIN_AGO }, { ts: NOW - 5 * MIN_AGO },
        { ts: NOW - 3 * MIN_AGO }, { ts: NOW - MIN_AGO },
      ],
      windowStartMs: NOW - 15 * MIN_AGO,
      windowEndMs: NOW,
      // Signal 3: novelty
      subject: 'Johnny',
      episodicSummaries: ['unrelated past'],
      // Signal 5: naming
      text: 'Ich nenne dich Johnny — das solltest du nie vergessen',
    });
    assertEqual(r.triggered, true);
    assert(r.signalCount >= 4, `expected >=4, got ${r.signalCount}`);
  });

  test('below threshold when 0-3 signals', () => {
    const r = SD.detectAll({
      emotionHistory: [],
      userMessages: [],
      subject: 'Python',
      episodicSummaries: ['I love Python'],
      text: 'just a regular message',
    });
    assertEqual(r.triggered, false);
    assert(r.signalCount < 4);
  });

  test('always returns full signal report', () => {
    const r = SD.detectAll({ text: 'test' });
    assert(r.allResults, 'allResults present');
    assert(r.allResults['persistent-emotion']);
    assert(r.allResults['user-beteiligung']);
    assert(r.allResults['novelty']);
    assert(r.allResults['problem-to-solution']);
    assert(r.allResults['naming-event']);
    assert(r.allResults['explicit-flag']);
  });

  test('THRESHOLD is 4', () => {
    assertEqual(SD.THRESHOLD, 4);
  });
});

run();
