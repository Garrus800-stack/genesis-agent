#!/usr/bin/env node
// ============================================================
// GENESIS — scripts/audit-raw-settimeout.js (v7.6.3)
//
// Counts raw setTimeout() calls under src/agent/ that are not
// (a) part of a Promise.race timeout-pattern, (b) assigned to
// a tracked field/var that is later cleared, (c) on an EXEMPT
// list of legitimate kernel/pre-DI sites.
//
// Background: the v7.6.3 erweiterte Analyse-report L2 finding
// flagged 24 raw setTimeout sites with `this.X` references —
// fire-and-forget closures that survive their parent service if
// the timer is still pending when the service is reinstantiated.
// The architectural-fitness setInterval audit covers the
// recurring case but had no setTimeout equivalent.
//
// LEGITIMATE PATTERNS (not flagged):
//   1. Promise.race timeout: `setTimeout(() => reject(...), MS)`
//      inside `new Promise(...)` or `Promise.race([...])`.
//   2. Assigned timer:        `this._timer = setTimeout(...)` or
//      `entry._timer = setTimeout(...)` — pattern used to enable
//      clearTimeout later.
//   3. Method-form:           `req.setTimeout(...)` on HTTP req objects.
//
// FIRE-AND-FORGET (flagged):
//   `setTimeout(() => this._something(), MS)` with no assignment —
//   the timer fires once and disappears, but holds a closure on `this`
//   that prevents the parent from being GC'd until firing.
//
// USAGE:
//   node scripts/audit-raw-settimeout.js          — table output
//   node scripts/audit-raw-settimeout.js --json   — machine-readable
//   node scripts/audit-raw-settimeout.js --strict — exit 1 on offences
//                                                   (above EXEMPT baseline)
//
// EXIT CODES:
//   0 : count ≤ baseline, or --strict not set
//   1 : count grew above baseline (--strict only)
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

// ── EXEMPT files: legitimate raw setTimeout ─────────────────────────
// HTTP/network timeouts, kernel-pre-DI lifecycle, boot-once schedulers
// that fire exactly once during boot and have no later state to tear
// down, and worker-internal timers that run inside a child-process
// whose entire lifecycle is the parent process.
const EXEMPT = new Set([
  'capabilities/McpTransport.js',          // HTTP req.setTimeout + Promise-race
  'foundation/backends/OllamaBackend.js',  // req.setTimeout on http.request
  'foundation/backends/MockBackend.js',    // test-only fake-latency
  // v7.6.5 (raw-settimeout phase 2 closeout): boot-once + worker-internal.
  'AgentCore.js',                          // boot-once _pushStatus(readyPayload, 500ms) — fires once after boot, no field to track
  'capabilities/AutoUpdater.js',           // boot-once checkForUpdate(10s) — fires once after boot, no migrate-target
  'capabilities/_self-worker.js',          // worker-process internal, lifecycle is the worker process itself
]);

// Baseline: known raw fire-and-forget setTimeouts at v7.6.3 ship time.
// New offenders above this number fail the --strict check. Migration
// happens iteratively as fields like _scanTimer get extended to all
// callsites. The v7.6.3 extended-analysis report itemised these and
// they are safe-but-untracked — same defensive posture as the existing
// architectural-fitness setInterval baseline. v7.6.5 closes phase 2:
// HotReloader and SelfStatementLog migrated in v7.6.4 T3 (2 sites);
// GoalDriver, GoalDriverFailurePolicy, DaemonController, NetworkSentinel
// migrated in v7.6.5 (6 sites); AgentCore, AutoUpdater, _self-worker
// added to EXEMPT (4 sites). Net: 12 → 0 non-exempt non-migrated.
const BASELINE = 12;

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

