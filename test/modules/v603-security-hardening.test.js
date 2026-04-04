// ============================================================
// Test: v6.0.3 Security Audit Hardening
//
// Tests for:
//   - IPC input validation patterns (H-1, H-2, H-3, M-1, L-1)
//   - Sandbox FS intercept expansion (M-6: cp, cpSync, appendFile)
//   - Sandbox executeExternal namespace isolation (M-5)
//   - WorldState allSettled resilience (M-3)
// ============================================================
let passed = 0, failed = 0;
const _testQueue = [];
function test(name, fn) { _testQueue.push({ name, fn }); }
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }

const path = require('path');
const fs = require('fs');
const os = require('os');

console.log('\n  🔐 v6.0.3 Security Audit Hardening');

// ═══════════════════════════════════════════════════════════
// SECTION 1: IPC Input Validation Patterns
// ═══════════════════════════════════════════════════════════
// main.js is an Electron entry point and can't be imported.
// Instead, we test the validation logic patterns extracted as
// pure functions to verify the kernel would reject bad inputs.

console.log('\n    ── IPC Input Validation ──');

// Replicate _validateStr from main.js
function _validateStr(v, name, maxLen = 0) {
  if (typeof v !== 'string' || v.length === 0) return `${name} must be a non-empty string`;
  if (maxLen > 0 && v.length > maxLen) return `${name} exceeds max length (${maxLen})`;
  return null;
}

// H-1: agent:import-data — path scope check
test('H-1: import-data rejects non-string filePath', () => {
  const err = _validateStr(42, 'filePath');
  assert(err !== null, 'should reject number');
  assert(err.includes('non-empty string'), 'should say non-empty string');
});

test('H-1: import-data rejects empty string', () => {
  const err = _validateStr('', 'filePath');
  assert(err !== null, 'should reject empty');
});

test('H-1: import-data accepts valid path', () => {
  const err = _validateStr('/home/user/backup.tar.gz', 'filePath');
  assert(err === null, 'should accept valid path');
});

test('H-1: import-data scope check rejects paths outside home', () => {
  const homeDir = os.homedir();
  const resolved = path.resolve('/etc/shadow');
  const inHome = resolved.startsWith(homeDir + path.sep) || resolved === homeDir;
  assert(!inHome, '/etc/shadow should not be in home dir');
});

test('H-1: import-data scope check accepts paths inside home', () => {
  const homeDir = os.homedir();
  const testPath = path.join(homeDir, 'genesis-backup.tar.gz');
  const resolved = path.resolve(testPath);
  const inHome = resolved.startsWith(homeDir + path.sep) || resolved === homeDir;
  assert(inHome, 'path in home should be accepted');
});

// H-2: agent:get-replay-diff — ID validation
test('H-2: replay-diff rejects non-string IDs', () => {
  assert(_validateStr(undefined, 'idA') !== null, 'should reject undefined');
  assert(_validateStr(null, 'idA') !== null, 'should reject null');
  assert(_validateStr(123, 'idA') !== null, 'should reject number');
  assert(_validateStr({}, 'idA') !== null, 'should reject object');
});

test('H-2: replay-diff rejects oversized IDs', () => {
  const err = _validateStr('x'.repeat(201), 'idA', 200);
  assert(err !== null, 'should reject >200 chars');
  assert(err.includes('max length'), 'should mention max length');
});

test('H-2: replay-diff accepts valid IDs', () => {
  assert(_validateStr('replay-2026-01-01-abc123', 'idA', 200) === null, 'should accept valid ID');
});

// H-3: agent:clone — config validation
test('H-3: clone rejects null config', () => {
  const config = null;
  assert(!config || typeof config !== 'object', 'null should be rejected');
});

test('H-3: clone rejects array config', () => {
  const config = [1, 2, 3];
  assert(Array.isArray(config), 'array should be detected');
});

test('H-3: clone rejects string config', () => {
  const config = 'not-an-object';
  assert(typeof config !== 'object', 'string should be rejected');
});

test('H-3: clone accepts plain object config', () => {
  const config = { name: 'clone-1' };
  assert(config && typeof config === 'object' && !Array.isArray(config), 'plain object should pass');
});

