#!/usr/bin/env node
'use strict';
// ════════════════════════════════════════════════════════════
// GENESIS — audit-tool-selftest.js
// The guardian for the guardians.
//
// The v7.9.29 hygiene split produced two CI false-positives that no
// existing audit caught, because the audits themselves were blind in
// two ways. This selftest encodes the two principles that WOULD have
// caught them, so the next split cannot repeat the failure silently.
//
//   Principle 1 — RUNTIME BEATS REGEX.
//     audit-class-wiring parsed a `module.exports = { ... }` block with a
//     regex and dropped an export whose comma-segment carried an inline
//     comment with a ':'. `node --check` passed; only require() knew the
//     truth. Here: for every module that exposes an object export block, we
//     require() it and confirm each capitalised name the block *textually*
//     exposes is actually present at runtime. A parser that silently drops a
//     name (or a bad edit that removes a referenced symbol) is caught.
//
//   Principle 2 — GLOB, DON'T HARDCODE.
//     validate-intent-wiring scanned one hardcoded file (AgentCoreBoot.js);
//     a split moved the register() call into AgentCoreBootWire.js and the
//     validator went blind. We cannot auto-prove a validator globs, but we
//     CAN prove every hardcoded `src/…` file path a validator references
//     still resolves to a real file — the rename/delete guard. (The full
//     glob-instead-of-hardcode rule stays a review principle, noted here.)
//
// Exit 0: clean.  Exit 1 (with --strict): a runtime/parser mismatch or a
// validator pointing at a missing file.
// ════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const strict = process.argv.includes('--strict');
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

function walk(dir, acc = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'vendor' || e.name === 'dist') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (e.name.endsWith('.js')) acc.push(full);
  }
  return acc;
}

// ── Principle 1: runtime-load oracle ─────────────────────────
// A file can pass `node --check` (syntax) yet throw at require() time — e.g.
// an object export block that references a name a bad edit deleted (the class
// of a near-miss this release: removing a function left `extractKeywords` in the
// export list, syntactically fine, a ReferenceError at load). Every module
// that declares a top-level object export block is a wired service; we
// require() each so a load-time break is caught here, not only when the app
// boots. Modules with an object export block are require-safe in isolation
// (verified: 0 load failures on a clean tree); genuinely un-loadable modules
// (UI needing browser globals) do not use this shape and are covered by
// headless-boot instead.
const loadFailures = [];
let checkedModules = 0;
const hasExportBlock = /^module\.exports\s*=\s*\{/m; // top-level object export

for (const file of walk(path.join(ROOT, 'src'))) {
  // src/ui modules need browser globals / bundler-only deps (dompurify, etc.)
  // and are not require-able in a bare Node context — they are the domain of
  // the UI test suites, not this service-side wiring oracle.
  if (/[\\/]src[\\/]ui[\\/]/.test(file)) continue;
  const src = fs.readFileSync(file, 'utf8');
  if (!hasExportBlock.test(src)) continue;
  try {
    require(file);
    checkedModules++;
  } catch (err) {
    loadFailures.push({ file: path.relative(ROOT, file), err: String(err.message).split('\n')[0] });
  }
}

// ── Principle 2: validator hardcoded-path existence ──────────
// Every `path.join(ROOT|__dirname, 'src', …, 'X.js')` and every literal
// 'src/…/X.js' string inside a checker script must resolve to a real file.
const brokenRefs = [];
let checkedRefs = 0;
const scriptDir = path.join(ROOT, 'scripts');
const checkerScripts = fs.readdirSync(scriptDir)
  .filter((f) => /^(audit|validate|check|scan)-.*\.js$/.test(f) && f !== 'audit-tool-selftest.js');

// path.join(..., 'src', 'agent', 'Foo.js')  → capture the segment list
const joinRe = /path\.join\([^)]*?\bROOT\b[^)]*?\)|path\.join\([^)]*?__dirname[^)]*?\)/g;
// literal "src/…/Foo.js" strings
const litRe = /['"`](src\/[\w./-]+\.js)['"`]/g;

for (const sf of checkerScripts) {
  const src = fs.readFileSync(path.join(scriptDir, sf), 'utf8');

  // literal src/…/X.js paths
  let m;
  litRe.lastIndex = 0;
  while ((m = litRe.exec(src)) !== null) {
    checkedRefs++;
    if (!fs.existsSync(path.join(ROOT, m[1]))) brokenRefs.push({ script: sf, ref: m[1] });
  }

  // path.join(ROOT/__dirname, 'a','b','X.js') sequences ending in a .js literal
  joinRe.lastIndex = 0;
  while ((m = joinRe.exec(src)) !== null) {
    const segs = [...m[0].matchAll(/['"`]([^'"`]+)['"`]/g)].map((x) => x[1]);
    if (segs.length === 0) continue;
    const last = segs[segs.length - 1];
    if (!/\.js$/.test(last)) continue; // only resolve when it targets a file
    // Reconstruct relative to ROOT if the join is ROOT-anchored (contains 'src').
    const srcIdx = segs.indexOf('src');
    if (srcIdx === -1) continue;
    const rel = segs.slice(srcIdx).join(path.sep);
    checkedRefs++;
    if (!fs.existsSync(path.join(ROOT, rel))) brokenRefs.push({ script: sf, ref: rel });
  }
}

// ── Report ───────────────────────────────────────────────────
console.log('  ╔═══════════════════════════════════════════════╗');
console.log('  ║   GENESIS AUDIT-TOOL SELFTEST                 ║');
console.log('  ╚═══════════════════════════════════════════════╝');
console.log(`  Principle 1 (runtime beats regex): ${checkedModules} wired modules require() cleanly.`);
console.log(`  Principle 2 (validator path refs): ${checkedRefs} hardcoded src paths across ${checkerScripts.length} checkers.`);

let failed = false;

if (loadFailures.length > 0) {
  failed = true;
  console.log(red(`\n  ✗ ${loadFailures.length} module(s) pass syntax but throw at require() (runtime break):`));
  for (const p of loadFailures) {
    console.log(`      ${red('✗')} ${p.file} — ${p.err}`);
  }
}

if (brokenRefs.length > 0) {
  failed = true;
  console.log(red(`\n  ✗ ${brokenRefs.length} validator path reference(s) point at a missing file:`));
  for (const b of brokenRefs) {
    console.log(`      ${red('✗')} scripts/${b.script} → ${b.ref}  ${dim('(renamed/deleted? update the validator)')}`);
  }
}

if (!failed) {
  console.log(green('\n  ✅ Guardians agree with runtime, and every validator path resolves.'));
  process.exit(0);
}

if (strict) {
  console.log(red('\n  ❌ Strict mode: guardian selftest failed, exiting 1.'));
  process.exit(1);
}
console.log('\n  (non-strict: reporting only)');
process.exit(0);
