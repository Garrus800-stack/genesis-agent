// Test: HTNPlanner catches invalid step types (v7.3.5 commit 4)
// Before v7.3.5 the _validateStep method only had branches for CODE/SHELL/
// SEARCH/ANALYZE/DELEGATE. Unknown types (GIT_SNAPSHOT, WRITE_FILE, etc.)
// fell through silently and the plan was reported as "valid". AgentLoopSteps
// then hit "Unknown step type: GIT_SNAPSHOT" at execution time. Plan died,
// tokens burned.
//
// v7.3.5 closes the loop: step-types.js is imported, VALID_STEP_TYPES is
// consulted, unknown types become issues (blockers), aliased types become
// warnings (AgentLoopSteps will normalize).
const { describe, test, run } = require('../harness');
const { HTNPlanner } = require('../../src/agent/revolution/HTNPlanner');

function newPlanner() {
  return new HTNPlanner({
    bus: { emit() {}, fire() {} },
    sandbox: null,
    selfModel: null,
    guard: null,
    rootDir: process.cwd(),
  });
}

describe('HTNPlanner step-type validation (v7.3.5)', () => {
  test('canonical types produce no type-related issues', async () => {
    const htn = newPlanner();
    const result = await htn.validatePlan([
      { type: 'ANALYZE', action: 'look at src' },
      { type: 'CODE',    action: 'write file', target: 'test.js' },
      { type: 'SHELL',   action: 'npm test' },
      { type: 'SEARCH',  action: 'find docs' },
    ]);
    // No "Unknown step type" in issues
    const hasUnknown = result.steps.some(r =>
      r.issues.some(i => /unknown step type/i.test(i))
    );
    if (hasUnknown) throw new Error('canonical types marked unknown');
  });

  test('aliased step type GIT_SNAPSHOT is flagged as warning (has alias → SHELL)', async () => {
    const htn = newPlanner();
    const result = await htn.validatePlan([
      { type: 'GIT_SNAPSHOT', action: 'create snapshot' },
    ]);
    const issues = result.steps[0].issues;
    const warnings = result.steps[0].warnings;
    // GIT_SNAPSHOT has an alias in step-types.js → SHELL. Should warn, not error.
    if (issues.some(i => /unknown step type/i.test(i))) {
      throw new Error('GIT_SNAPSHOT has an alias, should not be unknown: ' + JSON.stringify(issues));
    }
    if (!warnings.some(w => /normalized to SHELL/i.test(w))) {
      throw new Error('GIT_SNAPSHOT should warn about normalization: ' + JSON.stringify(warnings));
    }
  });

  test('truly invented type TOTALLY_INVENTED_TYPE is flagged as issue', async () => {
    const htn = newPlanner();
    const result = await htn.validatePlan([
      { type: 'TOTALLY_INVENTED_TYPE', action: 'bogus step' },
    ]);
    const issues = result.steps[0].issues;
    const found = issues.some(i => /unknown step type/i.test(i));
    if (!found) throw new Error('TOTALLY_INVENTED_TYPE should produce an unknown-type issue: ' + JSON.stringify(issues));
  });

  test('aliased step type WRITE_FILE is flagged as warning (not blocker)', async () => {
    const htn = newPlanner();
    const result = await htn.validatePlan([
      { type: 'WRITE_FILE', action: 'write a file' },
    ]);
    const warnings = result.steps[0].warnings;
    const issues = result.steps[0].issues;
    // Not a blocker
    if (issues.some(i => /unknown step type/i.test(i))) {
      throw new Error('WRITE_FILE should not be unknown — it has an alias');
    }
    // Should produce a warning noting normalization target
    const hasWarn = warnings.some(w => /normalized to CODE/i.test(w));
    if (!hasWarn) throw new Error('WRITE_FILE should warn about normalization: ' + JSON.stringify(warnings));
  });

  test('aliased step type CODE_GENERATE warns, not blocks', async () => {
    const htn = newPlanner();
    const result = await htn.validatePlan([
      { type: 'CODE_GENERATE', action: 'generate code' },
    ]);
    const issues = result.steps[0].issues;
    if (issues.some(i => /unknown step type/i.test(i))) {
      throw new Error('CODE_GENERATE should not be unknown');
    }
  });

  test('plan with unknown types produces invalid: true in summary', async () => {
    const htn = newPlanner();
    const result = await htn.validatePlan([
      { type: 'CODE', action: 'ok step', target: 'a.js' },
      { type: 'TOTALLY_INVENTED_TYPE', action: 'bogus step' },
    ]);
    if (result.totalIssues === 0) throw new Error('should have at least 1 issue');
    if (result.valid !== false) throw new Error('plan with unknown type should be invalid');
  });

  test('dryRun of a v7.3.4-like failure case with a truly invented type reports invalid', async () => {
    // The v7.3.4 Windows failure used GIT_SNAPSHOT, CODE_GENERATE, WRITE_FILE —
    // all of which now have aliases (commit 1) and warn instead of block.
    // That's the right behaviour: AgentLoopSteps will normalize them at
    // execution time. But a genuinely unknown type should still invalidate
    // the plan. We mix a real alias with one made-up type to confirm the
    // issue-detection path.
    const htn = newPlanner();
    const dry = await htn.dryRun([
      { type: 'ANALYZE',        action: 'audit error handling' },
      { type: 'WRITE_FILE',     action: 'write handler' },     // has alias → warns
      { type: 'QUANTUM_COMMIT', action: 'invented type' },     // no alias → issues
    ]);
    if (dry.valid) throw new Error('plan with an alias-less unknown type should be invalid');
  });
});

run();
