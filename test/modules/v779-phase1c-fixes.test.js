#!/usr/bin/env node
// v7.7.9 Phase 1c — bug-fix contract
//
// Three bugs surfaced during Phase 1 burn-in on Win:
//
//   F1: SelfSpawner.spawnParallel() fired all tasks at once, so anything
//       beyond _maxWorkers fail-fast with "Max workers reached". A 10-task
//       run on a 3-worker pool produced 7 redundant warnings and lost
//       7 subtasks. Fix: real worker-pool with FIFO queue, max
//       _maxWorkers concurrent, no rejected tasks.
//
//   F2: ColonyOrchestrator decomposed up to maxSubtasks (default 10)
//       even when the local worker pool was smaller. Cap should be
//       min(config.maxSubtasks, selfSpawner.maxWorkers) for local
//       execution; only peer-distributed runs see the unrestricted
//       config value.
//
//   F3: AutonomousDaemon._checkDesiredCapabilities() looked for skills
//       under fixed names ('web-search', 'file-manager', 'scheduler',
//       'chart-gen'), but createSkill() let the LLM pick names freely.
//       Result: the same gaps re-detected every cycle, the same skill
//       built repeatedly under different names. Fix: gap carries an
//       expectedSkill name; createSkill accepts a desiredName option
//       and forces the manifest to use it.

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');

// ── F1: SelfSpawner worker-pool ─────────────────────────────

const { SelfSpawner } = require('../../src/agent/capabilities/SelfSpawner');

function spawnerStub({ maxWorkers = 3, taskMs = 20 } = {}) {
  // Stub spawn(): never starts a real worker, just simulates concurrency.
  const inFlight = { current: 0, peak: 0 };
  const s = new SelfSpawner({ bus: null, rootDir: '.', config: { maxWorkers } });
  // Override spawn so we don't fork real Node processes.
  s.spawn = function fakeSpawn(task) {
    return new Promise((resolve) => {
      inFlight.current++;
      if (inFlight.current > inFlight.peak) inFlight.peak = inFlight.current;
      setTimeout(() => {
        inFlight.current--;
        resolve({ success: true, result: { description: task.description } });
      }, taskMs);
    });
  };
  return { spawner: s, inFlight };
}

describe('F1 — SelfSpawner.spawnParallel uses a real worker pool', () => {
  test('runs tasks beyond maxWorkers without fail-fast errors', async () => {
    const { spawner } = spawnerStub({ maxWorkers: 3, taskMs: 10 });
    const tasks = Array.from({ length: 10 }, (_, i) => ({ description: `t${i}` }));
    const results = await spawner.spawnParallel(tasks);
    assertEqual(results.length, 10);
    const succeeded = results.filter(r => r && r.success).length;
    assertEqual(succeeded, 10);
  });

  test('peak concurrency never exceeds maxWorkers', async () => {
    const { spawner, inFlight } = spawnerStub({ maxWorkers: 3, taskMs: 25 });
    const tasks = Array.from({ length: 12 }, (_, i) => ({ description: `t${i}` }));
    await spawner.spawnParallel(tasks);
    assert(inFlight.peak <= 3, `peak was ${inFlight.peak}, expected ≤ 3`);
    assert(inFlight.peak >= 1, 'expected at least one worker to run');
  });

  test('result order matches input order', async () => {
    const { spawner } = spawnerStub({ maxWorkers: 2, taskMs: 5 });
    const tasks = Array.from({ length: 6 }, (_, i) => ({ description: `task-${i}` }));
    const results = await spawner.spawnParallel(tasks);
    for (let i = 0; i < tasks.length; i++) {
      assertEqual(results[i].result.description, `task-${i}`);
    }
  });

  test('empty input returns empty array', async () => {
    const { spawner } = spawnerStub({ maxWorkers: 3 });
    const results = await spawner.spawnParallel([]);
    assertEqual(results.length, 0);
  });

  test('public maxWorkers getter exposes pool size', () => {
    const { spawner } = spawnerStub({ maxWorkers: 4 });
    assertEqual(spawner.maxWorkers, 4);
  });
});

// ── F2: ColonyOrchestrator decompose cap ────────────────────

const { ColonyOrchestrator } = require('../../src/agent/revolution/ColonyOrchestrator');

function colonyStub({ maxSubtasks = 10, spawnerMaxWorkers = 3, peers = 0 } = {}) {
  const fakeBus = { fire: () => {} };
  const fakeLLM = {
    async chat() {
      // Return 10 subtasks regardless — the LLM tries its best, but
      // the post-LLM slice() must cap to the effective max.
      const subs = Array.from({ length: 10 }, (_, i) => ({ description: `sub-${i}` }));
      return JSON.stringify(subs);
    },
  };
  const fakeSpawner = { maxWorkers: spawnerMaxWorkers, spawnParallel: async () => [] };
  const fakePeers = { getPeers: () => [] };
  if (peers > 0) {
    fakePeers.getPeers = () => Array.from({ length: peers }, (_, i) => ({ id: `peer${i}` }));
  }
  const orch = new ColonyOrchestrator({
    bus: fakeBus,
    peerNetwork: fakePeers,
    taskDelegation: null,
    peerConsensus: null,
    llm: fakeLLM,
    selfSpawner: fakeSpawner,
    config: { maxSubtasks },
  });
  return orch;
}

