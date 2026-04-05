// ============================================================
// TEST: ShellAgent — Async Migration + Permission Default (F-01, F-10)
// ============================================================

const path = require('path');
const fs = require('fs');
const { describe, test, assert, assertEqual, run, createTestRoot } = require('../harness');

describe('ShellAgent — v4.0.0 Fixes', () => {
  const rootDir = createTestRoot('shellagent');
  fs.mkdirSync(rootDir, { recursive: true });

  const mockBus = { emit: () => [], fire: () => {}, on: () => () => {} };
  const mockModel = { chat: async () => '' };
  const { ShellAgent } = require('../../src/agent/capabilities/ShellAgent');
  const shell = new ShellAgent({
    lang: { t: (k) => k, detect: () => {}, current: 'en' },
    bus: mockBus, model: mockModel, memory: null,
    knowledgeGraph: null, eventStore: null, sandbox: null,
    guard: null, rootDir,
  });

  test('default permissionLevel is "read" (F-10)', () => {
    assertEqual(shell.permissionLevel, 'read');
  });

  test('run() returns a Promise (async migration F-01)', async () => {
    const result = shell.run('echo hello', { cwd: rootDir, timeout: 5000 });
    assert(result instanceof Promise, 'run() should return a Promise');
    const res = await result;
    assert(typeof res === 'object', 'result should be an object');
    assert('ok' in res, 'result should have ok property');
  });

  test('run() executes simple commands', async () => {
    if (process.platform === 'win32') return; // skip on windows in CI
    const res = await shell.run('echo hello', { cwd: rootDir, timeout: 5000, tier: 'write' });
    assert(res.ok, `Expected ok=true, got error: ${res.stderr}`);
    assert(res.stdout.includes('hello'), `Expected stdout to include "hello", got: ${res.stdout}`);
  });

  test('run() blocks destructive commands at read tier', async () => {
    const res = await shell.run('rm -rf /tmp/test', { cwd: rootDir, tier: 'read' });
    assert(!res.ok, 'Expected blocked result');
    assert(res.blocked, 'Expected blocked=true');
  });

  test('run() handles shell metacharacters via shell mode', async () => {
    if (process.platform === 'win32') return;
    shell.permissionLevel = 'write';
    const res = await shell.run('echo a && echo b', { cwd: rootDir, timeout: 5000 });
    assert(res.ok, `Expected ok=true, got: ${res.stderr}`);
    shell.permissionLevel = 'read'; // restore
  });

  test('_parseCommand splits simple commands correctly', () => {
    const parts = shell._parseCommand('git status --porcelain');
    assertEqual(parts[0], 'git');
    assertEqual(parts[1], 'status');
    assertEqual(parts[2], '--porcelain');
  });

  test('_parseCommand handles quoted arguments', () => {
    const parts = shell._parseCommand('grep -r "hello world" .');
    assertEqual(parts[0], 'grep');
    assertEqual(parts[1], '-r');
    assertEqual(parts[2], 'hello world');
    assertEqual(parts[3], '.');
  });

  test('scanProject returns async result', async () => {
    const result = shell.scanProject(rootDir);
    assert(result instanceof Promise, 'scanProject should return a Promise');
    const scan = await result;
    assert(typeof scan === 'object');
    assert('type' in scan);
  });
});

run();
