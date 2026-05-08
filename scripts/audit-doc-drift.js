#!/usr/bin/env node
// ============================================================
// GENESIS — scripts/audit-doc-drift.js
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

function getLiveFitness() {
  // v7.7.0: subprocess-call to architectural-fitness.js, parse "Score: NNN/130"
  // from stdout. Returns null on any failure (subprocess error, parse fail) so
  // that a broken fitness check doesn't break doc-drift altogether — drift
  // checks that depend on FITNESS will skip silently when null.
  try {
    const { execSync } = require('child_process');
    const out = execSync('node scripts/architectural-fitness.js', {
      cwd: ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const m = /Score:\s*(\d+)\s*\/\s*130/.exec(out);
    return m ? parseInt(m[1], 10) : null;
  } catch (_e) {
    return null;
  }
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
  const FITNESS = getLiveFitness();   // v7.7.0: may be null if subprocess fails

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
        tests:      { live: '6905 passing',      label: 'badge: tests',
                      // tests value is "<n> passing" — pin to Win-baseline + new contract tests.
                      // Update this constant on each release that changes test count.
                      // v7.7.1: +23 (v771-* contract tests). v7.7.0: -52 (renderer.test.js -51 + agentloop-legacy
                      //   lying test -1) +81 (v770-test-helpers contract +16,
                      //   ui-statusbar-module +13, ui-i18n-module +8, ui-chat-
                      //   module +19, ui-filetree-module +8, ui-settings-module
                      //   +7, ui-renderer-main +10) = +29 net.
                      // Linux actual: 6856. Win actual: 6867 (~11 Win-conditional
                      // test in v759-linux-open early-returns on non-Win, but
                      // the test() call itself counts as 'passed' on both
                      // platforms — the +1 difference comes from elsewhere).
                      // Badge pinned to Win-baseline; audit is strict.
                      // Note: pre-v7.7.0 README badge claimed 6837 but actual
                      // Win count then was ~6828 — the badge was already drifted
                      // by ~9 tests through several releases. v7.7.0 audit
                      // hardening (above) makes such drift visible going forward.
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
        // v7.7.0: fitness badge re-monitored. Was previously skipped; sat
        // stale at 127/130 across v7.6.5 → v7.6.9 because nothing audited it.
        // Skip silently if FITNESS is null (architectural-fitness.js subprocess
        // failed); only flag drift when we have a confirmed live value.
        fitness:    { live: FITNESS != null ? `${FITNESS}/130` : null,
                      label: 'badge: fitness',
                      compare: (got, exp) => exp != null && got === exp },
      };

      let m;
      while ((m = badgeRe.exec(readme)) !== null) {
        const rawLabel = decode(m[1]);
        const rawValue = decode(m[2]);
        const spec = badgeChecks[rawLabel];
        if (!spec) continue; // unmonitored badge (MCP, languages, electron, license)
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

      // ── README.md tabular + paragraph checks (v7.7.0 hardening) ──
      // Closes the v7.6.5 → v7.6.9 staleness pattern where five separate
      // documented numbers (fitness 127/130, CI gates 7, event types 458,
      // hash-locked 16, etc.) sat stale across five releases because
      // nothing audited them. These checks now make those drifts visible.

      // README "| Architectural fitness | N/130 — ..." table cell
      if (FITNESS != null) {
        const r = check('README.md', readme, 'fitness table',
          /\|\s*Architectural fitness\s*\|\s*(\d+)\/130\b/, FITNESS);
        if (r) { checked.push(r); if (!r.ok) drifts.push(r); }
      }

      // README "| CI gates | N (...)" table cell
      const rGates = check('README.md', readme, 'CI gates (table)',
        /\|\s*CI gates\s*\|\s*(\d+)\s*\(/, CI_GATES);
      if (rGates) { checked.push(rGates); if (!rGates.ok) drifts.push(rGates); }

      // README infrastructure paragraph: "EventBus (N event types..."
      const rEvents = check('README.md', readme, 'event types (paragraph)',
        /EventBus \((\d+)\s+event types/, CATALOG);
      if (rEvents) { checked.push(rEvents); if (!rEvents.ok) drifts.push(rEvents); }

      // README infrastructure paragraph: "N hash-locked files"
      const rLocks = check('README.md', readme, 'hash-locked files (paragraph)',
        /(\d+)\s+hash-locked files/, HASH_LOCKS);
      if (rLocks) { checked.push(rLocks); if (!rLocks.ok) drifts.push(rLocks); }
    }
  }

  // ── CAPABILITIES.md scale-line + ARCHITECTURE Fitness Score (v7.7.0) ──
  // Closes the same v7.6.5 → v7.6.9 staleness pattern in the secondary docs.
  {
    const src = loadDoc('CAPABILITIES.md');
    if (src) {
      // "<N> tests (Win baseline)" — pin to Win baseline (Linux is -1 because
      // of one Win-conditional test). Update this constant on each release
      // that changes test count.
      const TESTS_WIN_BASELINE = 6905;
      const rT = check('CAPABILITIES.md', src, 'tests (Win baseline)',
        /(\d+)\s+tests \(Win baseline\)/, TESTS_WIN_BASELINE);
      if (rT) { checked.push(rT); if (!rT.ok) drifts.push(rT); }

      // "<N> modules (live `selfModel.moduleCount()`)"
      const rM = check('CAPABILITIES.md', src, 'modules (scale-line)',
        /(\d+)\s+modules \(live/, SOURCE);
      if (rM) { checked.push(rM); if (!rM.ok) drifts.push(rM); }

      // "fitness N/130"
      if (FITNESS != null) {
        const rF = check('CAPABILITIES.md', src, 'fitness (scale-line)',
          /fitness\s+(\d+)\/130/, FITNESS);
        if (rF) { checked.push(rF); if (!rF.ok) drifts.push(rF); }
      }

      // "<N> CI audit gates"
      const rG = check('CAPABILITIES.md', src, 'CI audit gates (scale-line)',
        /(\d+)\s+CI audit gates/, CI_GATES);
      if (rG) { checked.push(rG); if (!rG.ok) drifts.push(rG); }
    }
  }

  // ── ARCHITECTURE-DEEP-DIVE.md Fitness Score table (v7.7.0) ──
  {
    const src = loadDoc('ARCHITECTURE-DEEP-DIVE.md');
    if (src && FITNESS != null) {
      const r = check('ARCHITECTURE-DEEP-DIVE.md', src, 'Fitness Score (table)',
        /\|\s*Fitness Score\s*\|\s*(\d+)\/130/, FITNESS);
      if (r) { checked.push(r); if (!r.ok) drifts.push(r); }
    }
  }


  // ════════════════════════════════════════════════════════════
  // v7.7.1 extensions — header stamps, table rows, inline stats,
  // version tables, and self-referential drifts
  // ════════════════════════════════════════════════════════════

  const TESTS_WIN = 6905;
  const TEST_FILES = 406;

  // #1: ARCHITECTURE.md header version stamp
  {
    const src = loadDoc('ARCHITECTURE.md');
    if (src) {
      const r = check('ARCHITECTURE.md', src, 'header version stamp',
        /^> Version: (\d+\.\d+\.\d+)/m, VERSION,
        (m) => m[1]);
      if (r) { checked.push(r); if (!r.ok) drifts.push(r); }
    }
  }

  // #2: ARCHITECTURE.md header — events / schemas pair
  {
    const src = loadDoc('ARCHITECTURE.md');
    if (src) {
      const rE = check('ARCHITECTURE.md', src, 'header catalogued events',
        /\((\d+) catalogued events \/ \d+ schemas\)/, CATALOG);
      if (rE) { checked.push(rE); if (!rE.ok) drifts.push(rE); }
      const rS = check('ARCHITECTURE.md', src, 'header schemas',
        /\(\d+ catalogued events \/ (\d+) schemas\)/, SCHEMAS);
      if (rS) { checked.push(rS); if (!rS.ok) drifts.push(rS); }
    }
  }

  // #3: ARCHITECTURE.md header — tests + fitness
  {
    const src = loadDoc('ARCHITECTURE.md');
    if (src) {
      const rT = check('ARCHITECTURE.md', src, 'header tests',
        /^> (\d+) tests, fitness \d+\/130/m, TESTS_WIN);
      if (rT) { checked.push(rT); if (!rT.ok) drifts.push(rT); }
      if (FITNESS != null) {
        const rF = check('ARCHITECTURE.md', src, 'header fitness',
          /^> \d+ tests, fitness (\d+)\/130/m, FITNESS);
        if (rF) { checked.push(rF); if (!rF.ok) drifts.push(rF); }
      }
    }
  }

  // #4: ARCHITECTURE.md inline "Current stats: NNN catalogued events"
  {
    const src = loadDoc('ARCHITECTURE.md');
    if (src) {
      const r = check('ARCHITECTURE.md', src, 'Current stats events',
        /\*\*Current stats:\*\* (\d+) catalogued events/, CATALOG);
      if (r) { checked.push(r); if (!r.ok) drifts.push(r); }
    }
  }

  // #5–7: ARCHITECTURE-DEEP-DIVE.md Key-Numbers table
  {
    const src = loadDoc('ARCHITECTURE-DEEP-DIVE.md');
    if (src) {
      const rSM = check('ARCHITECTURE-DEEP-DIVE.md', src, 'Key Numbers Source Modules',
        /\|\s*Source Modules\s*\|\s*(\d+)\s*JS files\s*\|/, SOURCE);
      if (rSM) { checked.push(rSM); if (!rSM.ok) drifts.push(rSM); }

      const rTF = check('ARCHITECTURE-DEEP-DIVE.md', src, 'Key Numbers Test Files',
        /\|\s*Test Files \/ Tests\s*\|\s*(\d+)\s*\/\s*\d+\s*\(Win baseline\)\s*\|/, TEST_FILES);
      if (rTF) { checked.push(rTF); if (!rTF.ok) drifts.push(rTF); }

      const rTC = check('ARCHITECTURE-DEEP-DIVE.md', src, 'Key Numbers Test Count',
        /\|\s*Test Files \/ Tests\s*\|\s*\d+\s*\/\s*(\d+)\s*\(Win baseline\)\s*\|/, TESTS_WIN);
      if (rTC) { checked.push(rTC); if (!rTC.ok) drifts.push(rTC); }

      const pj = require(path.join(ROOT, 'package.json'));
      const prodDeps = Object.keys(pj.dependencies || {}).length;
      const optDeps = Object.keys(pj.optionalDependencies || {}).length;
      const devDeps = Object.keys(pj.devDependencies || {}).length;
      const expectedDeps = `${prodDeps} production + ${optDeps} optional + ${devDeps} dev`;
      const rD = check('ARCHITECTURE-DEEP-DIVE.md', src, 'Key Numbers npm Dependencies',
        /\|\s*npm Dependencies\s*\|\s*([^|]+?)\s*\|/, expectedDeps,
        (m) => m[1].trim());
      if (rD) { checked.push(rD); if (!rD.ok) drifts.push(rD); }
    }
  }

  // #5b: ARCHITECTURE-DEEP-DIVE.md src/ total comment
  {
    const src = loadDoc('ARCHITECTURE-DEEP-DIVE.md');
    if (src) {
      const r = check('ARCHITECTURE-DEEP-DIVE.md', src, 'src/ total modules',
        /=\s*src\/ total\s+(\d+)\s*modules/, SOURCE);
      if (r) { checked.push(r); if (!r.ok) drifts.push(r); }
    }
  }

  // #8: CAPABILITIES.md Z.259 test files row
  {
    const src = loadDoc('CAPABILITIES.md');
    if (src) {
      const rTF = check('CAPABILITIES.md', src, 'test files row',
        /\|\s*\*\*(\d+) test files\*\*\s*\|\s*\d+\s*tests\s*\(Win baseline/, TEST_FILES);
      if (rTF) { checked.push(rTF); if (!rTF.ok) drifts.push(rTF); }
      const rTC = check('CAPABILITIES.md', src, 'test files row count',
        /\|\s*\*\*\d+ test files\*\*\s*\|\s*(\d+)\s*tests\s*\(Win baseline/, TESTS_WIN);
      if (rTC) { checked.push(rTC); if (!rTC.ok) drifts.push(rTC); }
    }
  }

  // #9: COMMUNICATION.md baseline marker
  {
    const src = loadDoc('COMMUNICATION.md');
    if (src) {
      const r = check('COMMUNICATION.md', src, 'event types baseline',
        /\*\*\d+ event types\*\* catalogued in `EventTypes\.js` \(v(\d+\.\d+\.\d+) baseline\)/,
        VERSION,
        (m) => m[1]);
      if (r) { checked.push(r); if (!r.ok) drifts.push(r); }
    }
  }

  // #10: MCP-SERVER-SETUP.md header version
  {
    const src = loadDoc('MCP-SERVER-SETUP.md');
    if (src) {
      const r = check('MCP-SERVER-SETUP.md', src, 'header version',
        /^> v(\d+\.\d+\.\d+) — Last verified/m, VERSION,
        (m) => m[1]);
      if (r) { checked.push(r); if (!r.ok) drifts.push(r); }
    }
  }

  // #11: AUDIT-BACKLOG.md header version (root-level doc, custom load)
  {
    let src;
    try { src = fs.readFileSync(path.join(ROOT, 'AUDIT-BACKLOG.md'), 'utf-8'); }
    catch { src = null; }
    if (src) {
      const r = check('AUDIT-BACKLOG.md', src, 'header version',
        /^> Version: (\d+\.\d+\.\d+)/m, VERSION,
        (m) => m[1]);
      if (r) { checked.push(r); if (!r.ok) drifts.push(r); }
    }
  }

  // #12: SECURITY.md supported-versions table rotation
  {
    let src;
    try { src = fs.readFileSync(path.join(ROOT, 'SECURITY.md'), 'utf-8'); }
    catch { src = null; }
    if (src) {
      // Compute expected current major.minor from version
      const [maj, min] = VERSION.split('.').map(Number);
      const expectActive = `${maj}.${min}.x`;
      const r = check('SECURITY.md', src, 'supported versions Active row',
        /\|\s*(\d+\.\d+\.x)\s*\|\s*✅ Active\s*\|/, expectActive,
        (m) => m[1]);
      if (r) { checked.push(r); if (!r.ok) drifts.push(r); }
    }
  }

  // #13: README Node-version (paired with engines.node)
  {
    let src;
    try { src = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf-8'); }
    catch { src = null; }
    if (src) {
      const pj = require(path.join(ROOT, 'package.json'));
      const enginesFloor = (pj.engines && pj.engines.node || '>=0').match(/(\d+)/);
      const expectedFloor = enginesFloor ? parseInt(enginesFloor[1], 10) : 0;
      const r = check('README.md', src, 'Node version requirement',
        /Requires \*\*Node\.js (\d+)\+\*\*/, expectedFloor);
      if (r) { checked.push(r); if (!r.ok) drifts.push(r); }
    }
  }

  // #14 (B8): script-header drift-anti-pattern
  {
    let scriptDir;
    try {
      scriptDir = fs.readdirSync(path.join(ROOT, 'scripts'))
        .filter(f => f.endsWith('.js'));
    } catch { scriptDir = []; }
    let driftCount = 0;
    const driftFiles = [];
    for (const f of scriptDir) {
      try {
        const head = fs.readFileSync(path.join(ROOT, 'scripts', f), 'utf-8')
          .split('\n').slice(0, 6).join('\n');
        // match: // GENESIS — scripts/foo.js (vN.N.N…)
        // diagnose-v741-d0.js is intentionally exempt (version is part of identity)
        if (/diagnose-v\d+/.test(f)) continue;
        if (/^\/\/\s*GENESIS\s*[—-]\s*[^()\n]+\s*\(v\d+\.\d+\.\d+/m.test(head)) {
          driftCount++;
          driftFiles.push(f);
        }
      } catch { /* ignore */ }
    }
    const r = {
      doc: 'scripts/*.js',
      label: 'header version stamps (drift-prone, should not be present)',
      expected: 0,
      actual: driftCount,
      ok: driftCount === 0,
    };
    if (driftCount > 0) {
      r.detail = `Files with stamps: ${driftFiles.join(', ')}`;
    }
    checked.push(r);
    if (!r.ok) drifts.push(r);
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
const _liveFitness = getLiveFitness();
console.log(`    fitness:        ${_liveFitness != null ? _liveFitness + '/130' : 'unknown'}`);
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
