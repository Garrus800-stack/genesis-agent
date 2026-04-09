// @ts-checked-v5.7
// ============================================================
// GENESIS — McpWorker.js (v5.1.0 — M-1x Process Isolation)
//
// Runs MCP user code in an isolated worker_thread.
// The main thread injects an `mcp()` function via async RPC:
//
//   Worker                          Main Thread
//   ──────                          ───────────
//   mcp('server', 'tool', args)
//     → postMessage({type:'call'})  ──→  executes real MCP call
//     ← receives result             ←──  postMessage({type:'result'})
//     resolves promise
//
// Security boundary:
//   - No require() — only pre-injected globals
//   - No process/fs/child_process access
//   - No access to main thread memory
//   - Worker terminated on timeout (hard kill)
//   - Output capped to prevent memory bomb
//
// Usage: Created by McpClient._executeCodeIsolated()
// ============================================================

'use strict';

const { parentPort, workerData } = require('worker_threads');
const vm = require('vm');

const { code, timeout = 10000, maxOutputSize = 64000 } = workerData;

// ── RPC State ────────────────────────────────────────────
const pendingCalls = new Map();
let callIdCounter = 0;

// ── Receive RPC results from main thread ─────────────────
// @ts-ignore — genuine TS error, fix requires type widening
parentPort.on('message', (msg) => {
  if (msg.type === 'mcp-result') {
    const pending = pendingCalls.get(msg.id);
    if (pending) {
      pendingCalls.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error));
      else pending.resolve(msg.result);
    }
  }
});

// ── mcp() function injected into user code context ───────
// Sends RPC to main thread, returns a Promise that resolves
// when the main thread completes the MCP call.
function mcp(server, tool, args = {}) {
  return new Promise((resolve, reject) => {
    const id = ++callIdCounter;

    // Timeout per individual MCP call (half of total timeout)
    const callTimeout = setTimeout(() => {
      pendingCalls.delete(id);
      reject(new Error(`MCP call timeout: ${server}/${tool} (${Math.round(timeout / 2)}ms)`));
    }, Math.round(timeout / 2));

    pendingCalls.set(id, {
      resolve: (result) => { clearTimeout(callTimeout); resolve(result); },
      reject: (err) => { clearTimeout(callTimeout); reject(err); },
    });

    // @ts-ignore — genuine TS error, fix requires type widening
    parentPort.postMessage({ type: 'mcp-call', id, server, tool, args });
  });
}

// ── Execute user code ────────────────────────────────────
async function execute() {
  const logs = [];
  const logFn = (...args) => {
    if (logs.length > 500) return;
    const line = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    if (line.length > 2000) logs.push(line.slice(0, 2000) + '…');
    else logs.push(line);
  };

  // Minimal sandbox context — no require, no process, no fs
  const context = vm.createContext({
    mcp,
    console: { log: logFn, info: logFn, warn: logFn, error: logFn, debug: logFn },
    JSON,
    Math,
    Date,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Map,
    Set,
    Promise,
    Error,
    TypeError,
    RangeError,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, timeout)),
    clearTimeout,
  });

  // Freeze all constructor prototypes to prevent prototype pollution
  for (const key of Object.keys(context)) {
    const val = context[key];
    if (val && typeof val === 'function' && val.prototype) {
      Object.freeze(val.prototype);
    }
  }

  const wrapped = `(async (mcp) => { ${code} })`;
  const startTime = Date.now();

  try {
    const script = new vm.Script(wrapped, /** @type {*} */ ({
      filename: 'mcp-user-code.js',
      timeout: timeout,
    }));

    const fn = script.runInContext(context, { timeout });
    const result = await fn(mcp);

    const output = logs.join('\n');
    // @ts-ignore — genuine TS error, fix requires type widening
    parentPort.postMessage({
      type: 'complete',
      output: output.length > maxOutputSize ? output.slice(0, maxOutputSize) + '\n…[truncated]' : output,
      result: result !== undefined ? JSON.stringify(result).slice(0, maxOutputSize) : undefined,
      duration: Date.now() - startTime,
    });
  } catch (err) {
    // @ts-ignore — genuine TS error, fix requires type widening
    parentPort.postMessage({
      type: 'complete',
      output: logs.join('\n'),
      error: err.message || String(err),
      duration: Date.now() - startTime,
    });
  }
}

execute().catch((err) => {
  // @ts-ignore — genuine TS error, fix requires type widening
  parentPort.postMessage({
    type: 'complete',
    output: '',
    error: `Worker fatal: ${err.message}`,
    duration: 0,
  });
});
