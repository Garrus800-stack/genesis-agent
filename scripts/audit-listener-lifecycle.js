#!/usr/bin/env node
// ============================================================
// GENESIS — scripts/audit-listener-lifecycle.js (v7.6.3)
//
// Verifies that every module subscribing 2+ listeners to the EventBus
// has at least one listener-cleanup mechanism: either explicit `.off()`
// / `.removeListener()` calls, OR the unsub-pattern (`this._unsub = bus.on(...)`
// + later `this._unsub()` in stop/dispose).
//
// Background: the v7.6.3 erweiterte Analyse-report L1 finding identified
// 18 modules with on>=2 / off=0 and no unsub-pattern. Many are static
// boot-wires that legitimately never need cleanup (AgentCoreWire,
// fan-out *Events.js files). The rest are real leak risks: under
// hot-reload or service-reinstantiation, old listeners stay attached to
// the bus and double-fire / hold stale state.
//
// CHECK: every src/agent/**/*.js file with 2+ on()-calls must either
//   (a) have an off()/removeListener() call in the same file, OR
//   (b) use the unsub-pattern (`this._unsub<X> = bus.on(...)` AND
//       `this._unsub<X>()` later, OR the centralised
//       `applySubscriptionHelper(this)` mixin from subscription-helper.js).
//
// WHITELIST: static boot-wires that legitimately never tear down.
// Each entry needs a justification.
//
// USAGE:
//   node scripts/audit-listener-lifecycle.js          — table output
//   node scripts/audit-listener-lifecycle.js --json   — machine-readable
//   node scripts/audit-listener-lifecycle.js --strict — exit 1 on offences
//
// EXIT CODES:
//   0 : every module either has cleanup, uses unsub-pattern, or is on the whitelist
//   1 : at least one module has 2+ listeners with no cleanup AND not whitelisted (--strict)
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT     = path.resolve(__dirname, '..');
const SCAN_DIR = path.join(ROOT, 'src/agent');

const args = process.argv.slice(2);
const jsonOutput = args.includes('--json');
const strict     = args.includes('--strict');

