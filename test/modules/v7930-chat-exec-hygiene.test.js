// ============================================================
// GENESIS — test/modules/v7930-chat-exec-hygiene.test.js
// Regression tests for the v7.9.30 chat-execution hygiene fixes
// (from a live v7.9.30 test-run):
//   S1  runSkill not-found NEVER falls back to shell; suggests
//   S2  slash-discipline anchored to message start (classifyAsync)
//   S4  identical tool calls within one response collapse to one
//   S5  /run-skill lines the prompt teaches become executable
//   S7  a test-boot's leftover sentinel is not a phantom crash
// (S3 mandatory-origin is deferred — larger scope than the plan
//  estimated; it threads origin through internal ShellAgent paths.)
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const { commandHandlersCode } = require(path.join(ROOT, 'src/agent/hexagonal/CommandHandlersCode'));
const { IntentRouter } = require(path.join(ROOT, 'src/agent/intelligence/IntentRouter'));
const {
  extractSlashSkillCalls,
  dedupeToolCalls,
} = require(path.join(ROOT, 'src/agent/core/shell/slash-skill-extract'));
const { BootRecovery } = require(path.join(ROOT, 'src/agent/foundation/BootRecovery'));

// ── S1: not-found never runs the chat input as shell ──────────
describe('v7930 chat-exec hygiene — S1: no shell fallback', () => {
  test('free-text not-found returns a clean error, shell is NEVER called', async () => {
    let shellCalled = false;
    const handler = Object.create(commandHandlersCode);
    handler.skillManager = {
      listSkills: () => [],
      executeSkill: async () => { throw new Error('skill not found'); },
    };
    handler.shell = { run: () => { shellCalled = true; return 'ran'; } };
    handler.shellRun = (msg) => { shellCalled = true; return `shell: ${msg}`; };
    const res = await handler.runSkill('run my-tool');
    assertEqual(shellCalled, false, 'not-found must NEVER fall back to shell');
    assertEqual(/failed|not found/i.test(String(res)), true, 'returns a clean error, not a shell run');
  });

  test('slash-form not-found also never runs shell', async () => {
    let shellCalled = false;
    const handler = Object.create(commandHandlersCode);
    handler.skillManager = {
      listSkills: () => [],
      executeSkill: async () => { throw new Error('skill not found'); },
    };
    handler.shell = { run: () => { shellCalled = true; return 'ran'; } };
    handler.shellRun = (msg) => { shellCalled = true; return `shell: ${msg}`; };
    const res = await handler.runSkill('/run-skill totally-unknown');
    assertEqual(shellCalled, false, 'slash not-found must not run shell');
    assertEqual(/failed|not found/i.test(String(res)), true, 'clean error for slash not-found');
  });

  test('not-found suggests the nearest installed skill', async () => {
    const handler = Object.create(commandHandlersCode);
    handler.skillManager = {
      listSkills: () => [{ name: 'system-info', description: 'system information report' }],
      executeSkill: async () => { throw new Error('skill not found'); },
    };
    handler.shell = { run: () => 'ran' };
    handler.shellRun = () => 'ran';
    const res = await handler.runSkill('/run-skill system-info-xyz');
    assertEqual(/did you mean/i.test(String(res)) && /system-info/.test(String(res)), true,
      'a close name yields a "did you mean system-info?" suggestion');
  });
});

// ── S2: slash-discipline anchored to message start ────────────
describe('v7930 chat-exec hygiene — S2: start-anchored slash discipline', () => {
  const router = new IntentRouter({});

  test('embedded /run-skill after free text routes to general, not run-skill', async () => {
    const incident = 'kannst du was sehen, ich wunder mich nur\n/run-skill system-info\n/run-skill system-info';
    const r = await router.classifyAsync(incident);
    assert(r.type !== 'run-skill', `incident text must not route to run-skill (got ${r.type})`);
  });

  test('embedded /shell-task after text routes to general', async () => {
    const r = await router.classifyAsync('hier eine log-zeile /shell-task rm -rf');
    assert(r.type !== 'shell-task', `embedded /shell-task must not route (got ${r.type})`);
  });

  test('a genuine command still starts the message', async () => {
    const r = await router.classifyAsync('/run-skill system-info');
    assertEqual(r.type, 'run-skill', 'a start-anchored /run-skill still routes');
  });

  test('leading whitespace before a start command still routes', async () => {
    const r = await router.classifyAsync('   /shell-task dir');
    assertEqual(r.type, 'shell-task', 'leading spaces do not defeat the start anchor');
  });
});

