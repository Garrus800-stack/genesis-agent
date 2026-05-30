#!/usr/bin/env node
// ============================================================
// GENESIS — test/modules/v7915-allow-scripts.contract.test.js
//
// v7.9.15: the install-script policy moves from the inert
// trustedDependencies field to npm's native allowScripts field.
//
// npm 11 warns at install time about packages with install scripts:
//   - esbuild             (postinstall: platform binary)
//   - puppeteer           (postinstall: Chrome-for-Testing download)
//   - electron-winstaller (install: 7z arch select)
//
// All three are legitimate and load-bearing — Genesis cannot build
// without them. trustedDependencies (a Bun-origin field) never
// governed npm's install-script gate; npm reads allowScripts. The
// entries are name-only (allow any installed version), so a routine
// dependency bump does not resurface the warning.
//
// This test guards four things:
//   1. allowScripts exists as an object with the three names allowed.
//   2. The allowlist is exactly those three — no silent accumulation.
//   3. The superseded trustedDependencies field is gone.
//   4. Each allowed name is a real (dev-/optional-/transitive) dep.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..', '..');
const pkg = require(path.join(ROOT, 'package.json'));

const EXPECTED = ['esbuild', 'puppeteer', 'electron-winstaller'];

describe('v7.9.15 — allowScripts install-script policy', () => {

  test('allowScripts exists and is an object', () => {
    assert('allowScripts' in pkg, 'package.json must define allowScripts');
    assert(pkg.allowScripts && typeof pkg.allowScripts === 'object' && !Array.isArray(pkg.allowScripts),
      'allowScripts must be an object map (name -> true)');
  });

  test('allowScripts allows the three install-script packages', () => {
    for (const name of EXPECTED) {
      assert(pkg.allowScripts[name] === true,
        `allowScripts must allow '${name}' (set to true) — one of the three packages npm warns about`);
    }
  });

  test('allowScripts has no extra entries beyond the expected three', () => {
    // Keeps the allowlist minimal. Any future addition must be a
    // deliberate change to this test, not a silent accumulation.
    const keys = Object.keys(pkg.allowScripts);
    assertEqual(keys.length, EXPECTED.length,
      `allowScripts must have exactly ${EXPECTED.length} entries (have ${keys.length}: ${JSON.stringify(keys)})`);
  });

  test('the superseded trustedDependencies field is gone', () => {
    assert(!('trustedDependencies' in pkg),
      'trustedDependencies was replaced by allowScripts in v7.9.15 and must not linger as a dead field');
  });

  test('every allowScripts entry is a real (dev-)dependency', () => {
    // Anti-typo guard: an entry that does not match any installed
    // dependency is wasted air, or worse, hides a typo of the real
    // package name that the maintainer thinks they covered.
    const allDeps = new Set([
      ...Object.keys(pkg.dependencies || {}),
      ...Object.keys(pkg.devDependencies || {}),
      ...Object.keys(pkg.optionalDependencies || {}),
    ]);

    for (const name of Object.keys(pkg.allowScripts)) {
      // electron-winstaller is transitive (comes in via the electron
      // toolchain), so we cannot demand top-level presence for it. But
      // we DO demand a real package in the lockfile when one exists.
      if (allDeps.has(name)) continue;

      try {
        const lockfile = require(path.join(ROOT, 'package-lock.json'));
        const inLock = Object.keys(lockfile.packages || {}).some(p => p.endsWith('/' + name) || p === 'node_modules/' + name);
        assert(inLock,
          `'${name}' is allowed but neither a direct dep nor present in package-lock.json — likely a typo`);
      } catch (e) {
        // No lockfile in a development checkout is fine; skip the check.
        if (e.code !== 'MODULE_NOT_FOUND') throw e;
      }
    }
  });

  test('allowScripts sits between optionalDependencies and overrides (consistent ordering)', () => {
    // Position matters for diff-readability — keep the dep-related
    // blocks grouped together rather than scattered across the file.
    const src = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
    const optIdx = src.indexOf('"optionalDependencies"');
    const allowIdx = src.indexOf('"allowScripts"');
    const overIdx = src.indexOf('"overrides"');
    assert(optIdx > 0 && allowIdx > 0 && overIdx > 0, 'all three keys must exist');
    assert(optIdx < allowIdx && allowIdx < overIdx,
      'ordering must be: optionalDependencies → allowScripts → overrides');
  });

});

if (require.main === module) run();
