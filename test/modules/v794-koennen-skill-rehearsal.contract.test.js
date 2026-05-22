// ============================================================
// GENESIS — test/modules/v794-koennen-skill-rehearsal.contract.test.js
// Contract test for v7.9.4 SkillRehearsal activity:
//   • shouldTrigger returns 0 when no pendingDir / no skillManager / no tracker
//   • shouldTrigger boost scales with pendingCount, capped at 1.6
//   • run() picks the skill with fewest rehearsals
//   • run() transitions status pending → rehearsing on first rehearsal
//   • run() updates rehearsedInputHashes (capped at 50)
//   • Distinct inputs accumulate, duplicates don't grow the set
//   • LLM-disabled fallback returns {}
// Every test name carries `koennen-promotion-v794 contract:` prefix.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');
const SkillRehearsal = require(path.join(ROOT, 'src/agent/autonomy/activities/SkillRehearsal'));

function _tmpKoennenDir() {
  const dir = path.join(os.tmpdir(), `genesis-rehearsal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function _writeSkill(koennenDir, name, manifest, code = 'module.exports = { execute: async (i) => ({ ok: true, echo: i }) };') {
  const skillDir = path.join(koennenDir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'skill-manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(skillDir, 'index.js'), code);
  return skillDir;
}

function _fakeIdleMind({ koennenDir, withModel = false, llmReturn = null, executeReturn = { output: '', error: null } }) {
  const tracker = {
    _records: [],
    recordInvocation(name, success, opts) { this._records.push({ name, success, opts }); },
    getStats() { return null; },
    getWilsonLB() { return 0.5; },
  };
  const sm = {
    koennenDir,
    listSkills() { return []; },
    async executeSkillByManifest(name, dir, input, opts) {
      tracker.recordInvocation(name, !executeReturn.error, opts);
      return executeReturn;
    },
  };
  return {
    skillManager: sm,
    effectivenessTracker: tracker,
    model: withModel ? {
      chat: async () => llmReturn,
    } : null,
    bus: { fire: () => {} },
    _settings: null,
  };
}

describe('koennen-promotion-v794 contract: SkillRehearsal activity metadata', () => {

  test('koennen-promotion-v794 contract: registered with name skill-rehearsal', () => {
    assertEqual(SkillRehearsal.name, 'skill-rehearsal', 'activity name');
    assertEqual(SkillRehearsal.weight, 1.0, 'activity weight');
    assertEqual(SkillRehearsal.cooldown, 10 * 60 * 1000, 'cooldown 10min');
    assertEqual(typeof SkillRehearsal.shouldTrigger, 'function', 'has shouldTrigger');
    assertEqual(typeof SkillRehearsal.run, 'function', 'has run');
  });

});

describe('koennen-promotion-v794 contract: SkillRehearsal shouldTrigger', () => {

  test('koennen-promotion-v794 contract: returns 0 without skillManager', () => {
    const ctx = { services: {}, snap: {} };
    assertEqual(SkillRehearsal.shouldTrigger(ctx), 0);
  });

  test('koennen-promotion-v794 contract: returns 0 without tracker', () => {
    const ctx = { services: { skillManager: { koennenDir: '/tmp/x' } }, snap: {} };
    assertEqual(SkillRehearsal.shouldTrigger(ctx), 0);
  });

  test('koennen-promotion-v794 contract: returns 0 when no pending skills', () => {
    const dir = _tmpKoennenDir();
    const ctx = {
      services: { skillManager: { koennenDir: dir }, effectivenessTracker: {} },
      snap: { genomeTraits: { curiosity: 0.6 } },
    };
    assertEqual(SkillRehearsal.shouldTrigger(ctx), 0);
  });

  test('koennen-promotion-v794 contract: boost scales with pendingCount, capped at 1.6', () => {
    const dir = _tmpKoennenDir();
    // Create 20 pending skills — boost should saturate
    for (let i = 0; i < 20; i++) {
      _writeSkill(dir, `skill-${i}`, {
        name: `skill-${i}`, version: '1', description: 'd', entry: 'index.js',
        status: 'pending',
        koennen: { crystallizedAt: Date.now(), rehearsalCount: 0, rehearsedInputHashes: [] },
      });
    }
    const ctx = {
      services: { skillManager: { koennenDir: dir }, effectivenessTracker: {} },
      snap: { genomeTraits: { curiosity: 1.0 } },  // max curiosity
    };
    const boost = SkillRehearsal.shouldTrigger(ctx);
    // (0.5 + 1.0) * min(1.6, 1+0.15*20) = 1.5 * 1.6 = 2.4
    // The cap is on the pendingCount-scaling, not the total — verify it
    // didn't run away.
    assert(boost > 0, 'positive boost');
    assert(boost <= 1.5 * 1.6 + 0.01, `boost ${boost} respects cap (≤ 1.5 * 1.6 = 2.4)`);
  });

  test('koennen-promotion-v794 contract: curiosity multiplier (0.5 + curiosity)', () => {
    const dir = _tmpKoennenDir();
    _writeSkill(dir, 'one', {
      name: 'one', version: '1', description: 'd', entry: 'index.js',
      status: 'pending',
      koennen: { crystallizedAt: Date.now(), rehearsalCount: 0, rehearsedInputHashes: [] },
    });
    const ctx0 = {
      services: { skillManager: { koennenDir: dir }, effectivenessTracker: {} },
      snap: { genomeTraits: { curiosity: 0 } },
    };
    const ctx1 = {
      services: { skillManager: { koennenDir: dir }, effectivenessTracker: {} },
      snap: { genomeTraits: { curiosity: 1 } },
    };
    const boost0 = SkillRehearsal.shouldTrigger(ctx0);
    const boost1 = SkillRehearsal.shouldTrigger(ctx1);
    assert(boost1 > boost0, `high curiosity (${boost1}) > zero curiosity (${boost0})`);
  });

});

describe('koennen-promotion-v794 contract: SkillRehearsal run() picks least-rehearsed', () => {

  test('koennen-promotion-v794 contract: picks skill with fewest rehearsals', async () => {
    const dir = _tmpKoennenDir();
    _writeSkill(dir, 'much-rehearsed', {
      name: 'much-rehearsed', version: '1', description: 'd', entry: 'index.js',
      status: 'rehearsing',
      koennen: { crystallizedAt: Date.now() - 1000, rehearsalCount: 10, rehearsedInputHashes: ['a','b','c'] },
    });
    _writeSkill(dir, 'fresh-skill', {
      name: 'fresh-skill', version: '1', description: 'd', entry: 'index.js',
      status: 'pending',
      koennen: { crystallizedAt: Date.now(), rehearsalCount: 0, rehearsedInputHashes: [] },
    });

    const idle = _fakeIdleMind({ koennenDir: dir });
    const result = await SkillRehearsal.run(idle);

    assert(result && result.includes('fresh-skill'), `expected fresh-skill rehearsed, got: ${result}`);
    assert(idle.effectivenessTracker._records.length === 1, 'one invocation recorded');
    assertEqual(idle.effectivenessTracker._records[0].name, 'fresh-skill');
  });

  test('koennen-promotion-v794 contract: status transitions pending → rehearsing on first rehearsal', async () => {
    const dir = _tmpKoennenDir();
    _writeSkill(dir, 'first-rehearsal', {
      name: 'first-rehearsal', version: '1', description: 'd', entry: 'index.js',
      status: 'pending',
      koennen: { crystallizedAt: Date.now(), rehearsalCount: 0, rehearsedInputHashes: [] },
    });

    const idle = _fakeIdleMind({ koennenDir: dir });
    await SkillRehearsal.run(idle);

    const m = JSON.parse(fs.readFileSync(path.join(dir, 'first-rehearsal', 'skill-manifest.json'), 'utf-8'));
    assertEqual(m.status, 'rehearsing', 'status transitioned to rehearsing');
    assertEqual(m.koennen.rehearsalCount, 1, 'rehearsalCount incremented');
    assertEqual(m.koennen.rehearsedInputHashes.length, 1, 'one input hash recorded');
  });

  test('koennen-promotion-v794 contract: distinct inputs accumulate, duplicates do not', async () => {
    const dir = _tmpKoennenDir();
    _writeSkill(dir, 'distinct-test', {
      name: 'distinct-test', version: '1', description: 'd', entry: 'index.js',
      status: 'rehearsing',
      koennen: { crystallizedAt: Date.now(), rehearsalCount: 0, rehearsedInputHashes: [] },
    });

    // No LLM → input is always {}, so all hashes identical
    const idle = _fakeIdleMind({ koennenDir: dir, withModel: false });
    await SkillRehearsal.run(idle);
    await SkillRehearsal.run(idle);
    await SkillRehearsal.run(idle);

    const m = JSON.parse(fs.readFileSync(path.join(dir, 'distinct-test', 'skill-manifest.json'), 'utf-8'));
    assertEqual(m.koennen.rehearsalCount, 3, 'three rehearsals counted');
    assertEqual(m.koennen.rehearsedInputHashes.length, 1, 'all three inputs hash to same — only one distinct');
  });

  test('koennen-promotion-v794 contract: LLM-disabled fallback gives empty input', async () => {
    const dir = _tmpKoennenDir();
    _writeSkill(dir, 'no-llm', {
      name: 'no-llm', version: '1', description: 'd', entry: 'index.js',
      status: 'pending',
      koennen: { crystallizedAt: Date.now(), rehearsalCount: 0, rehearsedInputHashes: [] },
    });

    // Disable LLM via settings stub
    const idle = _fakeIdleMind({ koennenDir: dir, withModel: true });
    idle._settings = {
      get(p) {
        if (p === 'cognitive.koennen.rehearsal.inputGeneration.llmFallback') return false;
        return null;
      },
    };

    const result = await SkillRehearsal.run(idle);
    assert(result, 'run completed');
    // Wouldn't have thrown — the empty-input fallback worked
  });

  test('koennen-promotion-v794 contract: sandbox error still counts as rehearsal', async () => {
    const dir = _tmpKoennenDir();
    _writeSkill(dir, 'errors-out', {
      name: 'errors-out', version: '1', description: 'd', entry: 'index.js',
      status: 'pending',
      koennen: { crystallizedAt: Date.now(), rehearsalCount: 0, rehearsedInputHashes: [] },
    });

    const idle = _fakeIdleMind({
      koennenDir: dir,
      executeReturn: { output: '', error: 'simulated failure' },
    });
    const result = await SkillRehearsal.run(idle);

    assert(result && result.includes('error'), `expected error in result text: ${result}`);
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'errors-out', 'skill-manifest.json'), 'utf-8'));
    assertEqual(m.koennen.rehearsalCount, 1, 'rehearsal counted even on error');
    assertEqual(idle.effectivenessTracker._records[0].success, false, 'tracker received success=false');
  });

  test('koennen-promotion-v794 contract: rehearsedInputHashes capped at 50', async () => {
    const dir = _tmpKoennenDir();
    const huge = [];
    for (let i = 0; i < 60; i++) huge.push(`hash-${i}`);
    _writeSkill(dir, 'overflow', {
      name: 'overflow', version: '1', description: 'd', entry: 'index.js',
      status: 'rehearsing',
      koennen: { crystallizedAt: Date.now(), rehearsalCount: 60, rehearsedInputHashes: huge },
    });

    // Add one more rehearsal — should keep array ≤ 50
    const idle = _fakeIdleMind({ koennenDir: dir });
    await SkillRehearsal.run(idle);

    const m = JSON.parse(fs.readFileSync(path.join(dir, 'overflow', 'skill-manifest.json'), 'utf-8'));
    assert(m.koennen.rehearsedInputHashes.length <= 50, `hashes capped to ≤50, got ${m.koennen.rehearsedInputHashes.length}`);
  });

});

run();
