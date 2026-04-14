#!/usr/bin/env node
// ============================================================
// GENESIS — audit-schemas.js (v7.1.9)
//
// Validates EventPayloadSchemas against actual bus.emit() calls.
// Detects: stale schemas, missing schemas, payload-shape mismatches.
//
// Usage:
//   node scripts/audit-schemas.js           — human-readable output
//   node scripts/audit-schemas.js --json    — JSON output
//   node scripts/audit-schemas.js --strict  — exit 1 on mismatches
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
const schemaLines = schemaBlock[1].split('\n');
for (const line of schemaLines) {
  const m = line.match(/'([^']+)'\s*:\s*\{([^}]+)\}/);
  if (!m) continue;
  const event = m[1];
  const fields = {};
  const pairs = m[2].matchAll(/(\w+)\s*:\s*'(required|optional)'/g);
  for (const p of pairs) fields[p[1]] = p[2];
  schemas[event] = fields;
}

// ── 2. Parse EventTypes catalog ─────────────────────────

const etPath = path.resolve(__dirname, '../src/agent/core/EventTypes.js');
const etCode = fs.readFileSync(etPath, 'utf8');
const catalogEvents = new Set();
const etMatches = etCode.matchAll(/:\s+'([a-z][^']+)'/g);
for (const m of etMatches) catalogEvents.add(m[1]);

// ── 3. Scan all bus.emit()/bus.fire() calls ─────────────

const srcDir = path.resolve(__dirname, '../src/agent');
const srcFiles = [];
function walk(dir) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    if (f.name === 'node_modules' || f.name === 'vendor' || f.name === 'dist') continue;
    const full = path.join(dir, f.name);
    if (f.isDirectory()) walk(full);
    else if (f.name.endsWith('.js')) srcFiles.push(full);
  }
}
walk(srcDir);

const mismatches = [];
for (const file of srcFiles) {
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/\.(?:emit|fire)\(\s*'([^']+)'\s*,\s*\{([^}]*)\}/);
    if (!m) continue;
    const event = m[1];
    const payloadStr = m[2];
    if (!schemas[event]) continue;

    const emittedFields = new Set();
    const fieldMatches = payloadStr.matchAll(/(\w+)\s*[,:]/g);
    for (const fm of fieldMatches) emittedFields.add(fm[1]);

    const schema = schemas[event];
    for (const [field, req] of Object.entries(schema)) {
      if (req === 'required' && !emittedFields.has(field)) {
        mismatches.push({
          event, field, file: path.relative(path.resolve(__dirname, '..'), file), line: i + 1,
        });
      }
    }
  }
}

// ── 4. Cross-reference: catalog vs schemas ──────────────

const schemaEvents = new Set(Object.keys(schemas));
const missingSchemas = [...catalogEvents].filter(e => !schemaEvents.has(e)).sort();
const orphanSchemas = [...schemaEvents].filter(e => !catalogEvents.has(e)).sort();

// ── 5. Report ───────────────────────────────────────────

const report = {
  summary: {
    catalogEvents: catalogEvents.size,
    schemaEvents: schemaEvents.size,
    missingSchemas: missingSchemas.length,
    orphanSchemas: orphanSchemas.length,
    payloadMismatches: mismatches.length,
  },
  missingSchemas,
  orphanSchemas,
  payloadMismatches: mismatches,
};

if (jsonOutput) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║       GENESIS EVENT SCHEMA AUDIT         ║');
  console.log('╚══════════════════════════════════════════╝\n');

  console.log(`  Catalog events:     ${report.summary.catalogEvents}`);
  console.log(`  Schema entries:     ${report.summary.schemaEvents}`);
  console.log(`  Missing schemas:    ${report.summary.missingSchemas}`);
  console.log(`  Orphan schemas:     ${report.summary.orphanSchemas}`);
  console.log(`  Payload mismatches: ${report.summary.payloadMismatches}`);
  console.log('');

  if (missingSchemas.length > 0) {
    console.log('⚠  CATALOG EVENTS WITHOUT SCHEMA:');
    for (const e of missingSchemas.slice(0, 20)) console.log(`   "${e}"`);
    if (missingSchemas.length > 20) console.log(`   ... and ${missingSchemas.length - 20} more`);
    console.log('');
  }

  if (orphanSchemas.length > 0) {
    console.log('⚠  SCHEMAS WITHOUT CATALOG EVENT:');
    for (const e of orphanSchemas) console.log(`   "${e}"`);
    console.log('');
  }

  if (mismatches.length > 0) {
    console.log('🔴 PAYLOAD MISMATCHES (emit missing required schema fields):');
    const byEvent = {};
    for (const m of mismatches) {
      if (!byEvent[m.event]) byEvent[m.event] = [];
      byEvent[m.event].push(m);
    }
    for (const [event, ms] of Object.entries(byEvent).sort()) {
      console.log(`   "${event}":`);
      for (const m of ms) console.log(`     missing "${m.field}" at ${m.file}:${m.line}`);
    }
    console.log('');
  }

  const issues = missingSchemas.length + orphanSchemas.length + mismatches.length;
  if (issues === 0) {
    console.log('✅ All schemas match catalog and payloads.');
  } else {
    console.log(`⚠  ${issues} issue(s) found.`);
  }
  console.log('');
}

// Exit code
const hasIssues = mismatches.length > 0 || orphanSchemas.length > 0;
process.exit(strict && hasIssues ? 1 : 0);
