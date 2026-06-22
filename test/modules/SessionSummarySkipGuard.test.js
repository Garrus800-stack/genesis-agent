#!/usr/bin/env node
// Test: shutdown session-summary skip guard — A (v7.9.25)
// The guard skips a summary only for a session that is BOTH too short AND empty.
// It must read `startedAt` (an ISO string) and parse it — the old code read the
// non-existent `startTime`, so every session looked "just started" (elapsed 0).
const { describe, test, assert, run } = require('../harness');
const { shouldSkipSessionSummary } = require('../../src/agent/AgentCoreHealth');

const MIN = 60000; // 60s, the default shutdown.sessionSummaryMinMs
const nowIso = () => new Date().toISOString();
const agoIso = (ms) => new Date(Date.now() - ms).toISOString();

describe('AgentCoreHealth A — session-summary skip guard', () => {

  test('a brand-new empty session is skipped', () => {
    assert(shouldSkipSessionSummary({ startedAt: nowIso(), messageCount: 0 }, 0, MIN) === true,
      'short + empty → skip');
  });

  test('an OLD empty session is NOT skipped (age now actually counts)', () => {
    // With the old startTime bug elapsed was always 0, so this wrongly returned
    // true. The fix parses startedAt, so a 2h-old session is not "too short".
    assert(shouldSkipSessionSummary({ startedAt: agoIso(2 * 3600 * 1000), messageCount: 0 }, 0, MIN) === false,
      'old + empty → do not skip');
  });

  test('a new session with messages is NOT skipped', () => {
    assert(shouldSkipSessionSummary({ startedAt: nowIso(), messageCount: 5 }, 0, MIN) === false,
      'short but has messages → do not skip');
  });

  test('a new session with chat history is NOT skipped', () => {
    assert(shouldSkipSessionSummary({ startedAt: nowIso(), messageCount: 0 }, 3, MIN) === false,
      'short but has history → do not skip');
  });

  test('an old session with content is NOT skipped', () => {
    assert(shouldSkipSessionSummary({ startedAt: agoIso(2 * 3600 * 1000), messageCount: 5 }, 0, MIN) === false,
      'old + content → do not skip');
  });

  test('a missing/invalid startedAt yields elapsed 0 (treated as just-started)', () => {
    assert(shouldSkipSessionSummary({ messageCount: 0 }, 0, MIN) === true,
      'no startedAt + empty → skip (elapsed 0)');
    assert(shouldSkipSessionSummary({ messageCount: 2 }, 0, MIN) === false,
      'no startedAt + content → do not skip');
  });
});

run();
