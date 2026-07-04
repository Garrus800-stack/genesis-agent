#!/usr/bin/env node
// ============================================================
// GENESIS — scripts/sync-doc-numbers.js
//
// Writes the live source-module count, test-file count, and
// architectural-fitness score into every documentation location
// that audit-doc-drift.js and audit-service-numbers.js verify.
//
// Why this exists: a refactor that splits a file, or any change
// that adds a module or a test, shifts these counts across five
// docs. Editing them by hand is what produced the recurring
// "one fixed, another drifted" red audits. This recomputes the
// live values (the SAME way the audits measure them) and rewrites
// the docs to match — so every intermediate step stays fully
// green instead of relying on a remembered exception list.
//
// It only ever writes the live number in place of whatever number
// currently sits in each anchored slot; it is idempotent and never
// touches anything but those numeric slots. Version tags are NOT
// handled here (a version bump is a separate, deliberate step).
//
// Usage:
//   node scripts/sync-doc-numbers.js          # write + report
//   node scripts/sync-doc-numbers.js --check   # report only, exit 1 if any slot is stale
// ============================================================

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CHECK_ONLY = process.argv.includes('--check');

// ── Live values (measured exactly like the audits measure them) ──
function walkCount(dir, suffix) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) n += walkCount(full, suffix);
    else if (e.isFile() && e.name.endsWith(suffix)) n += 1;
  }
  return n;
}
function liveFitness() {
  // Subprocess + parse "Score: NNN/130", matching audit-doc-drift.js.
  let out = '';
  try {
    out = execSync('node scripts/architectural-fitness.js', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    out = (e.stdout || '').toString();
  }
  const m = /Score:\s*(\d+)\s*\/\s*130/.exec(out);
  return m ? parseInt(m[1], 10) : null;
}

const MODULES = walkCount(path.join(ROOT, 'src'), '.js');
const TESTS = walkCount(path.join(ROOT, 'test'), '.test.js');
const FITNESS = liveFitness();

// ── Anchored numeric slots. Each regex captures the number as group 1;
// the surrounding context is distinctive enough not to grab anything else.
// Every rule is applied to every doc — a non-matching rule is a no-op, so
// there is no need to track which number lives in which file. ──
const RULES = [
  // Source modules
  { name: 'module badge',        re: /(modules-)(\d{2,4})/g,                     val: () => MODULES },
  { name: 'source modules',      re: /\b(\d{2,4})(\s+source modules?\b)/gi,      val: () => MODULES, grp: 1 },
  { name: 'JS files',            re: /\b(\d{2,4})(\s+JS files\b)/gi,             val: () => MODULES, grp: 1 },
  { name: 'modules in src',      re: /\b(\d{2,4})(\s+modules\s+(?:in\s+)?src\/)/gi, val: () => MODULES, grp: 1 },
  { name: 'src total modules',   re: /(src\/\s+total\s+)(\d{2,4})(\s+modules)/gi, val: () => MODULES, grp: 2 },
  // Fitness score
  { name: 'fitness badge',       re: /(fitness-)(\d{1,3})(%2F130)/gi,            val: () => FITNESS, grp: 2 },
  { name: 'fitness table pipe',  re: /(\|\s*)(\d{1,3})(\/130\s*\|)/g,            val: () => FITNESS, grp: 2 },
  { name: 'fitness prose',       re: /(fitness\s*\|\s*)(\d{1,3})(\/130)/gi,      val: () => FITNESS, grp: 2 },
  // Test files
  { name: 'test-suite table',    re: /\b(\d{2,4})(\s+files,\s+\d+\s+tests)/gi,   val: () => TESTS, grp: 1 },
  { name: 'test files slash',    re: /\b(\d{2,4})(\s*\/\s*9007)/g,               val: () => TESTS, grp: 1 },
  { name: 'test files count',    re: /\b(\d{2,4})(\s+test files\b)/gi,           val: () => TESTS, grp: 1 },
];

const DOCS = [
  'README.md',
  'ARCHITECTURE.md',
  'docs/ARCHITECTURE-DEEP-DIVE.md',
  'docs/CAPABILITIES.md',
];

let anyStale = false;
const report = [];

for (const rel of DOCS) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) continue;
  let content = fs.readFileSync(file, 'utf8');
  const before = content;
  for (const rule of RULES) {
    const grp = rule.grp || 2; // default: number is the last-but capturing group per rule
    content = content.replace(rule.re, (...args) => {
      // args: full, g1, g2, [g3], offset, string, groups
      const groups = args.slice(1, -2); // capture groups only
      const target = String(rule.val());
      const current = groups[grp - 1];
      if (current !== undefined && current !== target) {
        report.push(`  ${rel}: ${rule.name} ${current} → ${target}`);
        anyStale = true;
      }
      groups[grp - 1] = target;
      return groups.join('');
    });
  }
  if (content !== before && !CHECK_ONLY) fs.writeFileSync(file, content);
}

console.log(`Live values — source modules: ${MODULES}, test files: ${TESTS}, fitness: ${FITNESS}/130`);
if (report.length === 0) {
  console.log('  ✅ All numeric doc slots already match live values.');
  process.exit(0);
}
console.log(CHECK_ONLY ? '  ⚠ Stale slots (run without --check to fix):' : '  ✏ Updated:');
for (const line of report) console.log(line);
process.exit(CHECK_ONLY ? 1 : 0);
