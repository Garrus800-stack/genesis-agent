#!/usr/bin/env node
// ============================================================
// GENESIS — scripts/audit-doc-drift.js (v7.6.4)
//
// Detects documentation drift in docs/*.md by comparing claimed
// numeric facts (test count, event count, schema count, hash-lock
// count, contract-prefix count, source-module count, version tag)
// against live values. Optional CI gate.
//
// Background: v7.6.3 shipped with stale numbers in eight docs
// (test counts 6141 instead of 6650, "v7.5.6" tags despite being
// v7.6.3, hash-lock claims listing 7 files instead of 18, etc.).
// Most of these were drifted multiple releases — there was no
// automated check, so the numbers slowly went out of sync.
//
// This script reads a small set of patterns from each doc, looks
// up the live truth, and prints a delta. With --strict, exits 1
// if any drift is found.
//
// USAGE:
//   node scripts/audit-doc-drift.js          — table of drifts
//   node scripts/audit-doc-drift.js --json   — machine-readable
//   node scripts/audit-doc-drift.js --strict — exit 1 if drift found
//
// EXIT CODES:
//   0 : no drift, or --strict not set
//   1 : drift detected (--strict only)
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DOCS_DIR = path.join(ROOT, 'docs');

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

// ── Live truth probes ────────────────────────────────────

function getCurrentVersion() {
  return require(path.join(ROOT, 'package.json')).version;
}

function getCatalogSize() {
  const t = require(path.join(ROOT, 'src/agent/core/EventTypes.js'));
  const all = new Set();
  for (const v of Object.values(t.EVENTS)) {
    if (typeof v === 'object') for (const x of Object.values(v)) all.add(x);
    else all.add(v);
  }
  return all.size;
}

function getSchemaCount() {
  const s = require(path.join(ROOT, 'src/agent/core/EventPayloadSchemas.js'));
  return Object.keys(s.SCHEMAS).length;
}

function getHashLockCount() {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf-8');
  const block = main.match(/lockCritical\(\[([\s\S]*?)\]\)/);
  if (!block) return 0;
  // Count lines that look like 'src/...' string entries
  const lines = block[1].split('\n').filter(l => /^\s*['"]src\//.test(l));
  return lines.length;
}

function getContractPrefixCount() {
  const r = require(path.join(ROOT, 'scripts/stale-refs.json'));
  // Deduplicate — stale-refs.json historically has duplicate entries
  return new Set(r.contracts.map(x => x.prefix)).size;
}

function getSourceModuleCount() {
  // Match selfModel.moduleCount() semantics: count *.js files under src/
  let count = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.js')) count++;
    }
  };
  walk(path.join(ROOT, 'src'));
  return count;
}

function getCIGateCount() {
  // Count audit/validate/check scripts in package.json `ci` script
  const pkg = require(path.join(ROOT, 'package.json'));
  const ci = pkg.scripts.ci || '';
  // Match `node scripts/X.js` invocations
  const matches = ci.match(/node scripts\/[a-z-]+\.js/g) || [];
  return matches.length;
}

// ── Drift checks per doc ─────────────────────────────────

function check(docName, content, label, regex, expected, actualExtractor = (m) => parseInt(m[1].replace(/,/g, ''), 10)) {
  const m = regex.exec(content);
  if (!m) return null; // pattern not present — not a drift
  const actual = actualExtractor(m);
  const ok = actual === expected || actual === String(expected);
  return {
    doc: docName,
    label,
    expected,
    actual,
    ok,
  };
}