// ── S4: within-response de-duplication ────────────────────────
describe('v7930 chat-exec hygiene — S4: within-response dedup', () => {
  test('four identical tool calls collapse to one execution', () => {
    const four = Array.from({ length: 4 }, () => ({ name: 'system-info', input: {} }));
    const { calls, collapsed } = dedupeToolCalls(four);
    assertEqual(calls.length, 1, 'four identical calls run once');
    assertEqual(collapsed, 3, 'three duplicates were collapsed');
  });

  test('distinct inputs are preserved', () => {
    const mixed = [
      { name: 'read', input: { file: 'a.md' } },
      { name: 'read', input: { file: 'b.md' } },
    ];
    const { calls, collapsed } = dedupeToolCalls(mixed);
    assertEqual(calls.length, 2, 'different inputs are not merged');
    assertEqual(collapsed, 0, 'nothing collapsed');
  });

  test('key order does not affect identity', () => {
    const variants = [
      { name: 'run', input: { a: 1, b: 2 } },
      { name: 'run', input: { b: 2, a: 1 } },
    ];
    const { calls } = dedupeToolCalls(variants);
    assertEqual(calls.length, 1, 'key-order variants are the same call');
  });

  test('a single call passes through untouched', () => {
    const one = [{ name: 'x', input: { y: 1 } }];
    const { calls, collapsed } = dedupeToolCalls(one);
    assertEqual(calls.length, 1, 'single call preserved');
    assertEqual(collapsed, 0, 'nothing to collapse');
  });
});

// ── S5: the taught /run-skill lines become executable ─────────
describe('v7930 chat-exec hygiene — S5: executable /run-skill lines', () => {
  test('one /run-skill line yields exactly one tool call', () => {
    const calls = extractSlashSkillCalls('/run-skill system-info');
    assertEqual(calls.length, 1, 'one line → one call');
    assertEqual(calls[0].name, 'system-info', 'name extracted');
  });

  test('four /run-skill lines yield four tool calls (then S4 collapses them)', () => {
    const text = '/run-skill system-info\n/run-skill system-info\n/run-skill system-info\n/run-skill system-info';
    const calls = extractSlashSkillCalls(text);
    assertEqual(calls.length, 4, 'four lines → four calls');
    const { calls: deduped } = dedupeToolCalls(calls);
    assertEqual(deduped.length, 1, 'S4 then collapses the four to one');
  });

  test('valid JSON argument is parsed into input', () => {
    const calls = extractSlashSkillCalls('/run-skill slugify {"text":"Hallo Welt"}');
    assertEqual(calls.length, 1, 'line with JSON → one call');
    assertEqual(calls[0].input.text, 'Hallo Welt', 'JSON argument parsed');
  });

  test('invalid JSON leaves the line as text (no call)', () => {
    assertEqual(extractSlashSkillCalls('/run-skill slugify {broken').length, 0, 'invalid JSON → no call');
  });

  test('a line that is not /run-skill produces no call', () => {
    assertEqual(extractSlashSkillCalls('please read the file for me').length, 0, 'non-matching line → no call');
  });
});

