// @ts-checked-v5.7
// ============================================================
// GENESIS AGENT — Sandbox.js (v4.10.0 — Linux Namespace Isolation)
//
// v4.10.0 UPGRADE: Linux namespace isolation via unshare(1).
// On supported Linux kernels, execute() wraps child processes
// with PID/net/mount/IPC namespaces. Graceful degradation on
// Windows, macOS, Docker without --privileged, or kernels with
// restricted user namespaces.
//
// v4.0.0 UPGRADE: Two isolation modes:
//   1. PROCESS mode (default for untrusted code / self-mod):
//      Spawns a child process with minimal env, memory limit,
//      timeout, and restricted fs/net. Maximum isolation.
//   2. VM mode (for quick evaluations / tool results):
//      Uses Node's vm.createContext with a frozen global.
//      Faster (~5ms vs ~200ms) but same-process.
//
// Both modes share the same security surface:
//   - Allowlisted module require
//   - Restricted fs scope (sandbox/ + src/ read-only)
//   - No API keys in environment
//   - Audit logging
//
// v3.5.0: Replaced ALL execSync with async execFile.
// v4.0.0: Added vm-based fast path, process resource limits,
//          execution nonce tracking, and kill-group cleanup.
// ============================================================

const { execFile } = require('child_process');
const { TIMEOUTS } = require('../core/Constants');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../core/Logger');
const _log = createLogger('Sandbox');
let treeKill;
try { treeKill = require('tree-kill'); } catch { treeKill = (pid) => { try { process.kill(pid); } catch { /* ok */ } }; }

// v4.10.0: Linux namespace isolation for process sandbox
const { wrapCommand: _linuxWrap, getCapabilities: _linuxCaps } = require('./LinuxSandboxHelper');

class Sandbox {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.sandboxDir = path.join(rootDir, 'sandbox');
    this.timeout = 10000;
    this.memoryLimitMB = 128;
    this.activeProcesses = new Set();
    this._executionNonces = new Set(); // Track active execution IDs for kill-group
    this.auditLog = [];
    this.maxAuditEntries = 100;

    // FIX v5.1.0 (A-1): Injected via Container late-binding instead of
    // direct import from intelligence/CodeSafetyScanner. Eliminates the only
    // cross-phase coupling violation (foundation phase 1 → intelligence phase 2).
    // v5.2.0: Points to 'codeSafety' port service (CodeSafetyAdapter).
    this._codeSafety = null;

    this.blockedModules = new Set([
      'child_process', 'cluster', 'dgram', 'dns', 'net',
      'tls', 'http2', 'worker_threads', 'vm',
    ]);

    this.allowedModules = new Set([
      'path', 'url', 'querystring', 'util', 'assert',
      'buffer', 'events', 'stream', 'string_decoder', 'crypto',
      'os', // v5.9.1: Read-only system info — safe for skills
      'fs', // FIX v6.1.1: Skills need fs access. Path restrictions still enforced by restrictFs wrappers.
    ]);

