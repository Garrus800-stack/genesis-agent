'use strict';
// v7.9.22 G1 — a module is sent in full under a generous budget; an over-budget input
// is cut with an explicit marker so a cut is never read as the end of the file.
const path = require('path');
const assert = require('assert');
const ROOT = path.resolve(__dirname, '..', '..');
const { sourceForPrompt } = require(path.join(ROOT, 'src/agent/revolution/AgentLoopGrounding'));
let passed = 0, failed = 0;
function test(n, fn) { try { fn(); console.log('    \u2705 ' + n); passed++; } catch (e) { console.log('    \u274c ' + n + ': ' + e.message); failed++; } }

test('content within budget is sent in full', () => {
  const c = 'x'.repeat(5000);
  assert.strictEqual(sourceForPrompt(c, 24000), c);
});
test('a 13KB module (past the old 3000 cap) is still sent in full', () => {
  const c = 'a'.repeat(13000);
  assert.strictEqual(sourceForPrompt(c, 24000), c);
});
test('over-budget input shows the explicit truncation marker with the right count', () => {
  const out = sourceForPrompt('b'.repeat(30000), 24000);
  assert.ok(out.startsWith('b'.repeat(24000)), 'keeps the budget prefix');
  assert.ok(out.includes('[truncated: 6000 more characters not shown]'), 'marks the cut explicitly');
});

console.log('\n    ' + passed + ' passed \u00b7 ' + failed + ' failed \u00b7 v7.9.22 G1 source-budget');
process.exit(failed > 0 ? 1 : 0);
