#!/usr/bin/env node
// ============================================================
// GENESIS — test/modules/v7919-syntaxcheck-module-wrapper.test.js
//
// v7.9.19 Strang D — the self-repair loop must not misjudge valid
// modules as broken. Field bug (2026-05-31): the AutonomousDaemon
// reported "1 actionable issue, 0 fixed" every health cycle and
// eventually "1 fixed" — it had flagged test/modules/e2e-electron.test.js
// (a valid CommonJS module with a top-level `return` skip-guard) as a
// syntax error and rewrote a perfectly valid file to satisfy a bogus
// check. Root cause: Sandbox.syntaxCheck parsed with raw `new vm.Script()`
// (script mode), under which a top-level `return` is an "Illegal return
// statement" and an ES module's `import` is unparseable.
//
// Fix:
//   1. Sandbox.syntaxCheck wraps code in the CommonJS module wrapper
//      before parsing — exactly as Node's loader does. Top-level `return`
//      becomes legal; a genuine syntax error still throws inside the
//      wrapper, so real detection is unchanged.
//   2. Reflector.diagnose skips .mjs (ESM) files, which the CJS check
//      cannot parse and would misreport.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');
const { Sandbox } = require(path.join(ROOT, 'src/agent/foundation/Sandbox'));
const { Reflector } = require(path.join(ROOT, 'src/agent/planning/Reflector'));

// Code that is VALID as a Node module but illegal as a raw script.
const TOP_LEVEL_RETURN =
  'const ready = false;\nif (!ready) { console.log("skip"); return; }\nmodule.exports = { run() {} };';
const GENUINE_ERROR = 'const x = {{{;';
const NORMAL_OK = 'const a = 1 + 2;\nfunction f() { return a; }\nmodule.exports = { f };';
const ESM_SOURCE = 'import { strict as assert } from "node:assert";\nexport const value = 42;\nassert.ok(value);';

// ── 1. Sandbox.syntaxCheck — the wrapper fix (real child process) ──
describe('v7.9.19 Strang D — Sandbox.syntaxCheck parses in the CJS module wrapper', () => {
  const sb = new Sandbox(path.join(os.tmpdir(), 'genesis-syntax-wrap-test'));

  test('a top-level return (valid module, illegal raw script) is VALID', async () => {
    const r = await sb.syntaxCheck(TOP_LEVEL_RETURN);
    assertEqual(r.valid, true, 'top-level return must pass once wrapped like Node loads it');
  });

  test('a genuine syntax error is STILL invalid (no false negative)', async () => {
    const r = await sb.syntaxCheck(GENUINE_ERROR);
    assertEqual(r.valid, false, 'real syntax error must still be caught inside the wrapper');
    assert(typeof r.error === 'string' && r.error.length > 0, 'an error message is reported');
  });

  test('ordinary valid code stays valid', async () => {
    const r = await sb.syntaxCheck(NORMAL_OK);
    assertEqual(r.valid, true, 'normal module code is valid');
  });

  test('empty code stays valid (regression with sandbox.test.js)', async () => {
    const r = await sb.syntaxCheck('');
    assertEqual(r.valid, true, 'empty body is a valid wrapped function');
  });

  test('a leading shebang is VALID (stripped before wrapping, as Node does)', async () => {
    const r = await sb.syntaxCheck('#!/usr/bin/env node\n' + TOP_LEVEL_RETURN);
    assertEqual(r.valid, true, 'a line-1 shebang must not break the check once stripped — wrapping it unstripped put it illegally on line 2');
  });

  test('a real repo file that carries a shebang is VALID', async () => {
    const real = fs.readFileSync(path.join(ROOT, 'test/modules/sandbox.test.js'), 'utf8');
    const r = await sb.syntaxCheck(real);
    assertEqual(r.valid, true, 'a real shebang-prefixed module must pass — the unstripped wrapper flagged 153 of these in the field');
  });
});

// ── 2. Reflector.diagnose — end-to-end over a temp module set ──
describe('v7.9.19 Strang D — Reflector no longer false-flags valid modules', () => {
  async function withTempModules(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-reflector-'));
    try {
      fs.writeFileSync(path.join(dir, 'with_return.js'), TOP_LEVEL_RETURN, 'utf8');
      fs.writeFileSync(path.join(dir, 'an_esm.mjs'), ESM_SOURCE, 'utf8');
      fs.writeFileSync(path.join(dir, 'really_broken.js'), GENUINE_ERROR, 'utf8');
      fs.writeFileSync(path.join(dir, 'cli_with_shebang.js'), '#!/usr/bin/env node\n' + TOP_LEVEL_RETURN, 'utf8');
      return await fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  function makeReflector(dir) {
    const selfModel = {
      rootDir: dir,
      getFullModel: () => ({
        modules: {
          'with_return.js': { requires: [] },
          'an_esm.mjs': { requires: [] },
          'really_broken.js': { requires: [] },
          'cli_with_shebang.js': { requires: [] },
        },
      }),
    };
    const guard = {
      isProtected: () => false,
      verifyIntegrity: () => ({ ok: true, issues: [] }),
      validateWrite: () => true,
    };
    const sandbox = new Sandbox(dir);
    return new Reflector(selfModel, /*model*/ null, /*prompts*/ null, sandbox, guard);
  }

  test('a valid module with a top-level return is NOT flagged as syntax', async () => {
    await withTempModules(async (dir) => {
      const { issues } = await makeReflector(dir).diagnose();
      const flagged = issues.filter(i => i.type === 'syntax').map(i => i.file);
      assert(!flagged.includes('with_return.js'), `with_return.js wrongly flagged: ${JSON.stringify(flagged)}`);
    });
  });

  test('an ES module (.mjs) is skipped, not flagged as syntax', async () => {
    await withTempModules(async (dir) => {
      const { issues } = await makeReflector(dir).diagnose();
      const flagged = issues.filter(i => i.type === 'syntax').map(i => i.file);
      assert(!flagged.includes('an_esm.mjs'), `an_esm.mjs wrongly flagged: ${JSON.stringify(flagged)}`);
    });
  });

  test('a module with a leading shebang is NOT flagged as syntax', async () => {
    await withTempModules(async (dir) => {
      const { issues } = await makeReflector(dir).diagnose();
      const flagged = issues.filter(i => i.type === 'syntax').map(i => i.file);
      assert(!flagged.includes('cli_with_shebang.js'), `cli_with_shebang.js wrongly flagged: ${JSON.stringify(flagged)}`);
    });
  });

  test('a genuinely broken module IS still flagged as syntax', async () => {
    await withTempModules(async (dir) => {
      const { issues } = await makeReflector(dir).diagnose();
      const flagged = issues.filter(i => i.type === 'syntax').map(i => i.file);
      assert(flagged.includes('really_broken.js'), `really_broken.js should be flagged, got: ${JSON.stringify(flagged)}`);
    });
  });
});

if (require.main === module) run();
