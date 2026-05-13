#!/usr/bin/env node
// v7.7.9 Phase 2 — HardGates contract
//
// Pre-publishing gates. The order of these checks matters; cheap
// checks must come first so a noisy candidate gets rejected quickly.
// "Fail closed" — any error in evaluation defaults to suppression.

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');

const {
  runGates,
  isInQuietHours,
  parseHm,
} = require('../../src/agent/cognitive/proactiveSelfExpression/HardGates');

// ── Helpers ────────────────────────────────────────────────

function thought(kind = 'plan-failure-reflection', extras = {}) {
  return {
    kind,
    significance: 0.7,
    novelty: 0.5,
    ...extras,
  };
}

function defaultSettings() {
  return {
    enabled: true,
    minIntervalMs: 30 * 60 * 1000,
    quietHours: { start: '22:00', end: '07:00' },
    userActivityCooldownMs: 10 * 60 * 1000,
    dailyVolumeSoftCap: 8,
    allowedKinds: ['plan-failure-reflection'],
    perKindFloors: {
      'plan-failure-reflection': { sigFloor: 0.50 },
    },
  };
}

// Use a fixed daytime moment for tests so quietHours doesn't interfere
const NOON = new Date('2026-05-10T12:00:00').getTime();

// ── parseHm ────────────────────────────────────────────────

describe('parseHm', () => {
  test('parses HH:MM', () => {
    assertEqual(parseHm('22:00'), 22 * 60);
    assertEqual(parseHm('07:30'), 7 * 60 + 30);
    assertEqual(parseHm('00:00'), 0);
  });
  test('returns null for invalid input', () => {
    assertEqual(parseHm('25:00'), null);
    assertEqual(parseHm('not-a-time'), null);
    assertEqual(parseHm(''), null);
  });
});

// ── isInQuietHours ────────────────────────────────────────

describe('isInQuietHours', () => {
  test('non-wrap range (09:00→17:00): inside ⇒ true', () => {
    const ts = new Date('2026-05-10T12:00:00').getTime();
    assert(isInQuietHours(ts, { start: '09:00', end: '17:00' }));
  });
  test('non-wrap range: outside ⇒ false', () => {
    const ts = new Date('2026-05-10T18:00:00').getTime();
    assert(!isInQuietHours(ts, { start: '09:00', end: '17:00' }));
  });
  test('wrap range (22:00→07:00): inside (23:30) ⇒ true', () => {
    const ts = new Date('2026-05-10T23:30:00').getTime();
    assert(isInQuietHours(ts, { start: '22:00', end: '07:00' }));
  });
  test('wrap range: inside (early-morning 06:30) ⇒ true', () => {
    const ts = new Date('2026-05-10T06:30:00').getTime();
    assert(isInQuietHours(ts, { start: '22:00', end: '07:00' }));
  });
  test('wrap range: outside (15:00) ⇒ false', () => {
    const ts = new Date('2026-05-10T15:00:00').getTime();
    assert(!isInQuietHours(ts, { start: '22:00', end: '07:00' }));
  });
});

// ── Gate sequence ──────────────────────────────────────────

describe('Hard gates — fail-fast sequence', () => {
  test('clean candidate passes', () => {
    const r = runGates(thought(), { now: NOON }, defaultSettings());
    assertEqual(r.ok, true);
  });

  test('disabled = no message', () => {
    const r = runGates(thought(), { now: NOON }, { ...defaultSettings(), enabled: false });
    assertEqual(r.ok, false);
    assertEqual(r.reason, 'disabled');
  });

  test('quiet hours block', () => {
    const midnight = new Date('2026-05-10T23:30:00').getTime();
    const r = runGates(thought(), { now: midnight }, defaultSettings());
    assertEqual(r.ok, false);
    assertEqual(r.reason, 'quiet-hours');
  });

  test('min interval since last self-message', () => {
    const r = runGates(thought(), {
      now: NOON,
      lastSelfMessageMs: NOON - 5 * 60 * 1000,  // 5 min ago, < 30 min
    }, defaultSettings());
    assertEqual(r.ok, false);
    assertEqual(r.reason, 'min-interval');
  });

  test('min interval honoured when enough time passed', () => {
    const r = runGates(thought(), {
      now: NOON,
      lastSelfMessageMs: NOON - 60 * 60 * 1000,  // 60 min ago
    }, defaultSettings());
    assertEqual(r.ok, true);
  });

  test('user activity cooldown', () => {
    const r = runGates(thought(), {
      now: NOON,
      lastUserMessageMs: NOON - 5 * 60 * 1000,  // 5 min ago, < 10 min cooldown
    }, defaultSettings());
    assertEqual(r.ok, false);
    assertEqual(r.reason, 'user-activity-cooldown');
  });

  test('user activity cooldown OK after 10 min', () => {
    const r = runGates(thought(), {
      now: NOON,
      lastUserMessageMs: NOON - 15 * 60 * 1000,
    }, defaultSettings());
    assertEqual(r.ok, true);
  });

  test('mute via /quiet blocks', () => {
    const r = runGates(thought(), {
      now: NOON,
      mutedUntilMs: NOON + 60 * 60 * 1000,
    }, defaultSettings());
    assertEqual(r.ok, false);
    assertEqual(r.reason, 'user-muted');
  });

  test('mute is per-instant — ms in past = not muted', () => {
    const r = runGates(thought(), {
      now: NOON,
      mutedUntilMs: NOON - 60 * 60 * 1000,
    }, defaultSettings());
    assertEqual(r.ok, true);
  });

  test('kind-not-allowed blocks', () => {
    const r = runGates(thought('idle-thought'), { now: NOON }, defaultSettings());
    assertEqual(r.ok, false);
    assertEqual(r.reason, 'kind-not-allowed');
  });

  test('per-kind significance floor blocks', () => {
    const r = runGates(thought('plan-failure-reflection', { significance: 0.4 }),
      { now: NOON }, defaultSettings());
    assertEqual(r.ok, false);
    assertEqual(r.reason, 'per-kind-floor-significance');
  });

  test('daily volume hard stop at 2× soft cap', () => {
    const r = runGates(thought(), {
      now: NOON, dailyCount: 16,  // 2× 8 = 16
    }, defaultSettings());
    assertEqual(r.ok, false);
    assertEqual(r.reason, 'daily-volume-hard-stop');
  });

  test('fail-closed on malformed input', () => {
    const r = runGates(null, null, defaultSettings());
    assertEqual(r.ok, false);
  });
});

run();
