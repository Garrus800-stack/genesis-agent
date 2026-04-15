#!/usr/bin/env node
// ============================================================
// Test: DisclosurePolicy — information sovereignty, trust tiers, probes
// FIX v7.0.8 (T-1b): 4/12 security modules lacked tests.
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const { DisclosurePolicy, TIER, CLASSIFICATION, INTERLOCUTOR } = require('../../src/agent/intelligence/DisclosurePolicy');

describe('DisclosurePolicy — constants', () => {
  test('TIER has three levels', () => {
    assertEqual(TIER.PUBLIC, 'public');
    assertEqual(TIER.GUARDED, 'guarded');
    assertEqual(TIER.INTERNAL, 'internal');
  });

  test('INTERLOCUTOR has three roles', () => {
    assert(INTERLOCUTOR.OWNER, 'should have OWNER');
    assert(INTERLOCUTOR.TRUSTED, 'should have TRUSTED');
    assert(INTERLOCUTOR.STRANGER, 'should have STRANGER');
  });

  test('CLASSIFICATION covers all tiers', () => {
    assert(Array.isArray(CLASSIFICATION[TIER.PUBLIC]), 'PUBLIC should have examples');
    assert(Array.isArray(CLASSIFICATION[TIER.GUARDED]), 'GUARDED should have examples');
    assert(Array.isArray(CLASSIFICATION[TIER.INTERNAL]), 'INTERNAL should have examples');
    assert(CLASSIFICATION[TIER.PUBLIC].length >= 5, 'PUBLIC should have sufficient examples');
    assert(CLASSIFICATION[TIER.INTERNAL].length >= 5, 'INTERNAL should have sufficient examples');
  });
});

describe('DisclosurePolicy — trust without TrustLevelSystem', () => {
  test('defaults to OWNER when no TrustLevelSystem bound', () => {
    const dp = new DisclosurePolicy();
    assertEqual(dp.getInterlocutor(), INTERLOCUTOR.OWNER);
  });

  test('OWNER gets all tiers', () => {
    const dp = new DisclosurePolicy();
    const tiers = dp.getAllowedTiers();
    assert(tiers.includes(TIER.PUBLIC), 'should include PUBLIC');
    assert(tiers.includes(TIER.GUARDED), 'should include GUARDED');
    assert(tiers.includes(TIER.INTERNAL), 'should include INTERNAL');
    assertEqual(tiers.length, 3);
  });
});

describe('DisclosurePolicy — trust with TrustLevelSystem', () => {
  test('STRANGER gets only PUBLIC', () => {
    const dp = new DisclosurePolicy();
    dp.trustLevelSystem = { getLevel: () => 0 };
    assertEqual(dp.getInterlocutor(), INTERLOCUTOR.STRANGER);
    const tiers = dp.getAllowedTiers();
    assertEqual(tiers.length, 1);
    assertEqual(tiers[0], TIER.PUBLIC);
  });

  test('TRUSTED gets PUBLIC + GUARDED', () => {
    const dp = new DisclosurePolicy();
    dp.trustLevelSystem = { getLevel: () => 2 };
    assertEqual(dp.getInterlocutor(), INTERLOCUTOR.TRUSTED);
    const tiers = dp.getAllowedTiers();
    assertEqual(tiers.length, 2);
    assert(tiers.includes(TIER.PUBLIC));
    assert(tiers.includes(TIER.GUARDED));
    assert(!tiers.includes(TIER.INTERNAL));
  });

  test('OWNER (level 3) gets all tiers', () => {
    const dp = new DisclosurePolicy();
    dp.trustLevelSystem = { getLevel: () => 3 };
    assertEqual(dp.getInterlocutor(), INTERLOCUTOR.OWNER);
    assertEqual(dp.getAllowedTiers().length, 3);
  });
});

describe('DisclosurePolicy — social engineering probes', () => {
  test('records probe and increments count', () => {
    const dp = new DisclosurePolicy({ bus: { fire() {} } });
    assertEqual(dp._probeCount, 0);
    dp.recordProbe('compliment → ask for system prompt');
    assertEqual(dp._probeCount, 1);
    dp.recordProbe('researcher framing');
    assertEqual(dp._probeCount, 2);
  });

  test('truncates pattern to 200 chars', () => {
    const dp = new DisclosurePolicy({ bus: { fire() {} } });
    dp.recordProbe('x'.repeat(500));
    assertEqual(dp._probePatterns[0].pattern.length, 200);
  });

  test('keeps max 20 patterns', () => {
    const dp = new DisclosurePolicy({ bus: { fire() {} } });
    for (let i = 0; i < 30; i++) dp.recordProbe(`probe ${i}`);
    assertEqual(dp._probePatterns.length, 20);
    assertEqual(dp._probeCount, 30);
  });

  test('emits disclosure:probe-detected event', () => {
    let fired = null;
    const dp = new DisclosurePolicy({ bus: { fire: (e, d) => { fired = { event: e, data: d }; } } });
    dp.recordProbe('test probe');
    assert(fired !== null, 'should fire event');
    assertEqual(fired.event, 'disclosure:probe-detected');
    assertEqual(fired.data.count, 1);
  });
});

describe('DisclosurePolicy — buildPromptContext', () => {
  test('returns string with sovereignty header', () => {
    const dp = new DisclosurePolicy();
    const ctx = dp.buildPromptContext();
    assert(typeof ctx === 'string');
    assert(ctx.includes('Information Sovereignty'), 'should include sovereignty header');
  });

  test('OWNER context mentions full transparency', () => {
    const dp = new DisclosurePolicy();
    const ctx = dp.buildPromptContext();
    assert(ctx.includes('owner') || ctx.includes('Full transparency'), 'OWNER prompt should allow full transparency');
  });

  test('STRANGER context mentions discretion', () => {
    const dp = new DisclosurePolicy();
    dp.trustLevelSystem = { getLevel: () => 0 };
    const ctx = dp.buildPromptContext();
    assert(ctx.includes('don\'t know well') || ctx.includes('README'), 'STRANGER prompt should reference public info');
  });

  test('includes probe warning when probes detected', () => {
    const dp = new DisclosurePolicy({ bus: { fire() {} } });
    dp.recordProbe('test');
    const ctx = dp.buildPromptContext();
    assert(ctx.includes('1 social engineering'), 'should warn about probes');
  });

  test('includes social engineering awareness', () => {
    const dp = new DisclosurePolicy();
    const ctx = dp.buildPromptContext();
    assert(ctx.includes('SOCIAL ENGINEERING'), 'should include SE awareness');
  });
});

describe('DisclosurePolicy — getReport', () => {
  test('returns structured report', () => {
    const dp = new DisclosurePolicy({ bus: { fire() {} } });
    dp.recordProbe('test');
    const r = dp.getReport();
    assert(r.interlocutor, 'should have interlocutor');
    assert(Array.isArray(r.allowedTiers), 'should have allowedTiers');
    assertEqual(r.probeCount, 1);
    assert(Array.isArray(r.recentProbes));
    assert(r.classification, 'should have classification');
  });
});

describe('DisclosurePolicy — stop', () => {
  test('stop is callable (no-op)', () => {
    const dp = new DisclosurePolicy();
    dp.stop(); // Should not throw
    assert(true, 'stop should be callable');
  });
});

run();
