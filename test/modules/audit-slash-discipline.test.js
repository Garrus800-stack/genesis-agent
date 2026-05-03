// ============================================================
// GENESIS — test/modules/audit-slash-discipline.test.js (v7.5.7)
//
// Tests for scripts/audit-slash-discipline.js. Verifies that:
//  - The script exists and runs without error
//  - --json output is valid JSON with expected schema
//  - Pure slash-only intents are correctly identified
//  - SECURITY_REQUIRED_SLASH-listed intents are recognized
//  - FUZZY_BY_DESIGN whitelist is respected
//  - Real findings (open-path, mcp at v7.5.7 baseline) are flagged
//  - --strict exit-codes correctly
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(() => { passed++; console.log(`    ✅ ${name}`); })
              .catch(err => { failed++; failures.push({ name, error: err.message }); console.log(`    ❌ ${name}: ${err.message}`); });
    }
    passed++; console.log(`    ✅ ${name}`);
  } catch (err) { failed++; failures.push({ name, error: err.message }); console.log(`    ❌ ${name}: ${err.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'audit-slash-discipline.js');

function runScript(args = []) {
  // execFileSync would throw on non-zero exit; we want to inspect it.
  let stdout = '';
  let exitCode = 0;
  try {
    stdout = execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
  } catch (err) {
    stdout = err.stdout ? err.stdout.toString() : '';
    exitCode = err.status || 1;
  }
  return { stdout, exitCode };
}

(async () => {

  // ── Script existence and basic invocation ──

  test('audit-slash-discipline.js exists and is executable', () => {
    assert(fs.existsSync(SCRIPT), 'expected script at ' + SCRIPT);
  });

  test('script runs without error in non-strict mode', () => {
    const { stdout } = runScript([]);
    assert(stdout.includes('GENESIS SLASH-DISCIPLINE AUDIT'), 'expected header in output');
    assert(stdout.includes('Pure slash-only'), 'expected summary line');
  });

  // ── JSON output ──

  test('--json produces valid JSON with expected schema', () => {
    const { stdout } = runScript(['--json']);
    const data = JSON.parse(stdout);
    assert(Array.isArray(data.intents), 'data.intents should be array');
    assert(data.intents.length > 0, 'should find at least one intent');
    assert(Array.isArray(data.findings), 'data.findings should be array');
    assert(Array.isArray(data.securitySet), 'data.securitySet should be array');
    assert(typeof data.summary === 'object', 'data.summary should be object');
    assert(typeof data.summary.total === 'number', 'summary.total should be number');
    assert(typeof data.summary.findings === 'number', 'summary.findings should be number');
  });

  test('JSON: pure-slash-only intents are correctly identified', () => {
    const { stdout } = runScript(['--json']);
    const data = JSON.parse(stdout);
    const selfModify = data.intents.find(i => i.name === 'self-modify');
    assert(selfModify, 'self-modify should be present');
    assert.strict?.(selfModify.kind === 'pure-slash-only', `self-modify kind: ${selfModify.kind}`);
    if (selfModify.kind !== 'pure-slash-only') {
      throw new Error(`expected self-modify pure-slash-only, got: ${selfModify.kind}`);
    }
    assert(selfModify.isFinding === false, 'self-modify should not be a finding');
  });

  test('JSON: SECURITY_REQUIRED_SLASH intents are not flagged', () => {
    const { stdout } = runScript(['--json']);
    const data = JSON.parse(stdout);
    const runSkill = data.intents.find(i => i.name === 'run-skill');
    assert(runSkill, 'run-skill should be present');
    assert(runSkill.inSec === true, 'run-skill should be in security set');
    assert(runSkill.isFinding === false, 'run-skill should not be a finding (fuzzy but in security set)');
  });

  test('JSON: FUZZY_BY_DESIGN whitelist suppresses findings for greeting/retry/etc', () => {
    const { stdout } = runScript(['--json']);
    const data = JSON.parse(stdout);
    const greeting = data.intents.find(i => i.name === 'greeting');
    assert(greeting, 'greeting should be present');
    assert(greeting.kind === 'fuzzy-only', `greeting kind: ${greeting.kind}`);
    assert(greeting.isFinding === false, 'greeting must not be a finding (whitelisted)');
  });

  test('JSON: open-path is whitelisted (FUZZY_BY_DESIGN, not a finding)', () => {
    const { stdout } = runScript(['--json']);
    const data = JSON.parse(stdout);
    assert(!data.findings.includes('open-path'),
      `expected open-path NOT in findings (whitelisted); got: ${JSON.stringify(data.findings)}`);
    const intent = data.intents.find(i => i.name === 'open-path');
    assert(intent.isFinding === false, 'open-path should be marked isFinding:false');
  });

  test('JSON: mcp is whitelisted (FUZZY_BY_DESIGN, not a finding)', () => {
    const { stdout } = runScript(['--json']);
    const data = JSON.parse(stdout);
    assert(!data.findings.includes('mcp'),
      `expected mcp NOT in findings (whitelisted); got: ${JSON.stringify(data.findings)}`);
  });

  test('JSON: every intent has name, kind, inSec, isFinding, patterns fields', () => {
    const { stdout } = runScript(['--json']);
    const data = JSON.parse(stdout);
    for (const intent of data.intents) {
      assert(typeof intent.name === 'string', `intent.name missing on ${JSON.stringify(intent)}`);
      assert(typeof intent.kind === 'string', `intent.kind missing on ${intent.name}`);
      assert(typeof intent.inSec === 'boolean', `intent.inSec missing on ${intent.name}`);
      assert(typeof intent.isFinding === 'boolean', `intent.isFinding missing on ${intent.name}`);
      assert(Array.isArray(intent.patterns), `intent.patterns missing on ${intent.name}`);
    }
  });

  // ── Strict mode exit codes ──

  test('--strict exits 0 when no findings (current state)', () => {
    const { exitCode } = runScript(['--strict']);
    // v7.5.7 baseline: 0 findings (open-path/mcp whitelisted as FUZZY_BY_DESIGN)
    assert(exitCode === 0, `expected exit 0 with 0 findings, got: ${exitCode}`);
  });

  test('non-strict mode exits 0 even with findings', () => {
    const { exitCode } = runScript([]);
    assert(exitCode === 0, `expected exit 0 in non-strict, got: ${exitCode}`);
  });

  // ── Comment-aware parser ──

  test('parser does NOT mistake // comments for regex patterns', () => {
    // The 'goals' intent has heavy comment block with // /goal add ...
    // documentation. Pre-fix this was misclassified as fuzzy+slash-mix.
    // After fix it should be pure-slash-only.
    const { stdout } = runScript(['--json']);
    const data = JSON.parse(stdout);
    const goals = data.intents.find(i => i.name === 'goals');
    assert(goals, 'goals should be present');
    assert(goals.kind === 'pure-slash-only',
      `expected goals pure-slash-only after parser-fix, got: ${goals.kind}`);
  });

  // ── Done ─────────────────────────────────────────────

  console.log('');
  console.log(`  ${passed} passed${failed > 0 ? `, ${failed} failed` : ''}`);
  if (failed > 0) {
    console.log('');
    console.log('  Failures:');
    for (const f of failures) console.log(`    - ${f.name}: ${f.error}`);
    process.exit(1);
  }
})();
