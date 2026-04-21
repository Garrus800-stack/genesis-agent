#!/usr/bin/env node
// ============================================================
// GENESIS — check-stale-refs.js (v7.3.6)
//
// Two modes:
//   (1) Symbol scan — greps known-deleted identifiers (e.g. renamed
//       classes, split files) in src/ and docs/. Catches stale
//       references left behind by refactors.
//   (2) Contract check — verifies that tests with a given prefix
//       (e.g. 'gate contract: ') exist in at least a minimum count.
//       Guards behavioural contracts: if someone later renames or
//       deletes a regression-critical test, this fails loudly.
//
// The `contracts` section in stale-refs.json is OPTIONAL. Missing
// or empty → 0 contracts to check, no error. This is important so
// that #11's minCount-bump can land in a single commit with its
// test additions without breaking intermediate checkouts.
//
// Exit 0 → all clean.  Exit 1 → stale references found or
//   contract below threshold.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'scripts', 'stale-refs.json');

// ── ANSI colors ─────────────────────────────────────────────
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
const red    = (s) => c('31', s);
const green  = (s) => c('32', s);
const yellow = (s) => c('33', s);
const dim    = (s) => c('90', s);

// ── Utilities ───────────────────────────────────────────────

function getAllFiles(dir, exts) {
  const out = [];
  function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); }
    catch (_) { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        walk(full);
      } else if (exts.some(x => e.name.endsWith(x))) {
        out.push(full);
      }
    }
  }
  walk(dir);
  return out;
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(red(`✗ ${CONFIG_PATH} not found`));
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    console.error(red(`✗ Failed to parse stale-refs.json: ${err.message}`));
    process.exit(1);
  }
}

function shouldExclude(filePath, config) {
  const excludes = config._excludePaths || [];
  const rel = path.relative(ROOT, filePath);
  return excludes.some(ex => rel === ex || rel.startsWith(ex + path.sep));
}

// ── Mode 1: Symbol scan ─────────────────────────────────────

function scanSymbols(config) {
  const symbols = config.symbols || [];
  if (symbols.length === 0) {
    console.log(dim('  (no symbols configured)'));
    return { checked: 0, hits: [] };
  }

  const scanRoots = (config._scanRoots || ['src', 'docs']).map(r => path.join(ROOT, r));
  const allFiles = [];
  for (const r of scanRoots) {
    if (fs.existsSync(r)) {
      allFiles.push(...getAllFiles(r, ['.js', '.md']));
    }
  }
  const filtered = allFiles.filter(f => !shouldExclude(f, config));

  const hits = [];
  for (const sym of symbols) {
    // Use word boundaries to avoid false positives on generic names
    const pattern = new RegExp(`\\b${escapeRegex(sym.name)}\\b`);
    for (const file of filtered) {
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) {
          hits.push({
            symbol: sym.name,
            file: path.relative(ROOT, file),
            line: i + 1,
            text: lines[i].trim().slice(0, 120),
            note: sym.note,
          });
        }
      }
    }
  }
  return { checked: symbols.length, hits };
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Mode 2: Contract check (graceful — Iter 4 R) ────────────

function checkContracts(config) {
  // Graceful: missing or empty `contracts` section == 0 contracts to check
  const contracts = config.contracts || [];
  if (contracts.length === 0) {
    return { checked: 0, failures: [] };
  }

  const testDir = path.join(ROOT, 'test');
  if (!fs.existsSync(testDir)) {
    return { checked: contracts.length, failures: [
      { contract: '(all)', reason: 'test/ directory not found' }
    ] };
  }
  const testFiles = getAllFiles(testDir, ['.js']);

  const failures = [];
  for (const contract of contracts) {
    const { prefix, minCount } = contract;
    if (typeof prefix !== 'string' || typeof minCount !== 'number') {
      failures.push({
        contract: JSON.stringify(contract),
        reason: 'invalid contract entry (need prefix:string, minCount:number)',
      });
      continue;
    }
    // Grep tests for the prefix, e.g. test('gate contract: ...')
    let found = 0;
    const searchRe = new RegExp(
      `(?:test|it)\\s*\\(\\s*['"\`]${escapeRegex(prefix)}`,
      'g'
    );
    for (const file of testFiles) {
      const content = fs.readFileSync(file, 'utf8');
      const matches = content.match(searchRe);
      if (matches) found += matches.length;
    }
    if (found < minCount) {
      failures.push({
        contract: prefix,
        minCount,
        found,
        reason: `only ${found} tests with prefix "${prefix}" found, expected ≥ ${minCount}`,
      });
    } else {
      // Record success for reporting
      failures.push({ contract: prefix, found, minCount, _ok: true });
    }
  }
  return { checked: contracts.length, failures };
}

// ── Main ────────────────────────────────────────────────────

function main() {
  const config = loadConfig();

  console.log('');
  console.log('  GENESIS — Stale-Reference & Contract Check');
  console.log('  ──────────────────────────────────────────');

  // Mode 1
  console.log(dim('\n  Mode 1: Symbol scan'));
  const sym = scanSymbols(config);
  if (sym.hits.length === 0) {
    console.log(green(`  ✓ ${sym.checked} known-deleted symbols — 0 stale references`));
  } else {
    console.log(red(`  ✗ ${sym.hits.length} stale reference(s) found:`));
    for (const hit of sym.hits) {
      console.log(`    ${hit.file}:${hit.line}  →  ${hit.symbol}`);
      console.log(dim(`       ${hit.text}`));
      if (hit.note) console.log(dim(`       (${hit.note})`));
    }
  }

  // Mode 2
  console.log(dim('\n  Mode 2: Contract check'));
  const con = checkContracts(config);
  if (con.checked === 0) {
    console.log(dim('  (0 contracts to check)'));
  } else {
    const fails = con.failures.filter(f => !f._ok);
    const oks = con.failures.filter(f => f._ok);
    for (const ok of oks) {
      console.log(green(
        `  ✓ "${ok.contract}" — ${ok.found} test(s) found (min ${ok.minCount})`
      ));
    }
    for (const f of fails) {
      console.log(red(`  ✗ ${f.reason || f.contract}`));
    }
  }

  // Summary
  const failureCount = sym.hits.length + con.failures.filter(f => !f._ok).length;
  console.log('');
  if (failureCount === 0) {
    console.log(green('  All checks passed.'));
    process.exit(0);
  } else {
    console.log(red(`  ${failureCount} problem(s) found.`));
    process.exit(1);
  }
}

// Export for testing
module.exports = { scanSymbols, checkContracts, loadConfig };

if (require.main === module) main();
