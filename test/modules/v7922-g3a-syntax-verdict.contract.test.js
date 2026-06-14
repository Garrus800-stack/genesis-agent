'use strict';
// v7.9.22 G3a — the real parser verdict reaches the prompt (PASS / skip / FAIL); a null
// verifier or a non-JS target stays unverifiable, never confirmed-OK or confirmed-broken.
const path = require('path');
const assert = require('assert');
const ROOT = path.resolve(__dirname, '..', '..');
const { checkSyntaxForPrompt } = require(path.join(ROOT, 'src/agent/revolution/AgentLoopGrounding'));
let passed = 0, failed = 0;
function test(n, fn) { try { fn(); console.log('    \u2705 ' + n); passed++; } catch (e) { console.log('    \u274c ' + n + ': ' + e.message); failed++; } }

const okV = { checkSyntax: () => ({ passed: true }) };
const skipV = { checkSyntax: () => ({ passed: true, note: 'acorn not installed' }) };
const failV = { checkSyntax: () => ({ passed: false, error: 'X', line: 7 }) };

test('PASS reaches the prompt and sets syntaxOk true', () => {
  const r = checkSyntaxForPrompt(okV, 'src/a.js', 'const x=1;');
  assert.ok(/PASS/.test(r.line)); assert.strictEqual(r.syntaxOk, true);
});
test('skip note is reported as could-not-verify, syntaxOk null', () => {
  const r = checkSyntaxForPrompt(skipV, 'src/a.js', 'const x=1;');
  assert.ok(/could not verify/i.test(r.line)); assert.strictEqual(r.syntaxOk, null);
});
test('FAIL reaches the prompt with the line and sets syntaxOk false', () => {
  const r = checkSyntaxForPrompt(failV, 'src/a.js', 'const');
  assert.ok(/FAIL at line 7/.test(r.line)); assert.strictEqual(r.syntaxOk, false);
});
test('null verifier is unverifiable', () => {
  const r = checkSyntaxForPrompt(null, 'src/a.js', 'const x=1;');
  assert.strictEqual(r.line, ''); assert.strictEqual(r.syntaxOk, null);
});
test('non-JS target is unverifiable', () => {
  const r = checkSyntaxForPrompt(okV, 'notes.md', 'x');
  assert.strictEqual(r.line, ''); assert.strictEqual(r.syntaxOk, null);
});

console.log('\n    ' + passed + ' passed \u00b7 ' + failed + ' failed \u00b7 v7.9.22 G3a syntax-verdict');
process.exit(failed > 0 ? 1 : 0);
