'use strict';
// v7.9.22 Item 1 — a glob ANALYZE target is not turned into a file: existence
// requirement (so an idle-mind goal does not stall on a glob), and GoalStack has the
// by-id accessor the idle-mind hatch and GoalDriver primary path call.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const ROOT = path.resolve(__dirname, '..', '..');
const { getStepRequirements } = require(path.join(ROOT, 'src/agent/core/step-types'));
let passed = 0, failed = 0;
function test(n, fn) { try { fn(); console.log('    \u2705 ' + n); passed++; } catch (e) { console.log('    \u274c ' + n + ': ' + e.message); failed++; } }

test('a glob target produces no file: requirement', () => {
  const reqs = getStepRequirements('ANALYZE', { target: 'src/agent/autonomy/activities/*.js' });
  assert.ok(!reqs.some(r => String(r).startsWith('file:')), 'glob must not become a file requirement');
});
test('a real file target still produces its file: requirement', () => {
  const reqs = getStepRequirements('ANALYZE', { target: 'src/agent/foo.js' });
  assert.ok(reqs.includes('file:src/agent/foo.js'), 'a concrete file still requires existence');
});
test('GoalStack exposes getById returning the goal by id (or null)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/planning/GoalStack.js'), 'utf8');
  assert.ok(/getById\(id\)\s*\{\s*return this\.goals\.find\(g => g\.id === id\) \|\| null;/.test(src));
});

console.log('\n    ' + passed + ' passed \u00b7 ' + failed + ' failed \u00b7 v7.9.22 Item 1 glob+getById');
process.exit(failed > 0 ? 1 : 0);