const c = {
  green:  (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red:    (s) => `\x1b[31m${s}\x1b[0m`,
  dim:    (s) => `\x1b[2m${s}\x1b[0m`,
  bold:   (s) => `\x1b[1m${s}\x1b[0m`,
};

// ── Whitelist: legitimate static-wire modules ───────────────────────
// These never need .off() because they register listeners exactly once
// at boot and are never reinstantiated or hot-reloaded.

const WHITELIST = {
  'AgentCoreWire.js':                 'static boot-wire — registered once at AgentCore.start, never torn down',
  'cognitive/CognitiveEvents.js':     'fan-out wire — pure event-forwarder, no per-instance state',
  'organism/OrganismEvents.js':       'fan-out wire — pure event-forwarder, no per-instance state',
  'autonomy/AutonomyEvents.js':       'fan-out wire — pure event-forwarder, no per-instance state',
  'manifest/phase9-cognitive.js':     'manifest-time DI wire',
  'core/EventBus.js':                 'EventBus is the bus itself; internal self-registrations are intentional',
  // Note: subscription-helper.js itself uses bus.on inside a closure but
  // returns the unsub — that is the cleanup mechanism, not a leak.
  'core/subscription-helper.js':      'helper module: the bus.on inside provides unsub-return for callers',
};

// ── Walk source tree ────────────────────────────────────────────────

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// ── Per-file detector ───────────────────────────────────────────────

function detect(filePath) {
  const src = fs.readFileSync(filePath, 'utf-8');
  const onMatches  = (src.match(/(?:bus|events|this\.bus|eventBus|this\.eventBus|this\.events)\.on\(/g) || []).length;
  const offMatches = (src.match(/(?:bus|events|this\.bus|eventBus|this\.eventBus|this\.events)\.(?:off|removeListener)\(/g) || []).length;

  // unsub-pattern: assignment of a bus.on() return value to a field/var that is later called
  const hasUnsubAssign = /(?:this\._unsub|this\.unsub|const\s+unsub|let\s+unsub|this\._dispose|this\.dispose)[A-Za-z]*\s*=\s*(?:this\.)?(?:bus|events|eventBus)\.on\(/.test(src);
  const hasUnsubCall   = /(?:this\._unsub|this\.unsub)[A-Za-z]*\(\)/.test(src);

  // mixin-pattern: applySubscriptionHelper(this) — subscription-helper.js
  // grafts _sub() and _unsubAll() so the file wires listeners via _sub
  // and tears them down via _unsubAll().
  const usesMixin = /applySubscriptionHelper\s*\(/.test(src);

  return {
    on: onMatches,
    off: offMatches,
    hasUnsubAssign,
    hasUnsubCall,
    usesMixin,
  };
}

// ── Main ────────────────────────────────────────────────────────────

const all = walk(SCAN_DIR);
const findings = [];
const cleanModules = [];

for (const f of all) {
  const rel = path.relative(SCAN_DIR, f).replace(/\\/g, '/');
  const d = detect(f);
  if (d.on < 2) continue;  // single-listener modules are out of scope

  const hasUnsubPattern = d.hasUnsubAssign && d.hasUnsubCall;
  const hasOffCall      = d.off > 0;
  const cleanupOK       = hasOffCall || hasUnsubPattern || d.usesMixin;
  const whitelisted     = !!WHITELIST[rel];

  if (cleanupOK || whitelisted) {
    cleanModules.push({ rel, on: d.on, off: d.off, kind: cleanupOK ? 'cleanup' : 'whitelist' });
  } else {
    findings.push({
      rel, on: d.on, off: d.off,
      hasUnsubAssign: d.hasUnsubAssign,
      hasUnsubCall: d.hasUnsubCall,
      usesMixin: d.usesMixin,
    });
  }
}

findings.sort((a, b) => b.on - a.on);

if (jsonOutput) {
  console.log(JSON.stringify({ findings, cleanModules, whitelist: Object.keys(WHITELIST) }, null, 2));
  process.exit(strict && findings.length > 0 ? 1 : 0);
}

console.log('');
console.log(c.bold('  ╔════════════════════════════════════════════════════╗'));
console.log(c.bold('  ║   GENESIS LISTENER LIFECYCLE AUDIT                ║'));
console.log(c.bold('  ╚════════════════════════════════════════════════════╝'));
console.log('');
console.log(`  ${c.dim('Modules with cleanup or unsub-pattern:')} ${cleanModules.length}`);
console.log(`  ${c.dim('Modules on whitelist:')} ${Object.keys(WHITELIST).length}`);
console.log(`  ${c.dim('Modules with potential leak (on>=2, no off, no unsub, not whitelisted):')} ${findings.length}`);
console.log('');

if (findings.length === 0) {
  console.log(c.green('  ✅ All multi-listener modules have cleanup or are whitelisted.\n'));
  process.exit(0);
}

console.log(c.yellow(`  ⚠  ${findings.length} module(s) need attention:\n`));
for (const f of findings) {
  console.log(`    ${c.red('✗')} ${c.bold(f.rel)}  on=${f.on} off=${f.off}`);
  console.log(`        ${c.dim('hasUnsubAssign')}=${f.hasUnsubAssign}  ${c.dim('hasUnsubCall')}=${f.hasUnsubCall}  ${c.dim('mixin')}=${f.usesMixin}`);
}
console.log('');
console.log(c.dim('  Fix options per module:'));
console.log(c.dim('    (1) call applySubscriptionHelper(this) in constructor (preferred)'));
console.log(c.dim('    (2) capture bus.on() return value as this._unsub<X> and call it in stop()'));
console.log(c.dim('    (3) use bus.off() / bus.removeListener() explicitly in stop()/dispose()'));
console.log(c.dim('    (4) add to WHITELIST with justification if module is a static boot-wire'));
console.log('');

if (strict) {
  console.log(c.red('  ❌ Strict mode: leaks detected, exiting 1.\n'));
  process.exit(1);
}
process.exit(0);
