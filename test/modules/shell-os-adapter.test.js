#!/usr/bin/env node
// Test: ShellOSAdapter — pure OS adaptation functions (v7.5.4)

const { describe, test, assert, assertEqual, run } = require('../harness');
const OSAdapter = require('../../src/agent/capabilities/shell/ShellOSAdapter');

describe('ShellOSAdapter — resolveShell', () => {

  test('returns shell, shellFlag, isWindows, platform', () => {
    const r = OSAdapter.resolveShell();
    assert(typeof r.shell === 'string');
    assert(typeof r.shellFlag === 'string');
    assert(typeof r.isWindows === 'boolean');
    assert(typeof r.platform === 'string');
  });

  test('isWindows matches process.platform === win32', () => {
    const r = OSAdapter.resolveShell();
    assertEqual(r.isWindows, process.platform === 'win32');
  });

  test('platform reflects process.platform', () => {
    const r = OSAdapter.resolveShell();
    assertEqual(r.platform, process.platform);
  });
});

describe('ShellOSAdapter — adaptCommand on non-Windows', () => {

  test('returns cmd unchanged on linux', () => {
    assertEqual(OSAdapter.adaptCommand('ls -la', 'linux'), 'ls -la');
  });

  test('returns cmd unchanged on darwin', () => {
    assertEqual(OSAdapter.adaptCommand('cat file.txt', 'darwin'), 'cat file.txt');
  });

  test('returns cmd unchanged on freebsd', () => {
    assertEqual(OSAdapter.adaptCommand('grep foo bar', 'freebsd'), 'grep foo bar');
  });
});

describe('ShellOSAdapter — adaptCommand POSIX→Windows', () => {

  test('ls → dir', () => {
    assertEqual(OSAdapter.adaptCommand('ls', 'win32'), 'dir');
    assertEqual(OSAdapter.adaptCommand('ls -la', 'win32'), 'dir -la');
  });

  test('cat → type', () => {
    assertEqual(OSAdapter.adaptCommand('cat file.txt', 'win32'), 'type file.txt');
  });

  test('rm -rf → rmdir /s /q', () => {
    assertEqual(OSAdapter.adaptCommand('rm -rf temp', 'win32'), 'rmdir /s /q temp');
  });

  test('cp -r → xcopy /e /i', () => {
    assertEqual(OSAdapter.adaptCommand('cp -r src dst', 'win32'), 'xcopy /e /i src dst');
  });

  test('mv → move', () => {
    assertEqual(OSAdapter.adaptCommand('mv a b', 'win32'), 'move a b');
  });

  test('which → where', () => {
    assertEqual(OSAdapter.adaptCommand('which node', 'win32'), 'where node');
  });

  test('pwd → cd', () => {
    assertEqual(OSAdapter.adaptCommand('pwd', 'win32'), 'cd');
  });

  test('| wc -l → | find /V /C ":"', () => {
    assertEqual(OSAdapter.adaptCommand('dir /b | wc -l', 'win32'), 'dir /b | find /V /C ":"');
  });

  test('rewrites find /count hallucination', () => {
    const r = OSAdapter.adaptCommand('find /count *.js', 'win32');
    assert(r.includes('find /V /C ":"'), `expected canonical find form, got ${r}`);
  });

  test('rewrites findstr /c:"*" hallucination', () => {
    const r = OSAdapter.adaptCommand('findstr /c:"*" file.txt', 'win32');
    assert(r.includes('find /V /C ":"'), `expected canonical find form, got ${r}`);
  });

  test('grep → findstr (basic)', () => {
    const r = OSAdapter.adaptCommand('grep foo file', 'win32');
    assert(r.startsWith('findstr'), `expected findstr, got ${r}`);
  });

  test('/dev/null → NUL', () => {
    const r = OSAdapter.adaptCommand('echo hi > /dev/null', 'win32');
    assert(r.includes('NUL'), `expected NUL, got ${r}`);
  });
});

describe('ShellOSAdapter — parseTokens', () => {

  test('simple command', () => {
    assert.deepEqual ? assert.deepEqual(OSAdapter.parseTokens('npm install'), ['npm', 'install']) : null;
    const tokens = OSAdapter.parseTokens('npm install');
    assertEqual(tokens.length, 2);
    assertEqual(tokens[0], 'npm');
    assertEqual(tokens[1], 'install');
  });

  test('multiple args', () => {
    const tokens = OSAdapter.parseTokens('git commit -m message');
    assertEqual(tokens.length, 4);
    assertEqual(tokens[3], 'message');
  });

  test('quoted arg', () => {
    const tokens = OSAdapter.parseTokens('echo "hello world"');
    assertEqual(tokens.length, 2);
    assertEqual(tokens[1], 'hello world');
  });

  test('single-quoted arg', () => {
    const tokens = OSAdapter.parseTokens("echo 'foo bar'");
    assertEqual(tokens.length, 2);
    assertEqual(tokens[1], 'foo bar');
  });
});

describe('ShellOSAdapter — parseCommand (compose adapt + parse)', () => {

  test('parseCommand on linux: no adaptation, just tokenize', () => {
    const tokens = OSAdapter.parseCommand('ls -la', 'linux');
    assertEqual(tokens[0], 'ls');
    assertEqual(tokens[1], '-la');
  });

  test('parseCommand on win32: adapts then tokenizes', () => {
    const tokens = OSAdapter.parseCommand('ls -la', 'win32');
    assertEqual(tokens[0], 'dir');  // ls → dir (adapted), then tokenized
  });
});

run();
