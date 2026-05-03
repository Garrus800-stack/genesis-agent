#!/usr/bin/env node
// ============================================================
// GENESIS — scripts/audit-contracts.js (v7.5.7)
//
// Discovery-tool for stale-refs.json contracts. Scans test files for
// security-relevant patterns and lists tests that LOOK like they should
// be contract-protected but currently are NOT (no `<prefix> contract: `
// in their test name).
//
// Goal: surface "I should be guarded" tests so a reviewer can decide
// whether to mark them as contracts. The script never adds anything
// automatically — it's a checklist, not a writer.
//
// Heuristic for "security-relevant":
//   File name matches one of: gate, injection, sandbox, safety,
//   preservation, self-gate, immune, security, capability-guard.
//   AND test name uses one of: block, reject, deny, prevent, fail,
//   refuse, throw, must, do not, never, no.
//
// Already-protected tests (those whose names start with a known
// contract prefix from stale-refs.json) are skipped.
//
// USAGE:
//   node scripts/audit-contracts.js          — table of unprotected candidates
//   node scripts/audit-contracts.js --json   — machine-readable
//   node scripts/audit-contracts.js --strict — exit 1 if any candidates found
//
// EXIT CODES:
//   0 : no unprotected candidates (or --strict not set)
//   1 : candidates exist (--strict only)
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TEST_DIR = path.join(ROOT, 'test');
const STALE_REFS = path.join(__dirname, 'stale-refs.json');

const args = process.argv.slice(2);
const jsonOutput = args.includes('--json');
const strict = args.includes('--strict');

const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

// ── Load existing contract prefixes ────────────────────────

function loadContractPrefixes() {
  const config = JSON.parse(fs.readFileSync(STALE_REFS, 'utf8'));
  const contracts = config.contracts || [];
  return contracts.map(c => c.prefix);
}

// ── Test-file scope ────────────────────────────────────────

const SECURITY_FILE_PATTERNS = [
  /gate/i, /injection/i, /sandbox/i, /safety/i,
  /preservation/i, /self-?gate/i, /immune/i,
  /capability.?guard/i, /security/i,
];

function isSecurityRelevantFile(filename) {
  return SECURITY_FILE_PATTERNS.some(re => re.test(filename));
}

// ── Test-name pattern (verbal "block/reject/deny" markers) ─

const SECURITY_NAME_PATTERNS = [
  /\bblock\w*\b/i, /\breject\w*\b/i, /\bdeny\w*\b/i,
  /\bprevent\w*\b/i, /\brefuse\w*\b/i, /\bthrow\w*\b/i,
  /\bmust\b/i, /\bnever\b/i, /\bno\s+\w+\s+(?:bypass|leak|escape)/i,
  /fail-?closed/i, /must\s+not/i, /do\s+not\s+\w+/i,
];

function isSecurityRelevantName(testName) {
  return SECURITY_NAME_PATTERNS.some(re => re.test(testName));
}

// ── Walk test/ for *.test.js, extract test() / it() calls ──

function getAllTestFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...getAllTestFiles(full));
    } else if (entry.name.endsWith('.test.js') || entry.name === 'run-tests.js') {
      out.push(full);
    }
  }
  return out;
}

function extractTestNames(content) {
  // Match  test('name', ...) | test("name", ...) | it('name', ...) | it("name", ...)
  const out = [];
  const re = /\b(?:test|it)\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    out.push({ name: m[2], pos: m.index });
  }
  return out;
}

// ── Main scan ──────────────────────────────────────────────

const contractPrefixes = loadContractPrefixes();
const testFiles = getAllTestFiles(TEST_DIR);

const candidates = [];

for (const file of testFiles) {
  const rel = path.relative(ROOT, file);
  const baseName = path.basename(file);
  if (!isSecurityRelevantFile(baseName)) continue;
  const content = fs.readFileSync(file, 'utf8');
  const tests = extractTestNames(content);
  for (const t of tests) {
    if (!isSecurityRelevantName(t.name)) continue;
    // Skip already-protected
    const isProtected = contractPrefixes.some(p => t.name.startsWith(p));
    if (isProtected) continue;
    candidates.push({
      file: rel,
      name: t.name,
    });
  }
}

// Group by file
const byFile = new Map();
for (const c of candidates) {
  if (!byFile.has(c.file)) byFile.set(c.file, []);
  byFile.get(c.file).push(c.name);
}

// ── Output ─────────────────────────────────────────────────

if (jsonOutput) {
  console.log(JSON.stringify({
    contractPrefixes,
    candidates,
    byFile: Object.fromEntries(byFile),
    summary: {
      filesScanned: testFiles.filter(f => isSecurityRelevantFile(path.basename(f))).length,
      candidateCount: candidates.length,
      filesWithCandidates: byFile.size,
    },
  }, null, 2));
} else {
  console.log('');
  console.log(c.bold('  ╔═══════════════════════════════════════════════╗'));
  console.log(c.bold('  ║   GENESIS CONTRACT-CANDIDATE AUDIT            ║'));
  console.log(c.bold('  ╚═══════════════════════════════════════════════╝'));
  console.log('');
  console.log(`  ${c.dim('Existing contracts:')} ${contractPrefixes.length}`);
  for (const p of contractPrefixes) console.log(`    ${c.dim(p)}`);
  console.log('');
  if (candidates.length === 0) {
    console.log(c.green('  ✅ No unprotected candidates — every security-relevant test name'));
    console.log(c.green('     in security-relevant files starts with a known contract prefix.'));
  } else {
    console.log(c.yellow(`  ⚠  ${candidates.length} unprotected candidate${candidates.length === 1 ? '' : 's'} across ${byFile.size} file${byFile.size === 1 ? '' : 's'}:`));
    console.log('');
    for (const [file, names] of byFile) {
      console.log(`  ${c.bold(file)}`);
      for (const name of names) {
        console.log(`    ${c.dim('•')} ${name}`);
      }
      console.log('');
    }
    console.log(c.dim('  These tests look like they assert security properties (block/reject/'));
    console.log(c.dim('  prevent/etc) but lack a "<x> contract: " prefix. Decide per case:'));
    console.log(c.dim('  is this test a regression-guard whose accidental removal would weaken'));
    console.log(c.dim('  Genesis? If yes, rename with a contract prefix and add to stale-refs.json.'));
  }
  console.log('');
}

if (strict && candidates.length > 0) process.exit(1);
