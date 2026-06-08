'use strict';
// v7.9.21 (Point E) — a RUN_TESTS step must run the real test suite (npm test)
// to completion, behind the shell approval gate, instead of degrading to a
// read-only ANALYZE fallback (the field crash.log) or aborting at the 30s shell
// timeout. The command + extended timeout are injected at BOTH normalization
// choke points: _executeStep (covers FormalPlanner/HTN, which bypass
// normalizeStepTypes) and normalizeStepTypes (covers AgentLoopPlanner/replan).
const { describe, test, run, assert } = require('../harness');
const st = require('../../src/agent/core/step-types');
const { TIMEOUTS } = require('../../src/agent/core/Constants');
const { normalizeStepTypes } = require('../../src/agent/revolution/plan-context');
const { AgentLoopStepsDelegate } = require('../../src/agent/revolution/AgentLoopSteps');

describe('v7921 run-tests step runs the real suite', () => {
  test('alias + helper unit', () => {
    assert(st.normalizeStepType('RUN_TESTS') === 'SHELL', 'RUN_TESTS -> SHELL');
    assert(st.normalizeStepType('run_test') === 'SHELL', 'run_test -> SHELL (case-insensitive)');
    assert(st.normalizeStepType('TESTS') === 'SHELL', 'TESTS -> SHELL');
    assert(st.normalizeStepType('TEST') === 'SANDBOX', 'TEST stays SANDBOX (snippet, not suite)');

    const s1 = { type: 'RUN_TESTS' };
    st.applyStepTypeDefaults(s1, 'RUN_TESTS');
    assert(s1.command === 'npm test' && s1.timeoutMs === TIMEOUTS.TEST_RUN_EXEC && s1.target === null, 'field-case defaults');

    const s2 = { type: 'RUN_TESTS', command: 'npm run test:unit' };
    st.applyStepTypeDefaults(s2, 'RUN_TESTS');
    assert(s2.command === 'npm run test:unit', 'explicit command is not overwritten');

    const s3 = { type: 'SHELL', command: 'git status' };
    st.applyStepTypeDefaults(s3, 'SHELL');
    assert(s3.command === 'git status' && s3.timeoutMs === undefined, 'non-test SHELL untouched');
  });

  test('normalizeStepTypes (AgentLoopPlanner/replan path)', () => {
    const steps = [{ type: 'RUN_TESTS', description: 'run the suite', target: 'test/foo.test.js' }];
    normalizeStepTypes(steps, {});
    assert(steps[0].type === 'SHELL', 'RUN_TESTS -> SHELL — got: ' + steps[0].type);
    assert(steps[0].command === 'npm test', 'npm test injected — got: ' + steps[0].command);
    assert(steps[0].timeoutMs === TIMEOUTS.TEST_RUN_EXEC, 'extended timeout — got: ' + steps[0].timeoutMs);
    assert(steps[0].target === null, 'test-file target cleared — got: ' + JSON.stringify(steps[0].target));

    const unknown = [{ type: 'FLIBBERTIGIBBET', description: 'x' }];
    normalizeStepTypes(unknown, {});
    assert(unknown[0].type === 'ANALYZE', 'unknown type still -> ANALYZE (safety net)');
  });

  test('_executeStep choke point (FormalPlanner-bypass path)', async () => {
    const fakeLoop = {
      rootDir: '/tmp',
      approval: { request: async () => false }, // reject -> npm test is NOT actually run
      shell: { run: async () => ({ stdout: '', stderr: null }) },
      model: { chat: async () => '' },
    };
    const delegate = new AgentLoopStepsDelegate(fakeLoop);
    const step = { type: 'RUN_TESTS', description: 'run the suite', target: 'test/foo.test.js' };
    // _executeStep mutates the step (normalize + inject) BEFORE the switch; the
    // post-switch verifier/worldState wiring is not present offline, so tolerate
    // a throw there — we only assert the choke-point injection.
    try { await delegate._executeStep(step, 'ctx', () => {}); } catch (_e) { /* offline post-switch gap */ }
    assert(step.type === 'SHELL', 'RUN_TESTS normalized to SHELL — got: ' + step.type);
    assert(step.command === 'npm test', 'npm test injected at the choke point — got: ' + step.command);
    assert(step.timeoutMs === TIMEOUTS.TEST_RUN_EXEC, 'extended timeout injected — got: ' + step.timeoutMs);
    assert(step.target === null, 'test-file target cleared — got: ' + JSON.stringify(step.target));
  });

  test('_stepShell passes step.timeoutMs to the shell; normal shell stays at 30s', async () => {
    let lastTimeout = null;
    let lastCommand = null;
    const fakeLoop = {
      rootDir: '/tmp',
      approval: { request: async () => true },
      shell: { run: async (command, opts) => { lastCommand = command; lastTimeout = opts.timeout; return { stdout: 'ok', stderr: null }; } },
    };
    const delegate = new AgentLoopStepsDelegate(fakeLoop);

    await delegate._stepShell({ type: 'SHELL', command: 'npm test', timeoutMs: TIMEOUTS.TEST_RUN_EXEC }, 'ctx', () => {});
    assert(lastCommand === 'npm test', 'ran npm test — got: ' + lastCommand);
    assert(lastTimeout === TIMEOUTS.TEST_RUN_EXEC, 'shell received the extended timeout — got: ' + lastTimeout);

    await delegate._stepShell({ type: 'SHELL', command: 'git status' }, 'ctx', () => {});
    assert(lastTimeout === TIMEOUTS.SHELL_EXEC, 'an ordinary shell step falls back to SHELL_EXEC (30s) — got: ' + lastTimeout);
  });
});

if (require.main === module) run();
