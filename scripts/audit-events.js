#!/usr/bin/env node
// ============================================================
// GENESIS — scripts/audit-events.js
//
// Automated EventBus event-flow audit.
// Scans all source files for bus.emit() / bus.fire() / bus.on()
// and validates against EventTypes.js catalog.
//
// Usage:
//   node scripts/audit-events.js           — full audit
//   node scripts/audit-events.js --strict  — exit 1 on warnings
//   node scripts/audit-events.js --json    — machine-readable output
//
// Reports:
//   - Emitted events not in EventTypes catalog
//   - Subscribed events not in EventTypes catalog
//   - Events in catalog never emitted
//   - Events in catalog never subscribed
//   - Emitter → subscriber flow map
// ============================================================

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const jsonOutput = args.includes('--json');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');

// ── 1. Load EventTypes catalog ──────────────────────────────

let catalogEvents;
try {
  const { EVENTS } = require(path.join(SRC_DIR, 'agent', 'core', 'EventTypes'));
  catalogEvents = new Set();
  const walk = (obj) => {
    for (const val of Object.values(obj)) {
      if (typeof val === 'string') catalogEvents.add(val);
      else if (typeof val === 'object' && val !== null) walk(val);
    }
  };
  walk(EVENTS);
} catch (err) {
  console.error('Could not load EventTypes.js:', err.message);
  process.exit(1);
}

// ── 2. Scan source files ────────────────────────────────────

const emitters = new Map();   // event → [{ file, line }]
const subscribers = new Map(); // event → [{ file, line }]

const EMIT_PATTERN = /\.(?:emit|fire)\s*\(\s*['"`]([^'"`]+)['"`]/g;
const SUB_PATTERN  = /\.on\s*\(\s*['"`]([^'"`]+)['"`]/g;

function scanFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const relPath = path.relative(ROOT, filePath);
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;

    // Reset lastIndex for each line
    EMIT_PATTERN.lastIndex = 0;
    while ((m = EMIT_PATTERN.exec(line)) !== null) {
      const event = m[1];
      if (!emitters.has(event)) emitters.set(event, []);
      emitters.get(event).push({ file: relPath, line: i + 1 });
    }

    SUB_PATTERN.lastIndex = 0;
    while ((m = SUB_PATTERN.exec(line)) !== null) {
      const event = m[1];
      if (!subscribers.has(event)) subscribers.set(event, []);
      subscribers.get(event).push({ file: relPath, line: i + 1 });
    }
  }
}

function walkDir(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
      walkDir(full);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      scanFile(full);
    }
  }
}

walkDir(SRC_DIR);

// ── 2b. Include EVENT_STORE_BUS_MAP bus values in catalog ────
try {
  const { EVENT_STORE_BUS_MAP } = require(path.join(SRC_DIR, 'agent', 'core', 'EventTypes'));
  if (EVENT_STORE_BUS_MAP) {
    for (const entry of Object.values(EVENT_STORE_BUS_MAP)) {
      if (entry && typeof entry.bus === 'string') catalogEvents.add(entry.bus);
    }
  }
} catch (_) { /* optional — EVENTS is the primary source */ }

// ── 2c. Exclusion set — Node.js / Electron / DOM events ─────
// These are emitted/listened via Node.js EventEmitter, Electron IPC,
// or DOM elements — not the Genesis EventBus. Flagging them as
// uncatalogued is a false positive.
const EXCLUDED_EVENTS = new Set([
  // Node.js stream / process events
  'error', 'data', 'end', 'close', 'message', 'timeout', 'exit',
  'drain', 'readable', 'connect', 'open', 'add', 'change', 'unlink',
  'uncaughtException', 'SIGTERM',
  // ConsciousnessExtension internal EventEmitter (not Genesis EventBus)
  'started', 'stopped', 'state-change', 'frame-processed', 'keyframe',
  'hypervigilant-entered', 'dream-complete', 'awakened', 'daydream-reflection',
  // UI component DOM-style events (GenesisChat custom element)
  'chat-send', 'chat-stop', 'chat-copy', 'chat-open-editor',
  // IPC bridge events (emitted by Electron renderer, not Genesis EventBus)
  'chat:message', 'agent:stream-chunk', 'agent:stream-done',
  // PromptEvolution internal EventEmitter
  'prompt-evolution:promoted',
]);

