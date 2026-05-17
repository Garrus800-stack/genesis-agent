// ============================================================
// GENESIS — test/modules/v790-koennen-narrative-and-slash.contract.test.js
// Contract test for v7.9.0 Phase 2:
//   • SelfNarrative.skill-crystallized listener bumps accumulator by 3
//   • /skills-pending slash: helpful message when directory missing
//   • /skills-pending slash: helpful message when directory empty
//   • /skills-pending slash: lists pending skills with manifest info
//   • /skills-pending slash: shows Wilson-LB when tracker is wired
//   • /skills-pending slash: tolerates malformed manifest
// All test names carry `koennen-crystallizer-v790 contract:` prefix.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');
const { SelfNarrative } = require(path.join(ROOT, 'src/agent/cognitive/SelfNarrative'));
const { commandHandlersGoals } = require(path.join(ROOT, 'src/agent/hexagonal/CommandHandlersGoals'));

function makeBus() {
  const subs = new Map();
  return {
    on: (event, fn) => {
      if (!subs.has(event)) subs.set(event, new Set());
      subs.get(event).add(fn);
      return () => subs.get(event).delete(fn);
    },
    fire: (event, data) => {
      const set = subs.get(event);
      if (set) for (const fn of set) try { fn(data); } catch (_e) {}
    },
    emit: function () { return this.fire.apply(this, arguments); },
  };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-koennen-c-'));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
}

function newNarrative(bus) {
  const sn = new SelfNarrative({
    bus,
    metaLearning: { getStats: () => ({}), getAll: () => [] },
    episodicMemory: { getRecent: () => [] },
    emotionalState: { snapshot: () => ({}) },
    storage: null,
    model: { chat: async () => '' },
  });
  sn.start();
  return sn;
}

function newGoalsHandler(extras = {}) {
  const inst = Object.create(commandHandlersGoals);
  inst.koennenCandidateLog = null;
  inst.skillEffectivenessTracker = null;
  inst._genesisDir = null;
  inst.lang = { t: (k) => k };
  Object.assign(inst, extras);
  return inst;
}

function writePendingSkill(dir, name, manifest) {
  const skillDir = path.join(dir, 'koennen', 'skills-pending', name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'skill-manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(skillDir, 'index.js'), '// stub');
}

describe('koennen-crystallizer-v790 contract: SelfNarrative + /skills-pending', () => {
  test('koennen-crystallizer-v790 contract: skill-crystallized bumps accumulator by 3', () => {
    const bus = makeBus();
    const sn = newNarrative(bus);
    const before = sn.getChangeAccumulator();
    bus.fire('skill-crystallized', {
      skillName: 'foo', sourceCandidateIds: ['c'], patternSignature: 'sig',
    });
    assertEqual(sn.getChangeAccumulator(), before + 3);
  });

  test('koennen-crystallizer-v790 contract: /skills-pending returns helpful message when missing', () => {
    const tmp = tmpDir();
    try {
      const h = newGoalsHandler({ _genesisDir: tmp });
      const out = h.skillsPending('/skills-pending');
      assert(/No pending skills/.test(out));
    } finally { cleanup(tmp); }
  });

  test('koennen-crystallizer-v790 contract: /skills-pending returns helpful message when empty', () => {
    const tmp = tmpDir();
    try {
      fs.mkdirSync(path.join(tmp, 'koennen', 'skills-pending'), { recursive: true });
      const h = newGoalsHandler({ _genesisDir: tmp });
      assert(/No pending skills/.test(h.skillsPending('/skills-pending')));
    } finally { cleanup(tmp); }
  });

  test('koennen-crystallizer-v790 contract: /skills-pending lists pending skills with description', () => {
    const tmp = tmpDir();
    try {
      writePendingSkill(tmp, 'markdown-to-html', {
        name: 'markdown-to-html', description: 'Converts markdown to HTML',
        koennen: { crystallizedAt: Date.parse('2026-05-15T10:00:00Z'), patternSignature: 'a' },
      });
      const h = newGoalsHandler({ _genesisDir: tmp });
      const out = h.skillsPending('/skills-pending');
      assert(out.includes('Pending Skills'));
      assert(out.includes('1 extracted'));
      assert(out.includes('markdown-to-html'));
      assert(out.includes('Converts markdown to HTML'));
      assert(out.includes('2026-05-15'));
      assert(out.includes('wilson: —'));
    } finally { cleanup(tmp); }
  });

  test('koennen-crystallizer-v790 contract: /skills-pending shows Wilson-LB when tracker wired', () => {
    const tmp = tmpDir();
    try {
      writePendingSkill(tmp, 'flaky', {
        name: 'flaky', description: 'does X',
        koennen: { crystallizedAt: Date.now(), patternSignature: 's' },
      });
      const tracker = {
        getStats: (n) => n === 'flaky'
          ? { successes: 4, total: 10, wilsonLB: 0.18, runs: 9,
              lastInvocation: 0, lastSuccess: 0 }
          : null,
      };
      const h = newGoalsHandler({ _genesisDir: tmp, skillEffectivenessTracker: tracker });
      const out = h.skillsPending('/skills-pending');
      assert(out.includes('wilson: 0.18'));
      assert(out.includes('9 runs'));
    } finally { cleanup(tmp); }
  });

  test('koennen-crystallizer-v790 contract: /skills-pending tolerates malformed manifest', () => {
    const tmp = tmpDir();
    try {
      const d = path.join(tmp, 'koennen', 'skills-pending', 'broken');
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'skill-manifest.json'), '{ invalid');
      fs.writeFileSync(path.join(d, 'index.js'), '// stub');
      const h = newGoalsHandler({ _genesisDir: tmp });
      const out = h.skillsPending('/skills-pending');
      assert(out.includes('broken'));
      assert(out.includes('(no description)'));
    } finally { cleanup(tmp); }
  });
});

run();