function runChecks() {
  const VERSION = getCurrentVersion();
  const CATALOG = getCatalogSize();
  const SCHEMAS = getSchemaCount();
  const HASH_LOCKS = getHashLockCount();
  const PREFIXES = getContractPrefixCount();
  const SOURCE = getSourceModuleCount();
  const CI_GATES = getCIGateCount();

  const drifts = [];
  const checked = [];

  function loadDoc(name) {
    try { return fs.readFileSync(path.join(DOCS_DIR, name), 'utf-8'); }
    catch { return null; }
  }

  // ── banner.svg version check ──
  {
    const svg = loadDoc('banner.svg');
    if (svg) {
      const m = /v(\d+\.\d+\.\d+)/.exec(svg);
      if (m) {
        const ok = m[1] === VERSION;
        const r = { doc: 'banner.svg', label: 'version', expected: VERSION, actual: m[1], ok };
        checked.push(r);
        if (!ok) drifts.push(r);
      }
    }
  }

  // ── docs/*.md header version tags ──
  // Any doc whose first 10 lines contain a `vX.Y.Z` tag should match VERSION.
  // Historical references in body are NOT checked.
  for (const file of fs.readdirSync(DOCS_DIR)) {
    if (!file.endsWith('.md')) continue;
    const src = loadDoc(file);
    if (!src) continue;
    const head = src.split('\n').slice(0, 10).join('\n');
    // Skip BUG-TAXONOMY which is explicitly historical
    if (/historical reference/i.test(head)) continue;
    const m = /v(\d+\.\d+\.\d+)/.exec(head);
    if (m) {
      const ok = m[1] === VERSION;
      const r = { doc: file, label: 'header-version-tag', expected: VERSION, actual: m[1], ok };
      checked.push(r);
      if (!ok) drifts.push(r);
    }
  }

  // ── Header numeric claims (per-doc patterns) ──
  // EVENT-FLOW.md
  {
    const src = loadDoc('EVENT-FLOW.md');
    if (src) {
      const head = src.split('\n').slice(0, 10).join('\n');
      const r = check('EVENT-FLOW.md', head, 'catalogued events',
        /(\d{2,4})\s+catalogued events/, CATALOG);
      if (r) { checked.push(r); if (!r.ok) drifts.push(r); }
      const r2 = check('EVENT-FLOW.md', head, 'payload schemas',
        /(\d{2,4})\s+payload schemas/, SCHEMAS);
      if (r2) { checked.push(r2); if (!r2.ok) drifts.push(r2); }
    }
  }

  // CAPABILITIES.md
  {
    const src = loadDoc('CAPABILITIES.md');
    if (src) {
      const head = src.split('\n').slice(0, 12).join('\n');
      const r = check('CAPABILITIES.md', head, 'catalog events',
        /(\d{2,4})\s+events with/, CATALOG);
      if (r) { checked.push(r); if (!r.ok) drifts.push(r); }
      const r2 = check('CAPABILITIES.md', head, 'payload schemas',
        /(\d{2,4})\s+payload schemas/, SCHEMAS);
      if (r2) { checked.push(r2); if (!r2.ok) drifts.push(r2); }
    }
  }

  // COMMUNICATION.md body
  {
    const src = loadDoc('COMMUNICATION.md');
    if (src) {
      const r = check('COMMUNICATION.md', src, 'event types',
        /\*\*(\d{2,4})\s+event types\*\*/, CATALOG);
      if (r) { checked.push(r); if (!r.ok) drifts.push(r); }
      const r2 = check('COMMUNICATION.md', src, 'payload schemas',
        /\*\*(\d{2,4})\s+payload schemas\*\*/, SCHEMAS);
      if (r2) { checked.push(r2); if (!r2.ok) drifts.push(r2); }
    }
  }

  // ARCHITECTURE-DEEP-DIVE.md table
  {
    const src = loadDoc('ARCHITECTURE-DEEP-DIVE.md');
    if (src) {
      const r = check('ARCHITECTURE-DEEP-DIVE.md', src, 'event types (table)',
        /\|\s*Event Types \(catalogued\)\s*\|\s*(\d+)\s*\|/, CATALOG);
      if (r) { checked.push(r); if (!r.ok) drifts.push(r); }
      const r2 = check('ARCHITECTURE-DEEP-DIVE.md', src, 'event schemas (table)',
        /\|\s*Event Schemas\s*\|\s*(\d+)\s*\|/, SCHEMAS);
      if (r2) { checked.push(r2); if (!r2.ok) drifts.push(r2); }

      // Header text claims (these drifted in v7.6.3 — caught manually)
      const r3 = check('ARCHITECTURE-DEEP-DIVE.md', src, 'hash-locked files (header)',
        /(\d+)\s+hash-locked files/, HASH_LOCKS);
      if (r3) { checked.push(r3); if (!r3.ok) drifts.push(r3); }

      const r4 = check('ARCHITECTURE-DEEP-DIVE.md', src, 'contract prefixes (header)',
        /(\d+)\s+contract prefixes/, PREFIXES);
      if (r4) { checked.push(r4); if (!r4.ok) drifts.push(r4); }

      const r5 = check('ARCHITECTURE-DEEP-DIVE.md', src, 'CI audit gates (header)',
        /plus\s+(\d+)\s+CI audit gates/, CI_GATES);
      if (r5) { checked.push(r5); if (!r5.ok) drifts.push(r5); }
    }
  }

  // CAPABILITIES.md hash-locked claim
  {
    const src = loadDoc('CAPABILITIES.md');
    if (src) {
      const r = check('CAPABILITIES.md', src, 'hash-locked count',
        /SHA-256 locks on (\d+) critical files/, HASH_LOCKS);
      if (r) { checked.push(r); if (!r.ok) drifts.push(r); }
    }
  }

  // ── README.md shields.io badges (v7.6.5) ──
  // Pattern: img.shields.io/badge/<label>-<value>-<color>?style=...
  // URL-decoded: %20→space, %2F→/, %25→%.
  // Captures README badge drift structurally so the kind of multi-version
  // staleness that occurred from v7.6.0 → v7.6.5 (version-7.6.0, tests-6607,
  // modules-311, events-424, TSC-config_ok all stale) cannot recur.
  {
    let readme;
    try { readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf-8'); }
    catch { readme = null; }
    if (readme) {
      const badgeRe = /img\.shields\.io\/badge\/([^/-]+)-([^-]+)-/g;
      const decode = (s) => decodeURIComponent(s.replace(/%20/gi, ' '));
      const badgeChecks = {
        version:    { live: VERSION,             label: 'badge: version' },
        tests:      { live: '6799 passing',      label: 'badge: tests',
                      // tests value is "<n> passing" — pin to Win-baseline + new contract tests.
                      // Update this constant on each release that changes test count.
                      // v7.6.6: Win-baseline 6709 + 90 (39 new v766-* tests +
                      // 51 from existing platform-conditional tests now active) = 6799.
                      compare: (got, exp) => got === exp },
        modules:    { live: SOURCE,              label: 'badge: modules' },
        events:     { live: CATALOG,             label: 'badge: events' },
        TSC:        { live: 'typecheck_ok',      label: 'badge: TSC',
                      compare: (got, exp) => got === exp },
        schemas:    { live: '100%',              label: 'badge: schemas',
                      compare: (got, exp) => got === exp },
        services:   { live: 168,                 label: 'badge: services' },
        phases:     { live: 12,                  label: 'badge: phases' },
        capabilities: { live: '240+',            label: 'badge: capabilities',
                        // "240+" wildcards: match if README shows N+ where N >= 240.
                        compare: (got, _exp) => {
                          const m = /^(\d+)\+?$/.exec(String(got));
                          return m && parseInt(m[1], 10) >= 240;
                        } },
      };

      let m;
      while ((m = badgeRe.exec(readme)) !== null) {
        const rawLabel = decode(m[1]);
        const rawValue = decode(m[2]);
        const spec = badgeChecks[rawLabel];
        if (!spec) continue; // unmonitored badge (MCP, languages, electron, license, fitness)
        const expected = spec.live;
        const actualNum = /^\d+$/.test(rawValue) ? parseInt(rawValue, 10) : rawValue;
        const ok = spec.compare
          ? spec.compare(actualNum, expected)
          : (actualNum === expected || actualNum === String(expected));
        const r = {
          doc: 'README.md',
          label: spec.label,
          expected,
          actual: actualNum,
          ok,
        };
        checked.push(r);
        if (!ok) drifts.push(r);
      }
    }
  }

  return { drifts, checked };
}

// ── Output ───────────────────────────────────────────────

const result = runChecks();

if (jsonOutput) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(strict && result.drifts.length > 0 ? 1 : 0);
}

