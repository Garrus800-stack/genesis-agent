// ============================================================
// GENESIS — test/modules/v784-step-reporting.test.js (v7.8.4)
//
// step-reporting contract: AgentLoopSteps must not pre-declare
// "test passed" in the output of a write-file step. Verification
// runs LATER in AgentLoopPursuit, and the prior output line
// would lie when verification fails.
//
// plan-validator contract: HTNPlanner must not emit a warning
// for DELEGATE steps. Peer availability is decided at plan-
// construction time (AgentLoopPlanner.canDelegate) and at
// execution time (_stepDelegate fallback to ANALYZE) — the
// validator does not orakel about peer status.
// ============================================================

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`    ✅ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`    ❌ ${name}: ${err.message}`);
  }
}

// ── step-reporting contract: WRITE_FILE output is neutral ─

test('step-reporting contract: AgentLoopSteps _stepCode output has no "test passed" claim', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src/agent/revolution/AgentLoopSteps.js'),
    'utf-8'
  );
  // _stepCode is the method that writes files (CODE step type).
  // Find from "async _stepCode" up to the next method boundary.
  const methodMatch = src.match(/async _stepCode\([\s\S]*?\n  (?:async )?_step/);
  assert.ok(methodMatch, '_stepCode method must exist');
  // Strip comment lines so the assertion fires only on real code (return strings).
  const codeOnly = methodMatch[0]
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
  assert.ok(
    !/test passed/i.test(codeOnly),
    '_stepCode return value must not contain "test passed" — verification has not run yet at that point'
  );
});

test('step-reporting contract: _stepCode still reports lines written (neutral output)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src/agent/revolution/AgentLoopSteps.js'),
    'utf-8'
  );
  // The neutral output must still mention "Code written" + lines, so
  // downstream consumers (UI, logs) keep the same shape.
  const methodMatch = src.match(/async _stepCode\([\s\S]*?\n  (?:async )?_step/);
  assert.match(methodMatch[0], /Code written/);
  assert.match(methodMatch[0], /lines\b/);
});

// ── step-reporting contract: AgentLoopPursuit overlay on verify fail ─

test('step-reporting contract: AgentLoopPursuit overlays output marker when verification fails', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src/agent/revolution/AgentLoopPursuit.js'),
    'utf-8'
  );
  // After verification fail, result.output must be prefixed so a step-log
  // reader doesn't see both "Code written: X (N lines)" and "Verification
  // failed: …" sitting next to each other without context. Match the
  // whole fail-branch until the else.
  const verifyBlock = src.match(/if \(stepVerification\.status === 'fail'\)[\s\S]+?(?=\} else \{)/);
  assert.ok(verifyBlock, 'verification-fail branch must exist');
  assert.match(verifyBlock[0], /result\.output\s*=/, 'fail branch must overlay result.output');
  assert.match(verifyBlock[0], /verification failed/i, 'overlay must label the failure');
});

test('step-reporting contract: overlay is defensive — only overwrites string outputs', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src/agent/revolution/AgentLoopPursuit.js'),
    'utf-8'
  );
  const verifyBlock = src.match(/if \(stepVerification\.status === 'fail'\)[\s\S]+?(?=\} else \{)/);
  assert.match(
    verifyBlock[0],
    /typeof result\.output === 'string'/,
    'overlay must be guarded by a string-type check'
  );
});

// ── plan-validator contract: no DELEGATE warning ─────────

test('plan-validator contract: HTNPlanner emits NO warning for DELEGATE steps', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src/agent/revolution/HTNPlanner.js'),
    'utf-8'
  );
  // The old line `warnings.push('DELEGATE step requires reachable peers')`
  // must be gone — the validator does not orakel about peer status.
  assert.ok(
    !/DELEGATE step requires reachable peers/.test(src),
    'HTNPlanner must no longer emit "DELEGATE step requires reachable peers"'
  );
});

test('plan-validator contract: DELEGATE branch still exists (acknowledged step type)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src/agent/revolution/HTNPlanner.js'),
    'utf-8'
  );
  // The branch itself must remain so DELEGATE is not treated as "unknown
  // step type" (which would land in the catch-all and become an issue).
  assert.match(
    src,
    /else if \(type === 'DELEGATE'\)/,
    'HTNPlanner must still have a DELEGATE branch to short-circuit the unknown-type catch-all'
  );
});

// ── functional check: HTNPlanner.dryRun does not flag DELEGATE ──

test('plan-validator contract: dryRun() returns no warnings for a DELEGATE-only plan', async () => {
  const { HTNPlanner } = require('../../src/agent/revolution/HTNPlanner');
  const planner = new HTNPlanner({
    bus: { fire: () => {}, on: () => {} },
    sandbox: null,
    selfModel: null,
    guard: null,
    eventStore: null,
    storage: null,
    rootDir: process.cwd(),
  });
  if (typeof planner.dryRun !== 'function') {
    console.log('    ℹ skipped — planner has no dryRun() method');
    passed++;
    return;
  }
  // dryRun takes a steps-array directly, not a plan-object
  const steps = [{ type: 'DELEGATE', description: 'sub-task X', skills: ['ts'] }];
  const result = await planner.dryRun(steps);
  assert.ok(result, 'dryRun must return a result object');
  const warnings = (result.validation && result.validation.warnings) || [];
  const hasPeerWarning = warnings.some((w) =>
    /DELEGATE.*peer/i.test(typeof w === 'string' ? w : (w.message || w.text || JSON.stringify(w)))
  );
  assert.ok(
    !hasPeerWarning,
    'dryRun must not include the obsolete peer-warning'
  );
});

// ── summary ───────────────────────────────────────────────

(async () => {
  await new Promise((r) => setTimeout(r, 50));
  if (failed > 0) {
    console.log(`\n  ${failed} failure(s):`);
    for (const f of failures) console.log(`    - ${f.name}: ${f.error}`);
    process.exit(1);
  }
  console.log(`    ${passed} passed`);
})();
