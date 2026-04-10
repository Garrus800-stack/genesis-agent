#!/usr/bin/env node
// ============================================================
// Test: PreservationInvariants — semantic safety rules for self-mod
// FIX v7.0.8 (T-1): Audit finding — no dedicated unit tests existed.
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const { PreservationInvariants, INVARIANTS } = require('../../src/agent/core/PreservationInvariants');

describe('PreservationInvariants — structure', () => {
  test('has at least 10 invariants', () => {
    assert(INVARIANTS.length >= 10, `expected >=10 invariants, got ${INVARIANTS.length}`);
  });

  test('every invariant has required fields', () => {
    for (const inv of INVARIANTS) {
      assert(typeof inv.id === 'string', `missing id`);
      assert(typeof inv.description === 'string', `missing description for ${inv.id}`);
      assert(Array.isArray(inv.targets), `missing targets for ${inv.id}`);
      assert(typeof inv.check === 'function', `missing check for ${inv.id}`);
    }
  });

  test('instance exposes count and listInvariants', () => {
    const pi = new PreservationInvariants();
    assert(pi.count >= 10, 'count should reflect INVARIANTS');
    const list = pi.listInvariants();
    assert(Array.isArray(list), 'listInvariants should return array');
    assert(list[0].id && list[0].description && list[0].targets, 'list items should have id/description/targets');
  });
});

describe('PreservationInvariants — SAFETY_RULE_COUNT', () => {
  test('passes when block rules stay the same', () => {
    const pi = new PreservationInvariants();
    const old = "severity: 'block'\nseverity: 'block'\nseverity: 'block'";
    const r = pi.check('CodeSafetyScanner.js', old, old);
    assert(r.safe, 'same count should pass');
  });

  test('passes when block rules increase', () => {
    const pi = new PreservationInvariants();
    const old = "severity: 'block'\nseverity: 'block'";
    const neu = "severity: 'block'\nseverity: 'block'\nseverity: 'block'";
    const r = pi.check('CodeSafetyScanner.js', old, neu);
    assert(r.safe, 'more rules should pass');
  });

  test('fails when block rules decrease', () => {
    const pi = new PreservationInvariants();
    const old = "severity: 'block'\nseverity: 'block'\nseverity: 'block'";
    const neu = "severity: 'block'";
    const r = pi.check('CodeSafetyScanner.js', old, neu);
    assert(!r.safe, 'fewer rules should fail');
    assert(r.violations.some(v => v.invariant === 'SAFETY_RULE_COUNT'), 'should cite SAFETY_RULE_COUNT');
  });
});

describe('PreservationInvariants — SCANNER_FAIL_CLOSED', () => {
  test('passes when fail-closed preserved', () => {
    const pi = new PreservationInvariants();
    const code = "safe: false\nscanner unavailable";
    const r = pi.check('CodeSafetyScanner.js', code, code);
    assert(r.safe, 'unchanged fail-closed should pass');
  });

  test('fails when fail-closed removed', () => {
    const pi = new PreservationInvariants();
    const old = "safe: false\nscanner unavailable";
    const neu = "safe: true\nscanner ok";
    const r = pi.check('CodeSafetyScanner.js', old, neu);
    assert(!r.safe, 'removing fail-closed should fail');
    assert(r.violations.some(v => v.invariant === 'SCANNER_FAIL_CLOSED'));
  });
});

describe('PreservationInvariants — VERIFICATION_GATE', () => {
  test('fails when _verifyCode calls decrease', () => {
    const pi = new PreservationInvariants();
    const old = 'this._verifyCode(\nthis._verifyCode(';
    const neu = 'this._verifyCode(';
    const r = pi.check('SelfModificationPipeline.js', old, neu);
    assert(!r.safe, 'removing verification gate should fail');
    assert(r.violations.some(v => v.invariant === 'VERIFICATION_GATE'));
  });
});

describe('PreservationInvariants — SAFETY_SCAN_GATE', () => {
  test('fails when scanCode calls decrease', () => {
    const pi = new PreservationInvariants();
    const old = 'this._codeSafety.scanCode(\nthis._codeSafety.scanCode(';
    const neu = 'this._codeSafety.scanCode(';
    const r = pi.check('SelfModificationPipeline.js', old, neu);
    assert(!r.safe, 'removing safety scan gate should fail');
    assert(r.violations.some(v => v.invariant === 'SAFETY_SCAN_GATE'));
  });
});

describe('PreservationInvariants — SAFEGUARD_GATE', () => {
  test('fails when validateWrite calls decrease', () => {
    const pi = new PreservationInvariants();
    const old = 'this.guard.validateWrite(\nthis.guard.validateWrite(';
    const neu = 'this.guard.validateWrite(';
    const r = pi.check('SelfModificationPipeline.js', old, neu);
    assert(!r.safe, 'removing safeguard gate should fail');
    assert(r.violations.some(v => v.invariant === 'SAFEGUARD_GATE'));
  });
});

