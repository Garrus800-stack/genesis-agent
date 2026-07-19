// ============================================================
// TEST — v7.9.40 (B0) Fundament: TIMEOUTS-Import, src-Lese-Freigabe,
//        Fehlertext-Persistenz ins Archiv
//   node test/modules/v7940-fundament.contract.test.js
// Field 17.07.: every CODE-step test died on "TIMEOUTS is not defined";
// a sandbox "Read access blocked" died with the deleted steps file.
// ============================================================
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { describe, test, run } = require('../harness');
const ROOT = path.join(__dirname, '..', '..');
const STEPS_SRC = fs.readFileSync(path.join(ROOT,'src','agent','revolution','AgentLoopStepsCode.js'),'utf-8');
const { TIMEOUTS } = require('../../src/agent/core/Constants');
const { Sandbox } = require('../../src/agent/foundation/Sandbox');
const { GoalPersistence } = require('../../src/agent/planning/GoalPersistence');
const FIELD_ERR = '[SANDBOX] Read access blocked: D:\\Genesis Home\\Genesis\\src\\agent\\core\\AgentCoreHealth.js';

describe('v7.9.40 B0 — Fundament', () => {
  test('TIMEOUTS imported + used at the execute call (field: ReferenceError on every code step)', () => {
    assert.ok(STEPS_SRC.includes("const { TIMEOUTS } = require('../core/Constants');"));
    assert.ok(STEPS_SRC.includes('timeout: TIMEOUTS.SANDBOX_EXEC, env: _codeStepSandboxEnv(loop)'));
    assert.strictEqual(TIMEOUTS.SANDBOX_EXEC, 15000);
  });
  test('allowance helper: src-only, loop-guarded, Not-Aus env switch', () => {
    assert.ok(STEPS_SRC.includes('function _codeStepSandboxEnv(loop)'));
    assert.ok(STEPS_SRC.includes("GENESIS_CODESTEP_ALLOW_SRC_READ === '0'"));
    assert.ok(STEPS_SRC.includes("join(root, 'src')"));
  });
  test('REAL sandbox: src readable WITH the allowance (self-inspection lives)', async () => {
    const sb = new Sandbox(ROOT);
    const code = [
      "const fs = require('fs');","const path = require('path');",
      "const p = path.join(process.env.GENESIS_SANDBOX_ALLOW_READ_ROOT, 'agent', 'core', 'Constants.js');",
      "console.log('READ_OK ' + fs.readFileSync(p, 'utf-8').length);"
    ].join('\n');
    const res = await sb.execute(code, { timeout: TIMEOUTS.SANDBOX_EXEC,
      env: { GENESIS_SANDBOX_ALLOW_READ_ROOT: path.join(ROOT, 'src') } });
    assert.ok(!res.error, 'no error, got: ' + res.error);
    assert.ok(String(res.output).includes('READ_OK'));
  });
  test('REAL sandbox: same read blocked WITHOUT the allowance (guard untouched)', async () => {
    const sb = new Sandbox(ROOT);
    const code = [
      "const fs = require('fs');","const path = require('path');",
      "fs.readFileSync(path.join(" + JSON.stringify(ROOT) + ", 'src', 'agent', 'core', 'Constants.js'), 'utf-8');",
      "console.log('SHOULD_NOT_REACH');"
    ].join('\n');
    const res = await sb.execute(code, { timeout: TIMEOUTS.SANDBOX_EXEC });
    const text = String(res.error || '') + ' ' + String(res.output || '');
    assert.ok(text.includes('Read access blocked'), 'got: ' + text.slice(0, 160));
    assert.ok(!text.includes('SHOULD_NOT_REACH'));
  });
  test('REAL sandbox: WRITE on src stays blocked even WITH the allowance (forever pin)', async () => {
    const sb = new Sandbox(ROOT);
    const code = [
      "const fs = require('fs');","const path = require('path');",
      "fs.writeFileSync(path.join(process.env.GENESIS_SANDBOX_ALLOW_READ_ROOT, 'agent', 'core', 'v7940-write-probe.tmp'), 'x');",
      "console.log('WRITE_SHOULD_NOT_REACH');"
    ].join('\n');
    const res = await sb.execute(code, { timeout: TIMEOUTS.SANDBOX_EXEC,
      env: { GENESIS_SANDBOX_ALLOW_READ_ROOT: path.join(ROOT, 'src') } });
    const text = String(res.error || '') + ' ' + String(res.output || '');
    assert.ok(text.includes('Write access blocked'), 'got: ' + text.slice(0, 160));
    assert.ok(!fs.existsSync(path.join(ROOT,'src','agent','core','v7940-write-probe.tmp')));
  });
  test('_archiveGoal preserves the last step error → outcome (field: abandoned with no outcome)', async () => {
    const gp = Object.create(GoalPersistence.prototype);
    const goal = { id: 'g1', status: 'active', description: 'Inspect AgentCoreHealth' };
    gp._activeGoals = [goal]; gp._archive = []; gp._stats = { goalsArchived: 0 };
    gp._stepCheckpoints = new Map([['g1', {
      partialResult: { action: 'test-code', success: false, error: FIELD_ERR },
      partialResults: [{ error: null }, { error: FIELD_ERR }],
    }]]);
    gp.storage = { writeJSON: async () => {}, delete: async () => {} };
    await gp._archiveGoal('g1', 'abandoned');
    assert.strictEqual(goal.lastError, FIELD_ERR, 'full text, uncut');
    assert.ok(goal.outcome && goal.outcome.includes('Read access blocked'), 'outcome chain: ' + goal.outcome);
    assert.ok(!gp._stepCheckpoints.has('g1'));
  });
  test('_archiveGoal leaves an explicitly set lastError untouched', async () => {
    const gp = Object.create(GoalPersistence.prototype);
    const goal = { id: 'g2', status: 'active', lastError: 'earlier, more specific error' };
    gp._activeGoals = [goal]; gp._archive = []; gp._stats = { goalsArchived: 0 };
    gp._stepCheckpoints = new Map([['g2', { partialResult: { error: 'later noise' } }]]);
    gp.storage = { writeJSON: async () => {}, delete: async () => {} };
    await gp._archiveGoal('g2', 'failed');
    assert.strictEqual(goal.lastError, 'earlier, more specific error');
  });
});
if (require.main === module) run();
