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
const requestEmitters = new Map(); // v7.6.3: event → [{ file, line }] for bus.request(...) call sites

// v7.6.3: Pattern widened to also match optional-chaining call sites:
//   `bus.fire('e', ...)`           — base form
//   `bus?.fire('e', ...)`          — OC before method name
//   `bus.fire?.('e', ...)`         — OC before call paren
//   `bus?.fire?.('e', ...)`        — OC both sides
// Without this, the audit was missing real emit sites and reporting
// catalog events as "dead" when they were emitted via optional chaining
// (e.g. `model:cloud-without-fallback` in ModelBridgeAvailability.js).
const EMIT_PATTERN = /(?:\.|\?\.)(?:emit|fire)(?:\?\.)?\s*\(\s*['"`]([^'"`]+)['"`]/g;
const SUB_PATTERN  = /(?:\.|\?\.)on(?:\?\.)?\s*\(\s*['"`]([^'"`]+)['"`]/g;

// v7.6.7 Track B: subscription-helper pattern (subscription-helper.js mixin).
// `_sub('event', handler, opts)` is used by 124+ call sites across organism/,
// autonomy/, cognitive/ etc. — more sites than direct `bus.on(...)`. Without
// this pattern, the scanner reports active listeners (ServiceRecovery,
// NetworkSentinel, ImmuneSystem, ColonyOrchestrator etc.) as NEVER SUBSCRIBED.
// Matches:
//   `this._sub('e', ...)` / `this._sub?.('e', ...)` / `obj._sub('e', ...)`
//   plus alias-only form `_sub('e', ...)` if it ever appears at module scope.
const SUB_HELPER_PATTERN = /(?:\.|\?\.|\b)_sub(?:\?\.)?\s*\(\s*['"`]([^'"`]+)['"`]/g;

// v7.6.7 Track B: array-literal status-bridge pattern. AgentCoreWire's
// STATUS_BRIDGE iterates `[{ event: 'name', ... }, ...]` then subscribes via
// `bus.on(mapping.event, ...)` in a loop. The bus.on call uses a runtime
// variable, so SUB_PATTERN cannot resolve it. Detect the literal event name
// in the array entry instead — every `{ event: 'literal', ` qualifies as an
// implicit subscribe site. Same pattern shows up in mapping arrays elsewhere.
// False-positive risk is low (the `event:` key is a strong signal of intent)
// but consider this an upper-bound estimate for subscriber coverage.
const ARRAY_BRIDGE_PATTERN = /\{\s*event\s*:\s*['"`]([^'"`]+)['"`]/g;

// v7.6.3: bus.request('event', ...) is the request/response counterpart of
// emit/on. The handler-side uses bus.on() like a normal subscriber, but the
// publish side uses bus.request() rather than bus.emit/fire. Without scanning
// for this, request/response events show as "never emitted" even though they
// are actively published (e.g. `reasoning:solve`, `web:search`).
const REQUEST_PATTERN = /(?:\.|\?\.)request(?:\?\.)?\s*\(\s*['"`]([^'"`]+)['"`]/g;

// v7.6.7 Track B: EventTypes-constant subscribe pattern. Wrapper facades
// (AutonomyEvents.js, OrganismEvents.js, CognitiveEvents.js) subscribe via
// `bus.on(EVENTS.HEALTH.DEGRADATION, ...)`. The scanner is regex-based and
// cannot evaluate property access — instead we build a path→eventName map
// from EventTypes.js once, then resolve constant references in a second
// regex scan. Same approach for emit-side (`bus.fire(EVENTS.X.Y, ...)`).
const CONST_EMIT_PATTERN = /(?:\.|\?\.)(?:emit|fire)(?:\?\.)?\s*\(\s*(EVENTS\.[A-Z_][A-Z0-9_.]*)/g;
const CONST_SUB_PATTERN  = /(?:\.|\?\.)on(?:\?\.)?\s*\(\s*(EVENTS\.[A-Z_][A-Z0-9_.]*)/g;
const CONST_SUB_HELPER_PATTERN = /(?:\.|\?\.|\b)_sub(?:\?\.)?\s*\(\s*(EVENTS\.[A-Z_][A-Z0-9_.]*)/g;
const CONST_REQUEST_PATTERN = /(?:\.|\?\.)request(?:\?\.)?\s*\(\s*(EVENTS\.[A-Z_][A-Z0-9_.]*)/g;

// Build EVENTS-constant resolution map once at startup. Iterates the frozen
// EVENTS tree from EventTypes.js and emits 'EVENTS.A.B' → 'event-name' pairs
// for every leaf string value. Used in scanFile() to resolve constant-style
// subscribe/emit call sites.
function buildEventsConstantMap() {
  const map = new Map();
  try {
    const { EVENTS } = require(path.join(SRC_DIR, 'agent', 'core', 'EventTypes'));
    function walk(obj, prefix) {
      for (const key of Object.keys(obj)) {
        const v = obj[key];
        const pathStr = prefix + key;
        if (typeof v === 'string') {
          map.set('EVENTS.' + pathStr, v);
        } else if (v && typeof v === 'object') {
          walk(v, pathStr + '.');
        }
      }
    }
    walk(EVENTS, '');
  } catch (err) {
    // Map stays empty — scanner falls back to literal-string detection only.
  }
  return map;
}
const CONST_MAP = buildEventsConstantMap();

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

    // v7.6.7 Track B: subscription-helper `_sub('event', ...)` form
    SUB_HELPER_PATTERN.lastIndex = 0;
    while ((m = SUB_HELPER_PATTERN.exec(line)) !== null) {
      const event = m[1];
      if (!subscribers.has(event)) subscribers.set(event, []);
      subscribers.get(event).push({ file: relPath, line: i + 1 });
    }

    // v7.6.7 Track B: array-literal STATUS_BRIDGE-style implicit subscribe
    ARRAY_BRIDGE_PATTERN.lastIndex = 0;
    while ((m = ARRAY_BRIDGE_PATTERN.exec(line)) !== null) {
      const event = m[1];
      if (!subscribers.has(event)) subscribers.set(event, []);
      subscribers.get(event).push({ file: relPath, line: i + 1 });
    }

    // v7.6.3: scan bus.request() call sites — request/response publishers
    REQUEST_PATTERN.lastIndex = 0;
    while ((m = REQUEST_PATTERN.exec(line)) !== null) {
      const event = m[1];
      if (!requestEmitters.has(event)) requestEmitters.set(event, []);
      requestEmitters.get(event).push({ file: relPath, line: i + 1 });
    }

    // v7.6.7 Track B: EventTypes-constant resolution. Each pattern matches
    // a constant reference (e.g. EVENTS.HEALTH.DEGRADATION); CONST_MAP
    // resolves it to the literal event-name string. Skips silently if the
    // constant is unknown (defensive against typos / partial matches).
    CONST_EMIT_PATTERN.lastIndex = 0;
    while ((m = CONST_EMIT_PATTERN.exec(line)) !== null) {
      const event = CONST_MAP.get(m[1]);
      if (!event) continue;
      if (!emitters.has(event)) emitters.set(event, []);
      emitters.get(event).push({ file: relPath, line: i + 1 });
    }

    CONST_SUB_PATTERN.lastIndex = 0;
    while ((m = CONST_SUB_PATTERN.exec(line)) !== null) {
      const event = CONST_MAP.get(m[1]);
      if (!event) continue;
      if (!subscribers.has(event)) subscribers.set(event, []);
      subscribers.get(event).push({ file: relPath, line: i + 1 });
    }

    CONST_SUB_HELPER_PATTERN.lastIndex = 0;
    while ((m = CONST_SUB_HELPER_PATTERN.exec(line)) !== null) {
      const event = CONST_MAP.get(m[1]);
      if (!event) continue;
      if (!subscribers.has(event)) subscribers.set(event, []);
      subscribers.get(event).push({ file: relPath, line: i + 1 });
    }

    CONST_REQUEST_PATTERN.lastIndex = 0;
    while ((m = CONST_REQUEST_PATTERN.exec(line)) !== null) {
      const event = CONST_MAP.get(m[1]);
      if (!event) continue;
      if (!requestEmitters.has(event)) requestEmitters.set(event, []);
      requestEmitters.get(event).push({ file: relPath, line: i + 1 });
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
  'context-menu',
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

// v7.6.3: parallel structure for catalogNeverEmitted false-positives.
// The above isFalsePositiveListener handles "subscriber without emitter"
// (where the event is real but the emitter lives outside the regex's reach).
// This handler addresses the inverse: catalog entries that ARE emitted but
// the emit happens via patterns the EMIT_PATTERN regex can't see — namely,
// the AgentCoreWire push()-bridge, the Settings.set() dynamic-toggle pipeline,
// the CapabilityGuard scope-alias namespace, and template-literal emits like
// `bus.emit(\`store:${type}\`, ...)` from EventStore.append.
function isFalsePositiveCatalogNeverEmitted(event) {
  // FP_NE1: AgentCoreWire push() forwards renderer-bound events. The emit
  // is `push('event:name', data)` (a wrapper around webContents.send), not
  // bus.emit/fire. PUSH_CHANNELS is built once at startup from AgentCoreWire.js.
  if (PUSH_CHANNELS.has(event)) return 'push-bridge';
  // FP_NE2: Settings.set() emits dynamic event names from a TOGGLE_EVENT_KEYS
  // map. The string concatenation inside settings.js can't be statically matched.
  if (/^settings:.+-(?:toggled|changed)$/.test(event)) return 'settings-toggle';
  // FP_NE3: capability-scope alias namespace. The EventTypes.EXEC / FS / NET
  // sections list CapabilityGuard scopes (exec:sandbox, fs:write, net:external,
  // etc.). They're catalog entries by design (audit-trail completeness), not
  // events to emit at runtime. Confirmed by the section header
  // "// ── Execution Audit (CapabilityGuard) ──────────────────".
  if (/^(?:exec|fs|net):/.test(event)) return 'capability-scope';
  // FP_NE4: dynamic emit patterns where the event name is built at runtime
  // (bus.emit(`store:${type}`) etc.). The DYNAMIC_PATTERNS list is shared with
  // the listener-without-emitter analysis below.
  if (isDynamic(event)) return 'dynamic-emit';
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

// v7.6.7 Track B: Subscribers that are intentionally registered for events
// whose emitter lives outside `src/` reach (e.g. peer/cluster external
// triggers, opt-in colony work-distribution). Without this allowlist the
// listener-without-emitter cross-ref would produce strict-failure for known-
// reserved patterns. Pinned-via-test in v749-fix.test.js Z.156 ("opt-in
// feature") and listed in architectural-fitness.js Z.502 deploy/colony slot.
const RESERVED_NO_EMITTER = new Set([
  // ColonyOrchestrator subscribes for external peer/cluster invocation;
  // emit happens via IPC from spawned worker processes in v7.7+ Außenposten
  // operation, not from `src/` code paths.
  'colony:run-request',
]);

// v7.6.8 Track B: Events emitted as structured traces for diagnostics or
// downstream observers (UI streaming, .genesis/sessions/* journal). No
// backend listener expected — these are intentional fire-and-trace events,
// not code-debt. Excluded from the "frequently emitted but never listened"
// finding so the report shows real findings only.
const RESERVED_TELEMETRY_ONLY = new Set([
  'lesson:learned',          // AdaptiveStrategy state telemetry
  'narrative:updated',       // SelfNarrative output, journaled to .genesis/
  'reasoning:started',       // ReasoningEngine trace start (chatty)
  'symbolic:resolved',       // SymbolicResolver per-resolution trace
  // v7.7.8 telemetry-only events — fire-and-trace by design, no backend listener.
  // The block-result is reported to the user via the function return value
  // (modify() returns a string), the journal entry happens via selfStatementLog,
  // the bus events are intentional for dashboard / audit / cross-session-learning
  // consumers to subscribe later without forcing a backend handler today.
  'selfmod:trigger-sanity-blocked',
  'agent:goal-failed-classified',
  // v7.7.9 telemetry — mirror of InnerSpeech emissions. Subscriber will be
  // ProactiveSelfExpression (Phase 2), but the bus event itself remains
  // telemetry-only — full thought text is in the ring buffer + selfStatementLog,
  // not in this payload.
  'agent:inner-thought',
  // v7.7.9 Phase 2 telemetry — ProactiveSelfExpression bus traces.
  // agent:self-message has a real UI consumer (chat:self-message-appended
  // bridge handles renderer integration), so it is NOT in this set —
  // it's a real product event. The candidate/suppressed pair is for
  // observability via /proactive-status and future tuning, not a
  // backend handler.
  'agent:self-message-candidate',
  'agent:self-message-suppressed',
]);

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
    // v7.6.7 Track B: skip events explicitly reserved for external/opt-in emit
    if (RESERVED_NO_EMITTER.has(event)) continue;
    // v7.5.1: structural false-positive detection
    const fpClass = isFalsePositiveListener(event, subscribers.get(event));
    if (!fpClass) {
      listenersWithoutEmitters.push({ event, locations: subscribers.get(event) });
    }
  }
}

for (const event of catalogEvents) {
  // v7.6.3: union of emit-style and request-style publishers
  const isEmitted = emitters.has(event) || requestEmitters.has(event);
  if (!isEmitted) {
    // v7.6.7 Track B: opt-in subscribers (peer/cluster external-emit)
    if (RESERVED_NO_EMITTER.has(event)) {
      // skip — listener-only by design, emitter is external
    } else if (!isFalsePositiveCatalogNeverEmitted(event)) {
      // v7.6.3: structural false-positive detection (push-bridge, settings-
      // toggle pipeline, capability-scope alias namespace).
      catalogNeverEmitted.push(event);
    }
  }
  if (!subscribers.has(event)) {
    // v7.6.8: telemetry-only events are explicit fire-and-trace,
    // not "unhandled" — exclude from the catalog-never-subscribed report.
    if (RESERVED_TELEMETRY_ONLY.has(event)) continue;
    catalogNeverSubscribed.push(event);
  }
}

// H-3: Frequently emitted without any listener (>3 call sites = likely intentional)
for (const [event, locations] of emitters) {
  if (EXCLUDED_EVENTS.has(event) || isDynamic(event)) continue;
  if (RESERVED_TELEMETRY_ONLY.has(event)) continue;  // v7.6.8: explicit telemetry-only
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
