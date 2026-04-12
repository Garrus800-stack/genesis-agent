// @ts-check
// ============================================================
// GENESIS — SandboxVM.js (v7.1.2 — Composition Extract)
//
// VM-mode execution delegate: in-process evaluation using
// Node's vm.createContext with frozen globals.
//
// Extracted from Sandbox.js to reduce file size (776 → ~400 LOC).
// Same pattern as AgentLoop → AgentLoopStepsDelegate.
//
// ⚠ SECURITY NOTE: vm.createContext is NOT a true sandbox —
// it runs in the same process and V8 isolate. Use ONLY for
// trusted/quick evals. For untrusted code, use Sandbox.execute()
// which spawns a separate child process.
// ============================================================

'use strict';

const vm = require('vm');
const { createLogger } = require('../core/Logger');
const _log = createLogger('SandboxVM');

class SandboxVMDelegate {
  /**
   * @param {object} sandbox - Parent Sandbox instance
   */
  constructor(sandbox) {
    this._sandbox = sandbox;
  }

  /**
   * Execute code with injected context in VM mode.
   * @param {string} code - Code to execute
   * @param {object} context - Context values to inject
   * @param {object} options - { timeout, trusted }
   * @returns {Promise<object>}
   */
  async executeWithContext(code, context = {}, options = {}) {
    const { timeout = this._sandbox.timeout, trusted = false } = options;

    // Reject if caller did not explicitly opt in
    if (!trusted) {
      throw new Error(
        '[SANDBOX] executeWithContext() requires { trusted: true }. ' +
        'This mode runs in the same V8 isolate and is NOT a security boundary. ' +
        'For untrusted/LLM-generated code, use execute() (child process) instead.'
      );
    }

    // Pre-scan with CodeSafetyScanner if available
    try {
      if (this._sandbox._codeSafety) {
        const scanResult = this._sandbox._codeSafety.scanCode(code);
        if (scanResult.blocked && scanResult.blocked.length > 0) {
          const reasons = scanResult.blocked.map(b => b.description).join('; ');
          return { output: null, error: `[SANDBOX] Code blocked by safety scanner: ${reasons}`, duration: 0, mode: 'vm-blocked' };
        }
      }
    } catch (_scanErr) {
      _log.debug('[SANDBOX] CodeSafetyScanner not available for pre-scan:', _scanErr.message);
    }

    const startTime = Date.now();
    const logs = [];
    const nonce = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    this._sandbox._executionNonces.add(nonce);

    this._sandbox._audit('executeWithContext', Object.keys(context).join(', '));

    // Build a minimal, frozen sandbox environment
    const logFn = (...args) => {
      if (logs.length > 1000) return;
      logs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
    };
    const timerHandles = new Set();

    const sandbox = this._buildVMSandbox(logFn, timerHandles, timeout);

    // Explicitly block dangerous globals
    for (const blocked of ['process', 'require', 'module', 'global', 'globalThis',
                           '__dirname', '__filename', 'eval', 'Function']) {
      sandbox[blocked] = undefined;
    }

    const vmContext = vm.createContext(Object.freeze(sandbox));

    try {
      const script = new vm.Script(code, /** @type {*} */ ({
        filename: 'mcp-code-mode.js',
        timeout: Math.min(timeout, 30000),
      }));
      const fn = script.runInContext(vmContext, { timeout: Math.min(timeout, 30000) });

      if (typeof fn !== 'function') {
        return { output: String(fn), error: null, duration: Date.now() - startTime, mode: 'vm' };
      }

      const contextArgs = Object.values(context);
      const resultPromise = fn(...contextArgs);
      let _timeoutHandle;
      const timeoutPromise = new Promise((_, reject) => {
        _timeoutHandle = setTimeout(() => reject(new Error(`Timeout after ${timeout}ms`)), timeout);
      });
      const result = await Promise.race([resultPromise, timeoutPromise]);
      clearTimeout(_timeoutHandle);

      const output = result !== undefined
        ? (typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result))
        : logs.join('\n');

      return { output, error: null, duration: Date.now() - startTime, mode: 'vm' };

    } catch (err) {
      return { output: logs.join('\n') || '', error: err.message, duration: Date.now() - startTime, mode: 'vm' };
    } finally {
      for (const h of timerHandles) clearTimeout(h);
      timerHandles.clear();
      this._sandbox._executionNonces.delete(nonce);
    }
  }

  /**
   * Build the frozen VM sandbox environment.
   * Deep-freezes all exposed builtins to prevent prototype pollution.
   */
  _buildVMSandbox(logFn, timerHandles, timeout) {
    const _deepFreeze = (obj, seen = new WeakSet()) => {
      if (obj == null || typeof obj !== 'object' && typeof obj !== 'function') return obj;
      if (seen.has(obj)) return obj;
      seen.add(obj);
      try { Object.freeze(obj); } catch (_e) { /* some builtins resist */ }
      const proto = Object.getPrototypeOf(obj);
      if (proto && proto !== Object.prototype) _deepFreeze(proto, seen);
      for (const key of Object.getOwnPropertyNames(obj)) {
        try {
          const desc = Object.getOwnPropertyDescriptor(obj, key);
          if (desc && desc.value && (typeof desc.value === 'object' || typeof desc.value === 'function')) {
            _deepFreeze(desc.value, seen);
          }
        } catch (_e) { /* skip non-configurable */ }
      }
      return obj;
    };

    const safeCopy = (Ctor) => {
      const copy = Object.create(null);
      for (const key of Object.getOwnPropertyNames(Ctor)) {
        try { copy[key] = Ctor[key]; } catch (_e) { /* skip */ }
      }
      const proto = Object.create(null);
      try {
        for (const key of Object.getOwnPropertyNames(Ctor.prototype)) {
          try {
            const desc = Object.getOwnPropertyDescriptor(Ctor.prototype, key);
            if (desc) Object.defineProperty(proto, key, desc);
          } catch (_e) { /* skip */ }
        }
      } catch (_e) { /* skip */ }
      copy.prototype = proto;
      _deepFreeze(copy);
      return copy;
    };

    return {
      console: Object.freeze({
        log: logFn, error: logFn, warn: logFn, info: logFn, debug: logFn,
      }),
      JSON: _deepFreeze({ parse: JSON.parse, stringify: JSON.stringify }),
      Math: _deepFreeze(Object.create(Math)),
      Date: safeCopy(Date), Array: safeCopy(Array), Object: safeCopy(Object),
      String: safeCopy(String), Number: safeCopy(Number), Boolean: safeCopy(Boolean),
      Map: safeCopy(Map), Set: safeCopy(Set), WeakMap: safeCopy(WeakMap),
      WeakSet: safeCopy(WeakSet), Promise: safeCopy(Promise),
      RegExp: safeCopy(RegExp), Error: safeCopy(Error),
      parseInt, parseFloat, isNaN, isFinite,
      Buffer: safeCopy(Buffer),
      setTimeout: (fn, ms) => {
        const h = setTimeout(fn, Math.min(ms, timeout));
        timerHandles.add(h);
        return h;
      },
      clearTimeout: (h) => { timerHandles.delete(h); clearTimeout(h); },
      TextEncoder, TextDecoder,
    };
  }
}

module.exports = { SandboxVMDelegate };
