#!/usr/bin/env node
// ============================================================
// GENESIS — test/modules/v7919-idlemind-dedup.test.js
//
// v7.9.19 Strang B — the IdleMind plan-dedup fix. Two pure helpers
// in activities/Plan.js decide whether a proposed plan is a re-run
// of a RECENT failure, and they are the single shared source for
// both the LLM prompt hint and the skip check:
//
//   _recentRelevantFailures(goals, now, windowDays)
//     — terminal goals (failed/stalled/obsolete) touched within the
//       relevance window; older ones age out (uses g.updated, falls
//       back to g.created; undated → out-of-window).
//   _overlapRedundant(titleTokens, descTokens[, ratio])
//     — redundant iff >= REDUNDANCY_FLOOR distinct tokens overlap AND
//       that overlap is >= OVERLAP_SKIP_RATIO of the NEW title's own
//       content tokens.
//
// Field bug reproduced as the canonical case: a 5-week-old `failed`
// goal "Cognitive Health-Driven Daemon Throttling" blocked every new
// "Cognitive Health …" plan on the two shared words. With the window
// it ages out; even in-window, two shared words of a five-token title
// (ratio 0.4) no longer clear the ratio. Genuine re-runs still skip.
//
// Pure-function tests: no IdleMind loop, no model, no storage.
// Fixtures are synthetic, modelled on the real .genesis/goals.json.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, assertDeepEqual, run } =
  require('../harness');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const Plan = require(path.join(ROOT, 'src/agent/autonomy/activities/Plan'));
const {
  _tokenize, _recentRelevantFailures, _overlapRedundant,
  FAILURE_RELEVANCE_WINDOW_DAYS, OVERLAP_SKIP_RATIO, REDUNDANCY_FLOOR,
} = Plan;

const NOW = Date.parse('2026-05-30T21:00:00.000Z');
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

// A goal in the on-disk shape (status + description + timestamps).
function goal(status, description, updatedDaysAgo, extra = {}) {
  return {
    id: 'g_' + Math.random().toString(16).slice(2),
    status, description,
    created: daysAgo(updatedDaysAgo + 0.01),
    updated: daysAgo(updatedDaysAgo),
    ...extra,
  };
}
const tset = (s) => new Set(_tokenize(s));
const FIELD_FAIL_DESC = _tokenize('Cognitive Health-Driven Daemon Throttling');

describe('v7.9.19 Strang B — recent-relevant-failures (time aging)', () => {
  test('the field poisoner (a 5-week-old failed goal) ages out of the window', () => {
    const goals = [goal('failed', 'Cognitive Health-Driven Daemon Throttling', 36)];
    assertEqual(_recentRelevantFailures(goals, NOW, FAILURE_RELEVANCE_WINDOW_DAYS).length, 0,
      'older than the window → excluded (this is the fix for the field bug)');
  });

  test('a terminal goal within the window is included', () => {
    const goals = [goal('failed', 'Cognitive Health-Driven Daemon Throttling', 3)];
    assertEqual(_recentRelevantFailures(goals, NOW, FAILURE_RELEVANCE_WINDOW_DAYS).length, 1,
      'fresh failure still counts');
  });

  test('only terminal statuses count; active/completed/paused are excluded', () => {
    const goals = [
      goal('active', 'A', 1), goal('completed', 'B', 1), goal('paused', 'C', 1),
      goal('failed', 'D', 1), goal('stalled', 'E', 1), goal('obsolete', 'F', 1),
    ];
    const got = _recentRelevantFailures(goals, NOW, 14).map(g => g.status).sort();
    assertDeepEqual(got, ['failed', 'obsolete', 'stalled'], 'exactly the terminal trio');
  });

  test('falls back to created when updated is absent', () => {
    const inWin = { id: 'x', status: 'failed', description: 'D', created: daysAgo(3) };
    assertEqual(_recentRelevantFailures([inWin], NOW, 14).length, 1, 'created in window');
    const old = { id: 'y', status: 'failed', description: 'D', created: daysAgo(40) };
    assertEqual(_recentRelevantFailures([old], NOW, 14).length, 0, 'created out of window');
  });

  test('an undated terminal goal never counts (it must not block forever)', () => {
    const undated = { id: 'z', status: 'failed', description: 'D' };
    assertEqual(_recentRelevantFailures([undated], NOW, 14).length, 0, 'no timestamp → out-of-window');
  });

  test('the prompt hint and the skip check share this one aged list', () => {
    // Both call sites in Plan.js derive from _recentRelevantFailures, so a
    // failure that ages out disappears from BOTH at once. Asserted here as
    // the single source of truth for the two sites.
    const goals = [goal('failed', 'Cognitive Health-Driven Daemon Throttling', 36)];
    const aged = _recentRelevantFailures(goals, NOW, FAILURE_RELEVANCE_WINDOW_DAYS);
    assertEqual(aged.length, 0, 'gone from the shared list → gone from prompt AND dedup');
  });
});