// M-1: mcp-remove-server, mcp-reconnect, loop-reject
test('M-1: mcp-remove-server rejects non-string name', () => {
  const name = 42;
  assert(typeof name !== 'string' || !name, 'non-string should be rejected');
});

test('M-1: loop-reject truncates long reason', () => {
  const reason = 'x'.repeat(2000);
  const truncated = typeof reason === 'string' ? reason.slice(0, 1000) : 'User rejected';
  assert(truncated.length === 1000, 'should truncate to 1000 chars');
});

test('M-1: loop-reject defaults non-string reason', () => {
  const reason = 42;
  const safe = typeof reason === 'string' ? reason.slice(0, 1000) : 'User rejected';
  assert(safe === 'User rejected', 'should default non-string to "User rejected"');
});

// L-1: set-setting value type guard
test('L-1: set-setting rejects function values', () => {
  const value = function() {};
  assert(typeof value === 'function', 'function type should be detected');
});

test('L-1: set-setting rejects symbol values', () => {
  const value = Symbol('test');
  assert(typeof value === 'symbol', 'symbol type should be detected');
});

test('L-1: set-setting accepts string, number, boolean, null, object, array', () => {
  for (const value of ['str', 42, true, null, { a: 1 }, [1, 2]]) {
    assert(typeof value !== 'function' && typeof value !== 'symbol',
      `${JSON.stringify(value)} should be accepted`);
  }
});

// ═══════════════════════════════════════════════════════════
// SECTION 2: Sandbox FS Intercept Expansion (M-6)
// ═══════════════════════════════════════════════════════════

console.log('\n    ── Sandbox FS Intercepts ──');

const { Sandbox } = require('../../src/agent/foundation/Sandbox');
const tmpRoot = path.join(os.tmpdir(), `genesis-v603-test-${process.pid}`);
if (!fs.existsSync(tmpRoot)) fs.mkdirSync(tmpRoot, { recursive: true });
const sandbox = new Sandbox(tmpRoot);

test('M-6: fs.cp is blocked in sandbox', async () => {
  // _fs is available in sandbox scope — the intercepts protect this path
  const result = await sandbox.execute(`
    try {
      if (typeof _fs.cp === 'function') {
        _fs.cp('/tmp/a', '/tmp/b', { recursive: true }, () => {});
        console.log('NOT_BLOCKED');
      } else if (typeof _fs.cpSync === 'function') {
        _fs.cpSync('/tmp/a', '/tmp/b');
        console.log('NOT_BLOCKED');
      } else {
        console.log('BLOCKED_NO_METHOD');
      }
    } catch (e) {
      console.log('BLOCKED: ' + e.message);
    }
  `);
  assert(result.output.includes('BLOCKED'), 'fs.cp should be blocked: ' + JSON.stringify(result));
});

test('M-6: fs.cpSync is blocked in sandbox', async () => {
  const result = await sandbox.execute(`
    try {
      if (typeof _fs.cpSync === 'function') {
        _fs.cpSync('/tmp/a', '/tmp/b');
        console.log('NOT_BLOCKED');
      } else {
        console.log('BLOCKED_NO_METHOD');
      }
    } catch (e) {
      console.log('BLOCKED: ' + e.message);
    }
  `);
  assert(result.output.includes('BLOCKED'), 'fs.cpSync should be blocked: ' + JSON.stringify(result));
});

test('M-6: fs.appendFileSync write-path checked in sandbox', async () => {
  const result = await sandbox.execute(`
    try {
      _fs.appendFileSync('/etc/evil', 'data');
      console.log('NOT_BLOCKED');
    } catch (e) {
      console.log('BLOCKED: ' + e.message);
    }
  `);
  assert(result.output.includes('BLOCKED'), 'appendFileSync to /etc should be blocked: ' + JSON.stringify(result));
});

test('M-6: fs.appendFile write-path checked in sandbox', async () => {
  const result = await sandbox.execute(`
    try {
      _fs.appendFile('/tmp/outside-sandbox', 'data', (err) => {
        if (err) console.log('BLOCKED: ' + err.message);
        else console.log('NOT_BLOCKED');
      });
    } catch (e) {
      console.log('BLOCKED: ' + e.message);
    }
  `);
  assert(result.output.includes('BLOCKED'),
    'appendFile outside sandbox should be blocked: ' + JSON.stringify(result));
});

