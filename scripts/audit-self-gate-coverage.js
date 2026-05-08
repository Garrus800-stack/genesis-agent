#!/usr/bin/env node
// ============================================================
// GENESIS — scripts/audit-self-gate-coverage.js
//
// Verifies that every actionType documented in self-gate.js's JSDoc
// header has at least one selfGate.check({ actionType: ... }) call site
// in src/agent/. Fails (exit 1) when a documented actionType is not
// wired anywhere — exactly the class of "intention documented but
// implementation missing" drift that produced the v7.5/v7.6 audit
// finding "Self-Gate symmetry gap: only 2 of 4 documented actionTypes
// wired" before the v7.6.1 audit-closeout fixed it.
//
// CHECKS:
//   1. Parse self-gate.js JSDoc for the documented actionType list.
//   2. Grep src/agent for `actionType: '<name>'` literals appearing
//      inside selfGate.check(...) call contexts.
//   3. FAIL if a documented type has zero call sites.
//   4. WARN  if a wired type is not in the documented list (a draft
//      or undocumented addition that should be JSDoc'd).
//
// USAGE:
//   node scripts/audit-self-gate-coverage.js          — table output
//   node scripts/audit-self-gate-coverage.js --json   — machine-readable
//   node scripts/audit-self-gate-coverage.js --strict — exit 1 on FAIL only
//                                                       (warnings stay 0)
//
// EXIT CODES:
//   0 : every documented actionType has at least one wired call site
//   1 : a documented actionType has zero wired call sites
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT          = path.resolve(__dirname, '..');
const SELF_GATE_FILE = path.join(ROOT, 'src/agent/core/self-gate.js');
const SCAN_DIR       = path.join(ROOT, 'src/agent');

const args     = process.argv.slice(2);
const strict   = args.includes('--strict');
const jsonMode = args.includes('--json');

// ── Step 1: Parse documented actionTypes from JSDoc ─────────
function parseDocumentedActionTypes() {
  const src = fs.readFileSync(SELF_GATE_FILE, 'utf8');
  // Find the `@param {string} params.actionType - e.g. 'X', 'Y',\n  'Z', 'W'`
  // block. The list may span multiple lines in JSDoc-comment style.
  const m = src.match(/@param\s+\{string\}\s+params\.actionType[^\n]*\n((?:\s*\*\s*[^\n]*\n){0,8})/);
  if (!m) {
    throw new Error('Could not locate @param actionType JSDoc in self-gate.js');
  }
  const block = m[0];
  // Extract every quoted literal from the block.
  const literals = [...block.matchAll(/'([a-z][a-z0-9-]+)'/g)].map(x => x[1]);
  // Dedupe, preserve order.
  return [...new Set(literals)];
}

// ── Step 2: Find actionType call sites under src/agent ───────
function findActionTypeCallSites() {
  const sites = new Map(); // actionType → array of {file, line}

  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name === 'vendor') continue;
        walk(full);
      } else if (ent.isFile() && ent.name.endsWith('.js')) {
        const content = fs.readFileSync(full, 'utf8');
        // Match  actionType: 'X'  inside a selfGate.check(...) context.
        // Strictness: we require `selfGate.check(` (with the open paren)
        // to appear within 400 chars before the match. This deliberately
        // excludes EventPayloadSchemas.js where `actionType: 'required'`
        // appears in event-payload schema definitions ('required' is the
        // schema marker, not a real action-type literal). It also excludes
        // any other module that happens to write the word "self-gate" in
        // a comment or event name without actually calling the gate.
        const re = /actionType\s*:\s*['"]([a-z][a-z0-9-]+)['"]/g;
        let mm;
        while ((mm = re.exec(content)) !== null) {
          const type = mm[1];
          const before = content.slice(Math.max(0, mm.index - 400), mm.index);
          // Strict gate: must see selfGate.check( as the most recent
          // method invocation before this literal. We also accept
          // this.selfGate.check( and the rare selfGate?.check( form.
          if (!/(?:^|[^a-zA-Z_$])selfGate\??\.check\s*\(/m.test(before)) continue;
          // Compute line number.
          const upTo = content.slice(0, mm.index);
          const line = upTo.split('\n').length;
          if (!sites.has(type)) sites.set(type, []);
          sites.get(type).push({ file: path.relative(ROOT, full), line });
        }
      }
    }
  }
  walk(SCAN_DIR);
  return sites;
}

// ── Step 3: Compose report and exit code ─────────────────────
function main() {
  const documented = parseDocumentedActionTypes();
  const sites      = findActionTypeCallSites();

  const report = {
    documented,
    coverage: [],
    failed: [],
    undocumented: [],
  };

  for (const t of documented) {
    const arr = sites.get(t) || [];
    report.coverage.push({ actionType: t, callSites: arr });
    if (arr.length === 0) report.failed.push(t);
  }
  for (const t of sites.keys()) {
    if (!documented.includes(t)) report.undocumented.push(t);
  }

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('');
    console.log('Self-Gate actionType Coverage Audit');
    console.log('='.repeat(50));
    console.log(`Documented in self-gate.js JSDoc:  ${documented.length}`);
    console.log(`Wired in src/agent:                ${sites.size}`);
    console.log('');
    for (const c of report.coverage) {
      const status = c.callSites.length > 0
        ? `\u2713 ${c.callSites.length} call site${c.callSites.length === 1 ? '' : 's'}`
        : '\u2717 NO CALL SITES';
      console.log(`  ${c.actionType.padEnd(18)} ${status}`);
      for (const s of c.callSites) {
        console.log(`     \u2192 ${s.file}:${s.line}`);
      }
    }
    if (report.undocumented.length > 0) {
      console.log('');
      console.log('Wired but NOT documented (warning, not failure):');
      for (const t of report.undocumented) {
        console.log(`  ${t} (call sites: ${(sites.get(t) || []).length})`);
      }
    }
    console.log('');
    if (report.failed.length === 0) {
      console.log('\u2705 All documented actionTypes have at least one call site.');
    } else {
      console.log(`\u274C ${report.failed.length} documented actionType${report.failed.length === 1 ? '' : 's'} unwired:`);
      for (const t of report.failed) console.log(`     - ${t}`);
      console.log('');
      console.log('   Either wire the missing actionType(s) into a selfGate.check call');
      console.log('   in src/agent, or remove them from the @param actionType JSDoc.');
    }
  }

  if (report.failed.length > 0) {
    process.exit(strict ? 1 : 1); // fail in both modes — drift is real
  }
  process.exit(0);
}

main();