// ── 3. Analyze ──────────────────────────────────────────────

const emittedNotInCatalog = [];
const subscribedNotInCatalog = [];
const catalogNeverEmitted = [];
const catalogNeverSubscribed = [];

for (const event of emitters.keys()) {
  if (event.includes('*') || event.includes('$')) continue; // wildcard / template patterns
  if (EXCLUDED_EVENTS.has(event)) continue;
  if (!catalogEvents.has(event)) {
    emittedNotInCatalog.push({ event, locations: emitters.get(event) });
  }
}

for (const event of subscribers.keys()) {
  if (event.includes('*') || event.includes('$')) continue;
  if (EXCLUDED_EVENTS.has(event)) continue;
  if (!catalogEvents.has(event)) {
    subscribedNotInCatalog.push({ event, locations: subscribers.get(event) });
  }
}

for (const event of catalogEvents) {
  if (!emitters.has(event)) catalogNeverEmitted.push(event);
  if (!subscribers.has(event)) catalogNeverSubscribed.push(event);
}

// ── 4. Report ───────────────────────────────────────────────

const report = {
  summary: {
    catalogSize: catalogEvents.size,
    emittedEvents: emitters.size,
    subscribedEvents: subscribers.size,
    emittedNotInCatalog: emittedNotInCatalog.length,
    subscribedNotInCatalog: subscribedNotInCatalog.length,
    catalogNeverEmitted: catalogNeverEmitted.length,
    catalogNeverSubscribed: catalogNeverSubscribed.length,
  },
  emittedNotInCatalog,
  subscribedNotInCatalog,
  catalogNeverEmitted,
  catalogNeverSubscribed,
};

if (jsonOutput) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║       GENESIS EVENT FLOW AUDIT           ║');
  console.log('╚══════════════════════════════════════════╝\n');

  console.log(`  Catalog events:      ${report.summary.catalogSize}`);
  console.log(`  Emitted events:      ${report.summary.emittedEvents}`);
  console.log(`  Subscribed events:   ${report.summary.subscribedEvents}`);
  console.log('');

  if (emittedNotInCatalog.length > 0) {
    console.log('⚠  EMITTED but not in EventTypes catalog:');
    for (const { event, locations } of emittedNotInCatalog) {
      console.log(`   "${event}"`);
      for (const loc of locations) console.log(`     → ${loc.file}:${loc.line}`);
    }
    console.log('');
  }

  if (subscribedNotInCatalog.length > 0) {
    console.log('⚠  SUBSCRIBED but not in EventTypes catalog:');
    for (const { event, locations } of subscribedNotInCatalog) {
      console.log(`   "${event}"`);
      for (const loc of locations) console.log(`     → ${loc.file}:${loc.line}`);
    }
    console.log('');
  }

  if (catalogNeverEmitted.length > 0) {
    console.log('ℹ  Catalog events NEVER EMITTED (dead entries?):');
    for (const e of catalogNeverEmitted.slice(0, 20)) console.log(`   "${e}"`);
    if (catalogNeverEmitted.length > 20) console.log(`   ... and ${catalogNeverEmitted.length - 20} more`);
    console.log('');
  }

  if (catalogNeverSubscribed.length > 0) {
    console.log('ℹ  Catalog events NEVER SUBSCRIBED (unhandled?):');
    for (const e of catalogNeverSubscribed.slice(0, 20)) console.log(`   "${e}"`);
    if (catalogNeverSubscribed.length > 20) console.log(`   ... and ${catalogNeverSubscribed.length - 20} more`);
    console.log('');
  }

  const warnings = emittedNotInCatalog.length + subscribedNotInCatalog.length;
  if (warnings === 0) {
    console.log('✅ All events match the EventTypes catalog.');
  } else {
    console.log(`⚠  ${warnings} event(s) not in catalog.`);
  }
  console.log('');
}

// Exit code
const hasWarnings = emittedNotInCatalog.length > 0 || subscribedNotInCatalog.length > 0;
process.exit(strict && hasWarnings ? 1 : 0);
