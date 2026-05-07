// ============================================================
// GENESIS — test/modules/v762-closeout.contract.test.js
//
// Contract tests for the v7.6.2 audit-closeout patches. Each test
// pins a specific finding from the v7.6.2 static analysis so the
// fix can't silently regress:
//
//   H1: ChatOrchestratorHelpers passes valid string verdict to recordGate
//   H2: SANDBOX_ISOLATION rule fires against the real SandboxVM.js
//   H3: SHUTDOWN_SYNC_WRITES rule fires against real service-side files
//   H4: VERIFICATION/SAFETY_SCAN/SAFEGUARD_GATE rules fire against
//       the real SelfModificationPipelineModify.js (incl. the
//       (this)-cast pattern that defeated the old regex)
//   M1: SelfModificationPipelineModify.js + SandboxVM.js are in
//       the lockCritical([...]) list in main.js
//   M3: EVENTBUS_DEDUP rule fires against the real EventBus.js
//       (uses _keyedEntries/compositeKey identifiers, not "dedup"
//       comment-word)
//
// Plus smoke tests for the two new audit scripts wired into
// `npm run ci`:
//
//   scripts/audit-gate-stats-callers.js
//   scripts/audit-hash-lock-coverage.js
//
// Both follow the audit-self-gate-coverage template introduced in
// the v7.6.1 audit-closeout: parse a documented surface, scan
// src/agent for matching patterns, fail when there's a gap. The
// new scripts add 14./15. CI-gate to Genesis.
// ============================================================

'use strict';

const { describe, test, assert, run } = require('../harness');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

// ────────────────────────────────────────────────────────────────
// H1 — ChatOrchestratorHelpers passes valid verdict to recordGate
// ────────────────────────────────────────────────────────────────
describe('v7.6.2 closeout (H1): intent-tool-coherence GateStats wiring', () => {

  test('ChatOrchestratorHelpers no longer passes Object literal to recordGate', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'src/agent/hexagonal/ChatOrchestratorHelpers.js'), 'utf8');
    // The old buggy form passed { verdict: 'mismatch' } as arg #2 —
    // an Object that GateStats.recordGate silently dropped (Set lookup
    // against {pass,block,warn} fails on Object). Make sure that exact
    // pattern is gone.
    assert(!/recordGate\([^,]+,\s*\{[^}]*verdict\s*:/.test(src),
      'Object-literal verdict argument must not return');
    // The new form uses ternary with valid string verdicts.
    assert(/recordGate\([^,]+,\s*verdict\.coherent\s*\?\s*['"]pass['"]\s*:\s*['"]warn['"]/.test(src),
      'must use ternary with valid pass/warn string verdicts');
  });

  test('GateStats actually records intent-tool-coherence calls now', () => {
    const { GateStats } = require(path.join(ROOT, 'src/agent/cognitive/GateStats'));
    const stats = new GateStats();
    // Simulate the post-fix call shape from ChatOrchestratorHelpers
    stats.recordGate('intent-tool-coherence', 'pass');
    stats.recordGate('intent-tool-coherence', 'pass');
    stats.recordGate('intent-tool-coherence', 'warn');
    const summary = stats.summary();
    const itc = summary.find(g => g.name === 'intent-tool-coherence');
    assert(itc, 'intent-tool-coherence must appear in summary');
    assert(itc.total === 3, `total must be 3, got ${itc.total}`);
    assert(itc.pass === 2, `pass must be 2, got ${itc.pass}`);
    assert(itc.warn === 1, `warn must be 1, got ${itc.warn}`);
  });

});

