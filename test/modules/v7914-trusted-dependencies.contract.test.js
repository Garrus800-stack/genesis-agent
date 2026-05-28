#!/usr/bin/env node
// ============================================================
// GENESIS — test/modules/v7914-trusted-dependencies.contract.test.js
//
// v7.9.14 (Punkt 3): explicit allowlist of legitimate install-scripts
// via the trustedDependencies field in package.json.
//
// npm 10/11 warns at install time about packages with install scripts:
//   - esbuild           (postinstall: downloads platform binary)
//   - puppeteer         (postinstall: downloads Chrome-for-Testing)
//   - electron-winstaller (install: selects 7z arch)
//
// All three are legitimate and load-bearing — Genesis cannot build
// without them. trustedDependencies originated in Bun (~2023) and is
// documented as supported in npm v10.3+, though the warning-suppress
// behaviour is not guaranteed across all current npm versions. The
// documentary value stands either way: anyone auditing the project's
// supply-chain surface sees the three allowed scripts explicitly.
//
// This test guards two things:
//   1. The field exists with the three expected names.
//   2. Each name is a real (dev-)dependency. A typo'd entry would
//      sit in trustedDependencies as a dead stub — this test catches
//      that.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const pkg = require(path.join(ROOT, 'package.json'));

const EXPECTED = ['esbuild', 'puppeteer', 'electron-winstaller'];

describe('v7.9.14 (Punkt 3) — trustedDependencies allowlist', () => {

  test('trustedDependencies field exists and is an array', () => {
    assert('trustedDependencies' in pkg, 'package.json must define trustedDependencies');
    assert(Array.isArray(pkg.trustedDependencies), 'trustedDependencies must be an array');
  });

  test('trustedDependencies contains the three expected install-script packages', () => {
    for (const name of EXPECTED) {
      assert(pkg.trustedDependencies.includes(name),
        `trustedDependencies must contain '${name}' (one of the three packages npm warns about)`);
    }
  });

  test('trustedDependencies has no extra entries beyond the expected three', () => {
    // Keeps the allowlist minimal. Any future addition must be a
    // deliberate change to this test, not a silent accumulation.
    assertEqual(pkg.trustedDependencies.length, EXPECTED.length,
      `trustedDependencies must have exactly ${EXPECTED.length} entries (have ${pkg.trustedDependencies.length}: ${JSON.stringify(pkg.trustedDependencies)})`);
  });

  test('every trustedDependencies entry is a real (dev-)dependency', () => {
    // Anti-typo guard: an entry that does not match any installed
    // dependency is wasted air, or worse, hides a typo of the real
    // package name that the maintainer thinks they covered.
    const allDeps = new Set([
      ...Object.keys(pkg.dependencies || {}),
      ...Object.keys(pkg.devDependencies || {}),
      ...Object.keys(pkg.optionalDependencies || {}),
    ]);

    for (const name of pkg.trustedDependencies) {
      // electron-winstaller is transitive (comes in via electron-builder
      // toolchain), so we cannot demand top-level presence for it. But
      // we DO demand a real package in the lockfile.
      if (allDeps.has(name)) continue;

      // Check lockfile as fallback for transitive deps
      try {
        const lockfile = require(path.join(ROOT, 'package-lock.json'));
        const inLock = Object.keys(lockfile.packages || {}).some(p => p.endsWith('/' + name) || p === 'node_modules/' + name);
        assert(inLock,
          `'${name}' is in trustedDependencies but neither a direct dep nor present in package-lock.json — likely a typo`);
      } catch (e) {
        // No lockfile? In a development checkout this is fine; skip the check.
        if (e.code !== 'MODULE_NOT_FOUND') throw e;
      }
    }
  });

  test('trustedDependencies sits between optionalDependencies and overrides (consistent ordering)', () => {
    // Position matters for diff-readability — keep the dep-related
    // blocks grouped together rather than scattered across the file.
    const fs = require('fs');
    const src = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
    const optIdx = src.indexOf('"optionalDependencies"');
    const trustIdx = src.indexOf('"trustedDependencies"');
    const overIdx = src.indexOf('"overrides"');
    assert(optIdx > 0 && trustIdx > 0 && overIdx > 0, 'all three keys must exist');
    assert(optIdx < trustIdx && trustIdx < overIdx,
      'ordering must be: optionalDependencies → trustedDependencies → overrides');
  });

});

if (require.main === module) run();
