// ============================================================
// v7.9.27 — sandbox temp-file races (syntaxCheck + testPatch).
//
// syntaxCheck wrote every check to one fixed temp file, and testPatch
// wrote every patch to a file named only after the original basename
// (always "index.js" for skills/plugins). Several subsystems run these
// concurrently on the shared singleton sandbox, so one caller's cleanup
// deleted another's file mid-run — a clean file reported as
// MODULE_NOT_FOUND, and reused names returned a stale cached module.
// Each call now writes a uniquely named temp file; the patch test loads
// by absolute path, so the name is free.
// ============================================================

'use strict';

const path = require('path');
const { describe, test, run, assert, createTestRoot } = require('../harness');

const ROOT = path.join(__dirname, '../..');
const { Sandbox } = require(path.join(ROOT, 'src/agent/foundation/Sandbox'));

describe('v7.9.27 — sandbox temp-file races', () => {
  test('concurrent syntaxCheck calls all pass on valid code', async () => {
    const sb = new Sandbox(createTestRoot('sbx-syntax-ok'));
    const code = 'module.exports = { x: 1 };';
    const results = await Promise.all(
      Array.from({ length: 6 }, () => sb.syntaxCheck(code)),
    );
    for (const r of results) assert(r.valid, `valid code must pass (${r.error || ''})`);
  });

  test('a real syntax error is still caught under concurrency', async () => {
    const sb = new Sandbox(createTestRoot('sbx-syntax-bad'));
    const good = 'module.exports = { ok: true };';
    const bad = 'function ( { return';
    const [g, b] = await Promise.all([sb.syntaxCheck(good), sb.syntaxCheck(bad)]);
    assert(g.valid, 'valid code passes');
    assert(!b.valid, 'broken code fails');
  });

  test('concurrent testPatch calls (all basename index.js) all succeed', async () => {
    const sb = new Sandbox(createTestRoot('sbx-patch'));
    const code = 'class Foo { run() { return 1; } }\nmodule.exports = { Foo };';
    const results = await Promise.all([
      sb.testPatch('skills/a/index.js', code),
      sb.testPatch('plugins/b/index.js', code),
      sb.testPatch('skills/c/index.js', code),
    ]);
    for (const r of results) {
      assert(r.success, `patch must succeed (phase=${r.phase}, err=${r.error || ''})`);
    }
  });

  test('temp files are uniquely named per call', async () => {
    const fs = require('fs');
    const sb = new Sandbox(createTestRoot('sbx-unique'));
    const seen = new Set();
    const realWrite = fs.writeFileSync;
    fs.writeFileSync = (file, ...rest) => {
      if (typeof file === 'string' && /_syntax_check_|_testpatch_/.test(file)) {
        assert(!seen.has(file), `temp name reused: ${file}`);
        seen.add(file);
      }
      return realWrite(file, ...rest);
    };
    try {
      await Promise.all([
        sb.syntaxCheck('module.exports = { a: 1 };'),
        sb.syntaxCheck('module.exports = { b: 2 };'),
      ]);
    } finally {
      fs.writeFileSync = realWrite;
    }
    assert(seen.size >= 2, 'each concurrent check wrote a distinct temp file');
  });
});

if (require.main === module) run();
