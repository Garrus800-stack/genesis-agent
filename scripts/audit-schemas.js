#!/usr/bin/env node
// ============================================================
// GENESIS — audit-schemas.js (v7.3.4)
//
// Cross-references EventTypes catalog ↔ EventPayloadSchemas.
// Reports two classes of drift:
//   - Missing schemas: events in catalog without a schema entry
//   - Orphan schemas: schema entries without a matching catalog event
//
// Payload-shape validation is handled by scripts/scan-schemas.js,
// which runs the real Node module loader and the same validation
// path the runtime uses. This script used to attempt a regex-based
// payload check, but the regex could not handle multi-line emits,
// nested braces, or template-literal payloads — it produced false
// positives that masked real issues.  Retired in v7.3.4.
//
// Usage:
//   node scripts/audit-schemas.js           — human-readable output
//   node scripts/audit-schemas.js --json    — JSON output
//   node scripts/audit-schemas.js --strict  — exit 1 on drift
// ============================================================

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const jsonOutput = args.includes('--json');
const strict = args.includes('--strict');

// ── 1. Parse SCHEMAS from EventPayloadSchemas.js ────────

const epsPath = path.resolve(__dirname, '../src/agent/core/EventPayloadSchemas.js');
const epsCode = fs.readFileSync(epsPath, 'utf8');
const schemaBlock = epsCode.match(/const SCHEMAS = \{([\s\S]+?)\n\};/);
if (!schemaBlock) { console.error('Could not parse SCHEMAS block'); process.exit(1); }

const schemas = {};
// Match each `'event:name': { ... }` entry across one OR multiple lines.
// The previous per-line parser missed entries whose body spanned lines like:
//   'expectation:compared': {
//     totalSurprise: 'required',
//     ...
//   }
// causing audit-schemas to falsely report them as missing.  v7.3.4 fix.
const entryRegex = /['"]([^'"\n]+)['"]\s*:\s*\{([^{}]*)\}/g;
for (const m of schemaBlock[1].matchAll(entryRegex)) {
  const event = m[1];
  // Skip non-event-looking keys (need a ':' in the name to be a Genesis event)
  if (!event.includes(':')) continue;
  const fields = {};
  const fieldMatches = m[2].matchAll(/(\w+)\s*:\s*['"](\w+)['"]/g);
  for (const fm of fieldMatches) fields[fm[1]] = fm[2];
  schemas[event] = fields;
}

// ── 2. Parse EventTypes catalog ─────────────────────────

const etPath = path.resolve(__dirname, '../src/agent/core/EventTypes.js');
const etCode = fs.readFileSync(etPath, 'utf8');
const catalogEvents = new Set();
const catalogMatches = etCode.matchAll(/['"]([\w-]+:[\w-:]+)['"]/g);
for (const cm of catalogMatches) catalogEvents.add(cm[1]);

// ── 3. Cross-reference ──────────────────────────────────

const schemaEvents = new Set(Object.keys(schemas));
const missingSchemas = [...catalogEvents].filter(e => !schemaEvents.has(e)).sort();
const orphanSchemas = [...schemaEvents].filter(e => !catalogEvents.has(e)).sort();

// ── 4. Report ───────────────────────────────────────────

const report = {
  summary: {
    catalogEvents: catalogEvents.size,
    schemaEvents: schemaEvents.size,
    missingSchemas: missingSchemas.length,
    orphanSchemas: orphanSchemas.length,
  },
  missingSchemas,
  orphanSchemas,
};

if (jsonOutput) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║       GENESIS EVENT SCHEMA AUDIT         ║');
  console.log('╚══════════════════════════════════════════╝\n');

  console.log(`  Catalog events:  ${report.summary.catalogEvents}`);
  console.log(`  Schema entries:  ${report.summary.schemaEvents}`);
  console.log(`  Missing schemas: ${report.summary.missingSchemas}`);
  console.log(`  Orphan schemas:  ${report.summary.orphanSchemas}`);
  console.log('');
  console.log('  Payload validation: run scripts/scan-schemas.js');
  console.log('');

  if (missingSchemas.length > 0) {
    console.log('⚠  CATALOG EVENTS WITHOUT SCHEMA:');
    for (const e of missingSchemas) console.log(`   "${e}"`);
    console.log('');
  }

  if (orphanSchemas.length > 0) {
    console.log('⚠  SCHEMAS WITHOUT CATALOG EVENT:');
    for (const e of orphanSchemas) console.log(`   "${e}"`);
    console.log('');
  }

  const issues = missingSchemas.length + orphanSchemas.length;
  if (issues === 0) {
    console.log('✅ Catalog and schemas are in sync.');
  } else {
    console.log(`⚠  ${issues} drift issue(s) found.`);
  }
  console.log('');
}

// Exit code
const hasIssues = missingSchemas.length > 0 || orphanSchemas.length > 0;
process.exit(strict && hasIssues ? 1 : 0);