describe('F2 — ColonyOrchestrator caps decompose at worker-pool size for local runs', () => {
  test('local execution: caps at min(maxSubtasks, spawner.maxWorkers)', () => {
    const orch = colonyStub({ maxSubtasks: 10, spawnerMaxWorkers: 3 });
    assertEqual(orch._effectiveMaxSubtasks(true), 3);
  });

  test('local execution: respects smaller config', () => {
    const orch = colonyStub({ maxSubtasks: 2, spawnerMaxWorkers: 5 });
    assertEqual(orch._effectiveMaxSubtasks(true), 2);
  });

  test('peer execution: original config.maxSubtasks applies', () => {
    const orch = colonyStub({ maxSubtasks: 10, spawnerMaxWorkers: 3, peers: 2 });
    assertEqual(orch._effectiveMaxSubtasks(false), 10);
  });

  test('no spawner wired: original config.maxSubtasks applies', () => {
    const fakeBus = { fire: () => {} };
    const fakePeers = { getPeers: () => [] };
    const orch = new ColonyOrchestrator({
      bus: fakeBus, peerNetwork: fakePeers,
      taskDelegation: null, peerConsensus: null,
      llm: null, selfSpawner: null,
      config: { maxSubtasks: 10 },
    });
    assertEqual(orch._effectiveMaxSubtasks(true), 10);
  });

  test('decompose returns at most effectiveMax subtasks', async () => {
    const orch = colonyStub({ maxSubtasks: 10, spawnerMaxWorkers: 3 });
    const subs = await orch._decompose('build a thing', {});
    assert(subs.length <= 3, `expected ≤ 3 subtasks, got ${subs.length}`);
  });
});

// ── F3: SkillManager desiredName ────────────────────────────

const { SkillManager } = require('../../src/agent/capabilities/SkillManager');
const path = require('path');
const fs = require('fs');
const os = require('os');

function skillManagerStub({ llmManifestName = null } = {}) {
  const tmpDir = path.join(os.tmpdir(), 'genesis-skill-test-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  fs.mkdirSync(tmpDir, { recursive: true });

  const fakeLLM = {
    async chat() {
      const name = llmManifestName ?? 'random-llm-pick';
      return [
        '```json',
        JSON.stringify({ name, version: '1.0.0', description: 'test skill', entry: 'index.js' }),
        '```',
        '',
        '```javascript',
        'module.exports = { run: () => "ok" };',
        '```',
      ].join('\n');
    },
  };
  const fakePrompts = { build: () => 'system prompt' };
  const fakeSandbox = {
    run: () => ({ ok: true }),
    testPatch: async () => ({ success: true }),
  };
  const fakeCodeSafety = { scanCode: () => ({ safe: true, issues: [] }) };

  // SkillManager(skillsDir, sandbox, model, prompts, guard)
  const sm = new SkillManager(tmpDir, fakeSandbox, fakeLLM, fakePrompts, null);
  sm._codeSafety = fakeCodeSafety;
  return sm;
}

describe('F3 — SkillManager.createSkill respects desiredName', () => {
  test('without desiredName: uses LLM-chosen name', async () => {
    const sm = skillManagerStub({ llmManifestName: 'llm-picked-name' });
    const result = await sm.createSkill('do something');
    const names = sm.listSkills().map(s => s.name);
    assert(names.includes('llm-picked-name'),
      `expected 'llm-picked-name' in [${names.join(', ')}], result was: ${result}`);
  });

  test('with desiredName: overrides LLM choice', async () => {
    const sm = skillManagerStub({ llmManifestName: 'llm-different-name' });
    await sm.createSkill('do something', { desiredName: 'web-search' });
    const names = sm.listSkills().map(s => s.name);
    assert(names.includes('web-search'),
      `expected 'web-search' in [${names.join(', ')}]`);
    assert(!names.includes('llm-different-name'),
      'LLM-picked name must have been overridden');
  });

  test('with desiredName when LLM gives no manifest: uses desiredName as auto-name', async () => {
    const tmpDir = path.join(os.tmpdir(), 'genesis-skill-test-' + Date.now() + '-' + Math.random().toString(36).slice(2));
    fs.mkdirSync(tmpDir, { recursive: true });
    const fakeLLM = {
      async chat() {
        return '```javascript\nmodule.exports = { run: () => "ok" };\n```';
      },
    };
    const fakePrompts = { build: () => 'system' };
    const fakeSandbox = {
      run: () => ({ ok: true }),
      testPatch: async () => ({ success: true }),
    };
    const sm = new SkillManager(tmpDir, fakeSandbox, fakeLLM, fakePrompts, null);
    sm._codeSafety = { scanCode: () => ({ safe: true, issues: [] }) };
    await sm.createSkill('do something', { desiredName: 'scheduler' });
    const names = sm.listSkills().map(s => s.name);
    assert(names.includes('scheduler'), `expected 'scheduler' in [${names.join(', ')}]`);
  });
});

run();
