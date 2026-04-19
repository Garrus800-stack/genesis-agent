#!/usr/bin/env node
// ============================================================
// GENESIS — scripts/scan-schemas.js (v7.2.7)
//
// Static schema validation: checks that every bus.emit/fire call
// includes the required fields defined in EventPayloadSchemas.
//
// Handles:
//   - Standard properties:  { key: value }
//   - ES6 shorthand:        { key }  (no colon)
//   - Spread operator:      { ...obj } (skips check — can't resolve statically)
//   - Multi-line payloads
//   - Nested objects in payload (only checks top-level keys)
//
// Usage:
//   node scripts/scan-schemas.js          # full scan
//   node scripts/scan-schemas.js --quiet  # exit code only
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');

const { SCHEMAS } = require('../src/agent/core/EventPayloadSchemas');

const quiet = process.argv.includes('--quiet');
const srcDir = path.join(__dirname, '..', 'src', 'agent');

// ── Collect all .js files ────────────────────────────────────
function walk(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) results.push(...walk(full));
    else if (entry.endsWith('.js')) results.push(full);
  }
  return results;
}

// ── Extract payload text with bracket matching ───────────────
// Starting from the position after the opening `{`, find the matching `}`.
// Handles nested `{}` correctly.
function extractPayload(code, startIdx) {
  let depth = 1;
  let i = startIdx;
  while (i < code.length && depth > 0) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') depth--;
    i++;
  }
  if (depth !== 0) return null;
  return code.slice(startIdx, i - 1); // content between { and }
}

// ── Parse top-level property names from payload text ─────────
// Returns { keys: string[], hasSpread: boolean }
function parsePayloadKeys(payloadText) {
  const keys = [];
  let hasSpread = false;

  // Remove nested objects/arrays (replace { ... } and [ ... ] with placeholder)
  let cleaned = '';
  let depth = 0;
  for (let i = 0; i < payloadText.length; i++) {
    const ch = payloadText[i];
    if (ch === '{' || ch === '[') { depth++; cleaned += ' '; continue; }
    if (ch === '}' || ch === ']') { depth--; cleaned += ' '; continue; }
    if (depth > 0) { cleaned += ' '; continue; }
    cleaned += ch;
  }

  // Remove string literals (single, double, template)
  cleaned = cleaned.replace(/'[^']*'/g, '""');
  cleaned = cleaned.replace(/"[^"]*"/g, '""');
  cleaned = cleaned.replace(/`[^`]*`/g, '""');

  // Remove comments
  cleaned = cleaned.replace(/\/\/[^\n]*/g, '');
  cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, '');

  // Check for spread
  if (/\.\.\./.test(cleaned)) hasSpread = true;

  // Match standard properties: `key:` or `key :` 
  const standardRe = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g;
  let m;
  while ((m = standardRe.exec(cleaned)) !== null) {
    keys.push(m[1]);
  }

  // Match shorthand properties: word followed by , or end
  // Split by commas, trim, find bare identifiers
  const parts = cleaned.split(',');
  for (const part of parts) {
    const trimmed = part.trim();
    // Shorthand: just an identifier (no colon, no spread, no function call)
    if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(trimmed) && !keys.includes(trimmed)) {
      keys.push(trimmed);
    }
  }

  return { keys, hasSpread };
}

// ── Main scan ────────────────────────────────────────────────
const files = walk(srcDir);
const issues = [];
let totalEmits = 0;
let checkedEmits = 0;
let skippedSpread = 0;

// Match: .emit('event-name', {  or  .fire('event-name', {
const emitRe = /\.(?:emit|fire)\(\s*['"]([^'"]+)['"]\s*,\s*\{/g;

for (const filePath of files) {
  const code = fs.readFileSync(filePath, 'utf8');
  const fileName = path.relative(srcDir, filePath);
  let match;

  while ((match = emitRe.exec(code)) !== null) {
    totalEmits++;
    const eventName = match[1];
    const schema = SCHEMAS[eventName];
    if (!schema) continue; // No schema for this event — skip

    checkedEmits++;

    // Extract full payload
    const payloadStart = match.index + match[0].length; // position after opening {
    const payloadText = extractPayload(code, payloadStart);
    if (!payloadText) continue; // Couldn't parse — skip

    const { keys, hasSpread } = parsePayloadKeys(payloadText);

    if (hasSpread) {
      skippedSpread++;
      continue; // Can't validate spread payloads statically
    }

    // Check required fields
    const requiredFields = Object.entries(schema)
      .filter(([, v]) => v === 'required')
      .map(([k]) => k);

    for (const field of requiredFields) {
      if (!keys.includes(field)) {
        issues.push({ event: eventName, field, file: fileName });
      }
    }
  }
}

// ── Report ───────────────────────────────────────────────────
if (!quiet) {
  console.log(`\n  Genesis Schema Scanner v7.3.2`);
  console.log(`  ─────────────────────────────`);
  console.log(`  Source files scanned:  ${files.length}`);
  console.log(`  Total emit/fire calls: ${totalEmits}`);
  console.log(`  Checked (has schema):  ${checkedEmits}`);
  console.log(`  Skipped (spread):      ${skippedSpread}`);
  console.log(`  Mismatches:            ${issues.length}`);
  console.log();
}

if (issues.length === 0) {
  if (!quiet) console.log('  ✅ Zero schema mismatches\n');
  process.exit(0);
} else {
  if (!quiet) {
    for (const { event, field, file } of issues) {
      console.log(`  ❌ ${event} missing "${field}" in ${file}`);
    }
    console.log();
  }
  process.exit(1);
}