// ────────────────────────────────────────────────────────────────
// H2 — SANDBOX_ISOLATION rule fires against real SandboxVM.js
// ────────────────────────────────────────────────────────────────
describe('v7.6.2 closeout (H2): SANDBOX_ISOLATION protects SandboxVM.js', () => {

  test('targets list now covers Sandbox.js AND SandboxVM.js', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'src/agent/core/PreservationInvariants.js'), 'utf8');
    assert(/targets:\s*\[\/Sandbox\\\.js\$\/\s*,\s*\/SandboxVM\\\.js\$\//.test(src),
      'SANDBOX_ISOLATION targets must cover both Sandbox.js and SandboxVM.js');
  });

  test('rule fires when SandboxVM.js loses freeze patterns (real source)', () => {
    const { PreservationInvariants } = require(
      path.join(ROOT, 'src/agent/core/PreservationInvariants'));
    const pi = new PreservationInvariants();
    const old = fs.readFileSync(
      path.join(ROOT, 'src/agent/foundation/SandboxVM.js'), 'utf8');
    const subverted = old.replace(/Object\.freeze|Object\.create\(null\)/g, 'noOp_DISABLED');
    const r = pi.check('src/agent/foundation/SandboxVM.js', old, subverted);
    assert(r.violations.some(v => (v.rule || v.invariant) === 'SANDBOX_ISOLATION'),
      'SANDBOX_ISOLATION must fire when SandboxVM.js loses Object.freeze patterns');
  });

});

// ────────────────────────────────────────────────────────────────
// H3 — SHUTDOWN_SYNC_WRITES re-scoped to all service-side files
// ────────────────────────────────────────────────────────────────
describe('v7.6.2 closeout (H3): SHUTDOWN_SYNC_WRITES re-scoped', () => {

  test('targets list now covers all src/agent/**.js files', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'src/agent/core/PreservationInvariants.js'), 'utf8');
    // Match from this rule's id: marker until the NEXT id: marker.
    // (Non-greedy with `check\s*\(` doesn't work — the rule comments
    //  describe `check()` and the lazy regex stops there.)
    const ruleBlock = src.match(/id:\s*['"]SHUTDOWN_SYNC_WRITES['"][\s\S]+?id:\s*['"]/);
    assert(ruleBlock, 'SHUTDOWN_SYNC_WRITES rule must exist with a following rule');
    // The new broad target is the literal string /^src\/agent\/.*\.js$/
    assert(ruleBlock[0].includes('/^src\\/agent\\/.*\\.js$/'),
      'targets must be broad src/agent/**.js pattern');
    // The OLD narrow target /AgentCoreHealth\.js$/ must NOT appear in any
    // active targets line. (The audit-closeout comment mentioning the old
    // pattern by name is fine — only the live targets array matters.)
    const targetsLine = ruleBlock[0].split('\n').find(
      l => /^\s*targets:/.test(l));
    assert(targetsLine, 'targets line must exist');
    assert(!targetsLine.includes('AgentCoreHealth'),
      'narrow AgentCoreHealth target must not be in active targets array');
  });

  test('rule has early-return for files without sync-write patterns', () => {
    const { PreservationInvariants } = require(
      path.join(ROOT, 'src/agent/core/PreservationInvariants'));
    const pi = new PreservationInvariants();
    // A non-persisting file: should pass even if "modified"
    const r = pi.check(
      'src/agent/core/EventBus.js',
      'class EventBus { foo() { return 1; } }',
      'class EventBus { foo() { return 2; } }');
    assert(!r.violations.some(v => (v.rule || v.invariant) === 'SHUTDOWN_SYNC_WRITES'),
      'rule must early-return for files without sync-write patterns');
  });

  test('rule fires when a service-side file regresses sync→async', () => {
    const { PreservationInvariants } = require(
      path.join(ROOT, 'src/agent/core/PreservationInvariants'));
    const pi = new PreservationInvariants();
    const old = `class GoalPersistence {
      stop() { this._saveSync(); fs.writeFileSync(this.path, this.data); }
    }`;
    const reduced = `class GoalPersistence {
      stop() { /* nothing */ }
    }`;
    const r = pi.check('src/agent/planning/GoalPersistence.js', old, reduced);
    assert(r.violations.some(v => (v.rule || v.invariant) === 'SHUTDOWN_SYNC_WRITES'),
      'rule must fire when sync writes are removed from a persisting service');
  });

});

