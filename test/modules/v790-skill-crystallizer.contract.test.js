// ============================================================
// GENESIS — test/modules/v790-skill-crystallizer.contract.test.js
// Contract test for v7.9.0 Phase 2 SkillCrystallizer:
//   • run() no-ops when master toggle off
//   • run() no-ops when crystallization toggle off
//   • run() no-ops when llm.enabled is false
//   • cluster below minCandidatesPerPattern → no extraction
//   • cluster ≥ N + safe code + sandbox ok → written to skills-pending/
//   • CodeSafety block → fires skill:quarantined, NO skill-crystallized
//   • Sandbox-init failure → fires skill:quarantined
//   • Parse failure → reason='parse-failure', no quarantine
//   • Cooldown prevents re-extraction within window
//   • Already-pending pattern is skipped
//   • dream:skills-crystallized summary fires when something happened
//   • Persisted manifest carries koennen metadata
// All test names carry `koennen-crystallizer-v790 contract:` prefix.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');
const { SkillCrystallizer } = require(
  path.join(ROOT, 'src/agent/cognitive/SkillCrystallizer')
);

function makeBus() {
  const fired = [];
  return {
    on: () => () => {},
    fire: (event, data) => { fired.push({ event, data }); },
    emit: function () { return this.fire.apply(this, arguments); },
    _fired: fired,
    _of: (name) => fired.filter(e => e.event === name),
  };
}

function makeCandidateLog(records) {
  return { getCandidatesSince: () => records.slice() };
}

function makeModel(resp) {
  return { chat: async () => resp };
}

function makeSettings(overrides = {}) {
  const defaults = {
    'cognitive.koennen.enabled': true,
    'cognitive.koennen.crystallization.enabled': true,
    'cognitive.koennen.crystallization.minCandidatesPerPattern': 3,
    'cognitive.koennen.crystallization.windowMs': 7 * 24 * 60 * 60 * 1000,
    'cognitive.koennen.crystallization.cooldownMs': 6 * 60 * 60 * 1000,
    'cognitive.koennen.crystallization.llm.enabled': true,
    'cognitive.koennen.crystallization.llm.maxTokens': 2000,
    'cognitive.koennen.crystallization.llm.timeoutMs': 120000,
    'cognitive.koennen.crystallization.sandbox.initTestTimeoutMs': 10000,
    ...overrides,
  };
  return { get: (k, fb) => k in defaults ? defaults[k] : fb };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-cryst-'));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
}

function makeCandidates(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      candidateId: `cand_${i}`, goalId: `goal_${i}`,
      taskTitle: `convert markdown to html variant ${i}`,
      outcome: 'success', gatePass: true,
      recordedAt: Date.now() - i * 1000,
    });
  }
  return out;
}

const GOOD_LLM = '```json\n{\n  "name": "markdown-to-html",\n  "version": "1.0.0",\n  "description": "Converts markdown text into HTML.",\n  "entry": "index.js"\n}\n```\n\n```javascript\nclass MarkdownToHtml {\n  async execute(input) { return { html: String(input.text || "") }; }\n}\nmodule.exports = { MarkdownToHtml };\n```';

