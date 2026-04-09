// ============================================================
// Test: CodeSafetyPort.js — Port interface, adapter, mock,
// static factory, and DI wiring verification
// ============================================================

const { describe, test, assert, assertEqual, assertThrows, run } = require('../harness');
const { CodeSafetyPort, CodeSafetyAdapter, MockCodeSafety } = require('../../src/agent/ports/CodeSafetyPort');

// ── Port interface ──────────────────────────────────────────

describe('CodeSafetyPort (interface)', () => {
  test('scanCode throws NotImplemented', () => {
    const port = new CodeSafetyPort();
    assertThrows(() => port.scanCode('x', 'f.js'), /not implemented/i);
  });

  test('available defaults to false', () => {
    assertEqual(new CodeSafetyPort().available, false);
  });
});

// ── Adapter ─────────────────────────────────────────────────

describe('CodeSafetyAdapter', () => {
  function makeFakeScanner(result = { safe: true, severity: 'none', violations: [], blocked: [], warnings: [] }) {
    return {
      scanCodeSafety: (code, file) => ({ ...result, _code: code, _file: file }),
      acornAvailable: true,
    };
  }

  test('delegates scanCode to scanCodeSafety', () => {
    const scanner = makeFakeScanner();
    const adapter = new CodeSafetyAdapter(scanner);
    const result = adapter.scanCode('const x = 1;', 'test.js');
    assertEqual(result._code, 'const x = 1;');
    assertEqual(result._file, 'test.js');
    assertEqual(result.safe, true);
  });

  test('reports available from acornAvailable', () => {
    const scanner = makeFakeScanner();
    scanner.acornAvailable = true;
    assertEqual(new CodeSafetyAdapter(scanner).available, true);

    scanner.acornAvailable = false;
    assertEqual(new CodeSafetyAdapter(scanner).available, false);
  });

  test('tracks scan metrics', () => {
    const scanner = makeFakeScanner();
    const adapter = new CodeSafetyAdapter(scanner);

    adapter.scanCode('a', 'a.js');
    adapter.scanCode('b', 'b.js');

    const m = adapter.getMetrics();
    assertEqual(m.scans, 2);
    assertEqual(m.blocked, 0);
  });

  test('increments blocked count on unsafe code', () => {
    const scanner = makeFakeScanner({ safe: false, severity: 'block', violations: [{ description: 'eval' }], blocked: ['eval'], warnings: [] });
    const adapter = new CodeSafetyAdapter(scanner);

    adapter.scanCode('eval("bad")', 'bad.js');
    assertEqual(adapter.getMetrics().blocked, 1);
  });

  test('increments warnings count', () => {
    const scanner = makeFakeScanner({ safe: true, severity: 'warn', violations: [{ severity: 'warn', description: 'x' }], blocked: [], warnings: ['x'] });
    const adapter = new CodeSafetyAdapter(scanner);

    adapter.scanCode('something', 'f.js');
    assertEqual(adapter.getMetrics().warnings, 1);
  });

  test('getMetrics returns a copy', () => {
    const adapter = new CodeSafetyAdapter(makeFakeScanner());
    const m1 = adapter.getMetrics();
    m1.scans = 999;
    assertEqual(adapter.getMetrics().scans, 0);
  });
});

// ── Static factory ──────────────────────────────────────────

describe('CodeSafetyAdapter.fromScanner()', () => {
  // v7.0.5: Scanner must be passed explicitly (cross-layer require removed)
  const scanner = require('../../src/agent/intelligence/CodeSafetyScanner');

  test('creates adapter from real CodeSafetyScanner module', () => {
    const adapter = CodeSafetyAdapter.fromScanner(scanner);
    assert(adapter instanceof CodeSafetyAdapter);
    assert(adapter instanceof CodeSafetyPort);
    // acorn is vendored in kernel, so should always be available
    assertEqual(adapter.available, true);
  });

  test('scans safe code correctly', () => {
    const adapter = CodeSafetyAdapter.fromScanner(scanner);
    const result = adapter.scanCode('const x = 1 + 2;', 'safe.js');
    assertEqual(result.safe, true);
  });

  test('blocks eval()', () => {
    const adapter = CodeSafetyAdapter.fromScanner(scanner);
    const result = adapter.scanCode('eval("dangerous")', 'evil.js');
    assertEqual(result.safe, false);
  });

  test('throws when called without scanner', () => {
    try {
      CodeSafetyAdapter.fromScanner();
      throw new Error('Should have thrown');
    } catch (e) {
      assert(e.message.includes('requires scannerModule'), 'Should require scanner');
    }
  });
});

