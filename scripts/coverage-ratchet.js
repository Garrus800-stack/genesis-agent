#!/usr/bin/env node
// ============================================================
// GENESIS — scripts/coverage-ratchet.js (v7.1.2)
//
// Reads c8 coverage output (text format) and ratchets up
// thresholds in package.json to (actual - buffer).
//
// v7.1.2: Default buffer reduced 3 → 1 for tighter protection.
// Only ratchets UP (never lowers thresholds, even if coverage drops).
//
// Usage:
//   npm run test:coverage 2>&1 | node scripts/coverage-ratchet.js
//   node scripts/coverage-ratchet.js --dry-run < coverage.txt
//   node scripts/coverage-ratchet.js --buffer 2   (default: 1)
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const bufferIdx = args.indexOf('--buffer');
const buffer = bufferIdx >= 0 ? parseInt(args[bufferIdx + 1], 10) : 1;

const PKG_PATH = path.join(__dirname, '..', 'package.json');

// Read stdin (piped coverage output)
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const coverage = parseCoverage(input);
  if (!coverage) {
    console.error('[RATCHET] Could not parse coverage from input');
    console.error('[RATCHET] Usage: npm run test:coverage 2>&1 | node scripts/coverage-ratchet.js');
    process.exit(1);
  }

  console.log(`[RATCHET] Actual coverage:`);
  console.log(`  Lines:     ${coverage.lines}%`);
  console.log(`  Branches:  ${coverage.branches}%`);
  console.log(`  Functions: ${coverage.functions}%`);
  console.log(`  Buffer:    ${buffer}%`);

  const newLines = Math.max(0, Math.floor(coverage.lines - buffer));
  const newBranches = Math.max(0, Math.floor(coverage.branches - buffer));
  const newFunctions = Math.max(0, Math.floor(coverage.functions - buffer));

  // v7.1.2: Ratchet only goes UP — read current thresholds and take max
  const pkg = fs.readFileSync(PKG_PATH, 'utf8');
  const curLines = parseInt((pkg.match(/--lines (\d+)/) || [])[1] || '0', 10);
  const curBranches = parseInt((pkg.match(/--branches (\d+)/) || [])[1] || '0', 10);
  const curFunctions = parseInt((pkg.match(/--functions (\d+)/) || [])[1] || '0', 10);

  const finalLines = Math.max(newLines, curLines);
  const finalBranches = Math.max(newBranches, curBranches);
  const finalFunctions = Math.max(newFunctions, curFunctions);

  console.log(`[RATCHET] New thresholds:`);
  console.log(`  Lines:     ${finalLines}%${finalLines > curLines ? ` (was ${curLines}%)` : ' (unchanged)'}`);
  console.log(`  Branches:  ${finalBranches}%${finalBranches > curBranches ? ` (was ${curBranches}%)` : ' (unchanged)'}`);
  console.log(`  Functions: ${finalFunctions}%${finalFunctions > curFunctions ? ` (was ${curFunctions}%)` : ' (unchanged)'}`);

  if (dryRun) {
    console.log('[RATCHET] Dry run — no changes written');
    return;
  }

  // Update package.json
  const updated = pkg
    .replace(/--lines \d+/g, `--lines ${finalLines}`)
    .replace(/--branches \d+/g, `--branches ${finalBranches}`)
    .replace(/--functions \d+/g, `--functions ${finalFunctions}`);

  if (updated === pkg) {
    console.log('[RATCHET] No changes needed — thresholds already current');
    return;
  }

  fs.writeFileSync(PKG_PATH, updated, 'utf8');
  console.log('[RATCHET] ✅ package.json updated');
});

/**
 * Parse c8 text coverage output for the "All files" summary line.
 * Format: "All files  |  XX.XX |  XX.XX |  XX.XX |  XX.XX |"
 */
function parseCoverage(text) {
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.includes('All files')) {
      const numbers = line.match(/(\d+\.?\d*)/g);
      if (numbers && numbers.length >= 3) {
        return {
          lines: parseFloat(numbers[1]),     // Stmts is [0], Lines is [1] in some formats
          branches: parseFloat(numbers[2]),
          functions: parseFloat(numbers[3] || numbers[2]),
        };
      }
      // Alternative: pick by position
      const parts = line.split('|').map(s => s.trim()).filter(Boolean);
      if (parts.length >= 5) {
        return {
          lines: parseFloat(parts[1]),
          branches: parseFloat(parts[2]),
          functions: parseFloat(parts[3]),
        };
      }
    }
  }
  return null;
}