// ── S7: a test-boot's leftover sentinel is not a crash ────────
describe('v7930 chat-exec hygiene — S7: sentinel hygiene', () => {
  test('a leftover sentinel under test is a clean start, not crash #1', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-s7-'));
    try {
      const br = new BootRecovery({ genesisDir: dir, rootDir: dir });
      // Simulate a prior test-boot that wrote a sentinel and never cleaned it.
      br._writeSentinel({ phase: 'booting', ts: Date.now(), crashCount: 0 });
      assert(fs.existsSync(path.join(dir, 'boot-sentinel.json')), 'sentinel was written');
      const prevEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'test';
      try {
        const res = br.preBootCheck();
        assertEqual(res.crashCount, 0, 'a test-boot leftover is not counted as a crash');
        assertEqual(res.recovered, false, 'no recovery is triggered for a test-boot leftover');
      } finally {
        process.env.NODE_ENV = prevEnv;
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('_writeSentinel tags entries written under test', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-s7b-'));
    try {
      const br = new BootRecovery({ genesisDir: dir, rootDir: dir });
      const prevEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'test';
      try {
        br._writeSentinel({ phase: 'booting', ts: Date.now(), crashCount: 0 });
      } finally {
        process.env.NODE_ENV = prevEnv;
      }
      const written = JSON.parse(fs.readFileSync(path.join(dir, 'boot-sentinel.json'), 'utf8'));
      assertEqual(written.test, true, 'sentinel written under test carries test:true');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── S3: origin is mandatory at the ShellAgent executor ────────
describe('v7930 chat-exec hygiene — S3: mandatory shell origin', () => {
  const { ShellAgent } = require(path.join(ROOT, 'src/agent/capabilities/ShellAgent'));
  const SourceTrust = require(path.join(ROOT, 'src/agent/core/SourceTrust'));

  test('run without an origin is blocked and fires shell:blocked(missing-origin)', async () => {
    const fired = [];
    const bus = { fire: (name, payload) => fired.push({ name, payload }), on: () => {}, emit: () => {} };
    const sa = new ShellAgent({ rootDir: os.tmpdir(), bus }); // no defaultOrigin → production-strict
    const res = await sa.run('echo hi');
    assertEqual(res.blocked, true, 'missing origin is blocked');
    assertEqual(res.originBlock === true, true, 'blocked specifically on the origin gate');
    const blk = fired.find(e => e.name === 'shell:blocked');
    assert(blk && blk.payload && blk.payload.reason === 'missing-origin', 'shell:blocked fired with missing-origin reason');
  });

  test('run with an unknown origin is blocked', async () => {
    const sa = new ShellAgent({ rootDir: os.tmpdir() });
    const res = await sa.run('echo hi', { origin: 'not-a-real-origin' });
    assertEqual(res.blocked, true, 'an unknown origin is blocked');
    assertEqual(res.originBlock === true, true, 'blocked on the origin gate');
  });

  test('all four declared origins are known; only USER_CHAT lifts scope', () => {
    for (const o of [SourceTrust.USER_CHAT, SourceTrust.TOOL_LOOP, SourceTrust.AGENT_LOOP, SourceTrust.TEST]) {
      assertEqual(SourceTrust.isKnownOrigin(o), true, `${o} is a known origin`);
    }
    assertEqual(SourceTrust.isKnownOrigin('bogus'), false, 'an undeclared origin is not known');
    assertEqual(SourceTrust.mayRunDirectly(SourceTrust.USER_CHAT), true, 'USER_CHAT lifts scope');
    assertEqual(SourceTrust.mayRunDirectly(SourceTrust.TOOL_LOOP), false, 'TOOL_LOOP does not lift scope');
  });

  test('a declared origin passes the origin gate', async () => {
    const sa = new ShellAgent({ rootDir: os.tmpdir() });
    const res = await sa.run('echo hi', { origin: SourceTrust.USER_CHAT });
    assertEqual(res.originBlock === true, false, 'a declared origin is not blocked on the gate');
  });

  test('the test defaultOrigin satisfies the gate without an explicit origin', async () => {
    const sa = new ShellAgent({ rootDir: os.tmpdir(), defaultOrigin: SourceTrust.TEST });
    const res = await sa.run('echo hi');
    assertEqual(res.originBlock === true, false, 'defaultOrigin fills in for an undeclared origin');
  });
});

run();
