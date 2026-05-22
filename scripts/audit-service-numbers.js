#!/usr/bin/env node
// ============================================================
// GENESIS — scripts/audit-service-numbers.js
//
// Verifies that the three key codebase numbers (manifest-
// registered services, runtime-active services, source modules)
// appear consistently across the project documentation and match
// the live values measured from src/ and the DI manifests.
//
// Why this exists: the v7.9.5 deep-analysis audit found these
// numbers drifting across ARCHITECTURE.md (155/168/311),
// README.md (164/177, badge 168), ARCHITECTURE-DEEP-DIVE.md
// (164/177), and the live container (165/178/375). audit-doc-
// drift.js verifies 58 specific claims but did not catch the
// service-count drift because the wording varies across files.
//
// LIVE VALUES (re-measured at each run):
//   - manifest-services: services declared in
//     src/agent/manifest/phase*.js
//   - runtime-services:  reported by validate-service-wiring.js
//   - source-modules:    *.js files under src/
//
// SCANS:
//   - ARCHITECTURE.md            (chapter 1 prose)
//   - README.md                  (badge + technical-detail table)
//   - docs/ARCHITECTURE-DEEP-DIVE.md (layer diagram + counts)
//   - docs/CAPABILITIES.md       (if present)
//
// PATTERNS DETECTED (heuristic — high recall):
//   - "NNN services" / "NNN DI services" / "NNN manifest services"
//   - "NNN at runtime" / "NNN runtime" / "NNN active services"
//   - "NNN source modules" / "NNN modules" / "NNN .js files"
//   - badge URLs: "services-NNN"
//
// CLI:
//   node scripts/audit-service-numbers.js           (informational)
//   node scripts/audit-service-numbers.js --strict  (exits 1 on drift)
// ============================================================

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const STRICT = process.argv.includes('--strict');
const REPO_ROOT = path.resolve(__dirname, '..');

// ─── Live measurement ─────────────────────────────────────────

function countManifestServices() {
  // A registered service is a line like:
  //   ['serviceName', {
  // inside one of the phase manifest files.
  const dir = path.join(REPO_ROOT, 'src', 'agent', 'manifest');
  let total = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.startsWith('phase') || !f.endsWith('.js')) continue;
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const matches = text.match(/^\s*\['[a-zA-Z_][a-zA-Z0-9_]*',\s*\{/gm);
    if (matches) total += matches.length;
  }
  return total;
}

