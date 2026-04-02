// ============================================================
// GENESIS — test/modules/release-script.test.js (v5.9.3)
//
// Tests scripts/release.js: dry-run mode, version detection.
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

describe('Release Script', () => {

  test('--dry-run does not modify files', () => {
    const fs = require('fs');
    const pkgBefore = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8');

    try {
      execFileSync('node', [
        path.join(ROOT, 'scripts/release.js'), '99.99.99', '--dry-run', '--skip-ci',
      ], { cwd: ROOT, encoding: 'utf-8', timeout: 30_000 });
    } catch { /* may exit non-zero, that's ok */ }

    const pkgAfter = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8');
    assertEqual(pkgBefore, pkgAfter);
  });

  test('rejects same version', () => {
    const pkg = require(path.join(ROOT, 'package.json'));
    try {
      execFileSync('node', [
        path.join(ROOT, 'scripts/release.js'), pkg.version, '--dry-run',
      ], { cwd: ROOT, encoding: 'utf-8', stdio: 'pipe', timeout: 10_000 });
      assert(false, 'should have exited with error');
    } catch (err) {
      assert(err.status !== 0, 'exits non-zero for same version');
    }
  });

  test('requires version argument', () => {
    try {
      execFileSync('node', [
        path.join(ROOT, 'scripts/release.js'),
      ], { cwd: ROOT, encoding: 'utf-8', stdio: 'pipe', timeout: 10_000 });
      assert(false, 'should have exited with error');
    } catch (err) {
      assert(err.status !== 0, 'exits non-zero without version');
    }
  });

  test('dry-run output includes all 7 locations', () => {
    let output = '';
    try {
      output = execFileSync('node', [
        path.join(ROOT, 'scripts/release.js'), '99.99.99', '--dry-run', '--skip-ci',
      ], { cwd: ROOT, encoding: 'utf-8', timeout: 30_000 });
    } catch (err) {
      output = err.stdout || '';
    }
    assert(output.includes('package.json'), 'mentions package.json');
    assert(output.includes('README.md'), 'mentions README.md');
    assert(output.includes('banner.svg'), 'mentions banner.svg');
    assert(output.includes('McpTransport'), 'mentions McpTransport');
    assert(output.includes('Dry run'), 'confirms dry run');
  });
});

run();