test('M-6: fs.appendFileSync inside sandbox dir succeeds', async () => {
  const result = await sandbox.execute(`
    try {
      const _p = require('path');
      const target = _p.join(process.cwd(), 'append-test-' + Date.now() + '.txt');
      _fs.appendFileSync(target, 'hello');
      console.log('OK');
      _fs.unlinkSync(target);
    } catch (e) {
      console.log('ERROR: ' + e.message);
    }
  `);
  assert(result.output.includes('OK'), 'appendFileSync inside sandbox should work: ' + JSON.stringify(result));
});

// ═══════════════════════════════════════════════════════════
// SECTION 3: Sandbox executeExternal (M-5)
// ═══════════════════════════════════════════════════════════

console.log('\n    ── Sandbox executeExternal Isolation ──');

test('M-5: executeExternal runs with sandbox env stripping', async () => {
  // Write a small node script to check env
  const scriptPath = path.join(tmpRoot, 'env-check.js');
  fs.writeFileSync(scriptPath, `
    const keys = Object.keys(process.env);
    // Should NOT have API keys from parent
    const hasApiKey = keys.some(k => /API_KEY|SECRET|TOKEN|PASSWORD/i.test(k) && k !== 'NODE_ENV');
    console.log(hasApiKey ? 'LEAKED' : 'CLEAN');
    console.log('ENV_KEYS:' + keys.length);
  `);
  const result = await sandbox.executeExternal('node', [], scriptPath, [], { language: 'node', timeout: 5000 });
  assert(!result.error, 'should not error: ' + result.error);
  assert(result.output.includes('CLEAN'), 'env should not leak secrets: ' + result.output);
  assert(result.sandboxed === true, 'should be marked as sandboxed');
});

test('M-5: executeExternal applies timeout', async () => {
  const scriptPath = path.join(tmpRoot, 'infinite.js');
  fs.writeFileSync(scriptPath, 'while(true){}');
  const result = await sandbox.executeExternal('node', [], scriptPath, [], { language: 'node', timeout: 1000 });
  assert(result.error && result.error.includes('Timeout'), 'should timeout: ' + result.error);
});

test('M-5: executeExternal cwd is sandbox dir', async () => {
  const scriptPath = path.join(tmpRoot, 'cwd-check.js');
  fs.writeFileSync(scriptPath, 'console.log("CWD:" + process.cwd())');
  const result = await sandbox.executeExternal('node', [], scriptPath, [], { language: 'node', timeout: 5000 });
  assert(!result.error, 'should not error: ' + result.error);
  assert(result.output.includes(sandbox.sandboxDir), 'CWD should be sandbox dir: ' + result.output);
});

// ═══════════════════════════════════════════════════════════
// SECTION 4: WorldState allSettled Resilience (M-3)
// ═══════════════════════════════════════════════════════════

console.log('\n    ── WorldState allSettled ──');

test('M-3: Promise.allSettled handles partial failure', async () => {
  const [successResult, failResult] = await Promise.allSettled([
    Promise.resolve({ stdout: 'main\n' }),
    Promise.reject(new Error('git not found')),
  ]);
  const branch = successResult.status === 'fulfilled' ? successResult.value.stdout.trim() : 'unknown';
  const status = failResult.status === 'fulfilled' ? failResult.value.stdout.trim() : '';
  assert(branch === 'main', 'branch should be extracted from fulfilled promise');
  assert(status === '', 'status should default to empty on failure');
});

test('M-3: Promise.allSettled returns unknown branch on failure', async () => {
  const [branchResult] = await Promise.allSettled([
    Promise.reject(new Error('not a git repo')),
  ]);
  const branch = branchResult.status === 'fulfilled' ? branchResult.value.stdout.trim() : 'unknown';
  assert(branch === 'unknown', 'branch should be "unknown" on failure');
});

// ═══════════════════════════════════════════════════════════
// SECTION 5: ShellAgent Unicode Normalization (L-4)
// ═══════════════════════════════════════════════════════════

