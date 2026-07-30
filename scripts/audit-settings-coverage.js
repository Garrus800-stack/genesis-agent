#!/usr/bin/env node
// ============================================================
// GENESIS — scripts/audit-settings-coverage.js
//
// docs/SETTINGS.md describes settings under readable labels ("IdleMind
// score normalization"); the code knows them as key paths
// (idleMind.scoreNormalization). Nothing connected the two, so nothing
// could check whether the documentation still told the truth — and twice
// during the v7.9.47 audit a measurement went wrong for exactly that
// reason, once nearly "correcting" a changelog line that was right.
//
// Rows are gaining their key path in backticks. This gate guards every
// row that HAS one, in two directions:
//
//   1. the documented key must exist in the live default tree, and
//   2. the documented default must equal the live default.
//
// The second check is the one that matters. Existence alone cannot catch
// a WRONG assignment: put "Daemon enabled" on idleMind.enabled and the key
// exists, the row is documented, and both halves pass while the statement
// is false. The default value is the cross-check that already sat in the
// document unused — 82 of 97 rows carry one.
//
// Rows without a key path are counted, not failed: assigning the
// remaining ones is careful hand work, and a gate that forces guessing
// would produce exactly the false claims it exists to prevent.
//
// Exit codes: 0 clean (or no --strict), 1 violations found with --strict.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STRICT = process.argv.includes('--strict');
const DOC = path.join(ROOT, 'docs', 'SETTINGS.md');

const red = (s) => `\u001b[31m${s}\u001b[0m`;
const green = (s) => `\u001b[32m${s}\u001b[0m`;
const dim = (s) => `\u001b[2m${s}\u001b[0m`;

function liveDefaults() {
  const { defaultSettings } = require(path.join(ROOT, 'src/agent/foundation/SettingsDefaults.js'));
  return defaultSettings();
}

function at(tree, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), tree);
}

/** Compare a documented default (as written) with the live value. */
function defaultMatches(documented, live) {
  const a = String(documented).replace(/_/g, '').trim().replace(/^['"`]|['"`]$/g, '');
  const b = live === undefined ? 'undefined' : JSON.stringify(live);
  const bPlain = String(live);
  if (a === b || a === bPlain) return true;
  if (a === "''" && live === '') return true;
  if ((a === '[]' || a === '{}') && b === a) return true;
  // numbers written with separators or units, e.g. `180_000` or `600000`
  if (/^\d+$/.test(a) && String(Number(a)) === bPlain) return true;
  return false;
}

const src = fs.readFileSync(DOC, 'utf8');
const rows = src.split('\n')
  .map((line, i) => ({ line, no: i + 1 }))
  .filter(({ line }) => line.startsWith('| ') && line.split('|').length >= 4 && !/^\|\s*-+/.test(line));

const defaults = liveDefaults();
const violations = [];
let withKey = 0; let checkedDefault = 0;

for (const { line, no } of rows) {
  const cells = line.split('|');
  const keyMatch = /`([a-z][\w]*(?:\.[\w*]+)+)`/.exec(cells[1] || '');
  if (!keyMatch) continue;
  const key = keyMatch[1];
  withKey++;
  if (key.includes('*')) continue; // wildcard rows describe a family

  const live = at(defaults, key);
  if (live === undefined) {
    violations.push({ no, key, why: 'key does not exist in the default tree' });
    continue;
  }
  const docDefault = /`([^`]+)`/.exec(cells[2] || '');
  if (!docDefault) continue;
  checkedDefault++;
  if (!defaultMatches(docDefault[1], live)) {
    violations.push({
      no, key,
      why: `documented default ${docDefault[1]} vs live ${JSON.stringify(live)}`,
    });
  }
}

console.log('\n  Genesis — settings coverage');
console.log(dim('  ─────────────────────────────'));
console.log(`  Rows in SETTINGS.md:      ${rows.length}`);
console.log(`  …carrying a key path:     ${withKey}`);
console.log(`  …default cross-checked:   ${checkedDefault}`);
console.log(`  Rows still without a key: ${dim(String(rows.length - withKey))} ${dim('(hand work, not a failure)')}`);

if (violations.length) {
  console.log(red(`\n  ✗ ${violations.length} violation(s):`));
  for (const v of violations) console.log(`    SETTINGS.md:${v.no}  ${v.key} — ${v.why}`);
  console.log(dim('\n  A documented key must exist, and its documented default must match'));
  console.log(dim('  the live one. Existence alone cannot catch a wrong assignment.'));
  if (STRICT) process.exit(1);
} else {
  console.log(green('\n  ✅ Every documented key exists and every documented default matches.'));
}
process.exit(0);
