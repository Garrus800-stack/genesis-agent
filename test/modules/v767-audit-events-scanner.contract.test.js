// ============================================================
// GENESIS — v7.6.7 audit-events Scanner Extension contract test
//
// Pins the line-by-line regex extensions added in v7.6.7 Track B:
//   - SUB_HELPER_PATTERN     (this._sub('event', ...) form)
//   - ARRAY_BRIDGE_PATTERN   ({ event: 'name', ... } STATUS_BRIDGE form)
//   - CONST_*_PATTERN x4     (bus.fire/on/_sub/request with EVENTS.X.Y)
//   - RESERVED_NO_EMITTER    (opt-in subscriber-only allowlist)
//
// Without this test, a future scanner refactor could silently regress:
// e.g. dropping the _sub pattern would make 124+ subscriptions invisible
// again and reintroduce false-positive "frequently emitted but never
// listened" findings. The known-good pin is the canonical detection set.
// ============================================================

'use strict';

const { describe, test, run } = require('../harness');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '../..');
const SCANNER_PATH = path.join(ROOT, 'scripts/audit-events.js');

// v7.6.7 path-safety: spawnSync with array args avoids shell-quoting issues
// when ROOT contains spaces (e.g. "Genesis Home" on Linux). String-template
// execSync calls fail to escape the path — use this helper everywhere.
function runScanner(args = []) {
  return spawnSync('node', [SCANNER_PATH, ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000,
  });
}

describe('v7.6.7 audit-events scanner extensions', () => {

  test('scanner source declares SUB_HELPER_PATTERN', () => {
    const src = fs.readFileSync(SCANNER_PATH, 'utf8');
    assert(src.includes('SUB_HELPER_PATTERN'),
      'SUB_HELPER_PATTERN constant must be present in scanner');
    // Must match the _sub call shape that subscription-helper.js mounts.
    assert(/SUB_HELPER_PATTERN\s*=\s*\/[^/]*_sub/.test(src),
      'SUB_HELPER_PATTERN regex must target _sub method');
  });

  test('scanner source declares ARRAY_BRIDGE_PATTERN', () => {
    const src = fs.readFileSync(SCANNER_PATH, 'utf8');
    assert(src.includes('ARRAY_BRIDGE_PATTERN'),
      'ARRAY_BRIDGE_PATTERN constant must be present in scanner');
    // Must match { event: 'name', ... } literal-key array entries.
    // (single-line regex match across the const declaration)
    const declLine = src.split('\n').find(l => l.includes('ARRAY_BRIDGE_PATTERN') && l.includes('=')) || '';
    assert(declLine.includes('event'),
      'ARRAY_BRIDGE_PATTERN regex declaration must reference "event" key');
  });

  test('scanner source declares all 4 EVENTS-constant patterns', () => {
    const src = fs.readFileSync(SCANNER_PATH, 'utf8');
    for (const pat of ['CONST_EMIT_PATTERN', 'CONST_SUB_PATTERN',
                       'CONST_SUB_HELPER_PATTERN', 'CONST_REQUEST_PATTERN']) {
      assert(src.includes(pat), `${pat} constant must be present`);
    }
    assert(src.includes('buildEventsConstantMap'),
      'EVENTS-constant resolution map builder must be present');
  });

  test('scanner declares RESERVED_NO_EMITTER allowlist with colony entry', () => {
    const src = fs.readFileSync(SCANNER_PATH, 'utf8');
    assert(src.includes('RESERVED_NO_EMITTER'),
      'RESERVED_NO_EMITTER constant must be present');
    assert(src.includes("'colony:run-request'"),
      'colony:run-request must be in RESERVED_NO_EMITTER (opt-in peer/cluster pattern)');
  });

  test('strict run reaches exit 0 (no listener-without-emitter cross-ref errors)', () => {
    const result = runScanner(['--strict']);
    assert.strictEqual(result.status, 0,
      `audit-events --strict must exit 0 with v7.6.7 scanner extensions ` +
      `(stdout: ${(result.stdout || '').slice(0, 200)})`);
  });

  test('subscribed-event count crossed >120 threshold (helper coverage)', () => {
    // Pre-v7.6.7 baseline: 78 subscribed events visible (literal-string only).
    // Post-v7.6.7: ~155 visible (via _sub helper + STATUS_BRIDGE + EVENTS-const).
    // Test threshold conservative at 120 to allow for minor re-org without
    // false-failing — only catches a regression that drops back >30 events.
    const result = runScanner();
    assert.strictEqual(result.status, 0, 'scanner must run successfully');
    const m = (result.stdout || '').match(/Subscribed events:\s+(\d+)/);
    assert(m, 'output must contain Subscribed events count');
    const count = parseInt(m[1], 10);
    assert(count > 120,
      `subscribed events count ${count} below ratchet floor 120 — ` +
      `scanner extensions may have regressed`);
  });

  test('frequently-emitted-without-listener stays at-or-below v7.6.8 baseline (zero)', () => {
    // Ratchet-style baseline. v7.6.7 left 8 events emitted without listener
    // (deferred backlog). v7.6.8 closed all 8: 4 wired (goal:stalled +
    // model:unavailable-cleared via STATUS_BRIDGE; error:trend +
    // memory:consolidation-failed via ImmuneSystem subscriptions); 4
    // explicitly tagged telemetry-only via RESERVED_TELEMETRY_ONLY
    // (lesson:learned, narrative:updated, reasoning:started,
    // symbolic:resolved). New baseline = 0. Any future regression that
    // adds an orphan emit must be addressed (wire listener, or extend
    // RESERVED_TELEMETRY_ONLY if intentional fire-and-trace).
    const BASELINE = 0;
    const result = runScanner();
    assert.strictEqual(result.status, 0, 'scanner must run successfully');
    const entryRe = /^\s+"[^"]+"\s*\(\d+\s+emit\s+sites?\)/gm;
    const entries = (result.stdout || '').match(entryRe) || [];
    assert(entries.length <= BASELINE,
      `frequently-emitted-but-never-listened count ${entries.length} exceeds ` +
      `v7.6.8 baseline ${BASELINE} — either subscribe via _sub/bus.on, or add ` +
      `to RESERVED_TELEMETRY_ONLY if intentional. Current entries: ${entries.join(', ')}`);
  });
});

if (require.main === module) run();