describe('koennen-crystallizer-v790 contract: SkillCrystallizer', () => {
  test('koennen-crystallizer-v790 contract: skipped when master toggle off', async () => {
    const tmp = tmpDir();
    try {
      const c = new SkillCrystallizer({
        bus: makeBus(), candidateLog: makeCandidateLog(makeCandidates(5)),
        model: makeModel(GOOD_LLM),
        settings: makeSettings({ 'cognitive.koennen.enabled': false }),
        genesisDir: tmp,
      });
      assertEqual((await c.run()).skipped, 'disabled');
    } finally { cleanup(tmp); }
  });

  test('koennen-crystallizer-v790 contract: skipped when crystallization toggle off', async () => {
    const tmp = tmpDir();
    try {
      const c = new SkillCrystallizer({
        bus: makeBus(), candidateLog: makeCandidateLog(makeCandidates(5)),
        model: makeModel(GOOD_LLM),
        settings: makeSettings({ 'cognitive.koennen.crystallization.enabled': false }),
        genesisDir: tmp,
      });
      assertEqual((await c.run()).skipped, 'disabled');
    } finally { cleanup(tmp); }
  });

  test('koennen-crystallizer-v790 contract: skipped when llm.enabled is false', async () => {
    const tmp = tmpDir();
    try {
      const c = new SkillCrystallizer({
        bus: makeBus(), candidateLog: makeCandidateLog(makeCandidates(5)),
        model: makeModel(GOOD_LLM),
        settings: makeSettings({ 'cognitive.koennen.crystallization.llm.enabled': false }),
        genesisDir: tmp,
      });
      assertEqual((await c.run()).skipped, 'llm-disabled');
    } finally { cleanup(tmp); }
  });

  test('koennen-crystallizer-v790 contract: cluster below minN → no extraction', async () => {
    const tmp = tmpDir();
    try {
      const bus = makeBus();
      const c = new SkillCrystallizer({
        bus, candidateLog: makeCandidateLog(makeCandidates(2)),
        model: makeModel(GOOD_LLM),
        codeSafety: { scanCode: () => ({ safe: true }) },
        sandbox: { execute: async () => ({ probe: 'ok' }) },
        settings: makeSettings(), genesisDir: tmp,
      });
      const r = await c.run();
      assertEqual((r.results || []).length, 0);
      assertEqual(bus._of('skill-crystallized').length, 0);
    } finally { cleanup(tmp); }
  });

  test('koennen-crystallizer-v790 contract: ≥N + safe + sandbox-ok → written to pending', async () => {
    const tmp = tmpDir();
    try {
      const bus = makeBus();
      const c = new SkillCrystallizer({
        bus, candidateLog: makeCandidateLog(makeCandidates(5)),
        model: makeModel(GOOD_LLM),
        codeSafety: { scanCode: () => ({ safe: true }) },
        sandbox: { execute: async () => ({ probe: 'ok' }) },
        settings: makeSettings(), genesisDir: tmp,
      });
      const r = await c.run();
      const ok = (r.results || []).filter(x => x.success);
      assert(ok.length >= 1);
      const dir = path.join(tmp, 'koennen', 'skills-pending', ok[0].skillName);
      assert(fs.existsSync(path.join(dir, 'skill-manifest.json')));
      assert(fs.existsSync(path.join(dir, 'index.js')));
      assertEqual(bus._of('skill-crystallized').length, ok.length);
    } finally { cleanup(tmp); }
  });

  test('koennen-crystallizer-v790 contract: CodeSafety block fires skill:quarantined, not skill-crystallized', async () => {
    const tmp = tmpDir();
    try {
      const bus = makeBus();
      const c = new SkillCrystallizer({
        bus, candidateLog: makeCandidateLog(makeCandidates(5)),
        model: makeModel(GOOD_LLM),
        codeSafety: { scanCode: () => ({ safe: false, reasons: ['eval-detected'] }) },
        sandbox: { execute: async () => ({ probe: 'ok' }) },
        settings: makeSettings(), genesisDir: tmp,
      });
      await c.run();
      assertEqual(bus._of('skill-crystallized').length, 0);
      const q = bus._of('skill:quarantined');
      assert(q.length >= 1);
      assertEqual(q[0].data.reason, 'codesafety');
    } finally { cleanup(tmp); }
  });

  test('koennen-crystallizer-v790 contract: sandbox-init failure fires skill:quarantined', async () => {
    const tmp = tmpDir();
    try {
      const bus = makeBus();
      const c = new SkillCrystallizer({
        bus, candidateLog: makeCandidateLog(makeCandidates(5)),
        model: makeModel(GOOD_LLM),
        codeSafety: { scanCode: () => ({ safe: true }) },
        sandbox: { execute: async () => { throw new Error('no execute method'); } },
        settings: makeSettings(), genesisDir: tmp,
      });
      await c.run();
      assertEqual(bus._of('skill-crystallized').length, 0);
      const q = bus._of('skill:quarantined');
      assert(q.length >= 1);
      assertEqual(q[0].data.reason, 'sandbox-init');
    } finally { cleanup(tmp); }
  });

  test('koennen-crystallizer-v790 contract: parse-failure reason without quarantine', async () => {
    const tmp = tmpDir();
    try {
      const bus = makeBus();
      const c = new SkillCrystallizer({
        bus, candidateLog: makeCandidateLog(makeCandidates(5)),
        model: makeModel('garbage no fenced blocks'),
        codeSafety: { scanCode: () => ({ safe: true }) },
        sandbox: { execute: async () => ({ probe: 'ok' }) },
        settings: makeSettings(), genesisDir: tmp,
      });
      const r = await c.run();
      const fails = (r.results || []).filter(x => !x.success);
      assert(fails.length >= 1);
      assertEqual(fails[0].reason, 'parse-failure');
      assertEqual(bus._of('skill-crystallized').length, 0);
      assertEqual(bus._of('skill:quarantined').length, 0);
    } finally { cleanup(tmp); }
  });

  test('koennen-crystallizer-v790 contract: cooldown prevents re-extraction', async () => {
    const tmp = tmpDir();
    try {
      const cs = makeCandidates(5);
      const c1 = new SkillCrystallizer({
        bus: makeBus(), candidateLog: makeCandidateLog(cs),
        model: makeModel('garbage'),
        codeSafety: { scanCode: () => ({ safe: true }) },
        sandbox: { execute: async () => ({ probe: 'ok' }) },
        settings: makeSettings(), genesisDir: tmp,
      });
      await c1.run();
      const c2 = new SkillCrystallizer({
        bus: makeBus(), candidateLog: makeCandidateLog(cs),
        model: makeModel(GOOD_LLM),
        codeSafety: { scanCode: () => ({ safe: true }) },
        sandbox: { execute: async () => ({ probe: 'ok' }) },
        settings: makeSettings(), genesisDir: tmp,
      });
      const r = await c2.run();
      assertEqual((r.results || []).length, 0, 'cooldown must skip second run');
    } finally { cleanup(tmp); }
  });

  test('koennen-crystallizer-v790 contract: already-pending pattern is skipped', async () => {
    const tmp = tmpDir();
    try {
      const cs = makeCandidates(5);
      const c1 = new SkillCrystallizer({
        bus: makeBus(), candidateLog: makeCandidateLog(cs),
        model: makeModel(GOOD_LLM),
        codeSafety: { scanCode: () => ({ safe: true }) },
        sandbox: { execute: async () => ({ probe: 'ok' }) },
        settings: makeSettings(), genesisDir: tmp,
      });
      await c1.run();
      // Wipe cooldown so the only gate is "already-pending"
      try { fs.unlinkSync(path.join(tmp, 'koennen', 'crystallization-cooldown.json')); } catch (_e) {}
      const c2 = new SkillCrystallizer({
        bus: makeBus(), candidateLog: makeCandidateLog(cs),
        model: makeModel(GOOD_LLM),
        codeSafety: { scanCode: () => ({ safe: true }) },
        sandbox: { execute: async () => ({ probe: 'ok' }) },
        settings: makeSettings(), genesisDir: tmp,
      });
      const r = await c2.run();
      assertEqual((r.results || []).length, 0);
    } finally { cleanup(tmp); }
  });

  test('koennen-crystallizer-v790 contract: dream:skills-crystallized summary fires after run', async () => {
    const tmp = tmpDir();
    try {
      const bus = makeBus();
      const c = new SkillCrystallizer({
        bus, candidateLog: makeCandidateLog(makeCandidates(5)),
        model: makeModel(GOOD_LLM),
        codeSafety: { scanCode: () => ({ safe: true }) },
        sandbox: { execute: async () => ({ probe: 'ok' }) },
        settings: makeSettings(), genesisDir: tmp,
      });
      await c.run();
      const sum = bus._of('dream:skills-crystallized');
      assertEqual(sum.length, 1);
      assert(sum[0].data.crystallized >= 1);
      assertEqual(sum[0].data.rejected, 0);
    } finally { cleanup(tmp); }
  });

  test('koennen-crystallizer-v790 contract: persisted manifest carries koennen metadata', async () => {
    const tmp = tmpDir();
    try {
      const c = new SkillCrystallizer({
        bus: makeBus(), candidateLog: makeCandidateLog(makeCandidates(5)),
        model: makeModel(GOOD_LLM),
        codeSafety: { scanCode: () => ({ safe: true }) },
        sandbox: { execute: async () => ({ probe: 'ok' }) },
        settings: makeSettings(), genesisDir: tmp,
      });
      const r = await c.run();
      const ok = (r.results || []).filter(x => x.success)[0];
      assert(ok);
      const m = JSON.parse(fs.readFileSync(
        path.join(tmp, 'koennen', 'skills-pending', ok.skillName, 'skill-manifest.json'),
        'utf8',
      ));
      assert(m.koennen);
      assert(Array.isArray(m.koennen.sourceCandidateIds));
      assert(m.koennen.patternSignature);
      assertEqual(typeof m.koennen.crystallizedAt, 'number');
    } finally { cleanup(tmp); }
  });
});

run();