describe('v7.9.19 Strang B — overlap redundancy (floor + ratio)', () => {
  test('the exact field case is NOT redundant (overlap 2, ratio 0.4)', () => {
    const r = _overlapRedundant(tset('Inspect Cognitive Health Tracking Implementation'), FIELD_FAIL_DESC);
    assertEqual(r.overlap, 2, 'two shared tokens (cognitive, health)');
    assert(!r.redundant, 'two theme words must not block an otherwise-different plan');
  });

  test('a near-duplicate IS redundant (overlap 4, ratio 0.8)', () => {
    const r = _overlapRedundant(tset('Inspect Cognitive Health Daemon Throttling'), FIELD_FAIL_DESC);
    assert(r.overlap >= REDUNDANCY_FLOOR && r.redundant, 'near-duplicate is skipped');
  });

  test('a short title mostly made of the failure IS redundant (2 of 3)', () => {
    const r = _overlapRedundant(tset('Document Daemon Throttling'), FIELD_FAIL_DESC);
    assertEqual(r.overlap, 2, 'daemon + throttling');
    assert(r.redundant, '2/3 ≥ ratio → redundant');
  });

  test('a single shared token is NOT redundant (absolute floor)', () => {
    const r = _overlapRedundant(tset('Inspect Throttling'), FIELD_FAIL_DESC);
    assertEqual(r.overlap, 1, 'only throttling');
    assert(!r.redundant, 'below the floor of 2');
  });

  test('regression: an immediate re-proposal of the same failure IS redundant', () => {
    const r = _overlapRedundant(tset('Cognitive Health-Driven Daemon Throttling'), FIELD_FAIL_DESC);
    assert(r.redundant, 'an exact re-run is still skipped — the original purpose holds');
  });

  test('duplicate tokens in the description do not inflate the overlap', () => {
    const r = _overlapRedundant(tset('Inspect Cognitive Health'), _tokenize('cognitive cognitive cognitive'));
    assertEqual(r.overlap, 1, 'distinct overlap counts once, not three times');
  });

  test('an empty title is never redundant', () => {
    const r = _overlapRedundant(tset(''), FIELD_FAIL_DESC);
    assertEqual(r.overlap, 0, 'no tokens, no overlap');
    assert(!r.redundant, 'empty title cannot be a re-run');
  });
});

describe('v7.9.19 Strang B — tuning constants', () => {
  test('the defaults are the agreed values', () => {
    assertEqual(FAILURE_RELEVANCE_WINDOW_DAYS, 14, 'relevance window 14 days');
    assertEqual(OVERLAP_SKIP_RATIO, 0.6, 'overlap-skip ratio 0.6');
    assertEqual(REDUNDANCY_FLOOR, 2, 'absolute floor 2');
  });
});

if (require.main === module) run();
