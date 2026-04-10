#!/usr/bin/env node
// ============================================================
// Test: VerificationEngine — programmatic verification of step results
// FIX v7.0.8 (T-1): Audit finding — no dedicated unit tests existed.
// ============================================================

const { describe, test, assert, assertEqual, run, createTestRoot } = require('../harness');
const path = require('path');
const fs = require('fs');

const { VerificationEngine } = require('../../src/agent/intelligence/VerificationEngine');

const ROOT = createTestRoot('verifier');
fs.mkdirSync(path.join(ROOT, 'src'), { recursive: true });

function createEngine() {
  return new VerificationEngine({ bus: { emit() {}, fire() {} }, rootDir: ROOT });
}

describe('VerificationEngine — constructor', () => {
  test('creates with required deps', () => {
    const ve = createEngine();
    assert(ve.rootDir === ROOT, 'rootDir should be set');
    assert(ve._verifiers.code, 'code verifier should exist');
    assert(ve._verifiers.test, 'test verifier should exist');
    assert(ve._verifiers.shell, 'shell verifier should exist');
    assert(ve._verifiers.file, 'file verifier should exist');
    assert(ve._verifiers.plan, 'plan verifier should exist');
  });
});

describe('VerificationEngine — CODE verification', () => {
  test('passes valid JS code', () => {
    const ve = createEngine();
    const r = ve.verify('CODE', { target: 'test.js' }, { output: 'const x = 1 + 2;\nmodule.exports = { x };' });
    assert(r.status !== undefined, 'should return status');
    // Valid code should pass or be ambiguous (never fail)
    assert(r.status === 'pass' || r.status === 'ambiguous', `expected pass/ambiguous, got ${r.status}`);
  });

  test('detects syntax errors in code', () => {
    const ve = createEngine();
    const r = ve.verify('CODE', { target: 'test.js' }, { output: 'function { broken!!!' });
    // Syntax error should fail (if acorn available) or warn
    assert(r.status === 'fail' || r.checks?.some(c => c.status === 'fail' || c.status === 'warn'),
      'syntax error should be detected');
  });

  test('handles empty code output', () => {
    const ve = createEngine();
    const r = ve.verify('CODE', { target: 'test.js' }, { output: '' });
    // Empty output should not crash
    assert(typeof r.status === 'string', 'should return a status');
  });
});

describe('VerificationEngine — SHELL verification', () => {
  test('passes on exit code 0', () => {
    const ve = createEngine();
    const r = ve.verify('SHELL', { description: 'ls' }, { exitCode: 0, output: 'file.txt', error: '' });
    assertEqual(r.status, 'pass', 'exit code 0 should pass');
  });

  test('fails on non-zero exit code', () => {
    const ve = createEngine();
    const r = ve.verify('SHELL', { description: 'fail' }, { exitCode: 1, output: '', error: 'command not found' });
    assertEqual(r.status, 'fail', 'non-zero exit should fail');
  });

  test('detects timeout', () => {
    const ve = createEngine();
    const r = ve.verify('SHELL', { description: 'slow' }, { exitCode: 1, error: 'ETIMEDOUT', timedOut: true });
    assertEqual(r.status, 'fail', 'timeout should fail');
  });
});

describe('VerificationEngine — SANDBOX verification', () => {
  test('passes when sandbox test succeeds', () => {
    const ve = createEngine();
    const r = ve.verify('SANDBOX', { description: 'test calc' }, { exitCode: 0, output: 'PASS', error: '' });
    assertEqual(r.status, 'pass', 'sandbox pass should pass');
  });

  test('fails when sandbox test fails', () => {
    const ve = createEngine();
    const r = ve.verify('SANDBOX', { description: 'test fail' }, { exitCode: 1, error: 'AssertionError: expected 1 to equal 2' });
    assertEqual(r.status, 'fail', 'sandbox fail should fail');
  });
});

describe('VerificationEngine — unknown type handling', () => {
  test('returns ambiguous for unknown step types', () => {
    const ve = createEngine();
    const r = ve.verify('UNKNOWN_TYPE', {}, {});
    assertEqual(r.status, 'ambiguous', 'unknown type should be ambiguous');
  });

  test('handles null/undefined type gracefully', () => {
    const ve = createEngine();
    const r = ve.verify(null, {}, {});
    assertEqual(r.status, 'ambiguous', 'null type should be ambiguous');
  });
});

describe('VerificationEngine — stats tracking', () => {
  test('tracks verification counts', () => {
    const ve = createEngine();
    ve.verify('SHELL', {}, { exitCode: 0, output: '', error: '' });
    ve.verify('SHELL', {}, { exitCode: 1, output: '', error: 'err' });
    ve.verify('CODE', { target: 'x.js' }, { output: 'const x = 1;' });
    assert(ve._stats.total >= 3, `expected >=3 total, got ${ve._stats.total}`);
    assert(ve._stats.pass >= 1, 'should have at least 1 pass');
    assert(ve._stats.fail >= 1, 'should have at least 1 fail');
  });
});

describe('VerificationEngine — return structure', () => {
  test('always returns object with status', () => {
    const ve = createEngine();
    const types = ['CODE', 'SHELL', 'SANDBOX', 'ANALYZE', 'SEARCH', 'ASK', 'UNKNOWN'];
    for (const t of types) {
      const r = ve.verify(t, { target: 'x.js' }, { output: 'x', exitCode: 0, error: '' });
      assert(typeof r === 'object', `${t}: should return object`);
      assert(typeof r.status === 'string', `${t}: should have status string`);
      assert(['pass', 'fail', 'ambiguous', 'warn'].includes(r.status),
        `${t}: status '${r.status}' should be pass/fail/ambiguous/warn`);
    }
  });
});

run();
