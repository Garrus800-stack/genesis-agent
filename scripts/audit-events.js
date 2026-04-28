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

// v7.5.1: also scan main.js — it owns IPC bridging and emits ui:heartbeat,
// boot:complete, etc. via agent.bus?.emit() from ipcMain handlers.
const MAIN_JS = path.join(ROOT, 'main.js');
if (fs.existsSync(MAIN_JS)) scanFile(MAIN_JS);

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
  'uncaughtException', 'unhandledRejection', 'SIGTERM',
  // ConsciousnessExtension internal EventEmitter (not Genesis EventBus)
  'started', 'stopped', 'state-change', 'frame-processed', 'keyframe',
  'hypervigilant-entered', 'dream-complete', 'awakened', 'daydream-reflection',
  // IPC bridge events (emitted by Electron renderer, not Genesis EventBus)
  'chat:message', 'agent:stream-chunk', 'agent:stream-done',
  'agent:request-stream',
  // Electron app/window/webContents internal events
  'did-finish-load', 'did-fail-load', 'dom-ready',
  'will-navigate', 'window-all-closed', 'before-quit', 'activate',
  // v7.1.7 H-3: Removed 'prompt-evolution:promoted' — it IS a Bus event since v7.1.6
]);

// ── v7.5.1: Structural false-positive classes for "listener without emitter" ──
//
// Goal: replace the manual EXCLUDED_EVENTS list (which always lags reality)
// with structural rules that auto-detect the four legitimate cases that look
// like uncatalogued listeners but aren't real bugs:
//   FP1. UI-renderer files subscribe to push-channels sent via webContents.send
//        — the emitter lives in main.js / AgentCoreWire push(), not bus.emit.
//   FP2. AgentCoreWire registers bus.on() for IPC channels coming FROM the
//        renderer — the emitter is the Electron IPC bridge, not src/.
//   FP3. Settings toggles emit dynamic event names from a TOGGLE_EVENT_KEYS map
//        the regex parser can't see.
//   FP4. AgentCoreWire push-bridges: events appear as string literals inside
//        `push('...', data)` calls — those ARE the emit, just not via bus.emit.
const PUSH_CHANNELS = new Set();
try {
  const wireSrc = fs.readFileSync(path.join(SRC_DIR, 'agent', 'AgentCoreWire.js'), 'utf-8');
  for (const m of wireSrc.matchAll(/push\s*\(\s*['"`]([^'"`]+)['"`]/g)) {
    PUSH_CHANNELS.add(m[1]);
  }
} catch (_e) { /* AgentCoreWire absent in older trees → empty set */ }

const PRELOAD_RECEIVE_CHANNELS = new Set();
try {
  for (const fname of ['preload.mjs', 'preload.js']) {
    const p = path.join(ROOT, fname);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf-8');
    const m = src.match(/const\s+ALLOWED_RECEIVE\s*=\s*\[([^\]]+)\]/s);
    if (m) {
      for (const c of m[1].matchAll(/'([^']+)'/g)) PRELOAD_RECEIVE_CHANNELS.add(c[1]);
    }
  }
} catch (_e) { /* tolerate missing preload */ }

function isFalsePositiveListener(event, locations) {
  // FP1: All listener locations are in src/ui/  → renderer-side, emitter is push()
  if (locations.every(loc => loc.file.startsWith('src/ui/') || loc.file.startsWith('src\\ui\\'))) {
    return 'ui-renderer';
  }
  // FP3: Dynamic settings-toggle emit pattern
  if (/^settings:.+-(?:toggled|changed)$/.test(event)) {
    return 'settings-toggle-dynamic';
  }
  // FP4: AgentCoreWire push() is the actual emit
  if (PUSH_CHANNELS.has(event)) {
    return 'push-bridge';
  }
  // FP2: AgentCoreWire/AgentCore listener on a channel the renderer sends
  // (declared in preload ALLOWED_INVOKE/SEND area)
  const isWireListener = locations.every(loc =>
    loc.file === 'src/agent/AgentCoreWire.js' ||
    loc.file === 'src/agent/AgentCore.js' ||
    loc.file === 'src\\agent\\AgentCoreWire.js' ||
    loc.file === 'src\\agent\\AgentCore.js'
  );
  if (isWireListener && PRELOAD_RECEIVE_CHANNELS.has(event)) {
    return 'ipc-from-renderer';
  }
  // Some IPC channels exist in main.js CHANNELS but not in ALLOWED_RECEIVE
  // (e.g. agent:chat invokers). Be conservative: only auto-exclude wire-listeners
  // whose name follows the known IPC namespacing.
  if (isWireListener && /^(?:reasoning|web|settings|ui):/.test(event)) {
    return 'ipc-from-renderer-namespace';
  }
  return null;
}

// ── 3. Analyze ──────────────────────────────────────────────

const emittedNotInCatalog = [];
const subscribedNotInCatalog = [];
const catalogNeverEmitted = [];
const catalogNeverSubscribed = [];

// v7.1.7 H-3: Cross-reference — listeners without emitters and vice versa
// This catches event-name mismatches like shell:complete vs shell:outcome (v6.1.1→v7.1.6)
const listenersWithoutEmitters = [];
const frequentEmittersWithoutListeners = [];

// Dynamic event patterns that won't have static matches
const DYNAMIC_PATTERNS = [
  /^store:/, // EventStore emits store:${type} dynamically
  /^frontier:/, // FrontierWriter emits frontier:${name}:written/merged
  /^resource:(?:available|unavailable)$/, // ResourceRegistry: const eventName = next.available ? 'resource:available' : 'resource:unavailable'
];
const isDynamic = (event) => DYNAMIC_PATTERNS.some(p => p.test(event));

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
  // v7.5.1: skip subscribed-not-in-catalog if it's a known false-positive class
  const fpClass = isFalsePositiveListener(event, subscribers.get(event));
  if (fpClass) continue;
  if (!catalogEvents.has(event)) {
    subscribedNotInCatalog.push({ event, locations: subscribers.get(event) });
  }
  // H-3: Listener without emitter?
  if (!emitters.has(event) && !isDynamic(event) && !EXCLUDED_EVENTS.has(event)) {
    // v7.5.1: structural false-positive detection
    const fpClass = isFalsePositiveListener(event, subscribers.get(event));
    if (!fpClass) {
      listenersWithoutEmitters.push({ event, locations: subscribers.get(event) });
    }
  }
}

for (const event of catalogEvents) {
  if (!emitters.has(event)) catalogNeverEmitted.push(event);
  if (!subscribers.has(event)) catalogNeverSubscribed.push(event);
}

// H-3: Frequently emitted without any listener (>3 call sites = likely intentional)
for (const [event, locations] of emitters) {
  if (EXCLUDED_EVENTS.has(event) || isDynamic(event)) continue;
  if (locations.length >= 3 && !subscribers.has(event)) {
    frequentEmittersWithoutListeners.push({ event, count: locations.length });
  }
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
    listenersWithoutEmitters: listenersWithoutEmitters.length,
    frequentEmittersWithoutListeners: frequentEmittersWithoutListeners.length,
  },
  emittedNotInCatalog,
  subscribedNotInCatalog,
  catalogNeverEmitted,
  catalogNeverSubscribed,
  listenersWithoutEmitters,
  frequentEmittersWithoutListeners,
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
  if (listenersWithoutEmitters.length > 0) {
    console.log('🔴 LISTENERS WITHOUT EMITTERS (event-name mismatch?):');
    for (const { event, locations } of listenersWithoutEmitters) {
      console.log(`   "${event}"`);
      for (const loc of locations) console.log(`     → ${loc.file}:${loc.line}`);
    }
    console.log('');
  }

  if (frequentEmittersWithoutListeners.length > 0) {
    console.log('ℹ  FREQUENTLY EMITTED but never listened (≥3 call sites):');
    for (const { event, count } of frequentEmittersWithoutListeners) {
      console.log(`   "${event}" (${count} emit sites)`);
    }
    console.log('');
  }

  if (warnings === 0 && listenersWithoutEmitters.length === 0) {
    console.log('✅ All events match the EventTypes catalog.');
    console.log('✅ All listeners have at least one emitter.');
  } else {
    if (warnings > 0) console.log(`⚠  ${warnings} event(s) not in catalog.`);
    if (listenersWithoutEmitters.length > 0) console.log(`🔴 ${listenersWithoutEmitters.length} listener(s) without emitters — potential event-name mismatch!`);
  }
  console.log('');
}

// Exit code — listeners without emitters are HIGH severity
const hasWarnings = emittedNotInCatalog.length > 0 || subscribedNotInCatalog.length > 0;
const hasCrossRefErrors = listenersWithoutEmitters.length > 0;
process.exit(strict && (hasWarnings || hasCrossRefErrors) ? 1 : 0);