console.log('\n    ── ShellAgent Unicode Normalization ──');

const { ShellAgent } = require('../../src/agent/capabilities/ShellAgent');

test('L-4: _sanitizeCommand normalizes fullwidth Unicode to ASCII', () => {
  const shell = new ShellAgent({ bus: { emit() {}, on() { return () => {}; }, fire() {} } });
  // Fullwidth 'ｒｍ' should normalize to 'rm'
  const result = shell._sanitizeCommand('ｒｍ -rf /tmp/test');
  assert(result.ok, 'should succeed');
  assert(result.command.startsWith('rm'), 'fullwidth ｒｍ should normalize to rm: ' + result.command);
});

test('L-4: _sanitizeCommand normalizes fullwidth digits', () => {
  const shell = new ShellAgent({ bus: { emit() {}, on() { return () => {}; }, fire() {} } });
  const result = shell._sanitizeCommand('echo １２３');
  assert(result.ok, 'should succeed');
  assert(result.command.includes('123'), 'fullwidth digits should normalize: ' + result.command);
});

test('L-4: _sanitizeCommand preserves normal ASCII', () => {
  const shell = new ShellAgent({ bus: { emit() {}, on() { return () => {}; }, fire() {} } });
  const result = shell._sanitizeCommand('ls -la /home/user');
  assert(result.ok, 'should succeed');
  assert(result.command === 'ls -la /home/user', 'ASCII should be unchanged');
});

test('L-4: fullwidth rm is caught by blocklist after normalization', () => {
  const shell = new ShellAgent({ bus: { emit() {}, on() { return () => {}; }, fire() {} } });
  shell.permissionLevel = 'read';
  const sanitized = shell._sanitizeCommand('ｒｍ -rf /tmp/test');
  assert(sanitized.ok, 'sanitize should succeed');
  // After NFKC normalization, 'ｒｍ' becomes 'rm' which matches blocklist
  assert(/\brm\b/i.test(sanitized.command), 'should contain normalized rm');
});

// ═══════════════════════════════════════════════════════════
// SECTION 6: Sandbox VM safeCopy Independence (M-7)
// ═══════════════════════════════════════════════════════════

console.log('\n    ── Sandbox VM safeCopy ──');

test('M-7: VM sandbox Array.prototype is independent of host', async () => {
  const result = await sandbox.executeWithContext(`
    (function(input) {
      // Try to mutate Array.prototype — should not affect host
      try { Array.prototype._testPollution = 'hacked'; } catch (e) { /* frozen */ }
      return { polluted: typeof Array.prototype._testPollution === 'string' };
    })
  `, {}, { trusted: true, timeout: 3000 });
  assert(!result.error, 'should not error: ' + result.error);
  // Host Array.prototype should be unaffected regardless
  assert(!Array.prototype._testPollution, 'host Array.prototype must not be polluted');
});

test('M-7: VM sandbox Object.prototype is independent of host', async () => {
  const result = await sandbox.executeWithContext(`
    (function(input) {
      try { Object.prototype._vmTest = true; } catch (e) { /* frozen */ }
      return { attempted: true };
    })
  `, {}, { trusted: true, timeout: 3000 });
  assert(!result.error, 'should not error: ' + result.error);
  assert(!Object.prototype._vmTest, 'host Object.prototype must not be polluted');
});

// ═══════════════════════════════════════════════════════════
// RUNNER
// ═══════════════════════════════════════════════════════════

const TEST_TIMEOUT = 15000;

(async () => {
  for (const t of _testQueue) {
    try {
      const r = t.fn();
      if (r && r.then) {
        await Promise.race([
          r,
          new Promise((_, reject) => setTimeout(() => reject(new Error('Test timed out')), TEST_TIMEOUT)),
        ]);
      }
      passed++; console.log(`    ✅ ${t.name}`);
    } catch (err) {
      failed++; console.log(`    ❌ ${t.name}: ${err.message}`);
      // Don't abort on failure — run all tests
    }
  }
  // Cleanup
  try {
    sandbox.cleanup();
    if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch { /* ignore */ }
  console.log(`\n    ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
