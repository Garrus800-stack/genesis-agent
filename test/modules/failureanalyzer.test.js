// ============================================================
// Test: FailureAnalyzer.js — CI log parsing, classification, repair
// ============================================================
let passed = 0, failed = 0;
const _testQueue = [];
function test(name, fn) { _testQueue.push({ name, fn }); }
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }

const { FailureAnalyzer } = require('../../src/agent/revolution/FailureAnalyzer');

console.log('\n  🧠 FailureAnalyzer (Cognitive CI)');

const fa = new FailureAnalyzer();

// ── Parsing ──

test('parses ❌ test failure lines', () => {
  const log = '    ❌ should block writes: Write outside root blocked';
  const report = fa.analyze(log);
  assert(report.totalFailures === 1, `Expected 1, got ${report.totalFailures}`);
  assert(report.failures[0].name === 'should block writes');
});

test('parses multiple failures', () => {
  const log = `
    ✅ test A
    ❌ test B: error one
    ✅ test C
    ❌ test D: error two
  `;
  const report = fa.analyze(log);
  assert(report.totalFailures === 2);
});

test('parses Node.js errors', () => {
  const log = `TypeError: Cannot read properties of undefined (reading 'map')
    at Object.fn (/test/run.js:42:10)`;
  const report = fa.analyze(log);
  assert(report.totalFailures >= 1);
  assert(report.failures[0].errorType === 'TypeError');
});

test('parses SyntaxError', () => {
  const log = 'SyntaxError: Unexpected token }';
  const report = fa.analyze(log);
  assert(report.totalFailures >= 1);
});

test('parses npm errors', () => {
  const log = 'npm ERR! Missing: express@4.18.0';
  const report = fa.analyze(log);
  assert(report.totalFailures >= 1);
  assert(report.failures[0].type === 'npm');
});

test('handles empty log', () => {
  const report = fa.analyze('');
  assert(report.totalFailures === 0);
});

test('handles all-passing log', () => {
  const report = fa.analyze('    ✅ test A\n    ✅ test B');
  assert(report.totalFailures === 0);
});

// ── Classification ──

test('classifies /tmp/ path as CROSS_PLATFORM', () => {
  const log = "    ❌ sandbox test: ENOENT: no such file or directory '/tmp/test'";
  const report = fa.analyze(log);
  assert(report.failures[0].category === 'CROSS_PLATFORM',
    `Expected CROSS_PLATFORM, got ${report.failures[0].category}`);
});

test('classifies /etc/passwd as CROSS_PLATFORM', () => {
  const log = "    ❌ block writes: Write to /etc/passwd blocked";
  const report = fa.analyze(log);
  assert(report.failures[0].category === 'CROSS_PLATFORM');
});

test('classifies unhandled promise as ASYNC_TIMING', () => {
  const log = "    ❌ async test: unhandled promise rejection";
  const report = fa.analyze(log);
  assert(report.failures[0].category === 'ASYNC_TIMING');
});

test('classifies timeout as ASYNC_TIMING', () => {
  const log = "    ❌ long test: operation timed out";
  const report = fa.analyze(log);
  assert(report.failures[0].category === 'ASYNC_TIMING' || report.failures[0].category === 'TIMEOUT');
});

test('classifies Cannot find module as DEPENDENCY or IMPORT', () => {
  const log = "Error: Cannot find module 'nonexistent-package'";
  const report = fa.analyze(log);
  const cat = report.failures[0].category;
  assert(cat === 'DEPENDENCY' || cat === 'IMPORT', `Expected DEPENDENCY/IMPORT, got ${cat}`);
});

test('classifies diagnostics_channel as ENVIRONMENT', () => {
  const log = "TypeError: diagnostics_channel TracingChannel failed";
  const report = fa.analyze(log, { nodeVersion: 22 });
  assert(report.failures[0].category === 'ENVIRONMENT');
});

test('classifies assertion failure', () => {
  const log = '    ❌ value check: Expected "hello", got "world"';
  const report = fa.analyze(log);
  assert(report.failures[0].category === 'ASSERTION');
});

test('classifies parse error as SYNTAX', () => {
  const log = 'PARSE ERROR: src/test.js Unexpected token (42:5)';
  const report = fa.analyze(log);
  assert(report.failures[0].category === 'SYNTAX');
});

// ── Strategy Generation ──

test('generates REPLACE_PATH for /tmp/ failures', () => {
  const log = "    ❌ test: ENOENT /tmp/genesis-test";
  const report = fa.analyze(log);
  assert(report.strategies[0].action === 'REPLACE_PATH');
  assert(report.strategies[0].confidence >= 0.9);
  assert(report.strategies[0].effort === 'minutes');
});

