#!/usr/bin/env node
// ============================================================
// GENESIS — validate-intent-wiring.js (v7.4.1)
//
// CI guard against intent-type mismatches between IntentRouter
// definitions, slash-commands, and ChatOrchestrator handler
// registrations.
//
// Checks:
//   1. Every registerHandler() type has a matching
//      INTENT_DEFINITIONS entry or slash-command
//   2. Every INTENT_DEFINITIONS entry has a registerHandler()
//   3. Every slash-command name appears in INTENT_DEFINITIONS
//
// Usage:
//   node scripts/validate-intent-wiring.js
//   node scripts/validate-intent-wiring.js --strict
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');

const strict = process.argv.includes('--strict');
const ROOT = path.join(__dirname, '..');

// ── Collect INTENT_DEFINITIONS ───────────────────────────────
//
// v7.5.1: read both IntentPatterns.js (where the declarative table now
// lives since v7.4.3 "Aufräumen II") AND IntentRouter.js (kept for
// transitional compatibility — the import lives there). Previously
// only IntentRouter.js was scanned, so the v7.4.3 extraction silently
// reported every intent as missing — 44 false-positive errors that made
// `audit:intents:strict` exit 1.
const intentSearchFiles = [
  path.join(ROOT, 'src', 'agent', 'intelligence', 'IntentPatterns.js'),
  path.join(ROOT, 'src', 'agent', 'intelligence', 'IntentRouter.js'),
];
let irContent = '';
for (const p of intentSearchFiles) {
  if (fs.existsSync(p)) irContent += '\n' + fs.readFileSync(p, 'utf8');
}

const definitions = new Set();
for (const m of irContent.matchAll(/\['([\w-]+)',\s*\[/g)) {
  definitions.add(m[1]);
}
// 'general' is implicit (default fallback)
definitions.add('general');

// Dynamic registrations via intentRouter.register() in AgentCoreBoot
const bootPath = path.join(ROOT, 'src', 'agent', 'AgentCoreBoot.js');
if (fs.existsSync(bootPath)) {
  const bootContent = fs.readFileSync(bootPath, 'utf8');
  for (const m of bootContent.matchAll(/intentRouter.*\.register\('([\w-]+)'/g)) {
    definitions.add(m[1]);
  }
  // Also catch: c.resolve('intentRouter').register('X', ...)
  for (const m of bootContent.matchAll(/resolve\('intentRouter'\)\.register\('([\w-]+)'/g)) {
    definitions.add(m[1]);
  }
}

// ── Collect slash-commands ───────────────────────────────────

const slashPath = path.join(ROOT, 'src', 'agent', 'intelligence', 'slash-commands.js');
const slashContent = fs.readFileSync(slashPath, 'utf8');

const slashCommands = new Set();
for (const m of slashContent.matchAll(/name:\s*'([\w-]+)'/g)) {
  slashCommands.add(m[1]);
}
const slashAliases = new Set();
for (const m of slashContent.matchAll(/aliases:\s*\[([^\]]*)\]/g)) {
  for (const a of m[1].matchAll(/'([\w-]+)'/g)) {
    slashAliases.add(a[1]);
  }
}

// ── Collect registerHandler() calls ──────────────────────────

const handlerFiles = [
  'src/agent/hexagonal/CommandHandlers.js',
  'src/agent/hexagonal/SelfModificationPipeline.js',
  'src/agent/revolution/AgentLoop.js',
];

const handlers = new Map(); // type → file
const virtualHandlers = new Set(); // synthesized by orchestrator, not classified
for (const rel of handlerFiles) {
  const fPath = path.join(ROOT, rel);
  if (!fs.existsSync(fPath)) continue;
  const content = fs.readFileSync(fPath, 'utf8');

  // v7.6.0 audit §3.3: detect the @virtual-handler doc-anchor convention.
  // A registerHandler() call preceded (within ~12 lines above) by a
  // comment containing `@virtual-handler` is a synthesized handler that
  // is intentionally absent from INTENT_DEFINITIONS — ChatOrchestrator
  // routes to it from a non-classification source (e.g. _wasSlashOnlyRewrite).
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/registerHandler\('([\w-]+)'/);
    if (!m) continue;
    const type = m[1];
    handlers.set(type, path.basename(rel));
    // Look up to 12 lines back for the @virtual-handler anchor.
    const lookbackStart = Math.max(0, i - 12);
    const lookback = lines.slice(lookbackStart, i).join('\n');
    if (/@virtual-handler\b/.test(lookback)) {
      virtualHandlers.add(type);
    }
  }
}

// ── Validate ─────────────────────────────────────────────────

const errors = [];
const warnings = [];

// 1. Every handler must have a definition (or be 'general' or @virtual-handler)
for (const [type, file] of handlers) {
  if (type === 'general') continue;
  if (virtualHandlers.has(type)) continue; // intentionally synthesized
  if (!definitions.has(type)) {
    errors.push(`Handler '${type}' (${file}) has no INTENT_DEFINITIONS entry — IntentRouter can never route to it`);
  }
}

// 2. Every definition should have a handler
for (const def of definitions) {
  if (def === 'general') continue; // general goes to LLM streaming, no handler
  if (!handlers.has(def)) {
    warnings.push(`Definition '${def}' has no registerHandler() — will classify but never execute`);
  }
}

// 3. Every slash-command name should appear in definitions
for (const cmd of slashCommands) {
  if (!definitions.has(cmd)) {
    errors.push(`Slash-command '${cmd}' has no INTENT_DEFINITIONS entry — /command will never match`);
  }
}

// ── Output ───────────────────────────────────────────────────

console.log('');
console.log('  GENESIS — Intent Wiring Validation');
console.log('  ──────────────────────────────────');
console.log(`  INTENT_DEFINITIONS: ${definitions.size - 1} types (+general)`);
console.log(`  Slash commands:     ${slashCommands.size} (+${slashAliases.size} aliases)`);
console.log(`  Registered handlers: ${handlers.size}`);
console.log('');

if (warnings.length > 0) {
  console.log(`  ⚠  ${warnings.length} warning(s):`);
  for (const w of warnings) console.log(`     ${w}`);
  console.log('');
}

if (errors.length > 0) {
  console.log(`  ✗  ${errors.length} error(s):`);
  for (const e of errors) console.log(`     ${e}`);
  console.log('');
  if (strict) {
    console.log('  FAILED — intent wiring errors detected.');
    process.exit(1);
  }
} else {
  console.log('  ✓  All intent types properly wired.');
}

console.log('');
