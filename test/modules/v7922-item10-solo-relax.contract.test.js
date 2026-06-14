'use strict';
// v7.9.22 Item 10 — the publishing gate relaxes its score bar in extended solo operation
// (1h+ with no user → 0.35, down from the 0.55 base), measured from boot when no user message
// is on record, while minIntervalMs stays intact as the burst guard and the relaxation only lowers.
const { describe, test, assert, run } = require('../harness');
const { ProactiveSelfExpression } = require('../../src/agent/cognitive/ProactiveSelfExpression');

const HOUR = 60 * 60 * 1000, MIN = 60 * 1000;
const storageStub = { readJSON: () => null, writeJSON: () => {}, readJSONAsync: async () => null, exists: () => false };

async function gate({ lastUserMs, bootTime, lastSelfMs = null, base = 0.55 }) {
  const psx = new ProactiveSelfExpression({ innerSpeech: { subscribe: () => () => {} }, storage: storageStub });
  psx._defaultSettings.quietHours = null;     // never in quiet hours
  psx._defaultSettings.perKindFloors = {};    // no per-kind floor gate
  psx._defaultSettings.baseThreshold = base;
  psx._bootTime = bootTime;
  psx._lastUserMessageMs = () => lastUserMs;
  psx.stateStore = {
    getLastSelfMessageMs: () => lastSelfMs,
    getMutedUntilMs: () => null,
    getDailyCount: () => 0,
    getLastSelfMessageOfKindMs: () => null,
    recordSuppression: () => {},
  };
  let candidate = null, suppressReason = null;
  psx.bus = { fire: (ev, p) => {
    if (ev === 'agent:self-message-candidate') candidate = p;
    if (ev === 'agent:self-message-suppressed') suppressReason = p.reason;
  } };
  await psx._onCandidate({ id: 't1', kind: 'plan-failure-reflection', significance: 0.5, novelty: 0.5, timestamp: Date.now() });
  return { candidate, suppressReason };
}

describe('v7.9.22 Item 10 — solo-aware threshold relaxation', () => {
  test('a long solo run (2h since the user) relaxes the threshold to 0.35', async () => {
    const { candidate } = await gate({ lastUserMs: Date.now() - 2 * HOUR, bootTime: Date.now() - 3 * HOUR });
    assert(candidate, 'candidate event fired');
    assert(candidate.threshold === 0.35, `expected relaxed 0.35, got ${candidate.threshold}`);
  });

  test('a recent-enough user (30min, below the 1h trigger) keeps the base 0.55', async () => {
    const { candidate } = await gate({ lastUserMs: Date.now() - 30 * MIN, bootTime: Date.now() - 3 * HOUR });
    assert(candidate, 'candidate event fired (past the 10min cooldown)');
    assert(candidate.threshold === 0.55, `expected base 0.55, got ${candidate.threshold}`);
  });

  test('fresh boot, no user on record: relaxes only after solo-from-boot passes the trigger', async () => {
    const recent = await gate({ lastUserMs: null, bootTime: Date.now() - 30 * MIN });
    assert(recent.candidate && recent.candidate.threshold === 0.55,
      `fresh boot 30min ago should stay base 0.55, got ${recent.candidate && recent.candidate.threshold}`);
    const old = await gate({ lastUserMs: null, bootTime: Date.now() - 2 * HOUR });
    assert(old.candidate && old.candidate.threshold === 0.35,
      `boot 2h ago should relax to 0.35, got ${old.candidate && old.candidate.threshold}`);
  });

  test('minIntervalMs stays intact — a rapid second message is suppressed before scoring', async () => {
    const { candidate, suppressReason } = await gate({ lastUserMs: Date.now() - 2 * HOUR, bootTime: Date.now() - 3 * HOUR, lastSelfMs: Date.now() - MIN });
    assert(!candidate, 'no candidate event — gated before scoring');
    assert(suppressReason === 'min-interval', `expected min-interval suppression, got ${suppressReason}`);
  });

  test('the relaxation only lowers — a base already below 0.35 is not raised', async () => {
    const { candidate } = await gate({ lastUserMs: Date.now() - 2 * HOUR, bootTime: Date.now() - 3 * HOUR, base: 0.2 });
    assert(candidate && candidate.threshold === 0.2, `expected unchanged 0.2, got ${candidate && candidate.threshold}`);
  });
});

run();