// ────────────────────────────────────────────────────────────────
// H4 — VERIFICATION/SAFETY_SCAN/SAFEGUARD_GATE protect Modify.js
// ────────────────────────────────────────────────────────────────
describe('v7.6.2 closeout (H4): SelfMod-Pipeline rules cover Modify.js', () => {

  test('all three rule targets cover Pipeline AND Modify', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'src/agent/core/PreservationInvariants.js'), 'utf8');
    for (const ruleId of ['VERIFICATION_GATE', 'SAFETY_SCAN_GATE', 'SAFEGUARD_GATE']) {
      const block = src.match(new RegExp(`id:\\s*['"]${ruleId}['"][\\s\\S]+?check\\s*\\(`));
      assert(block, `${ruleId} rule must exist`);
      assert(/targets:\s*\[\/SelfModificationPipeline\(\?:Modify\)\?\\\.js\$\//.test(block[0]),
        `${ruleId} targets must cover Pipeline.js AND PipelineModify.js`);
    }
  });

  test('SAFETY_SCAN_GATE regex defeats the (this)-cast pattern', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'src/agent/core/PreservationInvariants.js'), 'utf8');
    const block = src.match(/id:\s*['"]SAFETY_SCAN_GATE['"][\s\S]+?check\s*\([\s\S]+?\}\s*,\s*\}/);
    assert(block, 'SAFETY_SCAN_GATE rule body must exist');
    assert(/\(\?:this\|\\?\(this\\?\)\)\\?\._codeSafety/.test(block[0]),
      'regex must match both `this._codeSafety` and `(this)._codeSafety`');
  });

  test('all three rules fire when Modify.js loses gate calls (real source)', () => {
    const { PreservationInvariants } = require(
      path.join(ROOT, 'src/agent/core/PreservationInvariants'));
    const pi = new PreservationInvariants();
    const old = fs.readFileSync(
      path.join(ROOT, 'src/agent/hexagonal/SelfModificationPipelineModify.js'), 'utf8');
    let subverted = old.replace(/this\._verifyCode\s*\(/g, '_DISABLED_(');
    subverted = subverted.replace(/(?:this|\(this\))\._codeSafety\.scanCode\s*\(/g, '_DISABLED_(');
    subverted = subverted.replace(/this\.guard\.validateWrite\s*\(/g, '_DISABLED_(');
    const r = pi.check('src/agent/hexagonal/SelfModificationPipelineModify.js', old, subverted);
    const fired = new Set(r.violations.map(v => v.rule || v.invariant));
    assert(fired.has('VERIFICATION_GATE'), 'VERIFICATION_GATE must fire');
    assert(fired.has('SAFETY_SCAN_GATE'), 'SAFETY_SCAN_GATE must fire');
    assert(fired.has('SAFEGUARD_GATE'), 'SAFEGUARD_GATE must fire');
  });

});

// ────────────────────────────────────────────────────────────────
// M1 — Hash-lock list covers Modify.js + SandboxVM.js
// ────────────────────────────────────────────────────────────────
describe('v7.6.2 closeout (M1): hash-lock list covers v7.4.3 + v7.1.2 splits', () => {

  test('main.js lockCritical includes SelfModificationPipelineModify.js', () => {
    const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    const m = src.match(/lockCritical\s*\(\s*\[([\s\S]+?)\]\s*\)/);
    assert(m, 'lockCritical([...]) call must exist in main.js');
    assert(m[1].includes("'src/agent/hexagonal/SelfModificationPipelineModify.js'"),
      'Modify.js must be in lockCritical (the file that actually writes to disk)');
  });

  test('main.js lockCritical includes SandboxVM.js', () => {
    const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    assert(src.includes("'src/agent/foundation/SandboxVM.js'"),
      'SandboxVM.js must be in lockCritical (holds VM prototype isolation patterns)');
  });

});

// ────────────────────────────────────────────────────────────────
// M3 — EVENTBUS_DEDUP rule uses real-code identifiers
// ────────────────────────────────────────────────────────────────
describe('v7.6.2 closeout (M3): EVENTBUS_DEDUP regex matches real code', () => {

  test('rule regex uses _keyedEntries/compositeKey identifiers', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'src/agent/core/PreservationInvariants.js'), 'utf8');
    const block = src.match(/id:\s*['"]EVENTBUS_DEDUP['"][\s\S]+?check\s*\([\s\S]+?\}\s*,\s*\}/);
    assert(block, 'EVENTBUS_DEDUP rule must exist');
    assert(/_keyedEntries\\b\|compositeKey\\b/.test(block[0]),
      'regex must check actual code identifiers, not the "dedup" comment word');
  });

  test('rule fires when real dedup logic is removed from EventBus.js', () => {
    const { PreservationInvariants } = require(
      path.join(ROOT, 'src/agent/core/PreservationInvariants'));
    const pi = new PreservationInvariants();
    const old = fs.readFileSync(
      path.join(ROOT, 'src/agent/core/EventBus.js'), 'utf8');
    const subverted = old.replace(/_keyedEntries|compositeKey/g, '_DISABLED');
    const r = pi.check('src/agent/core/EventBus.js', old, subverted);
    assert(r.violations.some(v => (v.rule || v.invariant) === 'EVENTBUS_DEDUP'),
      'EVENTBUS_DEDUP must fire when the dedup identifiers are removed');
  });

});

