'use strict';
// v7.9.22 G2 — a goal is complete only on positive evidence: gate 1 needs a real
// programmatic pass (not just a verdict object), and the heuristic gate applies only
// when there is no verification data at all, so an all-ambiguous goal drops to the LLM judge.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const ROOT = path.resolve(__dirname, '..', '..');
const src = fs.readFileSync(path.join(ROOT, 'src/agent/revolution/AgentLoopRecovery.js'), 'utf8');
let passed = 0, failed = 0;
function test(n, fn) { try { fn(); console.log('    \u2705 ' + n); passed++; } catch (e) { console.log('    \u274c ' + n + ': ' + e.message); failed++; } }

test('gate 1 requires a real programmatic pass, not just a verdict object', () => {
  assert.ok(/programmaticPasses > 0 && programmaticFails === 0 && successRate >= THRESHOLDS\.GOAL_SUCCESS_PROGRAMMATIC/.test(src));
  assert.ok(!/verified\.length > 0 && programmaticFails === 0 && successRate >= THRESHOLDS\.GOAL_SUCCESS_PROGRAMMATIC/.test(src), 'gate 1 must no longer fire on verified.length > 0');
});
test('gate 2 (heuristic) applies only when there is no verification data', () => {
  assert.ok(/verified\.length === 0 && successRate >= THRESHOLDS\.GOAL_SUCCESS_HEURISTIC && programmaticFails === 0/.test(src));
});

console.log('\n    ' + passed + ' passed \u00b7 ' + failed + ' failed \u00b7 v7.9.22 G2 positive-evidence');
process.exit(failed > 0 ? 1 : 0);
