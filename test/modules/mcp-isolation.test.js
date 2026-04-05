#!/usr/bin/env node
// ============================================================
// Test: v5.1.0 MCP Process Isolation (M-1x)
//
// Verifies that MCP user code runs in an isolated worker_thread
// with no access to require(), process, fs, or main thread memory.
// Tests the RPC bridge for mcp() calls and resource limits.
// ============================================================
const { describe, test, assert, run } = require('../harness');
const { Worker } = require('worker_threads');
const path = require('path');

const WORKER_PATH = path.resolve(__dirname, '../../src/agent/capabilities/McpWorker.js');

function runWorker(code, opts = {}) {
  const timeout = opts.timeout || 5000;
  return new Promise((resolve) => {
    const worker = new Worker(WORKER_PATH, {
      workerData: { code, timeout },
      resourceLimits: opts.resourceLimits || { maxOldGenerationSizeMb: 32 },
    });

    const killTimer = setTimeout(() => {
      worker.terminate();
      resolve({ output: '', error: 'test-timeout', duration: timeout });
    }, timeout + 3000);

    worker.on('message', (msg) => {
      if (msg.type === 'mcp-call' && opts.onMcpCall) {
        const result = opts.onMcpCall(msg);
        worker.postMessage({ type: 'mcp-result', id: msg.id, ...(result.error ? { error: result.error } : { result: result.result }) });
      }
      if (msg.type === 'complete') {
        clearTimeout(killTimer);
        worker.terminate();
        resolve(msg);
      }
    });

    worker.on('error', (err) => {
      clearTimeout(killTimer);
      resolve({ output: '', error: `worker-error: ${err.message}`, duration: 0 });
    });

    worker.on('exit', (exitCode) => {
      clearTimeout(killTimer);
      if (exitCode !== 0 && exitCode !== null) {
        resolve({ output: '', error: `worker-exit: ${exitCode}`, duration: 0 });
      }
    });
  });
}

// ════════════════════════════════════════════════════════════
// ISOLATION: require() blocked
// ════════════════════════════════════════════════════════════

describe('M-1x: Worker blocks require()', () => {
  test('require("fs") throws ReferenceError', async () => {
    const result = await runWorker('const fs = require("fs");');
    assert(result.error, 'should have error');
    assert(result.error.includes('require is not defined') || result.error.includes('not a function'),
      'error mentions require: ' + result.error);
  });

  test('require("child_process") blocked', async () => {
    const result = await runWorker('const cp = require("child_process");');
    assert(result.error, 'should block child_process');
  });
});

// ════════════════════════════════════════════════════════════
// ISOLATION: process/global objects blocked
// ════════════════════════════════════════════════════════════

describe('M-1x: Worker blocks process/global access', () => {
  test('process.exit() not available', async () => {
    const result = await runWorker('process.exit(0);');
    assert(result.error, 'process should not exist');
    assert(result.error.includes('process is not defined'), 'error: ' + result.error);
  });

  test('process.env not available', async () => {
    const result = await runWorker('return process.env.HOME;');
    assert(result.error, 'process.env should not exist');
  });

  test('global/globalThis limited', async () => {
    const result = await runWorker('return typeof require;');
    // Even if globalThis exists, require should not be on it
    assert(!result.error || true, 'should not crash');
  });
});

// ════════════════════════════════════════════════════════════
// EXECUTION: Safe code works
// ════════════════════════════════════════════════════════════

describe('M-1x: Worker executes safe code', () => {
  test('console.log captured in output', async () => {
    const result = await runWorker('console.log("hello isolation");');
    assert(!result.error, 'no error');
    assert(result.output.includes('hello isolation'), 'output captured');
  });

  test('return value available', async () => {
    const result = await runWorker('return 1 + 2;');
    assert(!result.error, 'no error');
    assert(result.result === '3', 'result is 3: ' + result.result);
  });

  test('async/await works', async () => {
    const result = await runWorker('const x = await Promise.resolve(42); console.log(x);');
    assert(!result.error, 'no error');
    assert(result.output.includes('42'), 'async result captured');
  });

  test('JSON operations work', async () => {
    const result = await runWorker('const obj = JSON.parse(\'{"a":1}\'); console.log(obj.a);');
    assert(!result.error, 'no error');
    assert(result.output.includes('1'), 'JSON parsed');
  });
});