// ── MockCodeSafety ──────────────────────────────────────────

describe('MockCodeSafety', () => {
  test('defaults to safe', () => {
    const mock = new MockCodeSafety();
    const result = mock.scanCode('anything', 'f.js');
    assertEqual(result.safe, true);
  });

  test('records scans', () => {
    const mock = new MockCodeSafety();
    mock.scanCode('code1', 'a.js');
    mock.scanCode('code2', 'b.js');
    assertEqual(mock.getScans().length, 2);
    assertEqual(mock.getScans()[0].code, 'code1');
    assertEqual(mock.getScans()[1].filename, 'b.js');
  });

  test('setResult changes output', () => {
    const mock = new MockCodeSafety();
    mock.setResult({ safe: false, severity: 'block', violations: [] });
    assertEqual(mock.scanCode('x', 'f.js').safe, false);
  });

  test('setResult with function', () => {
    const mock = new MockCodeSafety();
    mock.setResult((code) => ({ safe: code.length < 10, severity: 'none', violations: [] }));
    assertEqual(mock.scanCode('short', 'f.js').safe, true);
    assertEqual(mock.scanCode('this is a long piece of code', 'f.js').safe, false);
  });

  test('setAvailable controls available flag', () => {
    const mock = new MockCodeSafety();
    assertEqual(mock.available, true);
    mock.setAvailable(false);
    assertEqual(mock.available, false);
  });

  test('reset clears scan history', () => {
    const mock = new MockCodeSafety();
    mock.scanCode('x', 'f.js');
    mock.reset();
    assertEqual(mock.getScans().length, 0);
  });

  test('is instanceof CodeSafetyPort', () => {
    assert(new MockCodeSafety() instanceof CodeSafetyPort);
  });
});

// ── DI wiring verification ──────────────────────────────────

describe('DI wiring (cross-layer check)', () => {
  test('ports/index.js exports CodeSafety types', () => {
    const ports = require('../../src/agent/ports/index');
    assert(ports.CodeSafetyPort);
    assert(ports.CodeSafetyAdapter);
    assert(ports.MockCodeSafety);
  });

  test('manifest phase2 registers codeSafety service', () => {
    const fs = require('fs');
    const content = fs.readFileSync('src/agent/manifest/phase2-intelligence.js', 'utf-8');
    assert(content.includes("'codeSafety'"), 'codeSafety service must be in manifest');
    assert(content.includes('CodeSafetyAdapter'), 'must use CodeSafetyAdapter');
  });

  test('no direct intelligence/ imports from capabilities layer', () => {
    const fs = require('fs');
    const path = require('path');
    const capDir = path.join('src', 'agent', 'capabilities');
    const files = fs.readdirSync(capDir).filter(f => f.endsWith('.js'));
    const violations = [];

    for (const f of files) {
      const content = fs.readFileSync(path.join(capDir, f), 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue;
        // Allow lazy fallback in PluginRegistry (goes through ports/)
        if (f === 'PluginRegistry.js') continue;
        if (/require\s*\(\s*['"]\.\.\/intelligence\//.test(line)) {
          violations.push(`${f}:${i + 1}: ${line.trim()}`);
        }
      }
    }

    assertEqual(violations.length, 0, `Cross-layer violations: ${violations.join('; ')}`);
  });

  test('no direct intelligence/ imports from hexagonal layer', () => {
    const fs = require('fs');
    const path = require('path');
    const hexDir = path.join('src', 'agent', 'hexagonal');
    const files = fs.readdirSync(hexDir).filter(f => f.endsWith('.js'));
    const violations = [];

    for (const f of files) {
      const content = fs.readFileSync(path.join(hexDir, f), 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue;
        if (/require\s*\(\s*['"]\.\.\/intelligence\//.test(line)) {
          violations.push(`${f}:${i + 1}: ${line.trim()}`);
        }
      }
    }

    assertEqual(violations.length, 0, `Cross-layer violations: ${violations.join('; ')}`);
  });
});

run();
