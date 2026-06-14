'use strict';
// v7.9.22 G3b — the stored analysis node separates the acorn verdict (a verified fact)
// from the model prose (an unverified opinion), so a confabulated defect is never written
// as an established one.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const ROOT = path.resolve(__dirname, '..', '..');
const src = fs.readFileSync(path.join(ROOT, 'src/agent/revolution/AgentLoopSteps.js'), 'utf8');
let passed = 0, failed = 0;
function test(n, fn) { try { fn(); console.log('    \u2705 ' + n); passed++; } catch (e) { console.log('    \u274c ' + n + ': ' + e.message); failed++; } }

test('the analysis node carries the acorn verdict as syntaxOk', () => {
  assert.ok(/syntaxOk: syntax\.syntaxOk/.test(src));
});
test('the model prose is marked an unverified opinion (verified: false)', () => {
  assert.ok(/verified: false/.test(src));
});

console.log('\n    ' + passed + ' passed \u00b7 ' + failed + ' failed \u00b7 v7.9.22 G3b verified-fact');
process.exit(failed > 0 ? 1 : 0);
