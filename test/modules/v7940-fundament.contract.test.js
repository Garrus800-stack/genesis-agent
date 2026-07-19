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
  // v7.9.41 (F3) supersedes the .40 checkpoint pull: checkpoints only ever
  // existed for SUCCESSFUL steps (field proof 18.07.), so the archive-side
  // pull was structurally empty and has been removed. lastError is now set
  // at the pursuit STEP-DIAG site; the archive outcome chain picks it up.
  test('_archiveGoal carries pursuit-set lastError into outcome (v7.9.41 contract)', async () => {
    const gp = Object.create(GoalPersistence.prototype);
    const goal = { id: 'g1', status: 'active', description: 'Inspect AgentCoreHealth', lastError: FIELD_ERR };
    gp._activeGoals = [goal]; gp._archive = []; gp._stats = { goalsArchived: 0 };
    gp._stepCheckpoints = new Map();
    gp.storage = { writeJSON: async () => {}, delete: async () => {} };
    await gp._archiveGoal('g1', 'abandoned');
    assert.ok(goal.outcome && goal.outcome.includes('Read access blocked'), 'outcome chain: ' + goal.outcome);
  });
  test('the dead .40 archive-side checkpoint pull stays removed (source pin)', () => {
    const t = fs.readFileSync(path.join(ROOT, 'src', 'agent', 'planning', 'GoalPersistence.js'), 'utf-8');
    assert.ok(!t.includes('v7.9.40 (B0): preserve'), 'superseded by v7.9.41 F3 at the pursuit site');
  });
});
if (require.main === module) run();
