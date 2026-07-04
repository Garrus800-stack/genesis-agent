// ============================================================
// GENESIS — test/modules/v7928-trusted-skill-native.contract.test.js
//
// v7.9.28: built-in skills that legitimately need child_process / fs
// (git-status, system-info, code-stats, file-search) declare "sandbox": false
// in their manifest. They must run IN-PROCESS, not in the VM sandbox that
// blocks those APIs — otherwise the agent loop dead-ends with "child process
// not allowed". A GENERATED skill is never trusted, so it can never escape the
// sandbox by declaring "sandbox": false.
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { SkillManager } = require(path.join(ROOT, 'src/agent/capabilities/SkillManager'));

// A sandbox that BLOCKS everything — stands in for the VM refusing child_process.
const blockingSandbox = {
  rootDir: ROOT,
  execute: async () => ({ output: null, error: '[SANDBOX] child_process not allowed in this environment', duration: 0 }),
};

function freshManager() {
  const sm = new SkillManager(path.join(ROOT, 'src', 'skills'), blockingSandbox, null, null, null);
  sm.loadSkills();
  return sm;
}

describe('v7.9.28 trusted-skill native execution', () => {
  test('all four built-in skills load as _trusted with sandbox:false', () => {
    const sm = freshManager();
    for (const name of ['git-status', 'system-info', 'code-stats', 'file-search']) {
      const s = sm.loadedSkills.get(name);
      assert(s, `${name} is loaded`);
      assertEqual(s._trusted, true, `${name} is trusted`);
      assertEqual(s.sandbox, false, `${name} declares sandbox:false`);
    }
  });

  test('git-status runs natively (not blocked by the sandbox) and returns real data', async () => {
    const sm = freshManager();
    const r = await sm.executeSkill('git-status', {});
    assert(!/not allowed|\[SANDBOX\]/.test(String(r.error)), 'no sandbox-block error');
    const out = typeof r.output === 'string' ? r.output : JSON.stringify(r.output);
    assert(/branch|commitHash|recentCommits/.test(out), 'produced git status fields');
  });

  test('system-info runs natively', async () => {
    const sm = freshManager();
    const r = await sm.executeSkill('system-info', {});
    assert(!/not allowed|\[SANDBOX\]/.test(String(r.error)), 'no sandbox-block error');
  });

  test('SECURITY: an untrusted skill declaring sandbox:false is STILL sandboxed', async () => {
    const sm = freshManager();
    // Simulate a generated/Können skill that lies about being sandbox-free.
    sm.loadedSkills.set('evil', { name: 'evil', sandbox: false, _trusted: false, dir: path.join(ROOT, 'no-such-dir'), entry: 'index.js' });
    let sawSandbox = false;
    try {
      const r = await sm.executeSkill('evil', {});
      sawSandbox = /not allowed|\[SANDBOX\]/.test(String(r.error));
    } catch (e) {
      // Reaching the sandbox path fails on the missing entry file — that is
      // also proof it did NOT run natively.
      sawSandbox = /entry|not found|ENOENT/i.test(e.message);
    }
    assert(sawSandbox, 'untrusted sandbox:false did not run in-process');
  });
});

run();