function countRuntimeServices() {
  // validate-service-wiring prints "Registered services: NNN".
  try {
    const out = execSync('node scripts/validate-service-wiring.js', {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const m = out.match(/Registered services:\s*(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  } catch (e) {
    // Validator exits non-zero on unresolved refs but still emits the count.
    const out = (e.stdout || '') + (e.stderr || '');
    const m = out.match(/Registered services:\s*(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }
}

function countSourceModules() {
  // Cross-platform recursive walk. POSIX `find` is not available on
  // Windows (where `find` is a different, unrelated text-search tool),
  // so we use native fs. Counts *.js files anywhere under src/.
  const srcDir = path.join(REPO_ROOT, 'src');
  let count = 0;
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.js')) count++;
    }
  }
  walk(srcDir);
  return count;
}

// ─── Doc scanning ─────────────────────────────────────────────

const TARGETS = [
  'ARCHITECTURE.md',
  'README.md',
  'docs/ARCHITECTURE-DEEP-DIVE.md',
  'docs/CAPABILITIES.md',
];

// Each pattern returns the matched number plus the category it claims to
// represent. We keep the regex narrow enough to avoid grabbing unrelated
// numbers (versions, byte counts) but wide enough to catch the common
// phrasings.

const NUMBER_PATTERNS = [
  // Manifest-services: "registers 165 DI-managed services", "165 manifest services",
  // "165 services from 12 phase files".
  { kind: 'manifest', re: /\b(\d{2,4})\s+(?:DI-managed services|manifest[- ]services|services from \d+ phase|services\s+(?:are\s+)?(?:statically\s+)?(?:declared|registered)|services\s+(?:in|across)\s+(?:the\s+)?(?:DI\s+)?manifest)/gi },
  { kind: 'manifest', re: /registers?\s+(\d{2,4})\s+(?:DI-managed\s+)?services/gi },
  { kind: 'manifest', re: /\b(\d{2,4})\s+manifest\b/gi },
  { kind: 'manifest', re: /\bManifest-Services\s+\(registriert\)\s*\|\s*\*\*(\d{2,4})/gi },

  // Runtime-services: "178 at runtime", "178 active services", "178-service graph",
  // "178 runtime", "= 178 runtime".
  { kind: 'runtime', re: /\b(\d{2,4})\s+(?:at\s+runtime|active services|runtime services?|runtime\s+\(|service\s+graph|services\s+(?:running|at runtime|active in the container))/gi },
  { kind: 'runtime', re: /=\s*(\d{2,4})\s+(?:at\s+)?runtime/gi },
  { kind: 'runtime', re: /\b(\d{2,4})-service\b/gi },
  { kind: 'runtime', re: /service count to\s+(\d{2,4})/gi },

  // Source-modules: "375 source modules", "311 modules", "375 modules"
  { kind: 'modules', re: /\b(\d{2,4})\s+source modules?\b/gi },
  { kind: 'modules', re: /\b(\d{2,4})\s+modules\s+(?:in\s+)?src\//gi },
  { kind: 'modules', re: /src\/\s+total\s+(\d{2,4})\s+modules/gi },

  // Badge: "services-NNN"
  { kind: 'badge', re: /services-(\d{2,4})/g },
];

// Badge maps to runtime-services semantically — the README badge is the
// "total active service count" claim.

function scanFile(relPath, expected) {
  const full = path.join(REPO_ROOT, relPath);
  if (!fs.existsSync(full)) return [];
  const text = fs.readFileSync(full, 'utf8');
  const lines = text.split('\n');

  const findings = [];

  for (const { kind, re } of NUMBER_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const value = parseInt(m[1], 10);
      // Locate line number for nicer reporting
      const offset = m.index;
      const before = text.slice(0, offset);
      const lineNo = before.split('\n').length;
      const lineText = lines[lineNo - 1] || '';

      const semanticKind = kind === 'badge' ? 'runtime' : kind;
      const expectedValue = expected[semanticKind];
      if (expectedValue === null || expectedValue === undefined) continue;

      findings.push({
        file: relPath,
        line: lineNo,
        kind: semanticKind,
        actual: value,
        expected: expectedValue,
        ok: value === expectedValue,
        snippet: lineText.trim().slice(0, 110),
      });
    }
  }
  return findings;
}

// ─── Main ─────────────────────────────────────────────────────

function main() {
  console.log('━━━ Service Numbers Audit ━━━\n');

  const expected = {
    manifest: countManifestServices(),
    runtime: countRuntimeServices(),
    modules: countSourceModules(),
  };

  console.log('  Live values:');
  console.log(`    manifest-services:  ${expected.manifest}`);
  console.log(`    runtime-services:   ${expected.runtime}`);
  console.log(`    source-modules:     ${expected.modules}\n`);

  const allFindings = [];
  for (const target of TARGETS) {
    allFindings.push(...scanFile(target, expected));
  }

  // Dedupe by (file, line, kind, actual) so the same hit from two regexes
  // doesn't double-report.
  const seen = new Set();
  const findings = [];
  for (const f of allFindings) {
    const key = `${f.file}:${f.line}:${f.kind}:${f.actual}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push(f);
  }

  const drifts = findings.filter(f => !f.ok);

  if (drifts.length === 0) {
    console.log(`  \x1b[32m✅ All ${findings.length} service/module counts in docs match live values.\x1b[0m`);
    process.exit(0);
  }

  console.log(`  \x1b[33m⚠ Found ${drifts.length} drift(s) across ${new Set(drifts.map(d => d.file)).size} file(s):\x1b[0m\n`);

  const byFile = new Map();
  for (const d of drifts) {
    if (!byFile.has(d.file)) byFile.set(d.file, []);
    byFile.get(d.file).push(d);
  }
  for (const [file, ds] of byFile) {
    console.log(`  \x1b[1m${file}\x1b[0m`);
    for (const d of ds) {
      console.log(`     \x1b[2mL${d.line}\x1b[0m  [${d.kind}] doc=${d.actual} live=${d.expected}`);
      console.log(`           ${d.snippet}`);
    }
    console.log('');
  }

  console.log('  Convention: service/module counts in ARCHITECTURE.md, README.md,');
  console.log('  docs/ARCHITECTURE-DEEP-DIVE.md, and docs/CAPABILITIES.md must match');
  console.log('  the live values. Update the doc to the actual count or, if the count');
  console.log('  is the one drifting, investigate why before changing the doc.');

  if (STRICT) process.exit(1);
  process.exit(0);
}

main();