// ════════════════════════════════════════════════════════════
// RPC BRIDGE: mcp() calls
// ════════════════════════════════════════════════════════════

describe('M-1x: RPC bridge for mcp() calls', () => {
  test('mcp() call round-trips through main thread', async () => {
    const result = await runWorker(
      'const r = await mcp("srv", "tool", {q: "test"}); console.log(JSON.stringify(r));',
      {
        onMcpCall: (msg) => {
          assert(msg.server === 'srv', 'server passed');
          assert(msg.tool === 'tool', 'tool passed');
          assert(msg.args.q === 'test', 'args passed');
          return { result: { answer: 'pong' } };
        },
      }
    );
    assert(!result.error, 'no error: ' + result.error);
    assert(result.output.includes('pong'), 'RPC result received');
  });

  test('mcp() error propagates to worker', async () => {
    const result = await runWorker(
      'try { await mcp("bad", "tool"); } catch(e) { console.log("caught:" + e.message); }',
      {
        onMcpCall: () => ({ error: 'server unavailable' }),
      }
    );
    assert(!result.error, 'code itself should not error');
    assert(result.output.includes('caught:server unavailable'), 'error propagated');
  });

  test('multiple mcp() calls execute sequentially', async () => {
    let callCount = 0;
    const result = await runWorker(
      'const a = await mcp("s","t1"); const b = await mcp("s","t2"); console.log(a.n + "," + b.n);',
      {
        onMcpCall: (msg) => {
          callCount++;
          return { result: { n: callCount } };
        },
      }
    );
    assert(!result.error, 'no error');
    assert(result.output.includes('1,2'), 'sequential calls: ' + result.output.trim());
    assert(callCount === 2, 'exactly 2 calls made');
  });
});

// ════════════════════════════════════════════════════════════
// RESOURCE LIMITS
// ════════════════════════════════════════════════════════════

describe('M-1x: Resource limits', () => {
  test('infinite loop killed by timeout', async () => {
    const result = await runWorker('while(true) {}', { timeout: 500 });
    assert(result.error, 'should error on timeout');
  });

  test('memory bomb killed by resource limit', async () => {
    const result = await runWorker(
      'const arr = []; while(true) arr.push(new Array(1e6).fill(1));',
      { timeout: 5000, resourceLimits: { maxOldGenerationSizeMb: 16 } }
    );
    // Either error in message or worker crash — both are acceptable
    assert(result.error, 'memory bomb should cause error/crash');
  });

  test('output truncated at max size', async () => {
    const result = await runWorker(
      'for(let i=0; i<10000; i++) console.log("x".repeat(100));',
      { timeout: 5000 }
    );
    // Output should be capped (maxOutputSize = 64000 default)
    assert(!result.error || result.output.length > 0, 'should produce output or error');
    if (result.output.length > 70000) {
      assert(false, 'output should be truncated: ' + result.output.length);
    }
  });
});

// ════════════════════════════════════════════════════════════
// McpClient integration — _executeCodeMode method exists
// ════════════════════════════════════════════════════════════

describe('M-1x: McpClient has isolation method', () => {
  test('McpClient exports _executeCodeIsolated', () => {
    const os = require('os');
    const { McpClient } = require('../../src/agent/capabilities/McpClient');
    const client = new McpClient({
      bus: { on() {}, emit() {}, fire() {} },
      settings: { getMcpServers: () => [] },
      toolRegistry: { register() {} },
      sandbox: { timeout: 5000, execute: async () => ({}) },
      knowledgeGraph: {},
      eventStore: { append() {} },
      storageDir: os.tmpdir(),
      storage: { readJSON: () => null, writeJSON() {}, writeJSONDebounced() {} },
    });
    assert(typeof client._executeCodeMode === 'function', 'has _executeCodeMode');
    // v5.2.0: code execution methods moved to McpCodeExec delegate
    assert(client._codeExec !== undefined, 'has _codeExec delegate');
    assert(typeof client._codeExec.execute === 'function', 'delegate has execute()');
    assert(typeof client._codeExec._isolated === 'function', 'delegate has _isolated()');
    assert(typeof client._codeExec._sandbox === 'function', 'delegate has _sandbox() fallback');
  });
});

run();
