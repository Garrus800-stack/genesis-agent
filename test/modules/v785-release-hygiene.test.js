// ============================================================
// GENESIS — test/modules/v785-release-hygiene.test.js (v7.8.5)
//
// release-hygiene contract: empty runtime-managed directories
// must be either tracked-empty (plugins/) or gitignored
// (sandbox/). Before v7.8.5 the release ZIP shipped a stray
// sandbox/ directory that the test runner had created locally.
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

const ROOT = path.join(__dirname, '..', '..');

test('release-hygiene contract: plugins/ has a .gitkeep marker with explanatory comment', () => {
  const p = path.join(ROOT, 'plugins/.gitkeep');
  assert.ok(fs.existsSync(p), 'plugins/.gitkeep must exist so the directory is tracked');
  const content = fs.readFileSync(p, 'utf-8');
  // The file is short, but must explain itself so a contributor doesn't
  // delete it thinking it's noise.
  assert.match(content, /PluginRegistry/,
    '.gitkeep must reference PluginRegistry so its purpose is discoverable');
});

test('release-hygiene contract: sandbox/ is listed in .gitignore', () => {
  const p = path.join(ROOT, '.gitignore');
  assert.ok(fs.existsSync(p), '.gitignore must exist');
  const content = fs.readFileSync(p, 'utf-8');
  assert.match(content, /^sandbox\/?\s*$/m,
    '.gitignore must contain a line for sandbox/ — runtime workspace, must not be tracked');
});

test('release-hygiene contract: CONTRIBUTING.md documents both directories', () => {
  const p = path.join(ROOT, 'CONTRIBUTING.md');
  const content = fs.readFileSync(p, 'utf-8');
  assert.match(content, /Special directories/,
    'CONTRIBUTING.md must have a "Special directories" section');
  assert.match(content, /plugins\/[\s\S]+PluginRegistry/,
    'CONTRIBUTING.md must explain plugins/ and its registry');
  assert.match(content, /sandbox\/[\s\S]+(Sandbox|Gitignored|runtime)/i,
    'CONTRIBUTING.md must explain sandbox/ as runtime/gitignored');
});

if (failed > 0) {
  console.log(`\n  ${failed} failure(s):`);
  for (const f of failures) console.log(`    - ${f.name}: ${f.error}`);
  process.exit(1);
}
console.log(`    ${passed} passed`);