function findOffenders(filePath) {
  const src = fs.readFileSync(filePath, 'utf-8');
  const lines = src.split('\n');
  const offenders = [];

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // Find raw setTimeout( — but skip method-form X.setTimeout( where X is not the global.
    // Match `setTimeout(` not preceded by a dot-access.
    if (!/(?<![.\w])setTimeout\s*\(/.test(l)) continue;

    // Check 5-line window for context patterns
    const start = Math.max(0, i - 1);
    const end = Math.min(lines.length, i + 5);
    const window = lines.slice(start, end).join('\n');

    // Pattern 1: Promise.race / new Promise — timeout-race
    if (/Promise\.race|new\s+Promise\s*\(.*setTimeout|\(\s*\)\s*=>\s*reject|\(\s*\)\s*=>\s*resolve/.test(window)) {
      continue;
    }

    // Pattern 2: assigned to a tracked field/var
    // Match `this._X = setTimeout(...)` / `entry._timer = ...` / `const t = ...` / `let timer = ...`
    if (/(?:this\.[_\w]+|[\w]+\.[\w]+|const\s+\w+|let\s+\w+|var\s+\w+)\s*=\s*\(?\s*setTimeout/.test(l)) {
      continue;
    }

    // Pattern 2b: assignment with JSDoc-typecast wrapper, e.g.
    //   entry.timer = /** @type {*} */ (setTimeout(...))
    if (/=\s*\/\*\*.*\*\/\s*\(?\s*setTimeout/.test(l)) {
      continue;
    }

    // Pattern 3: assignment with parens/typecast wrapper around setTimeout
    if (/=\s*\(\s*setTimeout/.test(l)) {
      continue;
    }

    // Pattern 4: object-literal property exposing setTimeout (e.g. inside
    // a sandboxed worker context). Match `setTimeout: (fn, ms) => ...`.
    if (/^\s*setTimeout\s*:/.test(l)) {
      continue;
    }

    // Otherwise: fire-and-forget. Flag.
    offenders.push({ line: i + 1, text: l.trim().slice(0, 100) });
  }
  return offenders;
}

// ── Main ────────────────────────────────────────────────────────────

const all = walk(SCAN_DIR);
const fileResults = [];
let totalOffenders = 0;

for (const f of all) {
  const rel = path.relative(SCAN_DIR, f).replace(/\\/g, '/');
  if (EXEMPT.has(rel)) continue;
  const offenders = findOffenders(f);
  if (offenders.length === 0) continue;
  fileResults.push({ rel, count: offenders.length, sites: offenders });
  totalOffenders += offenders.length;
}

fileResults.sort((a, b) => b.count - a.count);

if (jsonOutput) {
  console.log(JSON.stringify({ totalOffenders, baseline: BASELINE, files: fileResults, exempt: [...EXEMPT] }, null, 2));
  process.exit(strict && totalOffenders > BASELINE ? 1 : 0);
}

console.log('');
console.log(c.bold('  ╔════════════════════════════════════════════════════╗'));
console.log(c.bold('  ║   GENESIS RAW setTimeout AUDIT                    ║'));
console.log(c.bold('  ╚════════════════════════════════════════════════════╝'));
console.log('');
console.log(`  ${c.dim('Files with raw fire-and-forget setTimeout (after exemptions):')} ${fileResults.length}`);
console.log(`  ${c.dim('Total fire-and-forget sites:')} ${totalOffenders}`);
console.log(`  ${c.dim('Baseline (v7.6.3):')} ${BASELINE}`);
console.log(`  ${c.dim('Exempt files:')} ${EXEMPT.size}`);
console.log('');

if (fileResults.length === 0) {
  console.log(c.green('  ✅ No raw fire-and-forget setTimeouts found.\n'));
  process.exit(0);
}

if (totalOffenders > BASELINE) {
  console.log(c.red(`  ⚠  Count grew from baseline ${BASELINE} → ${totalOffenders}. New offenders:`));
} else {
  console.log(c.yellow(`  ℹ  Count at/below baseline ${BASELINE} — informational only.`));
}
console.log('');

for (const fr of fileResults) {
  console.log(`    ${c.bold(fr.rel)}  ${c.dim('count=')}${fr.count}`);
  for (const s of fr.sites.slice(0, 3)) {
    console.log(`        ${c.dim(s.line + ':')} ${s.text}`);
  }
  if (fr.sites.length > 3) {
    console.log(`        ${c.dim('(+' + (fr.sites.length - 3) + ' more)')}`);
  }
}
console.log('');
console.log(c.dim('  Migration target: TimerRegistry/IntervalManager.timeout(name, fn, ms).'));
console.log(c.dim('  Per-site fix: capture return value as this._<X>Timer and clear in stop()/dispose().'));
console.log('');

if (strict && totalOffenders > BASELINE) {
  console.log(c.red(`  ❌ Strict mode: ${totalOffenders} > baseline ${BASELINE}, exiting 1.\n`));
  process.exit(1);
}
process.exit(0);
