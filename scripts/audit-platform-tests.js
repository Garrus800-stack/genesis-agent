#!/usr/bin/env node
// ============================================================
// GENESIS — scripts/audit-platform-tests.js
//
// Reports which test sub-blocks skip themselves based on
// process.platform. Pattern recognized:
//
//   if (process.platform === 'win32') return;
//   if (process.platform !== 'linux') return;
//   if (process.platform === 'darwin') return;
//   ...with optional && / || combinations (flagged as "conditional")
//
// Output:
//   - human-readable matrix on stdout
//   - JSON snapshot at scripts/platform-tests-baseline.json
//   - delta number: how many more tests run on linux/macOS vs win32
//
// Why this exists: before v7.8.5, RELEASE_NOTES claimed
// "Win 7459 / Linux 7458" — pattern-matched, never measured.
// This audit makes the platform delta data-backed instead.
// Runs as a reporting tool, not a strict CI gate, so adding new
// platform-specific tests does not break CI by surprise.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TEST_DIR = path.join(ROOT, 'test', 'modules');
const BASELINE_PATH = path.join(__dirname, 'platform-tests-baseline.json');

// Recognized platform-skip patterns. Pure = the entire skip condition
// is just process.platform. Conditional = combined with && / || / other.
const PLATFORM_RE   = /process\.platform\s*([=!]==)\s*['"](win32|linux|darwin)['"]/;
const SKIP_LINE_RE  = /\bif\s*\(([^)]*)\)\s*return\s*;?/;
// Block-form skip: `if (process.platform [op] 'X') { ... test(...) ... }`.
// This catches describe-internal branches that define a different set of
// tests per platform — e.g. `if (process.platform !== 'linux') { test(...); test(...); }`
// which is functionally a skip on linux of those tests.
const BLOCK_OPEN_RE = /\bif\s*\(([^)]*process\.platform[^)]*)\)\s*\{/;
const TEST_CALL_RE  = /(?:await\s+)?(?:test|it)\s*\(\s*['"`]([^'"`]+)['"`]/;

function findTestFiles(dir) {
  const out = [];
  function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && /\.test\.js$/.test(entry.name)) out.push(p);
    }
  }
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

// Walk backwards from the skip line to find the enclosing test/it name.
function findEnclosingTestName(lines, skipLineIdx) {
  for (let i = skipLineIdx; i >= Math.max(0, skipLineIdx - 80); i--) {
    const m = lines[i].match(/(?:await\s+)?(?:test|it)\s*\(\s*['"`]([^'"`]+)['"`]/);
    if (m) return m[1];
  }
  return '<unknown>';
}

function classifySkip(condition) {
  const platformMatches = [...condition.matchAll(/process\.platform\s*([=!]==)\s*['"](win32|linux|darwin)['"]/g)];
  if (platformMatches.length === 0) return null;
  const hasOtherLogic = /(&&|\|\|)/.test(condition);
  const skipped = [];
  for (const m of platformMatches) {
    const op = m[1], platform = m[2];
    if (op === '===') skipped.push(platform);
    else if (op === '!==') {
      // skip on everything EXCEPT this platform
      for (const p of ['win32', 'linux', 'darwin']) if (p !== platform) skipped.push(p);
    }
  }
  return {
    skipsOn: [...new Set(skipped)],
    kind: hasOtherLogic ? 'conditional' : 'pure',
  };
}

function scanFile(filePath) {
  const src = fs.readFileSync(filePath, 'utf-8');
  const lines = src.split('\n');
  const findings = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    // Skip comment lines and lines where the pattern is inside a string
    // literal (e.g. unit tests that PASS platform expressions as strings).
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    // Form A — early return: if (process.platform === 'X') return;
    const ret = lines[i].match(SKIP_LINE_RE);
    if (ret && PLATFORM_RE.test(ret[1])) {
      const cls = classifySkip(ret[1]);
      if (cls) {
        findings.push({ testName: findEnclosingTestName(lines, i), line: i + 1, ...cls });
        continue;
      }
    }
    // Form B — describe-internal branch. Trigger only when the line is
    // an actual `if (...)` statement, not text containing one.
    if (trimmed.startsWith('if (') && BLOCK_OPEN_RE.test(lines[i])) {
      const block = lines[i].match(BLOCK_OPEN_RE);
      const cls = classifySkip(block[1]);
      if (!cls) continue;
      const ifInfo  = _scanBlockBraces(lines, i);
      // The closing `}` of the if-block may be on the same line as
      // `else {` — e.g. `  } else {`. Check that line first.
      let elseInfo = null;
      if (/\}\s*else\s*\{/.test(lines[ifInfo.endLine])) {
        elseInfo = _scanBlockBraces(lines, ifInfo.endLine);
      } else {
        for (let j = ifInfo.endLine + 1; j < Math.min(ifInfo.endLine + 4, lines.length); j++) {
          if (/^\s*else\s*\{/.test(lines[j])) {
            elseInfo = _scanBlockBraces(lines, j);
            break;
          }
        }
      }
      // The if-block runs when condition matches → tests inside skip on
      // the OTHER platforms. The else-block runs when condition does NOT
      // match → tests inside skip on platforms that DO match.
      const skippedByIf   = ['win32', 'linux', 'darwin'].filter(p => !cls.skipsOn.includes(p));
      const skippedByElse = cls.skipsOn;
      for (let k = 0; k < ifInfo.testCount; k++) {
        findings.push({
          testName: ifInfo.sampleNames[k] || '<block-test>',
          line: ifInfo.startLine + 1,
          skipsOn: skippedByIf,
          kind: cls.kind,
          blockForm: true,
        });
      }
      if (elseInfo) {
        for (let k = 0; k < elseInfo.testCount; k++) {
          findings.push({
            testName: elseInfo.sampleNames[k] || '<block-test>',
            line: elseInfo.startLine + 1,
            skipsOn: skippedByElse,
            kind: cls.kind,
            blockForm: true,
          });
        }
      }
      i = (elseInfo ? elseInfo.endLine : ifInfo.endLine);
    }
  }
  return findings;
}

// Walk forward from openLineIdx (which contains `{`), track brace depth
// from the FIRST `{` on that line. Closes as soon as depth returns to 0
// AFTER having been opened — so `} else {` on the closing line ends the
// if-block at the `}`, not at the trailing `{`.
function _scanBlockBraces(lines, openLineIdx) {
  let depth = 0;
  let started = false;
  let testCount = 0;
  const sampleNames = [];
  let endLine = openLineIdx;
  for (let i = openLineIdx; i < lines.length; i++) {
    let line = lines[i];
    if (i === openLineIdx) {
      const firstOpen = line.indexOf('{');
      if (firstOpen < 0) continue;
      line = line.slice(firstOpen);
    }
    if (started && i > openLineIdx) {
      const m = line.match(TEST_CALL_RE);
      if (m) { testCount++; sampleNames.push(m[1]); }
    }
    let closed = false;
    for (const ch of line) {
      if (ch === '{') { depth++; started = true; }
      else if (ch === '}') {
        depth--;
        if (started && depth === 0) { closed = true; break; }
      }
    }
    if (closed) { endLine = i; break; }
    endLine = i;
  }
  return { startLine: openLineIdx, endLine, testCount, sampleNames };
}

function buildMatrix() {
  const files = findTestFiles(TEST_DIR);
  const matrix = [];
  let pureWin = 0, pureLinux = 0, pureDarwin = 0, conditional = 0;
  let blockWin = 0, blockLinux = 0;
  for (const f of files) {
    const findings = scanFile(f);
    if (findings.length === 0) continue;
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    matrix.push({ file: rel, findings });
    for (const fi of findings) {
      if (fi.kind === 'conditional') { conditional++; continue; }
      if (fi.skipsOn.includes('win32'))  pureWin++;
      if (fi.skipsOn.includes('linux'))  pureLinux++;
      if (fi.skipsOn.includes('darwin')) pureDarwin++;
      // Block-form findings (per-branch test() definitions inside an
      // if/else under describe) are the only patterns that change the
      // actual test-count totals between platforms. Early-return
      // `if (process.platform) return;` patterns are no-ops that still
      // resolve as `passed` in the harness — they do NOT shift counts.
      if (fi.blockForm) {
        if (fi.skipsOn.includes('win32')) blockWin++;
        if (fi.skipsOn.includes('linux')) blockLinux++;
      }
    }
  }
  return {
    matrix,
    summary: {
      pureSkipsOnWin32:  pureWin,
      pureSkipsOnLinux:  pureLinux,
      pureSkipsOnDarwin: pureDarwin,
      conditional,
      // True delta in measured test counts. Only block-form (definition)
      // skips contribute — early-return patterns count as passed on
      // every platform in this harness, so they don't change totals.
      linuxTestCountDeltaFromWin32: blockWin - blockLinux,
    },
  };
}

function formatHuman(result) {
  const lines = [];
  lines.push('Platform-skip matrix:');
  lines.push('');
  if (result.matrix.length === 0) {
    lines.push('  (no platform-conditional skips found)');
  }
  for (const entry of result.matrix) {
    lines.push(`  ${entry.file}`);
    for (const fi of entry.findings) {
      const tag = fi.kind === 'conditional' ? '[conditional]' : '[pure]';
      lines.push(`    L${fi.line} ${tag} "${fi.testName}" — skipped on ${fi.skipsOn.join(', ')}`);
    }
  }
  lines.push('');
  lines.push('Summary:');
  lines.push(`  Pure skips on win32:  ${result.summary.pureSkipsOnWin32}`);
  lines.push(`  Pure skips on linux:  ${result.summary.pureSkipsOnLinux}`);
  lines.push(`  Pure skips on darwin: ${result.summary.pureSkipsOnDarwin}`);
  lines.push(`  Conditional:          ${result.summary.conditional}`);
  lines.push('');
  lines.push(`  Linux test-count delta vs Win32: ${result.summary.linuxTestCountDeltaFromWin32 >= 0 ? '+' : ''}${result.summary.linuxTestCountDeltaFromWin32}`);
  return lines.join('\n');
}

function writeBaseline(result) {
  const baseline = {
    generated: new Date().toISOString(),
    summary: result.summary,
    files: result.matrix.map(e => ({
      file: e.file,
      findings: e.findings.map(f => ({
        testName: f.testName,
        line: f.line,
        kind: f.kind,
        skipsOn: f.skipsOn,
      })),
    })),
  };
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n', 'utf-8');
}

// ── main ──
function main() {
  const args = process.argv.slice(2);
  const result = buildMatrix();
  console.log(formatHuman(result));
  if (args.includes('--write-baseline')) {
    writeBaseline(result);
    console.log(`\n  Baseline written to ${path.relative(ROOT, BASELINE_PATH).replace(/\\/g, '/')}`);
  }
  // Exit 0 — this is a reporting tool, not a CI gate.
  process.exit(0);
}

if (require.main === module) main();

module.exports = { buildMatrix, classifySkip, scanFile };
