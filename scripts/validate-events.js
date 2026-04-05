#!/usr/bin/env node
// ============================================================
// GENESIS — scripts/validate-events.js
// CI script: validates EventBus payload schemas.
//
// Runs without Electron — pure Node.js. Checks that:
// 1. All emitted events are in EventTypes catalog
// 2. All EventPayloadSchemas have matching EventTypes
// 3. No orphaned schemas (defined but never emitted)
//
// Usage:
//   node scripts/validate-events.js          — validate and report
//   node scripts/validate-events.js --strict — exit 1 on warnings
//
// v4.10.0: Added as CI gate for event schema integrity.
// ============================================================

const fs = require('fs');
const path = require('path');

const strict = process.argv.includes('--strict');
const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'agent');

// ── Load EventTypes catalog ──
const { EVENTS } = require(path.join(SRC, 'core', 'EventTypes'));

function flattenEvents(obj, prefix = '') {
  const result = new Set();
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === 'string') result.add(val);
    else if (typeof val === 'object' && val !== null) {
      for (const v of flattenEvents(val)) result.add(v);
    }
  }
  return result;
}

const catalogEvents = flattenEvents(EVENTS);

// Also include EVENT_STORE_BUS_MAP bus values in catalog
try {
  const { EVENT_STORE_BUS_MAP } = require(path.join(SRC, 'core', 'EventTypes'));
  if (EVENT_STORE_BUS_MAP) {
    for (const entry of Object.values(EVENT_STORE_BUS_MAP)) {
      if (entry && typeof entry.bus === 'string') catalogEvents.add(entry.bus);
    }
  }
} catch (_) { /* optional */ }

// ── Load Payload Schemas ──
let schemaEvents = new Set();
try {
  const { SCHEMAS } = require(path.join(SRC, 'core', 'EventPayloadSchemas'));
  if (SCHEMAS) {
    schemaEvents = new Set(Object.keys(SCHEMAS));
  }
} catch {
  console.log('⚠ EventPayloadSchemas not loadable — skipping schema cross-check');
}

// ── Scan source for emit/fire calls ──
function scanEmits(dir) {
  const emits = new Map(); // eventName → [{ file, line }]
  const files = getAllJS(dir);

  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match: bus.emit('event', ...), bus.fire('event', ...), .emit('event', ...)
      const matches = line.matchAll(/\.(?:emit|fire)\(\s*['`]([^'`]+)['`]/g);
      for (const m of matches) {
        const event = m[1];
        if (!emits.has(event)) emits.set(event, []);
        emits.get(event).push({
          file: path.relative(ROOT, filePath),
          line: i + 1,
        });
      }
      // Also match EVENTS.X.Y references used in emit
      const eventsRefMatches = line.matchAll(/\.(?:emit|fire)\(\s*EVENTS\.(\S+?)[,)]/g);
      for (const m of eventsRefMatches) {
        // These are valid by definition since they reference the catalog
      }
    }
  }
  return emits;
}

function getAllJS(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      results.push(...getAllJS(full));
    } else if (entry.name.endsWith('.js')) {
      results.push(full);
    }
  }
  return results;
}

// ── Run Checks ──
console.log('\n╔══════════════════════════════════════════╗');
console.log('║     GENESIS EVENT VALIDATION             ║');
console.log('╚══════════════════════════════════════════╝\n');

const emits = scanEmits(SRC);
let warnings = 0;
let errors = 0;

console.log(`Catalog: ${catalogEvents.size} event types`);
console.log(`Schemas: ${schemaEvents.size} payload schemas`);
console.log(`Source:  ${emits.size} unique emit calls\n`);

// Check 1: Emitted events not in catalog
console.log('━━━ Check 1: Unknown Events ━━━');

// Exclusion set — Node.js EventEmitter / ConsciousnessExtension internal events
const EXCLUDED_EVENTS = new Set([
  'error', 'data', 'end', 'close', 'message', 'timeout', 'exit',
  'drain', 'readable', 'connect', 'open', 'add', 'change', 'unlink',
  'uncaughtException',
  'started', 'stopped', 'state-change', 'frame-processed', 'keyframe',
  'hypervigilant-entered', 'dream-complete', 'awakened', 'daydream-reflection',
  'chat-send', 'chat-stop', 'chat-copy', 'chat-open-editor',
]);

const unknownEvents = [];
for (const [event, locations] of emits) {
  // Skip dynamic events (contain variables or template literals)
  if (event.includes('$') || event.includes('{')) continue;
  if (EXCLUDED_EVENTS.has(event)) continue;
  if (!catalogEvents.has(event)) {
    unknownEvents.push({ event, locations });
    warnings++;
  }
}

if (unknownEvents.length === 0) {
  console.log('  ✓ All emitted events are in EventTypes catalog');
} else {
  console.log(`  ⚠ ${unknownEvents.length} event(s) not in catalog:`);
  for (const { event, locations } of unknownEvents.slice(0, 20)) {
    const loc = locations[0];
    console.log(`    ${event}  (${loc.file}:${loc.line})`);
  }
  if (unknownEvents.length > 20) console.log(`    ... and ${unknownEvents.length - 20} more`);
}

// Check 2: Schemas without matching catalog entries
console.log('\n━━━ Check 2: Orphaned Schemas ━━━');
const orphanedSchemas = [];
for (const schemaEvent of schemaEvents) {
  if (!catalogEvents.has(schemaEvent)) {
    orphanedSchemas.push(schemaEvent);
    warnings++;
  }
}

if (orphanedSchemas.length === 0) {
  console.log('  ✓ All schemas match catalog entries');
} else {
  console.log(`  ⚠ ${orphanedSchemas.length} schema(s) without catalog entry:`);
  for (const event of orphanedSchemas) {
    console.log(`    ${event}`);
  }
}

// Check 3: High-traffic events without schemas
console.log('\n━━━ Check 3: Unschema\'d High-Traffic Events ━━━');
const highTraffic = [...emits.entries()]
  .filter(([, locs]) => locs.length >= 3)
  .filter(([event]) => !schemaEvents.has(event) && catalogEvents.has(event))
  .sort((a, b) => b[1].length - a[1].length);

if (highTraffic.length === 0) {
  console.log('  ✓ All high-traffic events have schemas');
} else {
  console.log(`  ℹ ${highTraffic.length} high-traffic event(s) lack schemas (recommended):`);
  for (const [event, locs] of highTraffic.slice(0, 10)) {
    console.log(`    ${event} (${locs.length} emit sites)`);
  }
}

// ── Summary ──
console.log('\n━━━ Summary ━━━');
console.log(`  Warnings: ${warnings}`);
console.log(`  Errors:   ${errors}`);

if (strict && (warnings > 0 || errors > 0)) {
  console.log('\n✗ Strict mode: failing due to warnings/errors');
  process.exit(1);
} else if (errors > 0) {
  console.log('\n✗ Errors found');
  process.exit(1);
} else {
  console.log('\n✓ Event validation passed');
  process.exit(0);
}
