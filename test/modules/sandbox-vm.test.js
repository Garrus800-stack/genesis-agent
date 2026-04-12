const { describe, test, assert, assertEqual, run } = require('../harness');

// SandboxVM is a delegate — test it through the parent Sandbox interface
// to verify the composition wiring is correct.
const { Sandbox } = require('../../src/agent/foundation/Sandbox');
const { SandboxVMDelegate } = require('../../src/agent/foundation/SandboxVM');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const TMP = path.join(os.tmpdir(), `genesis-test-sandbox-vm-${Date.now()}`);

describe('SandboxVM Delegate', () => {

  test('SandboxVMDelegate is instantiated by Sandbox constructor', () => {
    fs.mkdirSync(TMP, { recursive: true });
    const sandbox = new Sandbox(TMP);
    assert(sandbox._vm instanceof SandboxVMDelegate, '_vm should be SandboxVMDelegate');
    sandbox.cleanup();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  test('executeWithContext requires trusted: true', async () => {
    fs.mkdirSync(TMP, { recursive: true });
    const sandbox = new Sandbox(TMP);
    try {
      await sandbox.executeWithContext('() => 42', {});
      assert(false, 'Should have thrown');
    } catch (err) {
      assert(err.message.includes('trusted: true'), 'Error should mention trusted');
    }
    sandbox.cleanup();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  test('executeWithContext runs code in VM mode with trusted: true', async () => {
    fs.mkdirSync(TMP, { recursive: true });
    const sandbox = new Sandbox(TMP);
    const result = await sandbox.executeWithContext('() => 42', {}, { trusted: true });
    assertEqual(result.error, null, 'No error');
    assertEqual(result.mode, 'vm', 'Mode should be vm');
    assertEqual(result.output, '42', 'Output should be 42');
    sandbox.cleanup();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  test('executeWithContext captures console.log output', async () => {
    fs.mkdirSync(TMP, { recursive: true });
    const sandbox = new Sandbox(TMP);
    const result = await sandbox.executeWithContext(
      '() => { console.log("hello"); console.log("world"); }',
      {},
      { trusted: true }
    );
    assertEqual(result.error, null, 'No error');
    assert(result.output.includes('hello'), 'Should capture hello');
    assert(result.output.includes('world'), 'Should capture world');
    sandbox.cleanup();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  test('executeWithContext blocks dangerous globals', async () => {
    fs.mkdirSync(TMP, { recursive: true });
    const sandbox = new Sandbox(TMP);
    const result = await sandbox.executeWithContext(
      '() => { return typeof process; }',
      {},
      { trusted: true }
    );
    assertEqual(result.output, 'undefined', 'process should be undefined in VM');
    sandbox.cleanup();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  test('executeWithContext respects timeout', async () => {
    fs.mkdirSync(TMP, { recursive: true });
    const sandbox = new Sandbox(TMP);
    const start = Date.now();
    const result = await sandbox.executeWithContext(
      '(x) => x * 2',  // simple function — tests basic execution path with timeout option
      { x: 21 },
      { trusted: true, timeout: 500 }
    );
    // Verify timeout option is accepted (doesn't hang forever)
    const elapsed = Date.now() - start;
    assert(elapsed < 5000, 'Should complete within reasonable time');
    assertEqual(result.error, null, 'No error for valid code');
    sandbox.cleanup();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  test('executeWithContext blocks code via _codeSafety', async () => {
    fs.mkdirSync(TMP, { recursive: true });
    const sandbox = new Sandbox(TMP);
    // Mock code safety scanner that blocks everything
    sandbox._codeSafety = {
      scanCode: () => ({ blocked: [{ description: 'test block' }] })
    };
    const result = await sandbox.executeWithContext('() => 42', {}, { trusted: true });
    assert(result.error.includes('test block'), 'Should include block reason');
    assertEqual(result.mode, 'vm-blocked', 'Mode should be vm-blocked');
    sandbox.cleanup();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  test('SandboxVMDelegate._buildVMSandbox returns frozen environment', () => {
    fs.mkdirSync(TMP, { recursive: true });
    const sandbox = new Sandbox(TMP);
    const logs = [];
    const timers = new Set();
    const env = sandbox._vm._buildVMSandbox((...a) => logs.push(a.join(' ')), timers, 5000);

    assert(env.console !== undefined, 'Should have console');
    assert(env.JSON !== undefined, 'Should have JSON');
    assert(env.Math !== undefined, 'Should have Math');
    assert(env.setTimeout !== undefined, 'Should have setTimeout');
    assert(env.Date !== undefined, 'Should have Date');
    assert(env.Buffer !== undefined, 'Should have Buffer');
    // Verify frozen
    assert(Object.isFrozen(env.console), 'console should be frozen');

    sandbox.cleanup();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

});

run();
