// ============================================================
// Test: VerificationEngine.js — Programmatic truth verification
// CRITICAL: This is the safety-gate for all AgentLoop steps.
// ============================================================
let passed = 0, failed = 0;
const failures = [];
const path = require('path');
const fs = require('fs');

function test(name, fn) {
  // v3.5.2: Fixed — try/catch around fn() for sync errors
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => {
        passed++; console.log(`    ✅ ${name}`);
      }).catch(err => {
        failed++; failures.push({ name, error: err.message });
        console.log(`    ❌ ${name}: ${err.message}`);
      });
    }
    passed++; console.log(`    ✅ ${name}`);
  } catch (err) {
    failed++; failures.push({ name, error: err.message });
    console.log(`    ❌ ${name}: ${err.message}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }

const {
  VerificationEngine, CodeVerifier, TestVerifier,
  ShellVerifier, FileVerifier, PlanVerifier,
  PASS, FAIL, AMBIGUOUS,
} = require('../../src/agent/intelligence/VerificationEngine');

// Setup test workspace
const TEST_ROOT = path.join(__dirname, '..', '..', 'sandbox', '_ve_test');
if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
fs.mkdirSync(TEST_ROOT, { recursive: true });
fs.mkdirSync(path.join(TEST_ROOT, 'src', 'kernel'), { recursive: true });
fs.mkdirSync(path.join(TEST_ROOT, 'src', 'agent'), { recursive: true });
fs.mkdirSync(path.join(TEST_ROOT, 'node_modules', 'acorn'), { recursive: true });

// Create test files
fs.writeFileSync(path.join(TEST_ROOT, 'valid.js'), 'const x = 1;\nmodule.exports = { x };\n');
fs.writeFileSync(path.join(TEST_ROOT, 'invalid.js'), 'const x = {{{;\n');
fs.writeFileSync(path.join(TEST_ROOT, 'empty.js'), '');
fs.writeFileSync(path.join(TEST_ROOT, 'valid.json'), '{"key": "value"}');
fs.writeFileSync(path.join(TEST_ROOT, 'invalid.json'), '{key: bad}');
fs.writeFileSync(path.join(TEST_ROOT, 'readme.md'), '# Test');
fs.writeFileSync(path.join(TEST_ROOT, 'package.json'), '{"scripts":{"test":"echo ok"}}');

console.log('\n  📦 VerificationEngine');

// ── Constants ─────────────────────────────────────────────
test('PASS/FAIL/AMBIGUOUS constants are distinct strings', () => {
  assert(PASS === 'pass');
  assert(FAIL === 'fail');
  assert(AMBIGUOUS === 'ambiguous');
  assert(PASS !== FAIL && FAIL !== AMBIGUOUS);
});

// ── CodeVerifier ──────────────────────────────────────────
const cv = new CodeVerifier(TEST_ROOT);

test('CodeVerifier: valid JS passes', () => {
  const r = cv.verify('const x = 1;\nmodule.exports = { x };');
  assert(r.status === PASS, `Expected pass, got ${r.status}: ${r.reason}`);
  assert(r.checks.length >= 1, 'Should have at least 1 check');
});

test('CodeVerifier: syntax error fails', () => {
  const r = cv.verify('const x = {{{;');
  assert(r.status === FAIL, `Expected fail, got ${r.status}`);
  assert(r.checks.some(c => c.name === 'syntax' && !c.passed));
});

test('CodeVerifier: empty code fails', () => {
  const r = cv.verify('');
  assert(r.status === FAIL);
  assert(r.reason.includes('Empty'));
});

test('CodeVerifier: null code fails', () => {
  const r = cv.verify(null);
  assert(r.status === FAIL);
});

test('CodeVerifier: checkSyntax valid', () => {
  const r = cv.checkSyntax('function foo() { return 42; }');
  assert(r.passed === true);
});

test('CodeVerifier: checkSyntax invalid returns line info', () => {
  const r = cv.checkSyntax('function foo( { return; }');
  assert(r.passed === false);
  assert(typeof r.error === 'string');
});

test('CodeVerifier: detects Node.js built-in requires', () => {
  const r = cv.verify("const fs = require('fs');\nconst p = require('path');\nconsole.log(fs, p);");
  assert(r.status === PASS);
  assert(r.checks.some(c => c.name === 'import:fs' && c.passed));
});

test('CodeVerifier: detects missing relative imports', () => {
  const r = cv.verify("const m = require('./nonexistent-module');");
  const importCheck = r.checks.find(c => c.name.includes('nonexistent'));
  assert(importCheck && !importCheck.passed, 'Missing module import should fail');
});

test('CodeVerifier: warns on excessive console.log', () => {
  const code = Array(8).fill("console.log('x');").join('\n');
  const r = cv.verify(code);
  assert(r.checks.some(c => c.name === 'lint:excessive-console-log'));
});

test('CodeVerifier: warns on empty catch blocks', () => {
  const code = "try { foo(); } catch (e) {}\nconsole.log('done');";
  const r = cv.verify(code);
  assert(r.checks.some(c => c.name === 'lint:empty-catch'));
});

// ── TestVerifier ──────────────────────────────────────────
const tv = new TestVerifier();

test('TestVerifier: exit 0 + pass count = PASS', () => {
  const r = tv.verify({ exitCode: 0, output: '5 tests passed', stderr: '' });
  assert(r.status === PASS, `Expected pass, got ${r.status}`);
  assert(r.checks.some(c => c.name === 'tests-passed' && c.count === 5));
});

test('TestVerifier: exit 1 = FAIL', () => {
  const r = tv.verify({ exitCode: 1, output: '3 passing\n2 failing', stderr: '' });
  assert(r.status === FAIL);
});

test('TestVerifier: exit 0 + "✓" format passes', () => {
  const r = tv.verify({ exitCode: 0, output: '10 ✓', stderr: '' });
  assert(r.status !== FAIL);
});

test('TestVerifier: zero failures is pass', () => {
  const r = tv.verify({ exitCode: 0, output: '5 passing\n0 failing', stderr: '' });
  assert(r.status === PASS);
});

test('TestVerifier: catches TypeError in stderr', () => {
  const r = tv.verify({ exitCode: 1, output: '', stderr: 'TypeError: x is not a function' });
  assert(r.status === FAIL);
  assert(r.checks.some(c => c.name === 'error:type-error'));
});

test('TestVerifier: catches SyntaxError in output', () => {
  const r = tv.verify({ exitCode: 1, output: 'SyntaxError: Unexpected token', stderr: '' });
  assert(r.status === FAIL);
  assert(r.checks.some(c => c.name === 'error:syntax-error'));
});

test('TestVerifier: catches MODULE_NOT_FOUND', () => {
  const r = tv.verify({ exitCode: 1, output: '', stderr: 'Cannot find module "foo"' });
  assert(r.status === FAIL);
  assert(r.checks.some(c => c.name === 'error:module-not-found'));
});

test('TestVerifier: exit 0 no parse = AMBIGUOUS', () => {
  const r = tv.verify({ exitCode: 0, output: 'done', stderr: '' });
  assert(r.status === AMBIGUOUS, 'No pass/fail count should be ambiguous');
});

// ── ShellVerifier ─────────────────────────────────────────
const sv = new ShellVerifier();

test('ShellVerifier: exit 0 + output = PASS', () => {
  const r = sv.verify({ exitCode: 0, output: 'hello world', stderr: '' });
  assert(r.status === PASS);
});

test('ShellVerifier: exit 1 = FAIL', () => {
  const r = sv.verify({ exitCode: 1, output: '', stderr: 'error occurred' });
  assert(r.status === FAIL);
});

test('ShellVerifier: timeout detected', () => {
  const r = sv.verify({ exitCode: 1, timedOut: true, output: '', stderr: '' });
  assert(r.status === FAIL);
  assert(r.reason.includes('timed out'));
});

test('ShellVerifier: timeout from stderr pattern', () => {
  const r = sv.verify({ exitCode: 1, output: '', stderr: 'ETIMEDOUT' });
  assert(r.status === FAIL);
  assert(r.reason.includes('timed out'));
});

test('ShellVerifier: permission denied', () => {
  const r = sv.verify({ exitCode: 1, output: '', stderr: 'EACCES: permission denied' });
  assert(r.status === FAIL);
  assert(r.reason.includes('Permission denied'));
});

test('ShellVerifier: command not found (exit 127)', () => {
  const r = sv.verify({ exitCode: 127, output: '', stderr: '' });
  assert(r.status === FAIL);
  assert(r.reason.includes('not found'));
});

test('ShellVerifier: command not found from stderr', () => {
  const r = sv.verify({ exitCode: 1, output: '', stderr: 'command not found' });
  assert(r.status === FAIL);
});

test('ShellVerifier: exit 0 + stderr = PASS with warning', () => {
  const r = sv.verify({ exitCode: 0, output: 'ok', stderr: 'npm WARN deprecated' });
  assert(r.status === PASS);
  assert(r.checks.some(c => c.name === 'stderr-warnings' && c.severity === 'warn'));
});

// ── FileVerifier ──────────────────────────────────────────
const fv = new FileVerifier(TEST_ROOT);

test('FileVerifier: valid file passes', () => {
  const r = fv.verify('valid.js', {});
  assert(r.status === PASS, `Expected pass, got ${r.status}: ${r.reason}`);
  assert(r.checks.some(c => c.name === 'exists' && c.passed));
  assert(r.checks.some(c => c.name === 'non-empty' && c.passed));
});

test('FileVerifier: missing file fails', () => {
  const r = fv.verify('ghost.js', {});
  assert(r.status === FAIL);
  assert(r.reason.includes('does not exist'));
});

test('FileVerifier: empty file fails', () => {
  const r = fv.verify('empty.js', {});
  assert(r.status === FAIL);
  assert(r.reason.includes('empty'));
});

test('FileVerifier: no path specified fails', () => {
  const r = fv.verify(null, {});
  assert(r.status === FAIL);
  assert(r.reason.includes('No target'));
});

test('FileVerifier: valid JSON passes', () => {
  const r = fv.verify('valid.json', {});
  assert(r.status === PASS);
  assert(r.checks.some(c => c.name === 'json-valid' && c.passed));
});

test('FileVerifier: invalid JSON fails', () => {
  const r = fv.verify('invalid.json', {});
  assert(r.status === FAIL);
  assert(r.checks.some(c => c.name === 'json-valid' && !c.passed));
});

test('FileVerifier: JS syntax check on .js files', () => {
  const r = fv.verify('valid.js', {});
  assert(r.checks.some(c => c.name === 'js-syntax' && c.passed));
});

test('FileVerifier: invalid JS syntax detected', () => {
  const r = fv.verify('invalid.js', {});
  assert(r.status === FAIL);
  assert(r.checks.some(c => c.name === 'js-syntax' && !c.passed));
});

test('FileVerifier: non-text file skips content checks', () => {
  fs.writeFileSync(path.join(TEST_ROOT, 'data.bin'), Buffer.from([0x00, 0x01, 0xFF]));
  const r = fv.verify('data.bin', {});
  assert(r.status === PASS);
  assert(!r.checks.some(c => c.name === 'readable'));
});

// ── PlanVerifier ──────────────────────────────────────────
const pv = new PlanVerifier();

test('PlanVerifier: empty plan is valid', () => {
  const r = pv.verifyPlan([], {});
  assert(r.valid === true);
  assert(r.issues.length === 0);
});

test('PlanVerifier: WRITE_FILE to kernel detected', () => {
  const mockWS = {
    canWriteFile: (p) => !p.includes('kernel'),
    canRunShell: () => true,
    canRunTests: () => true,
    canUseModel: () => true,
  };
  const steps = [
    { type: 'WRITE_FILE', target: 'src/kernel/SafeGuard.js', description: 'modify kernel' },
  ];
  const r = pv.verifyPlan(steps, mockWS);
  assert(r.valid === false);
  assert(r.issues.length === 1);
  assert(r.issues[0].issues[0].includes('Cannot write'));
});

test('PlanVerifier: SHELL_EXEC with blocked command', () => {
  const mockWS = {
    canWriteFile: () => true,
    canRunShell: (cmd) => !cmd.includes('rm -rf'),
    canRunTests: () => true,
    canUseModel: () => true,
  };
  const steps = [
    { type: 'SHELL_EXEC', command: 'rm -rf /', description: 'destroy everything' },
  ];
  const r = pv.verifyPlan(steps, mockWS);
  assert(r.valid === false);
});

test('PlanVerifier: valid plan passes all preconditions', () => {
  const mockWS = {
    canWriteFile: () => true,
    canRunShell: () => true,
    canRunTests: () => true,
    canUseModel: () => true,
  };
  const steps = [
    { type: 'ANALYZE', description: 'read code' },
    { type: 'CODE_GENERATE', description: 'generate code', model: 'gemma2' },
    { type: 'WRITE_FILE', target: 'src/agent/foo.js', description: 'write file' },
    { type: 'RUN_TESTS', description: 'run tests' },
  ];
  const r = pv.verifyPlan(steps, mockWS);
  assert(r.valid === true);
  assert(r.totalIssues === 0);
});

test('PlanVerifier: unavailable model detected', () => {
  const mockWS = {
    canWriteFile: () => true,
    canRunShell: () => true,
    canRunTests: () => true,
    canUseModel: (m) => m === 'gemma2',
  };
  const steps = [
    { type: 'CODE_GENERATE', model: 'gpt-5', description: 'use unavailable model' },
  ];
  const r = pv.verifyPlan(steps, mockWS);
  assert(r.valid === false);
  assert(r.issues[0].issues[0].includes('not available'));
});

test('PlanVerifier: no test script detected', () => {
  const mockWS = {
    canWriteFile: () => true,
    canRunShell: () => true,
    canRunTests: () => false,
    canUseModel: () => true,
  };
  const steps = [{ type: 'RUN_TESTS', description: 'test' }];
  const r = pv.verifyPlan(steps, mockWS);
  assert(r.valid === false);
  assert(r.issues[0].issues[0].includes('No test script'));
});

// ── VerificationEngine (integration) ──────────────────────
console.log('\n  📦 VerificationEngine (integration)');

const ve = new VerificationEngine({ bus: { emit: () => [], fire: () => {} }, rootDir: TEST_ROOT });

async function runAsync() {
  await test('verify CODE: valid code passes', async () => {
    const r = await ve.verify('CODE', {}, { output: 'const x = 1; module.exports = x;' });
    assert(r.status === PASS, `Expected pass, got ${r.status}: ${r.reason}`);
  });

  await test('verify CODE: syntax error fails', async () => {
    const r = await ve.verify('CODE', {}, { output: 'const x = {{{;' });
    assert(r.status === FAIL);
  });

  await test('verify CODE: empty code fails', async () => {
    const r = await ve.verify('CODE', {}, { output: '' });
    assert(r.status === FAIL);
  });

  await test('verify CODE_GENERATE normalizes to CODE', async () => {
    const r = await ve.verify('CODE_GENERATE', {}, { code: 'const y = 2;' });
    assert(r.status === PASS);
  });

  await test('verify SHELL: exit 0 passes', async () => {
    const r = await ve.verify('SHELL', {}, { exitCode: 0, output: 'ok', stderr: '' });
    assert(r.status === PASS);
  });

  await test('verify SHELL_EXEC normalizes to SHELL', async () => {
    const r = await ve.verify('SHELL_EXEC', {}, { exitCode: 0, output: 'ok', stderr: '' });
    assert(r.status === PASS);
  });

  await test('verify RUN_TESTS: passing tests', async () => {
    const r = await ve.verify('RUN_TESTS', {}, { exitCode: 0, output: '10 passing', stderr: '' });
    assert(r.status === PASS);
  });

  await test('verify RUN_TESTS: failing tests', async () => {
    const r = await ve.verify('RUN_TESTS', {}, { exitCode: 1, output: '2 failing', stderr: '' });
    assert(r.status === FAIL);
  });

  await test('verify WRITE_FILE: existing file passes', async () => {
    const r = await ve.verify('WRITE_FILE', { target: 'valid.js' }, {});
    assert(r.status === PASS);
  });

  await test('verify WRITE_FILE: missing file fails', async () => {
    const r = await ve.verify('WRITE_FILE', { target: 'ghost.js' }, {});
    assert(r.status === FAIL);
  });

  await test('verify SANDBOX: successful execution with output', async () => {
    const r = await ve.verify('SANDBOX', {}, { output: 'result: 42' });
    assert(r.status === PASS);
  });

  await test('verify SANDBOX: security block detected', async () => {
    const r = await ve.verify('SANDBOX', {}, { error: 'sandbox execution denied' });
    assert(r.status === FAIL);
    assert(r.reason.includes('security'));
  });

  await test('verify SANDBOX: non-zero exit code fails', async () => {
    const r = await ve.verify('SANDBOX', {}, { exitCode: 1 });
    assert(r.status === FAIL);
  });

  await test('verify SANDBOX: no output = ambiguous', async () => {
    const r = await ve.verify('SANDBOX', {}, { output: '' });
    assert(r.status === AMBIGUOUS);
  });

  await test('verify ANALYZE: always ambiguous', async () => {
    const r = await ve.verify('ANALYZE', {}, {});
    assert(r.status === AMBIGUOUS);
  });

  await test('verify SEARCH: always ambiguous', async () => {
    const r = await ve.verify('SEARCH', {}, {});
    assert(r.status === AMBIGUOUS);
  });

  await test('verify ASK: always ambiguous', async () => {
    const r = await ve.verify('ASK', {}, {});
    assert(r.status === AMBIGUOUS);
  });

  await test('verify unknown type: ambiguous', async () => {
    const r = await ve.verify('FOOBAR', {}, {});
    assert(r.status === AMBIGUOUS);
  });

  await test('verify null type: ambiguous', async () => {
    const r = await ve.verify(null, {}, {});
    assert(r.status === AMBIGUOUS);
  });

  await test('verify case insensitive (lowercase)', async () => {
    const r = await ve.verify('shell', {}, { exitCode: 0, output: 'ok', stderr: '' });
    assert(r.status === PASS);
  });

  await test('stats track correctly', async () => {
    const stats = ve.getStats();
    assert(stats.total > 0, 'total should be > 0');
    assert(stats.pass > 0, 'pass should be > 0');
    assert(stats.fail > 0, 'fail should be > 0');
    assert(stats.ambiguous > 0, 'ambiguous should be > 0');
  });

  await test('verifyPlan without worldState returns valid', () => {
    const r = ve.verifyPlan([{ type: 'WRITE_FILE', target: 'kernel.js' }]);
    assert(r.valid === true);
    assert(r.note.includes('WorldState not available'));
  });

  await test('verifyPlan with worldState checks preconditions', () => {
    ve.worldState = {
      canWriteFile: (p) => !p.includes('kernel'),
      canRunShell: () => true,
      canRunTests: () => true,
      canUseModel: () => true,
    };
    const r = ve.verifyPlan([
      { type: 'WRITE_FILE', target: 'src/kernel/boot.js' },
      { type: 'WRITE_FILE', target: 'src/agent/foo.js' },
    ]);
    assert(r.valid === false);
    assert(r.issues.length === 1);
    ve.worldState = null; // reset
  });

  await test('checkSyntax exposed on engine', () => {
    const r = ve.checkSyntax('const x = 1;');
    assert(r.passed === true);
  });

  // Cleanup
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failures.length > 0) failures.forEach(f => console.log(`    FAIL: ${f.name} — ${f.error}`));
  process.exit(failed > 0 ? 1 : 0);
}

runAsync();
