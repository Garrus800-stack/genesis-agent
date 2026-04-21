#!/usr/bin/env node
// ============================================================
// GENESIS — check-ratchet.js (v7.3.5)
//
// Ratchet enforcement. Reads scripts/ratchet.json for the floor
// values (test count, fitness score, drift thresholds). Runs the
// relevant scripts, compares current state, exits non-zero if any
// floor has been crossed.
//
// Intended for CI, but also runnable locally before a release:
//   node scripts/check-ratchet.js
//
// A ratchet never goes down. If a release legitimately raises the
// baseline (more tests, better fitness), edit ratchet.json AFTER
// the release lands. The script itself never updates the file —
// that's a human decision, so the floor remains meaningful.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RATCHET_PATH = path.join(ROOT, 'scripts', 'ratchet.json');

// ── ANSI colors (best-effort, safe on dumb terminals) ───────
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
const green = s => c('32', s);
const red = s => c('31', s);
const yellow = s => c('33', s);
const cyan = s => c('36', s);
const bold = s => c('1', s);

function die(msg) {
  console.error(red(`✗ ${msg}`));
  process.exit(1);
}

function banner() {
  console.log();
  console.log(bold(cyan('  GENESIS — Ratchet Check')));
  console.log(cyan('  ' + '─'.repeat(34)));
}

function loadRatchet() {
  if (!fs.existsSync(RATCHET_PATH)) die(`ratchet.json not found at ${RATCHET_PATH}`);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(RATCHET_PATH, 'utf8')); }
  catch (err) { die(`ratchet.json parse error: ${err.message}`); }
  return raw;
}

// ── Individual checks ───────────────────────────────────────

function runScript(relativePath, args = []) {
  try {
    return execFileSync(process.execPath, [path.join(ROOT, relativePath), ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    // Some scripts return non-zero on warnings. Capture output anyway.
    return (err.stdout || '') + (err.stderr || '');
  }
}

function checkFitness(floor) {
  const out = runScript('scripts/architectural-fitness.js');
  const m = out.match(/Score:\s+(\d+)\s*\/\s*\d+/);
  if (!m) return { ok: false, reason: 'Could not parse fitness score', current: null, floor };
  const current = parseInt(m[1], 10);
  return { ok: current >= floor, current, floor, reason: current < floor ? `fitness ${current} < floor ${floor}` : null };
}

function checkSchemaMismatches(max) {
  const out = runScript('scripts/scan-schemas.js');
  const m = out.match(/Mismatches:\s+(\d+)/);
  if (!m) return { ok: false, reason: 'Could not parse schema mismatches', current: null, max };
  const current = parseInt(m[1], 10);
  return { ok: current <= max, current, max, reason: current > max ? `${current} mismatches > max ${max}` : null };
}

function checkSchemaAudit() {
  // audit-schemas.js is the static drift checker (missing / orphan)
  const out = runScript('scripts/audit-schemas.js');
  const missing = (out.match(/Missing schemas?:\s+(\d+)/i) || [null, '?'])[1];
  const orphan = (out.match(/Orphan schemas?:\s+(\d+)/i) || [null, '?'])[1];
  return { missing: parseInt(missing, 10), orphan: parseInt(orphan, 10), rawOutput: out };
}

function checkTestCount(floor) {
  // Run the full suite and count passed tests. Match the style of
  // Genesis' own test index output: "N passed · M failed".
  const out = runScript('test/index.js');
  // Find the final summary line (there may be multiple per-suite summaries)
  const matches = [...out.matchAll(/(\d+)\s+passed\s*[·,\-]/g)].map(m => parseInt(m[1], 10));
  if (matches.length === 0) return { ok: false, reason: 'Could not parse test count', current: null, floor };
  // The final match is the overall summary.
  const current = matches[matches.length - 1];
  return { ok: current >= floor, current, floor, reason: current < floor ? `${current} tests < floor ${floor}` : null };
}

// ── Reporting ───────────────────────────────────────────────

function reportCheck(label, r) {
  if (r.ok) {
    let info = '';
    if (r.current !== undefined && r.current !== null) {
      if (r.floor !== undefined) info = ` (${r.current} ≥ ${r.floor})`;
      else if (r.max !== undefined) info = ` (${r.current} ≤ ${r.max})`;
    }
    console.log(`  ${green('✓')} ${label}${info}`);
    return true;
  }
  const info = r.reason ? ` — ${r.reason}` : '';
  console.log(`  ${red('✗')} ${label}${info}`);
  return false;
}

// ── Main ────────────────────────────────────────────────────

function main() {
  banner();
  const ratchet = loadRatchet();
  const failures = [];

  // Parse args — allow skipping the slow test-count check in dev
  const args = process.argv.slice(2);
  const skipTests = args.includes('--skip-tests');

  // Fitness
  const fitnessResult = checkFitness(ratchet.fitnessScore.floor);
  if (!reportCheck('fitness score', fitnessResult)) failures.push('fitness');

  // Schema mismatches
  const mismatchResult = checkSchemaMismatches(ratchet.schemaMismatches.max);
  if (!reportCheck('schema mismatches', mismatchResult)) failures.push('schema-mismatches');

  // Schema audit (missing + orphan)
  const audit = checkSchemaAudit();
  if (Number.isFinite(audit.missing)) {
    const r = { ok: audit.missing <= ratchet.schemaMissing.max, current: audit.missing, max: ratchet.schemaMissing.max,
                reason: audit.missing > ratchet.schemaMissing.max ? `${audit.missing} missing > max ${ratchet.schemaMissing.max}` : null };
    if (!reportCheck('schema missing', r)) failures.push('schema-missing');
  } else {
    console.log(`  ${yellow('⚠')}  schema missing — could not parse (audit-schemas output changed?)`);
  }
  if (Number.isFinite(audit.orphan)) {
    const r = { ok: audit.orphan <= ratchet.schemaOrphan.max, current: audit.orphan, max: ratchet.schemaOrphan.max,
                reason: audit.orphan > ratchet.schemaOrphan.max ? `${audit.orphan} orphan > max ${ratchet.schemaOrphan.max}` : null };
    if (!reportCheck('schema orphan', r)) failures.push('schema-orphan');
  } else {
    console.log(`  ${yellow('⚠')}  schema orphan — could not parse`);
  }

  // Test count (slow — optional skip)
  if (skipTests) {
    console.log(`  ${yellow('⚠')}  test count — skipped (--skip-tests)`);
  } else {
    const testResult = checkTestCount(ratchet.testCount.floor);
    if (!reportCheck('test count', testResult)) failures.push('test-count');
  }

  // Summary
  console.log();
  if (failures.length === 0) {
    console.log(green(bold('  All ratchet checks passed.')));
    process.exit(0);
  } else {
    console.log(red(bold(`  Ratchet violated in: ${failures.join(', ')}`)));
    console.log(yellow('  This is a regression against the locked baseline.'));
    console.log(yellow(`  Either fix the regression, or (if intentional) update scripts/ratchet.json.`));
    process.exit(1);
  }
}

main();
