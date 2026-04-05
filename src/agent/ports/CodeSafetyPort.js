// @ts-checked-v5.7
// ============================================================
// GENESIS - CodeSafetyPort.js (v5.1.0 - Dependency Inversion)
//
// Port interface + adapter for code safety scanning.
//
// PROBLEM: CodeSafetyScanner (intelligence layer) was directly
// imported by 5 consumers across 3 layers (hexagonal, capabilities,
// foundation). This violated the Dependency Inversion Principle
// and created the only non-core cross-layer coupling hotspot.
//
// SOLUTION: A port in the ports layer that consumers depend on.
// The adapter wraps the real CodeSafetyScanner and is injected
// via Container lateBindings. Consumers never import from
// intelligence/ directly.
//
// Consumers: SelfModificationPipeline, PeerNetwork, SkillManager,
//            PluginRegistry, CloneFactory
//
// Pattern: Same as SandboxPort, MemoryPort, LLMPort, KnowledgePort.
// ============================================================

'use strict';

// ── Port interface ────────────────────────────────────────

class CodeSafetyPort {
  /**
   * Scan code for safety violations.
   * @param {string} code       - source code to scan
   * @param {string} [filename] - file identifier for diagnostics
   * @returns {{ safe: boolean, severity: string, violations: Array }}
   */
  scanCode(code, filename) {
    throw new Error('CodeSafetyPort.scanCode() not implemented');
  }

  /** @returns {boolean} Whether AST-based scanning is available */
  get available() { return false; }
}

// ── Adapter (wraps real CodeSafetyScanner) ─────────────────

class CodeSafetyAdapter extends CodeSafetyPort {
  /**
   * @param {{ scanCodeSafety: Function, acornAvailable: boolean }} scanner
   */
  constructor(scanner) {
    super();
    this._scanner = scanner;
    this._metrics = {
      scans: 0,
      blocked: 0,
      warnings: 0,
      totalMs: 0,
    };
  }

  scanCode(code, filename) {
    const t0 = Date.now();
    this._metrics.scans++;
    const result = this._scanner.scanCodeSafety(code, filename);
    this._metrics.totalMs += Date.now() - t0;
    if (!result.safe) this._metrics.blocked++;
    if (result.violations?.some(v => v.severity === 'warn')) this._metrics.warnings++;
    return result;
  }

  get available() {
    return this._scanner.acornAvailable;
  }

  getMetrics() { return { ...this._metrics }; }

  /**
   * Factory: create adapter from a CodeSafetyScanner module.
   * v5.2.0: Scanner is preferably passed in to avoid cross-layer import.
   * Falls back to auto-require for tests and standalone usage.
   *
   * @param {{ scanCodeSafety: Function, acornAvailable: boolean }} [scannerModule]
   * @returns {CodeSafetyAdapter}
   */
  static fromScanner(scannerModule) {
    if (!scannerModule) {
      // Fallback for tests and standalone usage - not used in production
      // (manifests always pass the scanner explicitly via R()).
      scannerModule = require('../intelligence/CodeSafetyScanner');
    }
    return new CodeSafetyAdapter(scannerModule);
  }
}

// ── Mock (for testing) ─────────────────────────────────────

class MockCodeSafety extends CodeSafetyPort {
  constructor() {
    super();
    this._scans = [];
    /** @type {object | Function} */
    this._result = { safe: true, severity: 'none', violations: [] };
    this._available = true;
  }

  scanCode(code, filename) {
    this._scans.push({ code, filename });
    return typeof this._result === 'function'
      ? this._result(code, filename)
      : { ...this._result };
  }

  get available() { return this._available; }

  // Test helpers
  setResult(r)    { this._result = r; }
  setAvailable(v) { this._available = v; }
  getScans()      { return this._scans; }
  reset()         { this._scans = []; }
}

module.exports = { CodeSafetyPort, CodeSafetyAdapter, MockCodeSafety };
