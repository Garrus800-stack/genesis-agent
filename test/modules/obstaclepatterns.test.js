// Test: ObstaclePatterns.js — v7.4.5 Baustein D
const { matchObstacle, buildContextPath, BLOCKLIST } = require('../../src/agent/intelligence/ObstaclePatterns');

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`    ✅ ${name}`); }
  catch (err) { failed++; failures.push({ name, error: err.message }); console.log(`    ❌ ${name}: ${err.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }

test('matches Cannot find module pattern (Node.js)', () => {
  const r = matchObstacle("Error: Cannot find module 'lodash'");
  assert(r, 'should match');
  assert(r.type === 'module-not-found', `wrong type: ${r.type}`);
  assert(r.module === 'lodash', `wrong module: ${r.module}`);
  assert(r.contextKey === 'module:lodash', `wrong contextKey: ${r.contextKey}`);
  assert(r.subGoalDescription.includes('lodash'), 'description missing module name');
});

test('matches Webpack Module not found pattern', () => {
  const r = matchObstacle("Module not found: Can't resolve './missing'");
  assert(r, 'should match');
  assert(r.type === 'module-not-found');
  assert(r.module === './missing');
});

test('matches Python ModuleNotFoundError', () => {
  const r = matchObstacle("ModuleNotFoundError: No module named 'numpy'");
  assert(r, 'should match');
  assert(r.type === 'python-package-missing');
  assert(r.module === 'numpy');
  assert(r.contextKey === 'pip:numpy');
});

test('matches Unix command not found', () => {
  const r = matchObstacle("bash: jq: command not found");
  assert(r, 'should match');
  assert(r.type === 'command-not-found');
  assert(r.command === 'jq');
});

test('matches Windows command not found', () => {
  const r = matchObstacle("'jq' is not recognized as an internal or external command");
  assert(r, 'should match');
  assert(r.type === 'command-not-found');
  assert(r.command === 'jq');
});

test('returns null for unmatched errors', () => {
  assert(matchObstacle('TypeError: foo.bar is not a function') === null);
  assert(matchObstacle('') === null);
  assert(matchObstacle(null) === null);
});

test('blocklist refuses dangerous targets', () => {
  // sudo is in BLOCKLIST
  assert(BLOCKLIST.has('sudo'));
  const r = matchObstacle('bash: sudo: command not found');
  assert(r === null, 'should refuse sudo');
});

test('blocklist refuses rm', () => {
  const r = matchObstacle('bash: rm: command not found');
  assert(r === null);
});

test('buildContextPath produces stable identifier', () => {
  const path = buildContextPath('g_abc', 5, 'module:lodash');
  assert(path === 'g_abc/5/module:lodash', `wrong: ${path}`);
});

test('different goals → different contextPaths (loop-protect discrimination)', () => {
  const a = buildContextPath('g_a', 3, 'module:foo');
  const b = buildContextPath('g_b', 3, 'module:foo');
  assert(a !== b, 'should differ for different parents');
});

console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\n  Failures:');
  for (const f of failures) console.log(`    - ${f.name}: ${f.error}`);
  process.exit(1);
}
