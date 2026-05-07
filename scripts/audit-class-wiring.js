#!/usr/bin/env node
// ============================================================
// GENESIS — scripts/audit-class-wiring.js (v7.6.3)
//
// Verifies that every `R('FooClass').FooClass`-call in the
// manifest files refers to an actual module file under
// src/agent/**/FooClass.js that exports `FooClass` (named).
//
// Background: the v7.6.3 erweiterte Analyse-report A1 finding
// noted that Genesis's R() resolver hides classes from naive
// dead-code detectors. There is `validate-service-wiring`
// covering 168 services / 919 references, but no audit that
// verifies the *file-side* of `R(name)` actually contains a
// matching named export. A typo in the manifest (R('FooClas')
// instead of R('FooClass')) only fails at runtime, when the
// affected service is first resolved.
//
// USAGE:
//   node scripts/audit-class-wiring.js          — table output
//   node scripts/audit-class-wiring.js --json   — machine-readable
//   node scripts/audit-class-wiring.js --strict — exit 1 on offences
//
// EXIT CODES:
//   0 : every R(name).name pair resolves to a file with a matching export
//   1 : at least one R(name).name pair has no matching file/export (--strict)
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT      = path.resolve(__dirname, '..');
const SCAN_DIR  = path.join(ROOT, 'src/agent');
const MANIFEST  = path.join(ROOT, 'src/agent/manifest');

const args = process.argv.slice(2);
const jsonOutput = args.includes('--json');
const strict     = args.includes('--strict');

const c = {
  green:  (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red:    (s) => `\x1b[31m${s}\x1b[0m`,
  dim:    (s) => `\x1b[2m${s}\x1b[0m`,
  bold:   (s) => `\x1b[1m${s}\x1b[0m`,
};

// ── Walk source tree ────────────────────────────────────────────────

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// ── Index: every file under src/agent and its named exports ────────

function indexExports() {
  const idx = new Map(); // ClassName → { filePath, exportName }
  for (const f of walk(SCAN_DIR)) {
    const base = path.basename(f, '.js');
    let src;
    try { src = fs.readFileSync(f, 'utf-8'); } catch { continue; }
    const exportNames = new Set();

    // Pattern 1: ALL `module.exports = { ... }` blocks (last assignment wins
    // in JS, but for static analysis we want every name that any block
    // exposes — the file might re-export incrementally).
    const blockRe = /module\.exports\s*=\s*\{([^}]+)\}/gs;
    let bm;
    while ((bm = blockRe.exec(src)) !== null) {
      for (const part of bm[1].split(',')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const name = trimmed.split(':')[0].trim();
        if (/^[A-Za-z_][\w]*$/.test(name)) exportNames.add(name);
      }
    }

    // Pattern 2: exports.Foo = ...
    const m2 = src.matchAll(/^\s*exports\.([A-Za-z_][\w]*)\s*=/gm);
    for (const m of m2) exportNames.add(m[1]);

    // Pattern 3: module.exports = ClassName  (single-name export)
    const m3 = src.match(/module\.exports\s*=\s*([A-Z][\w]*)\s*[;\n]/);
    if (m3) exportNames.add(m3[1]);

    for (const name of exportNames) {
      if (!idx.has(name)) idx.set(name, []);
      idx.get(name).push({ filePath: path.relative(ROOT, f), basename: base });
    }
  }
  return idx;
}

// ── Find R() calls in manifest ─────────────────────────────────────

function findRCalls() {
  const calls = [];  // { manifestFile, line, modName, exportName }
  for (const f of fs.readdirSync(MANIFEST)) {
    if (!f.endsWith('.js')) continue;
    const fp = path.join(MANIFEST, f);
    const src = fs.readFileSync(fp, 'utf-8');
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      // Match: R('Name').Name  /  R("Name").Name
      const re = /R\(\s*['"]([A-Za-z_][\w]*)['"]\s*\)\s*\.\s*([A-Za-z_][\w]*)/g;
      let m;
      while ((m = re.exec(l)) !== null) {
        calls.push({
          manifestFile: f,
          line: i + 1,
          modName: m[1],
          exportName: m[2],
        });
      }
    }
  }
  return calls;
}

// ── Main ───────────────────────────────────────────────────────────

const exportIdx = indexExports();
const rCalls = findRCalls();

const offenders = [];
for (const call of rCalls) {
  const candidates = exportIdx.get(call.exportName) || [];
  // Find a candidate where the filename matches modName
  const fileMatch = candidates.find(c => c.basename === call.modName);
  if (!fileMatch) {
    // Either no file with that name, or no matching export name
    const fileExists = [...exportIdx.values()].flat().some(c => c.basename === call.modName);
    offenders.push({
      ...call,
      reason: fileExists
        ? `file exists but does not export "${call.exportName}"`
        : `no file ${call.modName}.js found under src/agent/`,
    });
  }
}

if (jsonOutput) {
  console.log(JSON.stringify({
    totalRCalls: rCalls.length,
    distinctClasses: new Set(rCalls.map(c => c.modName)).size,
    offenders,
  }, null, 2));
  process.exit(strict && offenders.length > 0 ? 1 : 0);
}

console.log('');
console.log(c.bold('  ╔════════════════════════════════════════════════════╗'));
console.log(c.bold('  ║   GENESIS CLASS-WIRING AUDIT (R() resolver)       ║'));
console.log(c.bold('  ╚════════════════════════════════════════════════════╝'));
console.log('');
console.log(`  ${c.dim('Total R(...) calls in manifest:')} ${rCalls.length}`);
console.log(`  ${c.dim('Distinct classes referenced:')} ${new Set(rCalls.map(c => c.modName)).size}`);
console.log(`  ${c.dim('Offenders (no matching file/export):')} ${offenders.length}`);
console.log('');

if (offenders.length === 0) {
  console.log(c.green('  ✅ Every R() reference resolves to an existing file with matching named export.\n'));
  process.exit(0);
}

console.log(c.red(`  ❌ ${offenders.length} unresolved R() references:\n`));
for (const o of offenders) {
  console.log(`    ${c.red('✗')} ${c.bold(o.manifestFile)}:${o.line}  R('${o.modName}').${o.exportName}`);
  console.log(`        ${c.dim('reason:')} ${o.reason}`);
}
console.log('');

if (strict) {
  console.log(c.red(`  ❌ Strict mode: ${offenders.length} broken R() refs, exiting 1.\n`));
  process.exit(1);
}
process.exit(0);
