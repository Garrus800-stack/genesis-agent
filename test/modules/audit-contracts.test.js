// ============================================================
// GENESIS — test/modules/audit-contracts.test.js (v7.5.7)
//
// Tests for scripts/audit-contracts.js. Verifies the contract-candidate
// discovery script: it scans security-relevant test files, lists tests
// that look like security-guards but are NOT yet protected by a known
// contract prefix from stale-refs.json.
//
// Tests cover:
//  - Script exists and runs
//  - --json output schema
//  - Existing contract-marked tests are NOT listed as candidates
//  - Tests in non-security files are NOT listed
//  - Tests with non-security names are NOT listed
//  - --strict exit-codes
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

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'audit-contracts.js');

function runScript(args = []) {
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

  test('audit-contracts.js exists', () => {
    assert(fs.existsSync(SCRIPT), 'expected script at ' + SCRIPT);
  });

  test('script runs without error in non-strict mode', () => {
    const { stdout } = runScript([]);
    assert(stdout.includes('GENESIS CONTRACT-CANDIDATE AUDIT'), 'expected header');
    assert(stdout.includes('Existing contracts:'), 'expected contract list');
  });

  test('--json produces valid JSON with expected schema', () => {
    const { stdout } = runScript(['--json']);
    const data = JSON.parse(stdout);
    assert(Array.isArray(data.contractPrefixes), 'contractPrefixes should be array');
    assert(Array.isArray(data.candidates), 'candidates should be array');
    assert(typeof data.byFile === 'object', 'byFile should be object');
    assert(typeof data.summary === 'object', 'summary should be object');
    assert(typeof data.summary.candidateCount === 'number', 'summary.candidateCount');
  });

  test('JSON: contract prefixes from stale-refs.json are loaded', () => {
    const { stdout } = runScript(['--json']);
    const data = JSON.parse(stdout);
    // v7.5.7 baseline: 7 contracts in stale-refs.json
    assert(data.contractPrefixes.length >= 7,
      `expected ≥7 prefixes, got: ${data.contractPrefixes.length}`);
    assert(data.contractPrefixes.includes('injection-gate contract: '),
      'expected injection-gate contract: prefix');
    assert(data.contractPrefixes.includes('shell-safety contract: '),
      'expected shell-safety contract: prefix');
  });

  test('JSON: tests already marked with a contract prefix are NOT candidates', () => {
    const { stdout } = runScript(['--json']);
    const data = JSON.parse(stdout);
    // Marked tests start with one of the prefixes — none should be in candidates
    for (const cand of data.candidates) {
      const isProtected = data.contractPrefixes.some(p => cand.name.startsWith(p));
      assert(!isProtected, `protected test should not be candidate: ${cand.name}`);
    }
  });

  test('JSON: every candidate has file and name fields', () => {
    const { stdout } = runScript(['--json']);
    const data = JSON.parse(stdout);
    for (const c of data.candidates) {
      assert(typeof c.file === 'string', `c.file missing on ${JSON.stringify(c)}`);
      assert(typeof c.name === 'string', `c.name missing on ${JSON.stringify(c)}`);
    }
  });

  test('JSON: candidates only come from security-relevant files', () => {
    const { stdout } = runScript(['--json']);
    const data = JSON.parse(stdout);
    const securityKeywords = /gate|injection|sandbox|safety|preservation|self-?gate|immune|capability.?guard|security/i;
    for (const c of data.candidates) {
      assert(securityKeywords.test(path.basename(c.file)),
        `non-security file should not produce candidates: ${c.file}`);
    }
  });

  test('JSON: candidate names contain a security verb (block/reject/etc)', () => {
    const { stdout } = runScript(['--json']);
    const data = JSON.parse(stdout);
    // Mirrors SECURITY_NAME_PATTERNS in audit-contracts.js
    const securityVerbs = /\b(?:block|reject|deny|prevent|refuse|throw|must|never)\w*\b|fail-?closed|do\s+not/i;
    for (const c of data.candidates) {
      assert(securityVerbs.test(c.name),
        `candidate name should contain security verb: ${c.name}`);
    }
  });

  test('non-strict mode: exit 0 even with candidates', () => {
    const { exitCode } = runScript([]);
    assert(exitCode === 0, `expected exit 0, got: ${exitCode}`);
  });

  test('--strict mode: exit code reflects candidate presence', () => {
    const { stdout, exitCode } = runScript(['--strict']);
    const { stdout: jsonOut } = runScript(['--json']);
    const data = JSON.parse(jsonOut);
    if (data.candidates.length > 0) {
      assert(exitCode === 1, `with ${data.candidates.length} candidates, --strict should exit 1, got: ${exitCode}`);
    } else {
      assert(exitCode === 0, `with 0 candidates, --strict should exit 0, got: ${exitCode}`);
    }
  });

  test('JSON: byFile groups candidates by their file', () => {
    const { stdout } = runScript(['--json']);
    const data = JSON.parse(stdout);
    let totalInGroups = 0;
    for (const file of Object.keys(data.byFile)) {
      const names = data.byFile[file];
      assert(Array.isArray(names), `byFile[${file}] should be array`);
      totalInGroups += names.length;
    }
    assert(totalInGroups === data.candidates.length,
      `byFile total (${totalInGroups}) should equal candidates (${data.candidates.length})`);
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
