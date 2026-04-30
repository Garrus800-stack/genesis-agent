#!/usr/bin/env node
// Test: ShellPlanner — LLM-based shell-step planner (v7.5.4)

const { describe, test, assert, assertEqual, run } = require('../harness');
const { createBus } = require('../../src/agent/core/EventBus');
const { ShellPlanner } = require('../../src/agent/capabilities/shell/ShellPlanner');

function makeMockModel(response) {
  return {
    chatStructured: async () => response,
  };
}

function makeContext(overrides = {}) {
  return {
    project: { type: 'node', scripts: { test: 'npm test' }, gitStatus: 'clean', keyFiles: ['package.json'] },
    cwd: '/tmp/test-project',
    isWindows: false,
    permissionLevel: 'read',
    ...overrides,
  };
}

describe('ShellPlanner', () => {

  test('constructor accepts deps with defaults', () => {
    const p = new ShellPlanner({ model: null });
    assert(p.lang, 'should have lang stub');
    assert(p.bus, 'should have bus (NullBus)');
    assertEqual(p.selfStatementLog, null, 'selfStatementLog defaults to null');
  });

  test('selfStatementLog hook is no-op when null', async () => {
    const p = new ShellPlanner({
      model: makeMockModel([{ cmd: 'echo hi', critical: false }]),
    });
    // Should not throw even though selfStatementLog is null
    const r = await p.generate('test task', makeContext());
    assert(r.steps);
    assertEqual(r.steps.length, 1);
  });

  test('selfStatementLog.recordPromise is called when present', async () => {
    const calls = [];
    const log = { recordPromise: (entry) => calls.push(entry) };
    const p = new ShellPlanner({
      model: makeMockModel([{ cmd: 'echo hi' }]),
      selfStatementLog: log,
    });
    await p.generate('test task', makeContext());
    assertEqual(calls.length, 1);
    assertEqual(calls[0].kind, 'plan');
    assertEqual(calls[0].task, 'test task');
  });

  test('emits shell:planning event with source ShellPlanner', async () => {
    const bus = createBus();
    const captured = [];
    bus.on('shell:planning', (data, meta) => captured.push({ data, meta }));
    const p = new ShellPlanner({
      model: makeMockModel([{ cmd: 'echo' }]),
      bus,
    });
    await p.generate('do thing', makeContext());
    assertEqual(captured.length, 1);
    assertEqual(captured[0].meta.source, 'ShellPlanner');
  });

  test('returns steps from direct array LLM response', async () => {
    const p = new ShellPlanner({
      model: makeMockModel([{ cmd: 'a' }, { cmd: 'b' }]),
    });
    const r = await p.generate('task', makeContext());
    assertEqual(r.steps.length, 2);
  });

  test('salvages steps from {steps:[...]} wrapper', async () => {
    const p = new ShellPlanner({
      model: makeMockModel({ steps: [{ cmd: 'a' }] }),
    });
    const r = await p.generate('task', makeContext());
    assertEqual(r.steps.length, 1);
  });

  test('salvages steps from {plan:[...]} wrapper', async () => {
    const p = new ShellPlanner({
      model: makeMockModel({ plan: [{ cmd: 'x' }] }),
    });
    const r = await p.generate('task', makeContext());
    assertEqual(r.steps.length, 1);
  });

  test('salvages from _raw text fallback', async () => {
    const raw = '```bash\nnpm install\nnpm test\n```';
    const p = new ShellPlanner({
      model: makeMockModel({ _raw: raw, _parseError: true }),
    });
    const r = await p.generate('task', makeContext());
    assert(r.steps && r.steps.length >= 2, `expected 2+ steps, got ${JSON.stringify(r)}`);
  });

  test('returns error when LLM response has no recognizable schema', async () => {
    const p = new ShellPlanner({
      model: makeMockModel({ random: 'garbage' }),
    });
    const r = await p.generate('task', makeContext());
    assertEqual(r.steps, null);
    assert(r.error, 'should have error message');
  });

  test('returns error when LLM throws', async () => {
    const p = new ShellPlanner({
      model: { chatStructured: async () => { throw new Error('LLM offline'); } },
    });
    const r = await p.generate('task', makeContext());
    assertEqual(r.steps, null);
    assert(r.error, 'should have error message');
  });
});

describe('ShellPlanner._salvageStepsFromText', () => {

  test('extracts from fenced code block', () => {
    const p = new ShellPlanner({ model: null });
    const steps = p._salvageStepsFromText('```\nnpm install\nnpm test\n```');
    assertEqual(steps.length, 2);
    assertEqual(steps[0].cmd, 'npm install');
  });

  test('skips comment lines in fenced block', () => {
    const p = new ShellPlanner({ model: null });
    const steps = p._salvageStepsFromText('```\n# comment\nnpm install\n```');
    assertEqual(steps.length, 1);
    assertEqual(steps[0].cmd, 'npm install');
  });

  test('extracts from backticks when no fence', () => {
    const p = new ShellPlanner({ model: null });
    const steps = p._salvageStepsFromText('Run `dir /b *.js` to list files');
    assertEqual(steps.length, 1);
    assertEqual(steps[0].cmd, 'dir /b *.js');
  });

  test('extracts from $ prompt lines when no fence/backticks', () => {
    const p = new ShellPlanner({ model: null });
    const steps = p._salvageStepsFromText('$ npm install\n$ npm test');
    assertEqual(steps.length, 2);
  });

  test('returns empty for empty input', () => {
    const p = new ShellPlanner({ model: null });
    assertEqual(p._salvageStepsFromText('').length, 0);
    assertEqual(p._salvageStepsFromText('   ').length, 0);
  });

  test('caps at 10 steps', () => {
    const p = new ShellPlanner({ model: null });
    const text = '```\n' + Array.from({ length: 20 }, (_, i) => `cmd${i}`).join('\n') + '\n```';
    const steps = p._salvageStepsFromText(text);
    assertEqual(steps.length, 10);
  });
});

run();
