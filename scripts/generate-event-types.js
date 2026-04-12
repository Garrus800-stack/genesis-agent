#!/usr/bin/env node
// ============================================================
// GENESIS — scripts/generate-event-types.js (v7.1.2)
//
// Generates src/agent/core/EventPayloads.d.ts from the runtime
// EventPayloadSchemas.js. Provides TypeScript-level type safety
// for bus.fire() and bus.on() without changing any .js file.
//
// Usage:
//   node scripts/generate-event-types.js           — generate
//   node scripts/generate-event-types.js --check   — verify up-to-date
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCHEMAS_PATH = path.join(ROOT, 'src', 'agent', 'core', 'EventPayloadSchemas.js');
const OUTPUT_PATH = path.join(ROOT, 'src', 'agent', 'core', 'EventPayloads.d.ts');
const CHECK_MODE = process.argv.includes('--check');

// Load schemas
const schemasContent = fs.readFileSync(SCHEMAS_PATH, 'utf-8');

// Parse event names and their field specs from the schemas object
// Format: 'event:name': { field1: 'required', field2: 'optional' }
const eventRegex = /'([a-z][\w-]*:[a-z][\w-]*)'\s*:\s*\{([^}]*)\}/g;
const events = [];

let match;
while ((match = eventRegex.exec(schemasContent))) {
  const eventName = match[1];
  const fieldsStr = match[2].trim();

  const fields = [];
  if (fieldsStr) {
    const fieldRegex = /(\w+)\s*:\s*'(required|optional)'/g;
    let fieldMatch;
    while ((fieldMatch = fieldRegex.exec(fieldsStr))) {
      fields.push({
        name: fieldMatch[1],
        required: fieldMatch[2] === 'required',
      });
    }
  }

  events.push({ name: eventName, fields });
}

// Generate .d.ts content
const lines = [
  '// ============================================================',
  '// GENESIS — EventPayloads.d.ts (auto-generated)',
  `// Generated: ${new Date().toISOString().split('T')[0]}`,
  `// Source: EventPayloadSchemas.js (${events.length} events)`,
  '//',
  '// DO NOT EDIT — regenerate with:',
  '//   node scripts/generate-event-types.js',
  '// ============================================================',
  '',
  '/** Payload type map for all Genesis EventBus events. */',
  'export interface EventPayloadMap {',
];

for (const evt of events) {
  const fieldDefs = evt.fields
    .map(f => `    ${f.name}${f.required ? '' : '?'}: any;`)
    .join('\n');

  if (fieldDefs) {
    lines.push(`  '${evt.name}': {`);
    lines.push(fieldDefs);
    lines.push('  };');
  } else {
    lines.push(`  '${evt.name}': Record<string, never>;`);
  }
}

lines.push('}');
lines.push('');
lines.push('/** All known event names. */');
lines.push(`export type EventName = keyof EventPayloadMap;`);
lines.push('');

const output = lines.join('\n');

if (CHECK_MODE) {
  if (!fs.existsSync(OUTPUT_PATH)) {
    console.error('[EVENT-TYPES] EventPayloads.d.ts not found — run: node scripts/generate-event-types.js');
    process.exit(1);
  }
  const existing = fs.readFileSync(OUTPUT_PATH, 'utf-8');
  // Compare ignoring the date line
  const normalize = (s) => s.replace(/^\/\/ Generated:.*$/m, '');
  if (normalize(existing) !== normalize(output)) {
    console.error('[EVENT-TYPES] EventPayloads.d.ts is out of date — regenerate with: node scripts/generate-event-types.js');
    process.exit(1);
  }
  console.log(`[EVENT-TYPES] ✅ EventPayloads.d.ts is up to date (${events.length} events)`);
} else {
  fs.writeFileSync(OUTPUT_PATH, output, 'utf-8');
  console.log(`[EVENT-TYPES] ✅ Generated EventPayloads.d.ts — ${events.length} events`);
}