describe('PreservationInvariants — CIRCUIT_BREAKER_FLOOR', () => {
  test('passes with threshold >= 2', () => {
    const pi = new PreservationInvariants();
    const r = pi.check('SelfModificationPipeline.js', '', 'this._circuitBreakerThreshold = 3');
    assert(r.safe, 'threshold 3 should pass');
  });

  test('fails with threshold < 2', () => {
    const pi = new PreservationInvariants();
    const r = pi.check('SelfModificationPipeline.js', '', 'this._circuitBreakerThreshold = 1');
    assert(!r.safe, 'threshold 1 should fail');
    assert(r.violations.some(v => v.invariant === 'CIRCUIT_BREAKER_FLOOR'));
  });
});

describe('PreservationInvariants — SANDBOX_ISOLATION', () => {
  test('fails when Object.freeze patterns removed', () => {
    const pi = new PreservationInvariants();
    const old = 'Object.freeze(ctx)\nObject.create(null)';
    const neu = 'ctx';
    const r = pi.check('Sandbox.js', old, neu);
    assert(!r.safe, 'removing freeze should fail');
    assert(r.violations.some(v => v.invariant === 'SANDBOX_ISOLATION'));
  });
});

describe('PreservationInvariants — HASH_LOCK_LIST', () => {
  test('fails when lockCritical entries shrink', () => {
    const pi = new PreservationInvariants();
    const old = "lockCritical([\n  'src/a.js',\n  'src/b.js',\n  'src/c.js',\n])";
    const neu = "lockCritical([\n  'src/a.js',\n])";
    const r = pi.check('main.js', old, neu);
    assert(!r.safe, 'shrinking lock list should fail');
    assert(r.violations.some(v => v.invariant === 'HASH_LOCK_LIST'));
  });

  test('passes when lockCritical entries grow', () => {
    const pi = new PreservationInvariants();
    const old = "lockCritical([\n  'src/a.js',\n])";
    const neu = "lockCritical([\n  'src/a.js',\n  'src/b.js',\n])";
    const r = pi.check('main.js', old, neu);
    assert(r.safe, 'growing lock list should pass');
  });
});

describe('PreservationInvariants — KERNEL_IMPORT_BLOCK', () => {
  test('fails when kernel circumvention rule removed', () => {
    const pi = new PreservationInvariants();
    const old = "description: 'direct kernel import — circumvention attempt'";
    const neu = "description: 'some other rule'";
    const r = pi.check('CodeSafetyScanner.js', old, neu);
    assert(!r.safe, 'removing kernel block should fail');
    assert(r.violations.some(v => v.invariant === 'KERNEL_IMPORT_BLOCK'));
  });
});

describe('PreservationInvariants — targeting', () => {
  test('ignores non-matching files', () => {
    const pi = new PreservationInvariants();
    // Feed CodeSafetyScanner invariants a file that isn't CodeSafetyScanner.js
    const r = pi.check('SomeOtherModule.js', "severity: 'block'\nseverity: 'block'", "");
    // SomeOtherModule.js doesn't match CodeSafetyScanner targets, so those rules don't fire
    // It also doesn't match SelfModificationPipeline targets, etc.
    // Only universal rules (if any) would fire
    assert(r.violations.length === 0 || r.safe !== false, 'non-targeted file should not trigger targeted rules');
  });
});

describe('PreservationInvariants — fail-closed', () => {
  test('treats check() exceptions as violations', () => {
    const pi = new PreservationInvariants();
    // Inject a rule that throws
    pi._invariants.push({
      id: 'TEST_THROWS',
      description: 'test rule that throws',
      targets: [/throwtest\.js$/],
      check() { throw new Error('intentional test error'); },
    });
    const r = pi.check('throwtest.js', 'old', 'new');
    assert(!r.safe, 'thrown check should fail-closed');
    assert(r.violations.some(v => v.invariant === 'TEST_THROWS'), 'should report the throwing invariant');
    assert(r.violations.some(v => /fail-closed/i.test(v.detail)), 'detail should mention fail-closed');
  });
});

describe('PreservationInvariants — event emission', () => {
  test('emits preservation:violation on failure', () => {
    let emitted = null;
    const pi = new PreservationInvariants({ bus: { emit: (e, d) => { emitted = { event: e, data: d }; } } });
    const old = "severity: 'block'\nseverity: 'block'\nseverity: 'block'";
    const neu = "severity: 'block'";
    pi.check('CodeSafetyScanner.js', old, neu);
    assert(emitted !== null, 'should emit event');
    assertEqual(emitted.event, 'preservation:violation');
  });

  test('does not emit on success', () => {
    let emitted = false;
    const pi = new PreservationInvariants({ bus: { emit: () => { emitted = true; } } });
    pi.check('CodeSafetyScanner.js', "severity: 'block'", "severity: 'block'");
    assert(!emitted, 'should not emit on success');
  });
});

run();
