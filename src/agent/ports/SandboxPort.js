// @ts-checked-v5.7
// ============================================================
// GENESIS — SandboxPort.js (v3.5.0 — Hexagonal Architecture)
//
// Port interface + adapter for code execution sandbox.
// 10 consumers to migrate.
// ============================================================

class SandboxPort {
  async execute(code, options) { throw new Error('Not implemented'); }
  async syntaxCheck(code) { throw new Error('Not implemented'); }
  getAuditLog() { return []; }
  cleanup() {}
}

class SandboxAdapter extends SandboxPort {
  static containerConfig = {
    name: 'sbx',
    phase: 1,
    deps: ['sandbox'],
    tags: ['port', 'foundation'],
    lateBindings: [],
    factory: (c) => new SandboxAdapter(c.resolve('sandbox')),
  };

  constructor(sandbox) {
    super();
    this._sandbox = sandbox;
    this._metrics = {
      executions: 0,
      syntaxChecks: 0,
      failures: 0,
      totalExecutionMs: 0,
    };
  }

  async execute(code, options = {}) {
    const start = Date.now();
    this._metrics.executions++;
    try {
      const result = await this._sandbox.execute(code, options);
      this._metrics.totalExecutionMs += Date.now() - start;
      if (result?.error) this._metrics.failures++;
      return result;
    } catch (err) {
      this._metrics.failures++;
      this._metrics.totalExecutionMs += Date.now() - start;
      throw err;
    }
  }

  async syntaxCheck(code) {
    this._metrics.syntaxChecks++;
    return this._sandbox.syntaxCheck(code);
  }

  getAuditLog() { return this._sandbox.getAuditLog(); }
  cleanup() { this._sandbox.cleanup(); }
  getMetrics() { return { ...this._metrics }; }
  get raw() { return this._sandbox; }
}

class MockSandbox extends SandboxPort {
  constructor() {
    super();
    this._executions = [];
    /** @type {any} */ this._syntaxResult = { valid: true };
    /** @type {any} */ this._execResult = { output: '', error: null };
  }
  async execute(code, options) {
    this._executions.push({ code, options });
    return typeof this._execResult === 'function'
      ? this._execResult(code) : { ...this._execResult };
  }
  async syntaxCheck(code) {
    return typeof this._syntaxResult === 'function'
      ? this._syntaxResult(code) : { ...this._syntaxResult };
  }
  /** @returns {any} */
  getAuditLog() { return this._executions.map((e, i) => ({ id: i, code: e.code })); }
  cleanup() { this._executions = []; }
  setExecResult(r) { this._execResult = r; }
  setSyntaxResult(r) { this._syntaxResult = r; }
}

module.exports = { SandboxPort, SandboxAdapter, MockSandbox };