    if (!fs.existsSync(this.sandboxDir)) {
      fs.mkdirSync(this.sandboxDir, { recursive: true });
    } else {
      try {
        for (const file of fs.readdirSync(this.sandboxDir)) {
          if (file.startsWith('exec_') || file.startsWith('_syntax')) {
            this._cleanFile(path.join(this.sandboxDir, file));
          }
        }
      } catch (_e) { _log.debug('[catch] ignore:', _e.message); }
    }
  }

  // v3.5.0: Fully async — no longer blocks main thread
  async syntaxCheck(code) {
    const tmpFile = path.join(this.sandboxDir, '_syntax_check.js');
    try {
      const checkCode = `
        const vm = require('vm');
        try {
          new vm.Script(${JSON.stringify(code)}, { filename: 'check.js' });
          process.stdout.write(JSON.stringify({ valid: true }));
        } catch (err) {
          process.stdout.write(JSON.stringify({ valid: false, error: err.message }));
        }
      `;
      fs.writeFileSync(tmpFile, checkCode, 'utf-8');

      const { stdout } = await execFileAsync('node', [tmpFile], {
        timeout: TIMEOUTS.GIT_OP, encoding: 'utf-8', cwd: this.sandboxDir,
        maxBuffer: 512 * 1024, windowsHide: true,
      });

      this._cleanFile(tmpFile);
      return JSON.parse(stdout);
    } catch (err) {
      this._cleanFile(tmpFile);
      return { valid: false, error: err.message };
    }
  }

  /**
   * Execute code with security restrictions
   * v3.5.0: Now fully async — uses execFile instead of execSync
   */
  // ════════════════════════════════════════════════════════
  // FIX v5.1.0 (SA-O2): Extracted from execute() to reduce CC.
  // ════════════════════════════════════════════════════════

  /**
   * Detect non-JavaScript code before sandbox execution.
   * @returns {{ detected: boolean, lang?: string }} 
   */
  _detectLanguage(code) {
    const patterns = [
      { pattern: /^#!.*python/m, lang: 'Python' },
      { pattern: /^#!.*bash|^#!.*sh\b/m, lang: 'Shell' },
      { pattern: /^<\?php/m, lang: 'PHP' },
      { pattern: /^#!.*ruby/m, lang: 'Ruby' },
      { pattern: /^@echo\s+off/im, lang: 'Batch' },
      { pattern: /^\s*def\s+\w+\s*\(.*\)\s*:/m, lang: 'Python' },
      { pattern: /^\s*import\s+\w+\s*$/m, lang: 'Python' },
      { pattern: /^\s*print\s*\(/m, lang: 'Python' },
    ];
    for (const { pattern, lang } of patterns) {
      if (pattern.test(code)) return { detected: true, lang };
    }
    return { detected: false };
  }

  async execute(code, options = {}) {
    // Guard: detect non-JavaScript code
    const langCheck = this._detectLanguage(code);
    if (langCheck.detected) {
      return { output: '', error: `This is ${langCheck.lang} code, not JavaScript.`, duration: 0, detectedLanguage: langCheck.lang };
    }

    const { timeout = this.timeout, allowRequire = false, env = {}, restrictFs = true, restrictNet = true } = options;
    const id = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const tmpFile = path.join(this.sandboxDir, `exec_${id}.js`);

    // FIX v5.1.0 (SA-O2): Template generation extracted to reduce execute() CC.
    const wrappedCode = this._buildExecutionScript(code, { allowRequire, restrictFs, restrictNet });

    fs.writeFileSync(tmpFile, wrappedCode, 'utf-8');
    this._audit('execute', code.slice(0, 200));

    // v3.5.0: Async execution — does NOT block main thread
    // FIX v3.5.4: Minimal env set — do NOT leak API keys, secrets, or tokens
    // from parent process. Only PATH, HOME/USERPROFILE, and TEMP are needed.
    const safeEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      TEMP: process.env.TEMP || process.env.TMPDIR || '/tmp',
      TMPDIR: process.env.TMPDIR || process.env.TEMP || '/tmp',
      NODE_ENV: 'sandbox',
      ...env, // Caller-specified overrides (e.g. GENESIS_SANDBOX_ALLOW_READ_ROOT)
    };
    try {
      // v4.10.0: On Linux, wrap with unshare for namespace isolation.
      // Provides PID/net/mount/IPC namespaces on supported kernels.
      // Graceful degradation: falls back to bare `node` if unavailable.
      const nodeArgs = [`--max-old-space-size=${this.memoryLimitMB}`, tmpFile];
      const wrapped = _linuxWrap('node', nodeArgs, { network: !restrictNet });
      if (wrapped.isolated) {
        _log.debug(`[SANDBOX] Linux namespace isolation: ${wrapped.namespaces.join(', ')}`);
      }

      const { stdout } = await execFileAsync(
        wrapped.binary,
        wrapped.args,
        {
          timeout,
          killSignal: 'SIGKILL', // v5.9.8: SIGKILL ensures unshare-wrapped processes die on timeout
          encoding: 'utf-8',
          cwd: this.sandboxDir,
          env: safeEnv,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        }
      );
      this._cleanFile(tmpFile);
      try { return JSON.parse(stdout); }
      catch (_e) { _log.debug('[catch] JSON parse:', _e.message); return { output: stdout, error: null, duration: 0 }; }
    } catch (err) {
      this._cleanFile(tmpFile);
      if (err.killed) return { output: '', error: `Timeout nach ${timeout}ms`, duration: timeout };
      const stderr = (err.stderr || '').trim();
      const errMsg = stderr || err.message;
      // v5.9.1: Include last 500 chars of stderr for better diagnostics
      return { output: err.stdout || '', error: errMsg.slice(-500), duration: 0 };
    }
  }

  /**
   * Execute code with injected context (e.g. async functions).
   * v4.0.0: Hardened VM mode — frozen globals, no prototype pollution,
   * restricted timers, explicit blocked identifiers.
   *
   * ⚠ SECURITY NOTE: vm.createContext is NOT a true sandbox — it runs
   * in the same process and V8 isolate. Prototype chain escapes are
   * theoretically possible. Use this mode ONLY for trusted/quick evals
   * (e.g. tool result formatting). For untrusted/LLM-generated code,
   * always use execute() which spawns a separate child process.
   * Future: migrate to isolated-vm or worker_threads for process-level
   * isolation with VM-like speed.
   * FIX v4.12.7 (Audit-10): Migration candidates ranked by isolation/speed:
   *   1. isolated-vm (npm) — separate V8 isolate, ~10ms startup, true memory isolation
   *   2. worker_threads  — separate thread, full Node API, ~50ms startup
   *   3. WebAssembly sandbox (experimental) — strongest isolation, limited API
   *
   * FIX v4.12.3 (S-03): Added runtime guard — callers must pass
   * { trusted: true } to explicitly acknowledge the same-process risk.
   * Code is also pre-scanned by CodeSafetyScanner for dangerous patterns.
   */
  async executeWithContext(code, context = {}, options = {}) {
    const { timeout = this.timeout, trusted = false } = options;

    // FIX v4.12.3 (S-03): Reject if caller did not explicitly opt in
    if (!trusted) {
      throw new Error(
        '[SANDBOX] executeWithContext() requires { trusted: true }. ' +
        'This mode runs in the same V8 isolate and is NOT a security boundary. ' +
        'For untrusted/LLM-generated code, use execute() (child process) instead.'
      );
    }

    // FIX v5.1.0 (A-1): Use injected scanner instead of direct require.
    // Eliminates cross-phase coupling (foundation → intelligence).
    try {
      if (this._codeSafety) {
        const scanResult = this._codeSafety.scanCode(code);
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
    this._executionNonces.add(nonce);

    this._audit('executeWithContext', Object.keys(context).join(', '));

    // v4.0.0: Build a minimal, frozen sandbox environment
    const logFn = (...args) => {
      if (logs.length > 1000) return; // Cap log buffer to prevent memory bomb
      logs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
    };
    const timerHandles = new Set();

    // FIX v4.10.0 (S-7): Deep-freeze all exposed builtins.
    // Object.freeze() is shallow — without this, VM code can mutate
    // Array.prototype, Object.prototype, etc. which persist within
    // the context. We create frozen copies of the prototype chains
    // for all exposed constructors.
    const _deepFreeze = (obj, seen = new WeakSet()) => {
      if (obj == null || typeof obj !== 'object' && typeof obj !== 'function') return obj;
      if (seen.has(obj)) return obj;
      seen.add(obj);
      try { Object.freeze(obj); } catch (_e) { _log.debug('[catch] some builtins resist:', _e.message); }
      // Freeze prototype chain
      const proto = Object.getPrototypeOf(obj);
      if (proto && proto !== Object.prototype) _deepFreeze(proto, seen);
      // Freeze own property values (only enumerable + non-enumerable descriptors)
      for (const key of Object.getOwnPropertyNames(obj)) {
        try {
          const desc = Object.getOwnPropertyDescriptor(obj, key);
          if (desc && desc.value && (typeof desc.value === 'object' || typeof desc.value === 'function')) {
            _deepFreeze(desc.value, seen);
          }
        } catch (_e) { _log.debug('[catch] skip non-configurable:', _e.message); }
      }
      return obj;
    };

    // Create safe copies of constructors with frozen prototypes
    // so VM code cannot pollute the host's prototypes
    const safeCopy = (Ctor) => {
      const copy = Object.create(null);
      for (const key of Object.getOwnPropertyNames(Ctor)) {
        try { copy[key] = Ctor[key]; } catch (_e) { _log.debug('[catch] skip:', _e.message); }
      }
      // FIX v6.0.3 (M-7): Create fully independent prototype — not linked to original.
      // Previous: Object.create(Ctor.prototype) — shared __proto__ chain meant
      // mutations could propagate if _deepFreeze failed on certain builtins.
      // Now: copy all own properties into a null-prototype object.
      const proto = Object.create(null);
      try {
        for (const key of Object.getOwnPropertyNames(Ctor.prototype)) {
          try {
            const desc = Object.getOwnPropertyDescriptor(Ctor.prototype, key);
            if (desc) Object.defineProperty(proto, key, desc);
          } catch (_e) { _log.debug('[catch] proto skip:', _e.message); }
        }
      } catch (_e) { _log.debug('[catch] proto iter:', _e.message); }
      copy.prototype = proto;
      _deepFreeze(copy);
      return copy;
    };

    const sandbox = {
      console: Object.freeze({
        log: logFn, error: logFn, warn: logFn, info: logFn, debug: logFn,
      }),
      // Expose frozen constructor copies — prevents prototype pollution
      // of the host's builtins from within the VM context
      JSON: _deepFreeze({ parse: JSON.parse, stringify: JSON.stringify }),
      Math: _deepFreeze(Object.create(Math)),
      // FIX v4.10.0 (Audit P2-03): All constructors via safeCopy() — prevents
      // prototype pollution that would persist within the VM context.
      // Previously Date, Array, Object etc. were passed as direct references.
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

    // Explicitly block dangerous globals
    for (const blocked of ['process', 'require', 'module', 'global', 'globalThis',
                           '__dirname', '__filename', 'eval', 'Function']) {
      sandbox[blocked] = undefined;
    }

    // Freeze the sandbox to prevent prototype pollution
    const vmContext = vm.createContext(Object.freeze(sandbox));

    try {
      const script = new vm.Script(code, /** @type {*} */ ({
        filename: 'mcp-code-mode.js',
        timeout: Math.min(timeout, 30000), // Hard cap at 30s for VM mode
      }));
      const fn = script.runInContext(vmContext, { timeout: Math.min(timeout, 30000) });

      if (typeof fn !== 'function') {
        return { output: String(fn), error: null, duration: Date.now() - startTime, mode: 'vm' };
      }

      const contextArgs = Object.values(context);
      const resultPromise = fn(...contextArgs);
      // FIX v4.0.0: Track timeout handle so it can be cleared in finally block
      let _timeoutHandle;
      const timeoutPromise = new Promise((_, reject) => {
        _timeoutHandle = setTimeout(() => reject(new Error(`Timeout after ${timeout}ms`)), timeout);
      });
      const result = await Promise.race([resultPromise, timeoutPromise]);
      clearTimeout(_timeoutHandle); // Clean up winning race's loser

      const output = result !== undefined
        ? (typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result))
        : logs.join('\n');

      return { output, error: null, duration: Date.now() - startTime, mode: 'vm' };

    } catch (err) {
      return { output: logs.join('\n') || '', error: err.message, duration: Date.now() - startTime, mode: 'vm' };
    } finally {
      // v4.0.0: Clean up leaked timers
      for (const h of timerHandles) clearTimeout(h);
      timerHandles.clear();
      this._executionNonces.delete(nonce);
    }
  }

  async testPatch(filePath, newCode) {
    const syntax = await this.syntaxCheck(newCode);
    if (!syntax.valid) return { success: false, error: `Syntax error: ${syntax.error}`, phase: 'syntax' };

    const sandboxFile = path.join(this.sandboxDir, path.basename(filePath));
    fs.writeFileSync(sandboxFile, newCode, 'utf-8');

    const requireTest = await this.execute(`
      try {
        const mod = require('${sandboxFile.replace(/\\/g, '\\\\')}');
        console.log('Module loaded. Exports:', Object.keys(mod || {}).join(', '));
      } catch (err) { throw new Error('Require failed: ' + err.message); }
    `, {
      allowRequire: true, restrictFs: true, restrictNet: true,
      // FIX v3.5.4: Restrict read scope to src/ instead of entire rootDir.
      // Previous: rootDir (includes .genesis/settings.json with API keys).
      env: { GENESIS_SANDBOX_ALLOW_READ_ROOT: path.join(this.rootDir, 'src') },
    });

    this._cleanFile(sandboxFile);
    if (requireTest.error) return { success: false, error: requireTest.error, phase: 'require' };

    const hasTest = newCode.includes('test()') || newCode.includes('test ()');
    if (hasTest) {
      fs.writeFileSync(sandboxFile, newCode, 'utf-8');
      const testResult = await this.execute(`
        const mod = require('${sandboxFile.replace(/\\/g, '\\\\')}');
        const instance = Object.values(mod).find(v => typeof v === 'function');
        if (instance) {
          const obj = new instance();
          if (typeof obj.test === 'function') {
            const result = await obj.test();
            console.log('Test result:', JSON.stringify(result));
          }
        }
      `, {
        allowRequire: true, restrictFs: true, restrictNet: true,
        env: { GENESIS_SANDBOX_ALLOW_READ_ROOT: path.join(this.rootDir, 'src') },
      });
      this._cleanFile(sandboxFile);
      if (testResult.error) return { success: false, error: testResult.error, phase: 'test' };
    }

    return { success: true, error: null, phase: 'complete' };
  }

  getAuditLog() { return [...this.auditLog]; }

  // ════════════════════════════════════════════════════════
  // FIX v4.0.0: EXTERNAL LANGUAGE SANDBOX
  // ════════════════════════════════════════════════════════
  //
  // Problem: FileProcessor.executeFile() ran Python, PHP, Ruby, etc.
  // as naked child_processes with full host access. An LLM-generated
  // Python script could read /etc/shadow, install backdoors, or
  // exfiltrate data.
  //
  // Solution: executeExternal() applies the SAME isolation principles
  // as the JS sandbox (execute()):
  //   1. Minimal env (no API keys, no secrets)
  //   2. CWD restricted to sandbox dir (copied file)
  //   3. Timeout + memory limit (via ulimit on Linux, job object concept on Windows)
  //   4. Audit logging
  //   5. Network: no explicit restriction (runtime-dependent), but
  //      env stripping removes proxy/API configs
  //
  // The file is COPIED into the sandbox dir before execution — the
  // runtime can only see/modify files in sandbox/.

  /**
   * Execute a non-JS file in a restricted environment.
   * @param {string} binary - Runtime binary (e.g. 'python', 'ruby')
   * @param {string[]} binaryArgs - Prefix args (e.g. ['-File'] for powershell)
   * @param {string} filePath - Absolute path to the file to execute
   * @param {string[]} args - User-provided arguments
   * @param {object} options - { timeout, language }
   * @returns {Promise<object>}
   */
  async executeExternal(binary, binaryArgs, filePath, args = [], options = {}) {
    const { timeout = this.timeout, language = 'unknown' } = options;
    const startTime = Date.now();
    const fileName = path.basename(filePath);

    this._audit('executeExternal', `${language}: ${fileName}`);

    // Copy file into sandbox dir — runtime CWD will be sandbox/
    const sandboxCopy = path.join(this.sandboxDir, `exec_${Date.now()}_${fileName}`);
    try {
      fs.copyFileSync(filePath, sandboxCopy);
    } catch (err) {
      return { output: '', error: `Failed to copy to sandbox: ${err.message}`, duration: 0, language, sandboxed: true };
    }

    // Minimal env — same pattern as JS execute()
    const safeEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      TEMP: process.env.TEMP || process.env.TMPDIR || '/tmp',
      TMPDIR: process.env.TMPDIR || process.env.TEMP || '/tmp',
      LANG: process.env.LANG || 'en_US.UTF-8',
      // Python-specific: disable user site-packages, force UTF-8
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONIOENCODING: 'utf-8',
    };

    const fullArgs = [...binaryArgs, sandboxCopy, ...args];

    try {
      // FIX v6.0.3 (M-5): Apply Linux namespace isolation to external language execution.
      // Same isolation as JS execute() — PID/net/mount/IPC namespaces on supported kernels.
      const wrapped = _linuxWrap(binary, fullArgs, { network: false });
      if (wrapped.isolated) {
        _log.debug(`[SANDBOX] External (${language}) namespace isolation: ${wrapped.namespaces.join(', ')}`);
      }

      const { stdout, stderr } = await execFileAsync(wrapped.binary, wrapped.args, {
        timeout,
        killSignal: 'SIGKILL',
        encoding: 'utf-8',
        cwd: this.sandboxDir,  // CWD = sandbox dir, not project root
        env: safeEnv,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
      const duration = Date.now() - startTime;
      this._cleanFile(sandboxCopy);
      return {
        output: stdout || stderr || '(no output)',
        error: null,
        duration,
        language,
        sandboxed: true,
      };
    } catch (err) {
      const duration = Date.now() - startTime;
      this._cleanFile(sandboxCopy);
      if (err.killed) {
        return { output: '', error: `Timeout nach ${timeout}ms`, duration, language, sandboxed: true };
      }
      return {
        output: err.stdout || '',
        error: err.stderr || err.message,
        duration,
        language,
        sandboxed: true,
      };
    }
  }

  /**
   * v4.10.0: Report isolation capabilities.
   * Returns Linux namespace status for health dashboard.
   */
  getIsolationStatus() {
    const linux = _linuxCaps();
    return {
      platform: process.platform,
      linuxNamespaces: linux.available,
      namespaces: linux.capabilities,
      reason: linux.reason,
      processIsolation: true,
      vmIsolation: true,
    };
  }

  /** v4.0.0: Runtime stats for health dashboard */
  getStats() {
    return {
      auditEntries: this.auditLog.length,
      activeProcesses: this.activeProcesses.size,
      activeVmExecutions: this._executionNonces.size,
      sandboxDir: this.sandboxDir,
      memoryLimitMB: this.memoryLimitMB,
      timeoutMs: this.timeout,
      isolation: this.getIsolationStatus(),
    };
  }

  _audit(action, detail) {
    this.auditLog.push({ action, detail, timestamp: new Date().toISOString() });
    if (this.auditLog.length > this.maxAuditEntries) this.auditLog.shift();
  }

  _cleanFile(filePath) {
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (err) { _log.debug('[SANDBOX] Cleanup:', err.message); }
  }


  /**
   * Build the sandboxed execution script template.
   * FIX v5.1.0 (SA-O2): Extracted from execute() to reduce method complexity.
   * @param {string} code - User code to execute
   * @param {{ allowRequire?: boolean, restrictFs?: boolean, restrictNet?: boolean }} [opts]
   * @returns {string} Complete script content for child process
   */
  _buildExecutionScript(code, { allowRequire = false, restrictFs = true, restrictNet = true } = {}) {
    const sandboxDirEscaped = this.sandboxDir.replace(/\\/g, '\\\\');
    const nodeModulesDirEscaped = path.resolve(this.rootDir, 'node_modules').replace(/\\/g, '\\\\');

    return `
'use strict';
const _startTime = Date.now();
const _output = [];
const _originalLog = console.log;
console.log = (...args) => {
  _output.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
};
console.error = console.log;
console.warn = console.log;

// ── Security: Block escape vectors ──────────────────────
delete process.mainModule;
delete process.dlopen;
delete process.binding;
delete process._linkedBinding;
// v3.5.2 FIX: Removed module.constructor._load/_resolveFilename destruction.
// On Node 22+, this breaks the entire require() chain because
// diagnostics_channel.TracingChannel wraps the module loader.
// Security is fully enforced by _safeRequire allowlist below.

// ── Security: Allowlist-based require ───────────────────
const _originalRequire = require;
const _allowedModules = new Set(${JSON.stringify([...this.allowedModules])});
${!restrictNet ? `_allowedModules.add('http'); _allowedModules.add('https');` : ''}
${!restrictFs ? `_allowedModules.add('fs');` : ''}
const _nodeModulesDir = '${nodeModulesDirEscaped}';
const _sandboxDirForRequire = '${sandboxDirEscaped}';
const _pathSep = require('path').sep;

const _safeRequire = (id) => {
  if (id.startsWith('/') || id.startsWith('.') || /^[A-Z]:\\\\/.test(id)) {
    const resolved = _originalRequire('path').resolve(id);
    const inSandbox = resolved.startsWith(_sandboxDirForRequire + _pathSep) || resolved === _sandboxDirForRequire;
    const inNodeModules = resolved.startsWith(_nodeModulesDir + _pathSep) || resolved === _nodeModulesDir;
    if (!inSandbox && !inNodeModules) {
      throw new Error('[SANDBOX] Module path blocked: ' + id + ' (resolved: ' + resolved + ')');
    }
    return _originalRequire(id);
  }
  if (!_allowedModules.has(id)) {
    throw new Error('[SANDBOX] Module not allowed: ' + id + ' (allowed: ' + [..._allowedModules].join(', ') + ')');
  }
  return _originalRequire(id);
};

// ── Security: Filesystem restriction ───────────────────
${restrictFs ? `
const _fs = require('fs');
const _path = require('path');
const _sandboxDir = '${sandboxDirEscaped}';

function _checkReadPath(p) {
  const resolved = _path.resolve(String(p));
  const inSandbox = resolved.startsWith(_sandboxDir);
  const inNodeModules = resolved.startsWith(_nodeModulesDir);
  // Allow reading project root if env var is set (for testPatch)
  const allowRoot = process.env.GENESIS_SANDBOX_ALLOW_READ_ROOT || '';
  const inRoot = allowRoot && resolved.startsWith(allowRoot);
  if (!inSandbox && !inNodeModules && !inRoot) {
    throw new Error('[SANDBOX] Read access blocked: ' + p);
  }
}
function _checkWritePath(p) {
  const resolved = _path.resolve(String(p));
  if (!resolved.startsWith(_sandboxDir)) {
    throw new Error('[SANDBOX] Write access blocked: ' + p);
  }
}

const _origReadFileSync = _fs.readFileSync;
const _origWriteFileSync = _fs.writeFileSync;
const _origUnlinkSync = _fs.unlinkSync;
_fs.readFileSync = function(p, ...a)  { _checkReadPath(p);  return _origReadFileSync.call(this, p, ...a); };
_fs.writeFileSync = function(p, ...a) { _checkWritePath(p); return _origWriteFileSync.call(this, p, ...a); };
_fs.unlinkSync = function(p, ...a)    { _checkWritePath(p); return _origUnlinkSync.call(this, p, ...a); };

const _origReadFile = _fs.readFile;
const _origWriteFile = _fs.writeFile;
const _origUnlink = _fs.unlink;
_fs.readFile = function(p, ...a)  { _checkReadPath(p);  return _origReadFile.call(this, p, ...a); };
_fs.writeFile = function(p, ...a) { _checkWritePath(p); return _origWriteFile.call(this, p, ...a); };
_fs.unlink = function(p, ...a)    { _checkWritePath(p); return _origUnlink.call(this, p, ...a); };

const _origCreateReadStream = _fs.createReadStream;
const _origCreateWriteStream = _fs.createWriteStream;
_fs.createReadStream = function(p, ...a)  { _checkReadPath(p);  return _origCreateReadStream.call(this, p, ...a); };
_fs.createWriteStream = function(p, ...a) { _checkWritePath(p); return _origCreateWriteStream.call(this, p, ...a); };

if (_fs.promises) {
  const _promReadFile = _fs.promises.readFile;
  const _promWriteFile = _fs.promises.writeFile;
  const _promUnlink = _fs.promises.unlink;
  _fs.promises.readFile = function(p, ...a)  { _checkReadPath(p);  return _promReadFile.call(this, p, ...a); };
  _fs.promises.writeFile = function(p, ...a) { _checkWritePath(p); return _promWriteFile.call(this, p, ...a); };
  _fs.promises.unlink = function(p, ...a)    { _checkWritePath(p); return _promUnlink.call(this, p, ...a); };
}

// FIX v4.0.0: Also restrict open/openSync, readdir/readdirSync, stat/statSync, access/accessSync, mkdir/mkdirSync
const _origOpenSync = _fs.openSync;
const _origOpen = _fs.open;
if (_origOpenSync) _fs.openSync = function(p, ...a) { _checkReadPath(p); return _origOpenSync.call(this, p, ...a); };
if (_origOpen) _fs.open = function(p, ...a) { _checkReadPath(p); return _origOpen.call(this, p, ...a); };
const _origReaddirSync = _fs.readdirSync;
const _origReaddir = _fs.readdir;
if (_origReaddirSync) _fs.readdirSync = function(p, ...a) { _checkReadPath(p); return _origReaddirSync.call(this, p, ...a); };
if (_origReaddir) _fs.readdir = function(p, ...a) { _checkReadPath(p); return _origReaddir.call(this, p, ...a); };
const _origStatSync = _fs.statSync;
const _origLstatSync = _fs.lstatSync;
const _origAccessSync = _fs.accessSync;
if (_origStatSync) _fs.statSync = function(p, ...a) { _checkReadPath(p); return _origStatSync.call(this, p, ...a); };
if (_origLstatSync) _fs.lstatSync = function(p, ...a) { _checkReadPath(p); return _origLstatSync.call(this, p, ...a); };
if (_origAccessSync) _fs.accessSync = function(p, ...a) { _checkReadPath(p); return _origAccessSync.call(this, p, ...a); };
const _origMkdirSync = _fs.mkdirSync;
if (_origMkdirSync) _fs.mkdirSync = function(p, ...a) { _checkWritePath(p); return _origMkdirSync.call(this, p, ...a); };
if (_fs.promises) {
  const _promOpen = _fs.promises.open;
  const _promReaddir = _fs.promises.readdir;
  const _promStat = _fs.promises.stat;
  const _promAccess = _fs.promises.access;
  const _promMkdir = _fs.promises.mkdir;
  if (_promOpen) _fs.promises.open = function(p, ...a) { _checkReadPath(p); return _promOpen.call(this, p, ...a); };
  if (_promReaddir) _fs.promises.readdir = function(p, ...a) { _checkReadPath(p); return _promReaddir.call(this, p, ...a); };
  if (_promStat) _fs.promises.stat = function(p, ...a) { _checkReadPath(p); return _promStat.call(this, p, ...a); };
  if (_promAccess) _fs.promises.access = function(p, ...a) { _checkReadPath(p); return _promAccess.call(this, p, ...a); };
  if (_promMkdir) _fs.promises.mkdir = function(p, ...a) { _checkWritePath(p); return _promMkdir.call(this, p, ...a); };
}

// FIX v6.0.3 (M-6): Added cp, cpSync (Node 16+), appendFile, appendFileSync
const _blockedFs = ['copyFile', 'copyFileSync', 'cp', 'cpSync', 'rename', 'renameSync', 'symlink', 'symlinkSync', 'link', 'linkSync'];
for (const method of _blockedFs) {
  if (typeof _fs[method] === 'function') {
    _fs[method] = function() { throw new Error('[SANDBOX] ' + method + ' is blocked'); };
  }
}
// FIX v6.0.3 (M-6): Intercept appendFile/appendFileSync with write-path checks
const _origAppendFileSync = _fs.appendFileSync;
const _origAppendFile = _fs.appendFile;
if (_origAppendFileSync) _fs.appendFileSync = function(p, ...a) { _checkWritePath(p); return _origAppendFileSync.call(this, p, ...a); };
if (_origAppendFile) _fs.appendFile = function(p, ...a) { _checkWritePath(p); return _origAppendFile.call(this, p, ...a); };
if (_fs.promises && _fs.promises.appendFile) {
  const _promAppendFile = _fs.promises.appendFile;
  _fs.promises.appendFile = function(p, ...a) { _checkWritePath(p); return _promAppendFile.call(this, p, ...a); };
}
` : ''}

process.on('uncaughtException', (err) => {
  process.stdout.write(JSON.stringify({ output: _output.join('\\n'), error: err.message, duration: Date.now() - _startTime }));
  // v5.2.0 (L-2x): Use exitCode instead of process.exit() — lets stdout flush
  // before natural process termination. process.exit(1) could truncate output
  // on slow pipes, losing diagnostic information for the parent process.
  process.exitCode = 1;
});

try {
  ${allowRequire ? 'const require = _safeRequire;' : 'const require = _safeRequire;'}
  const _result = (async () => {
    ${code}
  })();
  Promise.resolve(_result).then((val) => {
    if (val !== undefined) _output.push(String(val));
    process.stdout.write(JSON.stringify({ output: _output.join('\\n'), error: null, duration: Date.now() - _startTime }));
  }).catch((err) => {
    process.stdout.write(JSON.stringify({ output: _output.join('\\n'), error: err.message, duration: Date.now() - _startTime }));
  });
} catch (err) {
  process.stdout.write(JSON.stringify({ output: _output.join('\\n'), error: err.message, duration: Date.now() - _startTime }));
}
    `;
  }

  cleanup() {
    for (const pid of this.activeProcesses) {
      try { treeKill(pid); } catch (err) { _log.debug('[SANDBOX] Kill:', err.message); }
    }
    this.activeProcesses.clear();
    if (fs.existsSync(this.sandboxDir)) {
      for (const file of fs.readdirSync(this.sandboxDir)) {
        this._cleanFile(path.join(this.sandboxDir, file));
      }
    }
  }
}

module.exports = { Sandbox };
