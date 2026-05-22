// ============================================================
// GENESIS — test/modules/v794-koennen-promotion-evaluator.contract.test.js
// Contract test for v7.9.4 SkillPromotionEvaluator:
//   • All four conjunctive promotion criteria
//   • Quarantine path on low Wilson-LB
//   • Discard-suggestion rate limit
//   • Legacy manifest migration is idempotent
//   • Events fired in correct order
// Every test name carries `koennen-promotion-v794 contract:` prefix.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');
const { SkillPromotionEvaluator, DEFAULTS } = require(path.join(ROOT, 'src/agent/cognitive/SkillPromotionEvaluator'));

function _tmpKoennenDir() {
  const dir = path.join(os.tmpdir(), `genesis-promo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(dir, 'koennen', 'skills-pending'), { recursive: true });
  return dir;
}

function _writeSkill(koennenDir, name, manifest) {
  const skillDir = path.join(koennenDir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'skill-manifest.json'), JSON.stringify(manifest, null, 2));
  return skillDir;
}

function _fakeTracker(byName) {
  return {
    getStats(name) { return byName[name] || null; },
    getWilsonLB(name) { return byName[name]?.wilsonLB ?? 0.5; },
    recordInvocation() { /* noop */ },
  };
}

function _fakeSkillManager(koennenDir) {
  return {
    koennenDir,
    loadSkills() { /* noop */ },
    listSkills() { return []; },
  };
}

function _fakeBus() {
  const events = [];
  return {
    fire(name, payload) { events.push({ name, payload }); },
    on() { /* noop */ },
    events,
  };
}

describe('koennen-promotion-v794 contract: SkillPromotionEvaluator constructor and lifecycle', () => {

  test('koennen-promotion-v794 contract: DEFAULTS contains all four promotion criteria', () => {
    assertEqual(DEFAULTS.minInvocations, 8, 'minInvocations default');
    assertEqual(DEFAULTS.minWilsonLB, 0.70, 'minWilsonLB default');
    assertEqual(DEFAULTS.minDistinctInputs, 3, 'minDistinctInputs default');
    assertEqual(DEFAULTS.minAgeMs, 48 * 60 * 60 * 1000, 'minAgeMs default');
  });

  test('koennen-promotion-v794 contract: trust-level is NOT in the promotion criteria', () => {
    // Promotion is an internal reflective act. Trust-level gates outward
    // actions, not internal maturity assessment. Verify DEFAULTS doesn't
    // accidentally carry a trustLevel field.
    assert(!('minTrustLevel' in DEFAULTS), 'should not have minTrustLevel');
    assert(!('trustLevel' in DEFAULTS), 'should not have trustLevel');
  });

  test('koennen-promotion-v794 contract: stateless evaluator has no lifecycle methods', () => {
    const ev = new SkillPromotionEvaluator();
    // No subscriptions, no intervals — stateless after construction.
    // The audit ratchet for Shutdown Coverage flags any service with
    // stop()/interval that isn't wired into shutdown; SkillPromotionEvaluator
    // intentionally has neither.
    assert(typeof ev.start === 'undefined', 'no start method');
    assert(typeof ev.stop === 'undefined', 'no stop method');
  });

});

describe('koennen-promotion-v794 contract: promotion paths', () => {

  test('koennen-promotion-v794 contract: skill meeting all four criteria gets promoted', async () => {
    const root = _tmpKoennenDir();
    const koennenDir = path.join(root, 'koennen', 'skills-pending');

    _writeSkill(koennenDir, 'mature-skill', {
      name: 'mature-skill',
      version: '1.0.0',
      description: 'a mature skill',
      entry: 'index.js',
      status: 'rehearsing',
      koennen: {
        crystallizedAt: Date.now() - 50 * 60 * 60 * 1000,  // 50h ago
        rehearsalCount: 8,
        rehearsedInputHashes: ['a', 'b', 'c', 'a'],  // 3 distinct
        acquisitionContext: 'Without me, the user would rewrite this each time.',
      },
    });

    const tracker = _fakeTracker({
      'mature-skill': { successes: 8, total: 8, wilsonLB: 0.72, lastInvocation: Date.now(), lastSuccess: Date.now(), runs: 8 },
    });
    const sm = _fakeSkillManager(koennenDir);
    const bus = _fakeBus();
    const ev = new SkillPromotionEvaluator({ bus, genesisDir: root });
    ev.skillManager = sm;
    ev.effectivenessTracker = tracker;

    const result = await ev.evaluate();
    assertEqual(result.results.promoted.length, 1, 'one skill promoted');
    assertEqual(result.results.promoted[0], 'mature-skill', 'correct skill promoted');

    const promotedEvents = bus.events.filter(e => e.name === 'skill:promoted');
    const acquiredEvents = bus.events.filter(e => e.name === 'selfnarrative:skill-acquired');
    assertEqual(promotedEvents.length, 1, 'skill:promoted fired once');
    assertEqual(acquiredEvents.length, 1, 'selfnarrative:skill-acquired fired once');

    const m = JSON.parse(fs.readFileSync(path.join(koennenDir, 'mature-skill', 'skill-manifest.json'), 'utf-8'));
    assertEqual(m.status, 'promoted', 'manifest status updated on disk');
    assert(m.koennen.promotedAt > 0, 'promotedAt timestamp set');
  });

  test('koennen-promotion-v794 contract: skill with too few rehearsals stays pending', async () => {
    const root = _tmpKoennenDir();
    const koennenDir = path.join(root, 'koennen', 'skills-pending');

    _writeSkill(koennenDir, 'young-skill', {
      name: 'young-skill', version: '1', description: 'd', entry: 'index.js',
      status: 'rehearsing',
      koennen: { crystallizedAt: Date.now() - 50 * 60 * 60 * 1000, rehearsalCount: 3, rehearsedInputHashes: ['a','b','c'], acquisitionContext: null },
    });

    const tracker = _fakeTracker({
      'young-skill': { successes: 3, total: 3, wilsonLB: 0.72, lastInvocation: Date.now(), lastSuccess: Date.now(), runs: 3 },
    });
    const ev = new SkillPromotionEvaluator({ bus: _fakeBus(), genesisDir: root });
    ev.skillManager = _fakeSkillManager(koennenDir);
    ev.effectivenessTracker = tracker;

    const result = await ev.evaluate();
    assertEqual(result.results.promoted.length, 0, 'not promoted with only 3 invocations');
  });

  test('koennen-promotion-v794 contract: skill with too few distinct inputs stays pending', async () => {
    const root = _tmpKoennenDir();
    const koennenDir = path.join(root, 'koennen', 'skills-pending');

    _writeSkill(koennenDir, 'narrow-skill', {
      name: 'narrow-skill', version: '1', description: 'd', entry: 'index.js',
      status: 'rehearsing',
      koennen: { crystallizedAt: Date.now() - 50 * 60 * 60 * 1000, rehearsalCount: 8, rehearsedInputHashes: ['x','x','x'], acquisitionContext: null },
    });

    const tracker = _fakeTracker({
      'narrow-skill': { successes: 8, total: 8, wilsonLB: 0.72, lastInvocation: Date.now(), lastSuccess: Date.now(), runs: 8 },
    });
    const ev = new SkillPromotionEvaluator({ bus: _fakeBus(), genesisDir: root });
    ev.skillManager = _fakeSkillManager(koennenDir);
    ev.effectivenessTracker = tracker;

    const result = await ev.evaluate();
    assertEqual(result.results.promoted.length, 0, 'not promoted with only 1 distinct input');
  });

  test('koennen-promotion-v794 contract: skill too young (<48h) stays pending', async () => {
    const root = _tmpKoennenDir();
    const koennenDir = path.join(root, 'koennen', 'skills-pending');

    _writeSkill(koennenDir, 'fresh-skill', {
      name: 'fresh-skill', version: '1', description: 'd', entry: 'index.js',
      status: 'rehearsing',
      koennen: { crystallizedAt: Date.now() - 1 * 60 * 60 * 1000, rehearsalCount: 8, rehearsedInputHashes: ['a','b','c'], acquisitionContext: null },
    });

    const tracker = _fakeTracker({
      'fresh-skill': { successes: 8, total: 8, wilsonLB: 0.72, lastInvocation: Date.now(), lastSuccess: Date.now(), runs: 8 },
    });
    const ev = new SkillPromotionEvaluator({ bus: _fakeBus(), genesisDir: root });
    ev.skillManager = _fakeSkillManager(koennenDir);
    ev.effectivenessTracker = tracker;

    const result = await ev.evaluate();
    assertEqual(result.results.promoted.length, 0, 'not promoted when only 1h old');
  });

  test('koennen-promotion-v794 contract: skill with too low Wilson-LB stays pending', async () => {
    const root = _tmpKoennenDir();
    const koennenDir = path.join(root, 'koennen', 'skills-pending');

    _writeSkill(koennenDir, 'unreliable-skill', {
      name: 'unreliable-skill', version: '1', description: 'd', entry: 'index.js',
      status: 'rehearsing',
      koennen: { crystallizedAt: Date.now() - 50 * 60 * 60 * 1000, rehearsalCount: 8, rehearsedInputHashes: ['a','b','c'], acquisitionContext: null },
    });

    const tracker = _fakeTracker({
      'unreliable-skill': { successes: 5, total: 8, wilsonLB: 0.45, lastInvocation: Date.now(), lastSuccess: Date.now(), runs: 8 },
    });
    const ev = new SkillPromotionEvaluator({ bus: _fakeBus(), genesisDir: root });
    ev.skillManager = _fakeSkillManager(koennenDir);
    ev.effectivenessTracker = tracker;

    const result = await ev.evaluate();
    assertEqual(result.results.promoted.length, 0, 'not promoted with Wilson 0.45');
  });

});

describe('koennen-promotion-v794 contract: quarantine and discard suggestion', () => {

  test('koennen-promotion-v794 contract: Wilson<0.30 with ≥5 invocations triggers quarantine', async () => {
    const root = _tmpKoennenDir();
    const koennenDir = path.join(root, 'koennen', 'skills-pending');

    _writeSkill(koennenDir, 'bad-skill', {
      name: 'bad-skill', version: '1', description: 'd', entry: 'index.js',
      status: 'rehearsing',
      koennen: { crystallizedAt: Date.now() - 50 * 60 * 60 * 1000, rehearsalCount: 6, rehearsedInputHashes: ['a','b','c'], acquisitionContext: null },
    });

    const tracker = _fakeTracker({
      'bad-skill': { successes: 1, total: 6, wilsonLB: 0.15, lastInvocation: Date.now(), lastSuccess: 0, runs: 6 },
    });
    const bus = _fakeBus();
    const ev = new SkillPromotionEvaluator({ bus, genesisDir: root });
    ev.skillManager = _fakeSkillManager(koennenDir);
    ev.effectivenessTracker = tracker;

    const result = await ev.evaluate();
    assertEqual(result.results.quarantined.length, 1, 'one quarantined');
    assertEqual(result.results.quarantined[0], 'bad-skill', 'correct skill quarantined');

    const m = JSON.parse(fs.readFileSync(path.join(koennenDir, 'bad-skill', 'skill-manifest.json'), 'utf-8'));
    assertEqual(m.status, 'quarantined', 'status updated on disk');

    const events = bus.events.filter(e => e.name === 'skill:quarantined');
    assertEqual(events.length, 1, 'skill:quarantined event fired');
  });

  test('koennen-promotion-v794 contract: discard-suggestion is rate-limited to 1 per evaluate', async () => {
    const root = _tmpKoennenDir();
    const koennenDir = path.join(root, 'koennen', 'skills-pending');

    // Three languishing skills: all old, few rehearsals, ambiguous Wilson
    for (const n of ['langu1', 'langu2', 'langu3']) {
      _writeSkill(koennenDir, n, {
        name: n, version: '1', description: 'd', entry: 'index.js',
        status: 'pending',
        koennen: { crystallizedAt: Date.now() - 16 * 24 * 60 * 60 * 1000, rehearsalCount: 1, rehearsedInputHashes: ['x'], acquisitionContext: null },
      });
    }

    const tracker = _fakeTracker({
      'langu1': { successes: 0, total: 1, wilsonLB: 0.45, lastInvocation: Date.now() - 10*24*3600*1000, lastSuccess: 0, runs: 1 },
      'langu2': { successes: 0, total: 1, wilsonLB: 0.50, lastInvocation: Date.now() - 10*24*3600*1000, lastSuccess: 0, runs: 1 },
      'langu3': { successes: 0, total: 1, wilsonLB: 0.55, lastInvocation: Date.now() - 10*24*3600*1000, lastSuccess: 0, runs: 1 },
    });
    const bus = _fakeBus();
    const ev = new SkillPromotionEvaluator({ bus, genesisDir: root });
    ev.skillManager = _fakeSkillManager(koennenDir);
    ev.effectivenessTracker = tracker;

    const result = await ev.evaluate();
    assertEqual(result.results.discardSuggested.length, 1, 'rate-limited to 1 suggestion per cycle');
  });

});

describe('koennen-promotion-v794 contract: legacy migration', () => {

  test('koennen-promotion-v794 contract: legacy v7.9.0 manifest gets migrated on first read', async () => {
    const root = _tmpKoennenDir();
    const koennenDir = path.join(root, 'koennen', 'skills-pending');

    // Legacy: no status, no rehearsalCount, no rehearsedInputHashes, no acquisitionContext
    _writeSkill(koennenDir, 'legacy-skill', {
      name: 'legacy-skill',
      version: '1.0.0',
      description: 'a skill from v7.9.0',
      entry: 'index.js',
      koennen: {
        crystallizedAt: Date.now() - 10 * 24 * 60 * 60 * 1000,
        sourceCandidateIds: ['cand_x'],
        patternSignature: 'abc',
      },
    });

    const tracker = _fakeTracker({});
    const ev = new SkillPromotionEvaluator({ bus: _fakeBus(), genesisDir: root });
    ev.skillManager = _fakeSkillManager(koennenDir);
    ev.effectivenessTracker = tracker;

    await ev.evaluate();

    const m = JSON.parse(fs.readFileSync(path.join(koennenDir, 'legacy-skill', 'skill-manifest.json'), 'utf-8'));
    assertEqual(m.status, 'pending', 'status defaulted to pending');
    assertEqual(m.koennen.rehearsalCount, 0, 'rehearsalCount defaulted to 0');
    assertEqual(m.koennen.acquisitionContext, null, 'acquisitionContext null for legacy');
    assert(Array.isArray(m.koennen.rehearsedInputHashes), 'rehearsedInputHashes initialized');
    assertEqual(m.koennen.rehearsedInputHashes.length, 0, 'rehearsedInputHashes empty');
  });

  test('koennen-promotion-v794 contract: migration is idempotent on second read', async () => {
    const root = _tmpKoennenDir();
    const koennenDir = path.join(root, 'koennen', 'skills-pending');

    _writeSkill(koennenDir, 'already-migrated', {
      name: 'already-migrated', version: '1', description: 'd', entry: 'index.js',
      status: 'pending',
      koennen: {
        crystallizedAt: Date.now() - 5 * 24 * 60 * 60 * 1000,
        rehearsalCount: 2,
        rehearsedInputHashes: ['a', 'b'],
        acquisitionContext: 'has a biography',
        promotedAt: null,
        discardedAt: null,
        discardedReason: null,
      },
    });

    const ev = new SkillPromotionEvaluator({ bus: _fakeBus(), genesisDir: root });
    ev.skillManager = _fakeSkillManager(koennenDir);
    ev.effectivenessTracker = _fakeTracker({});

    const before = fs.readFileSync(path.join(koennenDir, 'already-migrated', 'skill-manifest.json'), 'utf-8');
    await ev.evaluate();
    await ev.evaluate();
    const after = fs.readFileSync(path.join(koennenDir, 'already-migrated', 'skill-manifest.json'), 'utf-8');

    // Idempotent: contents unchanged through 2 passes (modulo whitespace)
    const m1 = JSON.parse(before);
    const m2 = JSON.parse(after);
    assertEqual(m1.koennen.acquisitionContext, m2.koennen.acquisitionContext, 'acquisition context preserved');
    assertEqual(m1.koennen.rehearsalCount, m2.koennen.rehearsalCount, 'rehearsal count preserved');
    assertEqual(m1.status, m2.status, 'status preserved');
  });

});

describe('koennen-promotion-v794 contract: graceful degradation', () => {

  test('koennen-promotion-v794 contract: returns skipped when no skill manager', async () => {
    const ev = new SkillPromotionEvaluator({ bus: _fakeBus() });
    ev.effectivenessTracker = _fakeTracker({});
    const r = await ev.evaluate();
    assertEqual(r.skipped, 'no-skill-manager');
  });

  test('koennen-promotion-v794 contract: returns skipped when no tracker', async () => {
    const ev = new SkillPromotionEvaluator({ bus: _fakeBus() });
    ev.skillManager = { koennenDir: '/tmp/x' };
    const r = await ev.evaluate();
    assertEqual(r.skipped, 'no-tracker');
  });

  test('koennen-promotion-v794 contract: returns skipped when promotion setting disabled', async () => {
    const ev = new SkillPromotionEvaluator({
      bus: _fakeBus(),
      settings: { get(p) { if (p === 'cognitive.koennen.promotion.enabled') return false; return null; } },
    });
    ev.skillManager = { koennenDir: '/tmp/x' };
    ev.effectivenessTracker = _fakeTracker({});
    const r = await ev.evaluate();
    assertEqual(r.skipped, 'disabled');
  });

});

run();
