#!/usr/bin/env node
// ============================================================
// Test: SafeGuard — kernel protection, hash-locks, write validation
// FIX v7.0.8 (T-1): Audit finding — no dedicated unit tests existed.
// ============================================================

const { describe, test, assert, assertEqual, assertThrows, run, createTestRoot } = require('../harness');
const path = require('path');
const fs = require('fs');

const { SafeGuard } = require('../../src/kernel/SafeGuard');

const ROOT = createTestRoot('safeguard');

// Setup: create fake project structure
const kernelDir = path.join(ROOT, 'kernel');
const agentDir = path.join(ROOT, 'agent');
const srcDir = path.join(ROOT, 'src');
fs.mkdirSync(kernelDir, { recursive: true });
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(srcDir, { recursive: true });
fs.writeFileSync(path.join(kernelDir, 'boot.js'), 'const x = 1;');
fs.writeFileSync(path.join(kernelDir, 'guard.js'), 'const y = 2;');
fs.writeFileSync(path.join(agentDir, 'critical.js'), 'const z = 3;');
fs.writeFileSync(path.join(agentDir, 'normal.js'), 'const w = 4;');

describe('SafeGuard — lockKernel', () => {
  test('locks kernel directory and tracks hashes', () => {
    const g = new SafeGuard([kernelDir], ROOT);
    g.lockKernel();
    assert(g.locked, 'should be locked');
    assert(g.kernelHashes.size >= 2, `expected >=2 kernel hashes, got ${g.kernelHashes.size}`);
  });

  test('isProtected returns true for kernel files', () => {
    const g = new SafeGuard([kernelDir], ROOT);
    g.lockKernel();
    assert(g.isProtected(path.join(kernelDir, 'boot.js')), 'kernel file should be protected');
    assert(g.isProtected(kernelDir), 'kernel dir should be protected');
  });

  test('isProtected returns false for non-kernel files', () => {
    const g = new SafeGuard([kernelDir], ROOT);
    g.lockKernel();
    assert(!g.isProtected(path.join(agentDir, 'normal.js')), 'agent file should not be protected');
  });
});

describe('SafeGuard — lockCritical', () => {
  test('hash-locks individual files', () => {
    const g = new SafeGuard([kernelDir], ROOT);
    g.lockKernel();
    const result = g.lockCritical(['agent/critical.js']);
    assertEqual(result.locked, 1);
    assertEqual(result.missing.length, 0);
  });

  test('reports missing files', () => {
    const g = new SafeGuard([kernelDir], ROOT);
    g.lockKernel();
    const result = g.lockCritical(['agent/nonexistent.js']);
    assertEqual(result.locked, 0);
    assertEqual(result.missing.length, 1);
  });

  test('isCritical returns true for locked files', () => {
    const g = new SafeGuard([kernelDir], ROOT);
    g.lockKernel();
    g.lockCritical(['agent/critical.js']);
    assert(g.isCritical(path.resolve(ROOT, 'agent/critical.js')), 'critical file should be detected');
  });

  test('isCritical returns false for non-critical files', () => {
    const g = new SafeGuard([kernelDir], ROOT);
    g.lockKernel();
    g.lockCritical(['agent/critical.js']);
    assert(!g.isCritical(path.resolve(ROOT, 'agent/normal.js')), 'normal file should not be critical');
  });
});

describe('SafeGuard — validateWrite', () => {
  test('allows writes to normal agent files', () => {
    const g = new SafeGuard([kernelDir], ROOT);
    g.lockKernel();
    const ok = g.validateWrite(path.join(agentDir, 'normal.js'));
    assert(ok, 'should allow write to normal file');
  });

  test('blocks writes to kernel files', () => {
    const g = new SafeGuard([kernelDir], ROOT);
    g.lockKernel();
    assertThrows(() => {
      g.validateWrite(path.join(kernelDir, 'boot.js'));
    }, 'should throw on kernel write');
  });

  test('blocks writes to critical files', () => {
    const g = new SafeGuard([kernelDir], ROOT);
    g.lockKernel();
    g.lockCritical(['agent/critical.js']);
    assertThrows(() => {
      g.validateWrite(path.resolve(ROOT, 'agent/critical.js'));
    }, 'should throw on critical file write');
  });

  test('blocks writes outside project root', () => {
    const g = new SafeGuard([kernelDir], ROOT);
    g.lockKernel();
    assertThrows(() => {
      g.validateWrite('/etc/passwd');
    }, 'should throw on write outside root');
  });

  test('blocks writes to node_modules', () => {
    const g = new SafeGuard([kernelDir], ROOT);
    g.lockKernel();
    const nmPath = path.join(ROOT, 'node_modules', 'something.js');
    assertThrows(() => {
      g.validateWrite(nmPath);
    }, 'should throw on node_modules write');
  });

  test('blocks writes to .git directory', () => {
    const g = new SafeGuard([kernelDir], ROOT);
    g.lockKernel();
    const gitPath = path.join(ROOT, '.git', 'config');
    assertThrows(() => {
      g.validateWrite(gitPath);
    }, 'should throw on .git write');
  });
});

describe('SafeGuard — verifyIntegrity', () => {
  test('passes when nothing has changed', () => {
    const g = new SafeGuard([kernelDir], ROOT);
    g.lockKernel();
    g.lockCritical(['agent/critical.js']);
    const result = g.verifyIntegrity();
    assert(result.ok, 'integrity should pass');
    assertEqual(result.issues.length, 0);
  });

  test('detects modified kernel files', () => {
    const g = new SafeGuard([kernelDir], ROOT);
    g.lockKernel();
    // Modify a kernel file directly (bypassing validateWrite)
    const bootPath = path.join(kernelDir, 'boot.js');
    const original = fs.readFileSync(bootPath, 'utf-8');
    fs.writeFileSync(bootPath, 'const x = 999;');
    const result = g.verifyIntegrity();
    assert(!result.ok, 'should detect modification');
    assert(result.issues.some(i => i.issue === 'MODIFIED'), 'should report MODIFIED');
    // Restore
    fs.writeFileSync(bootPath, original);
  });

  test('detects deleted kernel files', () => {
    const tmpFile = path.join(kernelDir, 'temp.js');
    fs.writeFileSync(tmpFile, 'temp');
    const g = new SafeGuard([kernelDir], ROOT);
    g.lockKernel();
    fs.unlinkSync(tmpFile);
    const result = g.verifyIntegrity();
    assert(!result.ok, 'should detect deletion');
    assert(result.issues.some(i => i.issue === 'MISSING'), 'should report MISSING');
  });
});

describe('SafeGuard — getProtectedFiles', () => {
  test('returns all protected files', () => {
    const g = new SafeGuard([kernelDir], ROOT);
    g.lockKernel();
    g.lockCritical(['agent/critical.js']);
    const files = g.getProtectedFiles();
    assert(files.length >= 3, `expected >=3 protected files, got ${files.length}`);
  });
});

run();
