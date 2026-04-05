// ============================================================
// TEST — CrashLog.js (v6.0.1)
// ============================================================

const { describe, test, run } = require('../harness');
const { CrashLog } = require('../../src/agent/core/CrashLog');
const fs = require('fs');
const path = require('path');
const os = require('os');

function tmpDir() {
  const dir = path.join(os.tmpdir(), `genesis-crashlog-test-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true }); } catch (_e) { /* best effort */ }
}

describe('CrashLog', () => {
  test('captures error entries', () => {
    const dir = tmpDir();
    const cl = new CrashLog(dir);
    cl.capture({ level: 'error', module: 'TestMod', args: ['something broke'], format: 'human' });
    const entries = cl.getRecent(10);
    if (entries.length !== 1) throw new Error(`Expected 1, got ${entries.length}`);
    if (entries[0].level !== 'error') throw new Error('Level mismatch');
    if (entries[0].module !== 'TestMod') throw new Error('Module mismatch');
    if (!entries[0].msg.includes('something broke')) throw new Error('Message mismatch');
    cleanup(dir);
  });

  test('captures warn entries', () => {
    const dir = tmpDir();
    const cl = new CrashLog(dir);
    cl.capture({ level: 'warn', module: 'W', args: ['warning msg'], format: 'human' });
    if (cl.getRecent(10).length !== 1) throw new Error('Should capture warns');
    cleanup(dir);
  });

  test('ignores info and debug entries', () => {
    const dir = tmpDir();
    const cl = new CrashLog(dir);
    cl.capture({ level: 'info', module: 'I', args: ['info'], format: 'human' });
    cl.capture({ level: 'debug', module: 'D', args: ['debug'], format: 'human' });
    if (cl.getRecent(10).length !== 0) throw new Error('Should ignore info/debug');
    cleanup(dir);
  });

  test('extracts stack traces from Error objects', () => {
    const dir = tmpDir();
    const cl = new CrashLog(dir);
    const err = new Error('test error');
    cl.capture({ level: 'error', module: 'E', args: ['fail:', err], format: 'human' });
    const entries = cl.getRecent(10);
    if (!entries[0].stack) throw new Error('Should extract stack trace');
    if (!entries[0].stack.includes('test error')) throw new Error('Stack should contain message');
    cleanup(dir);
  });

  test('enforces ring buffer max size', () => {
    const dir = tmpDir();
    const cl = new CrashLog(dir);
    // CrashLog MAX_ENTRIES = 1000, add 1010
    for (let i = 0; i < 1010; i++) {
      cl.capture({ level: 'error', module: 'M', args: [`entry-${i}`], format: 'human' });
    }
    const entries = cl.getRecent(2000);
    if (entries.length !== 1000) throw new Error(`Expected 1000, got ${entries.length}`);
    // Oldest should be entry-10, not entry-0
    if (!entries[0].msg.includes('entry-10')) throw new Error(`Oldest should be entry-10, got ${entries[0].msg}`);
    cleanup(dir);
  });

  test('getRecent returns last N entries', () => {
    const dir = tmpDir();
    const cl = new CrashLog(dir);
    for (let i = 0; i < 50; i++) {
      cl.capture({ level: 'error', module: 'M', args: [`msg-${i}`], format: 'human' });
    }
    const last5 = cl.getRecent(5);
    if (last5.length !== 5) throw new Error(`Expected 5, got ${last5.length}`);
    if (!last5[4].msg.includes('msg-49')) throw new Error('Should return last entries');
    cleanup(dir);
  });

  test('getRecent filters by level', () => {
    const dir = tmpDir();
    const cl = new CrashLog(dir);
    cl.capture({ level: 'error', module: 'E', args: ['err1'], format: 'human' });
    cl.capture({ level: 'warn', module: 'W', args: ['warn1'], format: 'human' });
    cl.capture({ level: 'error', module: 'E', args: ['err2'], format: 'human' });
    const errors = cl.getRecent(10, 'error');
    if (errors.length !== 2) throw new Error(`Expected 2 errors, got ${errors.length}`);
    cleanup(dir);
  });

  test('getStats returns correct counts', () => {
    const dir = tmpDir();
    const cl = new CrashLog(dir);
    cl.capture({ level: 'error', module: 'E', args: ['e1'], format: 'human' });
    cl.capture({ level: 'error', module: 'E', args: ['e2'], format: 'human' });
    cl.capture({ level: 'warn', module: 'W', args: ['w1'], format: 'human' });
    const stats = cl.getStats();
    if (stats.totalEntries !== 3) throw new Error(`Expected 3 total, got ${stats.totalEntries}`);
    if (stats.errors !== 2) throw new Error(`Expected 2 errors, got ${stats.errors}`);
    if (stats.warns !== 1) throw new Error(`Expected 1 warn, got ${stats.warns}`);
    cleanup(dir);
  });

  test('flush writes to disk', () => {
    const dir = tmpDir();
    const cl = new CrashLog(dir);
    cl.start();
    cl.capture({ level: 'error', module: 'E', args: ['disk-test'], format: 'human' });
    // Error triggers immediate flush
    const logPath = path.join(dir, 'crash.log');
    if (!fs.existsSync(logPath)) throw new Error('crash.log should exist after error');
    const content = fs.readFileSync(logPath, 'utf8');
    if (!content.includes('disk-test')) throw new Error('crash.log should contain entry');
    cl.stop();
    cleanup(dir);
  });

  test('clear removes all entries', () => {
    const dir = tmpDir();
    const cl = new CrashLog(dir);
    cl.start();
    cl.capture({ level: 'error', module: 'E', args: ['x'], format: 'human' });
    cl.clear();
    if (cl.getRecent(10).length !== 0) throw new Error('Should be empty after clear');
    cl.stop();
    cleanup(dir);
  });

  test('loads existing entries on start', () => {
    const dir = tmpDir();
    const logPath = path.join(dir, 'crash.log');
    fs.writeFileSync(logPath, '[2026-04-04T10:00:00.000Z] [ERROR] [TestMod] previous error\n');

    const cl = new CrashLog(dir);
    cl.start();
    const entries = cl.getRecent(10);
    if (entries.length !== 1) throw new Error(`Expected 1 loaded, got ${entries.length}`);
    if (entries[0].module !== 'TestMod') throw new Error('Should load module name');
    cl.stop();
    cleanup(dir);
  });

  test('formats object arguments as JSON', () => {
    const dir = tmpDir();
    const cl = new CrashLog(dir);
    cl.capture({ level: 'warn', module: 'W', args: ['ctx:', { foo: 'bar' }], format: 'human' });
    const entries = cl.getRecent(10);
    if (!entries[0].msg.includes('"foo"')) throw new Error('Should JSON-stringify objects');
    cleanup(dir);
  });
});

if (require.main === module) run();