test('generates NODE_COMPAT_FIX for diagnostics_channel', () => {
  const log = "TypeError: diagnostics_channel TracingChannel broken";
  const report = fa.analyze(log, { nodeVersion: 22 });
  assert(report.strategies[0].action === 'NODE_COMPAT_FIX');
  assert(report.strategies[0].confidence >= 0.9);
});

test('generates INSTALL_MODULE for missing dep', () => {
  const log = "Error: Cannot find module 'lodash'";
  const report = fa.analyze(log);
  assert(report.strategies[0].action === 'INSTALL_MODULE');
  assert(report.strategies[0].suggestedFix.includes('npm install'));
});

test('marks high-confidence fixes as autoFixable', () => {
  const log = "    ❌ test: ENOENT /tmp/genesis-test";
  const report = fa.analyze(log);
  assert(report.autoFixable >= 1);
});

// ── Repair Plan ──

test('generates prioritized repair plan', () => {
  const log = `
    ❌ path test: ENOENT /tmp/test
    ❌ module test: Expected "a", got "b"
    ❌ env test: diagnostics_channel error
  `;
  const report = fa.analyze(log, { nodeVersion: 22 });
  const plan = fa.generateRepairPlan(report);
  assert(plan.totalSteps >= 2, `Expected >= 2 steps, got ${plan.totalSteps}`);
  // HIGH priority items should come first
  if (plan.steps.length >= 2) {
    assert(plan.steps[0].priority === 'HIGH' || plan.steps[0].priority === 'MEDIUM');
  }
});

test('repair plan sorts by priority', () => {
  const log = `
    ❌ low: Expected "a", got "b"
    ❌ high: ENOENT /tmp/test
  `;
  const report = fa.analyze(log);
  const plan = fa.generateRepairPlan(report);
  // The /tmp/ fix (high confidence) should come before assertion (low confidence)
  const priorities = plan.steps.map(s => s.priority);
  const highIdx = priorities.indexOf('HIGH');
  const lowIdx = priorities.indexOf('LOW');
  if (highIdx !== -1 && lowIdx !== -1) {
    assert(highIdx < lowIdx, 'HIGH priority should come before LOW');
  }
});

// ── Stats & Learning ──

test('tracks analysis count', () => {
  const fa2 = new FailureAnalyzer();
  fa2.analyze('    ❌ test: error');
  fa2.analyze('    ❌ test: error');
  assert(fa2.getStats().analysisCount === 2);
});

test('tracks repairs generated', () => {
  const fa2 = new FailureAnalyzer();
  const report = fa2.analyze('    ❌ test: ENOENT /tmp/test');
  fa2.generateRepairPlan(report);
  assert(fa2.getStats().repairsGenerated === 1);
});

test('reports pattern count', () => {
  assert(fa.getStats().patternCount > 5);
});

// ── Real-World Scenario: Genesis v3.5.0 CI Failure ──

test('handles real Genesis CI failure log', () => {
  const realLog = `
╔═══════════════════════════════════════╗
║     GENESIS AGENT — Test Suite        ║
╚═══════════════════════════════════════╝

  📦 SafeGuard
    ✅ should detect protected paths
    ✅ should block writes to kernel

  📦 Sandbox
    ❌ should execute simple code: Should capture console output
    ❌ should capture errors safely: Should include error message

  📦 Sandbox v2 (Security)
    ❌ should block dangerous modules: Should block child_process: node:diagnostics_channel:328
    ❌ should block filesystem writes outside sandbox: Should block writes outside sandbox: node:diagnostics_channel:328

  Results: 120 passed, 4 failed
  `;

  const report = fa.analyze(realLog, { os: 'ubuntu-latest', nodeVersion: 22 });
  assert(report.totalFailures === 4, `Expected 4 failures, got ${report.totalFailures}`);

  // Should detect at least one ENVIRONMENT (diagnostics_channel) failure
  const envFailures = report.failures.filter(f => f.category === 'ENVIRONMENT');
  assert(envFailures.length >= 1, `Expected >= 1 ENVIRONMENT, got ${envFailures.length}`);

  const plan = fa.generateRepairPlan(report);
  assert(plan.totalSteps >= 2);
  assert(plan.autoFixable >= 1, 'Should have auto-fixable steps');
});

// ── Async-safe runner ──
(async () => {
  for (const t of _testQueue) {
    try {
      const r = t.fn(); if (r && r.then) await r;
      passed++; console.log(`    ✅ ${t.name}`);
    } catch (err) {
      failed++; console.log(`    ❌ ${t.name}: ${err.message}`);
    }
  }
  console.log(`\n    ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