console.log('');
console.log(c.bold('  ╔═══════════════════════════════════════════════╗'));
console.log(c.bold('  ║   GENESIS DOC-DRIFT AUDIT                     ║'));
console.log(c.bold('  ╚═══════════════════════════════════════════════╝'));
console.log('');
console.log(`  ${c.dim('Live values:')}`);
console.log(`    version:        ${getCurrentVersion()}`);
console.log(`    catalog size:   ${getCatalogSize()}`);
console.log(`    schemas:        ${getSchemaCount()}`);
console.log(`    hash-locks:     ${getHashLockCount()}`);
console.log(`    contractPrefix: ${getContractPrefixCount()}`);
console.log(`    source modules: ${getSourceModuleCount()}`);
console.log(`    CI gates:       ${getCIGateCount()}`);
console.log('');

if (result.drifts.length === 0) {
  console.log(c.green(`  ✅ All ${result.checked.length} doc claims match live values.\n`));
  process.exit(0);
}

console.log(c.yellow(`  ⚠  ${result.drifts.length} drift(s) across ${new Set(result.drifts.map(d => d.doc)).size} doc(s):\n`));
for (const d of result.drifts) {
  console.log(`    ${c.red('✗')} ${c.bold(d.doc)} — ${d.label}`);
  console.log(`        ${c.dim('expected')} ${d.expected}  ${c.dim('actual')} ${d.actual}`);
}
console.log('');

if (strict) {
  console.log(c.red('  ❌ Strict mode: drift detected, exiting 1.\n'));
  process.exit(1);
}
process.exit(0);
