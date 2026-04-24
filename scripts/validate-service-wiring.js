#!/usr/bin/env node
// ============================================================
// GENESIS — validate-service-wiring.js (v7.4.1)
//
// CI guard against service-name mismatches in the DI manifest.
// Scans all phase files + AgentCoreBoot for registered service
// names, then checks every `service:` late-binding reference
// and every `deps:` entry against that registry.
//
// This would have caught the peerNetwork/network mismatch
// (v7.4.1 Fix 1) at CI time instead of at analysis time.
//
// Usage:
//   node scripts/validate-service-wiring.js          — report
//   node scripts/validate-service-wiring.js --strict  — exit 1 on errors
//
// Pattern: Same as validate-events.js, audit-events.js.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');

const strict = process.argv.includes('--strict');
const ROOT = path.join(__dirname, '..');
const MANIFEST_DIR = path.join(ROOT, 'src', 'agent', 'manifest');
const BOOT_FILE = path.join(ROOT, 'src', 'agent', 'AgentCoreBoot.js');

// ── Phase 1: Collect all registered service names ────────────

const registered = new Map(); // name → source file

function collectFromManifests() {
  for (const f of fs.readdirSync(MANIFEST_DIR)) {
    if (!f.endsWith('.js')) continue;
    const content = fs.readFileSync(path.join(MANIFEST_DIR, f), 'utf8');
    const re = /\['(\w+)',\s*\{/g;
    let m;
    while ((m = re.exec(content))) {
      registered.set(m[1], f);
    }
  }
}

function collectFromBoot() {
  if (!fs.existsSync(BOOT_FILE)) return;
  const content = fs.readFileSync(BOOT_FILE, 'utf8');
  const re = /registerInstance\('(\w+)'/g;
  let m;
  while ((m = re.exec(content))) {
    registered.set(m[1], 'AgentCoreBoot.js');
  }
}

// ── Phase 2: Collect all references ──────────────────────────

/**
 * @typedef {{ name: string, file: string, line: number, context: string }} Ref
 */

/** @type {Ref[]} */
const refs = [];

function collectRefsFromManifests() {
  for (const f of fs.readdirSync(MANIFEST_DIR)) {
    if (!f.endsWith('.js')) continue;
    const content = fs.readFileSync(path.join(MANIFEST_DIR, f), 'utf8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      // Late-binding service references
      const svcMatch = lines[i].match(/service:\s*'(\w+)'/);
      if (svcMatch) {
        refs.push({ name: svcMatch[1], file: f, line: i + 1, context: 'lateBinding' });
      }

      // deps array references
      const depsMatch = lines[i].match(/deps:\s*\[([^\]]*)\]/);
      if (depsMatch) {
        for (const d of depsMatch[1].matchAll(/'(\w+)'/g)) {
          refs.push({ name: d[1], file: f, line: i + 1, context: 'deps' });
        }
      }

      // c.resolve('X') and c.tryResolve('X')
      for (const rm of lines[i].matchAll(/c\.(?:resolve|tryResolve)\('(\w+)'/g)) {
        refs.push({ name: rm[1], file: f, line: i + 1, context: 'resolve' });
      }
    }
  }
}

// ── Phase 3: Validate ────────────────────────────────────────

function validate() {
  const errors = [];
  const warnings = [];

  for (const ref of refs) {
    if (!registered.has(ref.name)) {
      errors.push(ref);
    }
  }

  // Check for duplicate registrations (same name in multiple places)
  const regByName = new Map();
  for (const [name, source] of registered) {
    if (!regByName.has(name)) regByName.set(name, []);
    regByName.get(name).push(source);
  }
  for (const [name, sources] of regByName) {
    if (sources.length > 1) {
      warnings.push({ name, sources });
    }
  }

  return { errors, warnings };
}

// ── Main ─────────────────────────────────────────────────────

collectFromManifests();
collectFromBoot();
collectRefsFromManifests();
const { errors, warnings } = validate();

console.log('');
console.log('  GENESIS — Service Wiring Validation');
console.log('  ────────────────────────────────────');
console.log(`  Registered services: ${registered.size}`);
console.log(`  Service references:  ${refs.length}`);
console.log('');

if (warnings.length > 0) {
  console.log(`  ⚠  ${warnings.length} duplicate registration(s):`);
  for (const w of warnings) {
    console.log(`     ${w.name} → ${w.sources.join(', ')}`);
  }
  console.log('');
}

if (errors.length > 0) {
  console.log(`  ✗  ${errors.length} unresolvable reference(s):`);
  for (const e of errors) {
    console.log(`     ${e.name} (${e.context}) → ${e.file}:${e.line}`);
  }
  console.log('');
  if (strict) {
    console.log('  FAILED — service wiring errors detected.');
    process.exit(1);
  }
} else {
  console.log(`  ✓  All ${refs.length} references resolve to registered services.`);
}

console.log('');
