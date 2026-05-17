// ============================================================
// GENESIS — test/modules/v790-skill-effectiveness-tracker.contract.test.js
// Contract test for v7.9.0 Phase 2 SkillEffectivenessTracker:
//   • recordInvocation updates successes/total/wilsonLB
//   • initial-evidence seed honors settings
//   • wilsonLB matches CognitiveSelfModel.wilsonLower (single source)
//   • invocation history capped at 50
//   • applyDecay reduces wilsonLB for week-old skills
//   • getWilsonLB returns 0.5 fallback for untracked skills
//   • forget removes a skill from tracking
//   • persists after each recordInvocation
//   • loads from storage on construction
//   • stop() persists final state without throwing
// All test names carry `koennen-crystallizer-v790 contract:` prefix.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { SkillEffectivenessTracker } = require(
  path.join(ROOT, 'src/agent/cognitive/SkillEffectivenessTracker')
);
const { wilsonLower } = require(
  path.join(ROOT, 'src/agent/cognitive/CognitiveSelfModel')
);

function makeBus() {
  return { on: () => () => {}, fire: () => {}, emit: () => {} };
}

function makeStorage() {
  const files = new Map();
  return {
    readJSON: (file, def) => files.has(file) ? JSON.parse(files.get(file)) : def,
    writeJSON: (file, data) => { files.set(file, JSON.stringify(data)); },
    _files: files,
  };
}

function makeSettings(overrides = {}) {
  const defaults = {
    'cognitive.koennen.effectiveness.initialEvidence': 1,
    'cognitive.koennen.effectiveness.decayPerWeek': 0.05,
    ...overrides,
  };
  return { get: (k, fb) => k in defaults ? defaults[k] : fb };
}

describe('koennen-crystallizer-v790 contract: SkillEffectivenessTracker', () => {
  test('koennen-crystallizer-v790 contract: recordInvocation updates totals and wilsonLB', () => {
    const t = new SkillEffectivenessTracker({
      bus: makeBus(), storage: makeStorage(), settings: makeSettings(),
    });
    t.recordInvocation('foo', true);
    t.recordInvocation('foo', true);
    t.recordInvocation('foo', false);
    const s = t.getStats('foo');
    // seed (1/1) + 2 success + 1 fail = 3/4
    assertEqual(s.successes, 3);
    assertEqual(s.total, 4);
    const expected = wilsonLower(3, 4);
    assert(Math.abs(s.wilsonLB - expected) < 1e-9);
  });

  test('koennen-crystallizer-v790 contract: initial-evidence is configurable', () => {
    const t = new SkillEffectivenessTracker({
      bus: makeBus(), storage: makeStorage(),
      settings: makeSettings({ 'cognitive.koennen.effectiveness.initialEvidence': 5 }),
    });
    t.recordInvocation('bar', true);
    assertEqual(t.getStats('bar').successes, 6);
    assertEqual(t.getStats('bar').total, 6);
  });

  test('koennen-crystallizer-v790 contract: invocation history capped at 50', () => {
    const t = new SkillEffectivenessTracker({
      bus: makeBus(), storage: makeStorage(), settings: makeSettings(),
    });
    for (let i = 0; i < 80; i++) t.recordInvocation('cap', i % 2 === 0);
    assertEqual(t.getStats('cap').runs, 50);
  });

  test('koennen-crystallizer-v790 contract: applyDecay reduces wilsonLB after a week unused', () => {
    let now = 1779000000000;
    const t = new SkillEffectivenessTracker({
      bus: makeBus(), storage: makeStorage(),
      settings: makeSettings({ 'cognitive.koennen.effectiveness.decayPerWeek': 0.1 }),
      clock: () => now,
    });
    t.recordInvocation('decayed', true);
    const before = t.getStats('decayed').wilsonLB;
    now += 2 * 7 * 24 * 60 * 60 * 1000;
    const n = t.applyDecay();
    assert(n > 0);
    assert(t.getStats('decayed').wilsonLB < before);
  });

  test('koennen-crystallizer-v790 contract: untracked skill returns 0.5 fallback', () => {
    const t = new SkillEffectivenessTracker({
      bus: makeBus(), storage: makeStorage(), settings: makeSettings(),
    });
    assertEqual(t.getWilsonLB('never-seen'), 0.5);
  });

  test('koennen-crystallizer-v790 contract: forget removes from tracking', () => {
    const t = new SkillEffectivenessTracker({
      bus: makeBus(), storage: makeStorage(), settings: makeSettings(),
    });
    t.recordInvocation('temp', true);
    assert(t.getStats('temp') !== null);
    t.forget('temp');
    assertEqual(t.getStats('temp'), null);
  });

  test('koennen-crystallizer-v790 contract: persists to storage after recordInvocation', () => {
    const storage = makeStorage();
    const t = new SkillEffectivenessTracker({
      bus: makeBus(), storage, settings: makeSettings(),
    });
    t.recordInvocation('p', true);
    assert(storage._files.has('koennen/skill-effectiveness.json'));
    const persisted = JSON.parse(storage._files.get('koennen/skill-effectiveness.json'));
    assertEqual(persisted.p.total, 2);
  });

  test('koennen-crystallizer-v790 contract: loads from storage on init', () => {
    const storage = makeStorage();
    storage.writeJSON('koennen/skill-effectiveness.json', {
      pre: { successes: 5, total: 10, wilsonLB: 0.21,
             lastInvocation: 0, lastSuccess: 0, invocations: [] },
    });
    const t = new SkillEffectivenessTracker({
      bus: makeBus(), storage, settings: makeSettings(),
    });
    assertEqual(t.getStats('pre').total, 10);
  });

  test('koennen-crystallizer-v790 contract: stop persists final state', () => {
    const storage = makeStorage();
    const t = new SkillEffectivenessTracker({
      bus: makeBus(), storage, settings: makeSettings(),
    });
    t.recordInvocation('z', true);
    storage._files.clear();
    t.stop();
    assert(storage._files.has('koennen/skill-effectiveness.json'));
  });

  test('koennen-crystallizer-v790 contract: getAll returns snapshot of all tracked skills', () => {
    const t = new SkillEffectivenessTracker({
      bus: makeBus(), storage: makeStorage(), settings: makeSettings(),
    });
    t.recordInvocation('a', true);
    t.recordInvocation('b', false);
    const all = t.getAll();
    assertEqual(Object.keys(all).length, 2);
    assert(all.a && all.b);
  });
});

run();
