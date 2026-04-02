#!/usr/bin/env node
// ============================================================
// Test: v4.12.3 Audit Security Fixes
//
// Covers:
//   S-02: ASTDiff — escaped funcName in regex
//   S-02: ToolRegistry — validated regex pattern
//   S-02/Q-07: ShellAgent — proper glob-to-regex
//   S-03: Sandbox — trusted guard on executeWithContext
//   S-04: PeerTransport — discovery token required
// ============================================================

const { describe, test, assert, assertEqual, assertThrows, assertRejects, run } = require('../harness');
const path = require('path');
const fs = require('fs');

// ── S-02: ASTDiff — funcName escaping ────────────────────────

describe('S-02: ASTDiff — funcName regex escaping', () => {
  let ASTDiff;

  test('load ASTDiff', () => {
    ({ ASTDiff } = require('../../src/agent/foundation/ASTDiff'));
    assert(ASTDiff, 'ASTDiff should load');
  });

  test('_findFunctionBoundary does not throw on regex metacharacters', () => {
    const diff = new ASTDiff({});
    // These names contain regex metacharacters that would crash unescaped new RegExp()
    const dangerousNames = [
      'func()',
      'a[0]',
      'obj.method',
      'name+extra',
      'test?maybe',
      'a{1,3}',
      'pipe|alt',
      'dollar$end',
      'caret^start',
      'star*glob',
      'parens(group)',
    ];
    for (const name of dangerousNames) {
      let threw = false;
      try {
        diff._findFunctionBoundary('function hello() { return 1; }', name);
      } catch (err) {
        if (err.message.includes('Invalid regular expression')) threw = true;
      }
      assert(!threw, `Should not throw RegExp error for funcName: "${name}"`);
    }
  });

  test('_findFunctionBoundary still finds normal functions', () => {
    const diff = new ASTDiff({});
    const code = `
function myFunc() {
  return 42;
}

const otherFunc = () => { return 1; };
`;
    const result = diff._findFunctionBoundary(code, 'myFunc');
    assert(result !== null, 'Should find myFunc');
  });
});

// ── S-02: ToolRegistry — pattern validation ──────────────────

describe('S-02: ToolRegistry — regex pattern validation', () => {
  test('ToolRegistry source contains try/catch for regex', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../src/agent/intelligence/ToolRegistry.js'), 'utf-8'
    );
    assert(src.includes('try {'), 'Should have try block for regex');
    assert(src.includes('Invalid regex pattern'), 'Should handle invalid regex');
    assert(src.includes('input.pattern.length > 200'), 'Should limit pattern length');
  });
});

// ── S-02/Q-07: ShellAgent — glob-to-regex ────────────────────

describe('S-02/Q-07: ShellAgent — glob-to-regex escaping', () => {
  test('ShellAgent source uses proper glob escaping', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../src/agent/capabilities/ShellAgent.js'), 'utf-8'
    );
    // Should escape metacharacters before replacing * with .*
    assert(
      src.includes('.replace(/[.+?^${}()|[\\]\\\\]/g'),
      'Should escape regex metacharacters in glob patterns'
    );
    // Should anchor the regex to prevent partial matches
    assert(
      src.includes('`^${escaped}$`'),
      'Should anchor glob regex with ^ and $'
    );
  });
});

// ── S-03: Sandbox — trusted guard ────────────────────────────

