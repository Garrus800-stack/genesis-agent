'use strict';
// v7.9.22 H2 — ratchet: no test may hand an absolute temp path (/tmp or /nonexistent,
// with or without a trailing slash) to a component as a string-first constructor argument
// or as storageDir/skillsDir/_globalDir. Such paths make a component create — and leak —
// a real directory (on Windows at the drive root). Tests must use the self-cleaning
// createTestRoot() instead. This file exempts itself (it holds the patterns as literals).
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const SELF = path.basename(__filename);
let passed = 0, failed = 0;
function test(n, fn) { try { fn(); console.log('    \u2705 ' + n); passed++; } catch (e) { console.log('    \u274c ' + n + ': ' + e.message); failed++; } }

// Component-config keys; \b after the dir matches bare '/tmp' and '/tmp/...' alike.
const KEY_RE = /(?:storageDir|skillsDir|_globalDir)\s*:\s*['"]\/(?:tmp|nonexistent)\b/;
const CTOR_RE = /new\s+\w+\s*\(\s*['"]\/(?:tmp|nonexistent)\b/;

function scanModules() {
  const dir = path.join(ROOT, 'test', 'modules');
  const offenders = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.test.js') || f === SELF) continue;
    fs.readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((line, i) => {
      if (KEY_RE.test(line) || CTOR_RE.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  return offenders;
}

test('no test hands an absolute /tmp or /nonexistent path to a component', () => {
  const off = scanModules();
  if (off.length) throw new Error('offending data-directory paths found:\n      ' + off.join('\n      '));
});
test('the ratchet bites: its patterns catch a reintroduced path', () => {
  assert_(KEY_RE.test("storageDir: '/tmp/foo'"), 'storageDir /tmp');
  assert_(KEY_RE.test('_globalDir: "/nonexistent/x"'), '_globalDir /nonexistent');
  assert_(KEY_RE.test("skillsDir: '/tmp'"), 'bare /tmp');
  assert_(CTOR_RE.test("new SkillManager('/tmp/skills', null)"), 'ctor /tmp');
  assert_(!KEY_RE.test("storageDir: createTestRoot('x')"), 'createTestRoot is allowed');
  assert_(!CTOR_RE.test("new SkillManager(createTestRoot('x'), null)"), 'createTestRoot ctor allowed');
});
function assert_(cond, msg) { if (!cond) throw new Error('ratchet pattern wrong: ' + msg); }

console.log('\n    ' + passed + ' passed \u00b7 ' + failed + ' failed \u00b7 v7.9.22 H2 no-abs-tmp-paths');
process.exit(failed > 0 ? 1 : 0);