// ────────────────────────────────────────────────────────────────
// New audit scripts (smoke tests)
// ────────────────────────────────────────────────────────────────
describe('v7.6.2 closeout: audit-gate-stats-callers.js (new CI gate)', () => {

  test('script exists and is executable', () => {
    const p = path.join(ROOT, 'scripts/audit-gate-stats-callers.js');
    assert(fs.existsSync(p), 'audit-gate-stats-callers.js must exist');
    const src = fs.readFileSync(p, 'utf8');
    assert(/VALID_VERDICTS\s*=\s*new Set\(\['pass'/.test(src),
      'must reference VALID_VERDICTS = pass/block/warn');
    assert(/strict/.test(src) && /jsonMode/.test(src),
      'must support --strict and --json flags');
  });

  test('script exits 0 on the current codebase (post-H1-fix)', () => {
    // Use execFileSync (args-array form) instead of execSync (template-string
    // form). The latter passes the command through a shell which splits on
    // whitespace — and ROOT may contain spaces (e.g. Linux "Schreibtisch/
    // Genesis Home/..."). With execFileSync each argument is preserved verbatim.
    let code;
    try {
      execFileSync('node',
        [path.join(ROOT, 'scripts/audit-gate-stats-callers.js')],
        { stdio: 'pipe' });
      code = 0;
    } catch (err) {
      code = err.status;
    }
    assert(code === 0, `script must exit 0, got ${code}`);
  });

});

describe('v7.6.2 closeout: audit-hash-lock-coverage.js (new CI gate)', () => {

  test('script exists and is executable', () => {
    const p = path.join(ROOT, 'scripts/audit-hash-lock-coverage.js');
    assert(fs.existsSync(p), 'audit-hash-lock-coverage.js must exist');
    const src = fs.readFileSync(p, 'utf8');
    assert(/STRICT_THRESHOLD\s*=\s*3/.test(src),
      'must use 3-of-3 gates as strict threshold');
    assert(/parseLockCritical/.test(src),
      'must parse lockCritical([...]) from main.js');
  });

  test('script exits 0 on the current codebase (post-M1-fix)', () => {
    // See note in audit-gate-stats-callers test above — execFileSync avoids
    // the shell-splits-on-space bug that triggers in paths like
    // "Schreibtisch/Genesis Home/...".
    let code;
    try {
      execFileSync('node',
        [path.join(ROOT, 'scripts/audit-hash-lock-coverage.js')],
        { stdio: 'pipe' });
      code = 0;
    } catch (err) {
      code = err.status;
    }
    assert(code === 0, `script must exit 0, got ${code}`);
  });

});

// ────────────────────────────────────────────────────────────────
// Both new scripts wired into `npm run ci`
// ────────────────────────────────────────────────────────────────
describe('v7.6.2 closeout: new audits wired into npm run ci', () => {

  test('package.json ci script invokes both new audits', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert(pkg.scripts.ci.includes('audit-gate-stats-callers.js'),
      'ci script must run audit-gate-stats-callers.js');
    assert(pkg.scripts.ci.includes('audit-hash-lock-coverage.js'),
      'ci script must run audit-hash-lock-coverage.js');
    assert(pkg.scripts['ci:full'].includes('audit-gate-stats-callers.js'),
      'ci:full script must run audit-gate-stats-callers.js');
    assert(pkg.scripts['ci:full'].includes('audit-hash-lock-coverage.js'),
      'ci:full script must run audit-hash-lock-coverage.js');
  });

});

run();