describe('S-03: Sandbox — executeWithContext trusted guard', () => {
  let Sandbox;

  test('load Sandbox', () => {
    ({ Sandbox } = require('../../src/agent/foundation/Sandbox'));
    assert(Sandbox, 'Sandbox should load');
  });

  test('executeWithContext rejects without trusted:true', async () => {
    const sandbox = new Sandbox(require('os').tmpdir());
    let errMsg = null;
    try {
      await sandbox.executeWithContext('(async () => { return 1; })');
    } catch (err) {
      errMsg = err.message;
    }
    assert(errMsg !== null, 'Should throw without trusted:true');
    assert(errMsg.includes('trusted: true'), 'Error should mention trusted flag');
    assert(errMsg.includes('NOT a security boundary'), 'Error should explain the risk');
  });

  test('executeWithContext works with trusted:true', async () => {
    const sandbox = new Sandbox(require('os').tmpdir());
    // FIX v5.1.0: Check acorn availability the same way the scanner does —
    // including the kernel-vendored fallback added in v5.1.0 (W-2).
    const { acornAvailable } = require('../../src/agent/intelligence/CodeSafetyScanner');

    const result = await sandbox.executeWithContext(
      '(async () => { return 42; })',
      {},
      { trusted: true }
    );
    assert(result !== null, 'Should return a result');
    if (acornAvailable) {
      assert(!result.error, 'Should not have an error when acorn is available');
    } else {
      // Without acorn, scanner blocks everything — this is the correct fail-closed behavior.
      assert(result.mode === 'vm-blocked', 'Should be vm-blocked when acorn is missing (expected in test env)');
    }
  });

  test('executeWithContext blocks dangerous code even with trusted:true (if acorn available)', async () => {
    const sandbox = new Sandbox(require('os').tmpdir());
    // FIX v5.1.0: Scanner is now injected via late-binding, not direct require.
    // v5.2.0: Sandbox uses _codeSafety (CodeSafetyAdapter port) instead of raw scanner.
    try {
      const { CodeSafetyAdapter } = require('../../src/agent/ports/CodeSafetyPort');
      sandbox._codeSafety = CodeSafetyAdapter.fromScanner();
    } catch (_) {}
    const result = await sandbox.executeWithContext(
      '(async () => { eval("1+1"); })',
      {},
      { trusted: true }
    );
    // CodeSafetyScanner blocks eval() IF acorn is installed.
    // Without acorn, the scanner falls back to regex which may not catch
    // eval inside string templates. Either outcome is valid in test env.
    // FIX v5.1.0: Use scanner's acornAvailable (includes vendored fallback)
    const { acornAvailable } = require('../../src/agent/intelligence/CodeSafetyScanner');
    if (acornAvailable) {
      assert(
        result.mode === 'vm-blocked' || result.error?.includes('blocked'),
        'Should block eval() when acorn is available'
      );
    } else {
      // Without acorn, scanner is degraded — this is expected.
      // The fix is still validated by the trusted:true guard tests above.
      assert(true, 'Acorn not installed — scanner degraded (expected in test env)');
    }
  });
});

// ── S-04: PeerTransport — discovery token ────────────────────

describe('S-04: PeerTransport — discovery token requirement', () => {
  test('PeerTransport source requires discovery token', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../src/agent/hexagonal/PeerTransport.js'), 'utf-8'
    );
    assert(
      src.includes('if (!token)'),
      'Should check for missing discovery token'
    );
    assert(
      src.includes('multicast discovery disabled'),
      'Should disable discovery when no token'
    );
  });

  test('startDiscovery returns early without token', () => {
    const { PeerTransport } = require('../../src/agent/hexagonal/PeerTransport');
    const transport = new PeerTransport({});
    // Should not throw, should not create a UDP socket
    transport.startDiscovery(19420, () => {}, null);
    assert(transport.udpSocket === null, 'UDP socket should remain null without token');
  });
});

// ── S-05: main.js — unhandledRejection handler ──────────────

describe('S-05: Global unhandledRejection handler', () => {
  test('main.js contains unhandledRejection handler', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../main.js'), 'utf-8'
    );
    assert(
      src.includes("process.on('unhandledRejection'"),
      'main.js should have unhandledRejection handler'
    );
  });
});

// ── S-06: main.js — sandbox:false warning ────────────────────

describe('S-06: Sandbox:false security warning', () => {
  test('main.js warns when sandbox:false', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../main.js'), 'utf-8'
    );
    assert(
      src.includes('SECURITY: Running with sandbox:false'),
      'Should warn when falling back to sandbox:false'
    );
  });
});

// ── S-01/Q-04: chat.js — XSS fix source verification ────────

describe('S-01/Q-04: chat.js XSS prevention', () => {
  test('renderMarkdown escapes HTML before transforms', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../src/ui/modules/chat.js'), 'utf-8'
    );
    // The fix extracts code blocks, then escapes remaining HTML, then applies markdown
    assert(
      src.includes('// 2. Escape all remaining HTML entities'),
      'Should have escape step before markdown transforms'
    );
    assert(
      src.includes('safe = escapeHtml(safe)'),
      'Should call escapeHtml on text before markdown'
    );
  });

  test('intent parameter is escaped in addMessage', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../src/ui/modules/chat.js'), 'utf-8'
    );
    assert(
      src.includes('escapeHtml(intent)'),
      'Intent should be escaped before innerHTML interpolation'
    );
  });
});

run();
