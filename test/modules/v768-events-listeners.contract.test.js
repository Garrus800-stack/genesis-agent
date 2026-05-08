// Test: v7.6.8 frequently-emitted events listener wiring (Track B)
// Pins the 4 wired listeners (STATUS_BRIDGE + ImmuneSystem) and the 4
// telemetry-only allowlist entries that close the v7.6.7 backlog of
// 8 frequently-emitted events without subscribers.

'use strict';

const { describe, test, run } = require('../harness');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '../..');
const SCANNER_PATH = path.join(ROOT, 'scripts/audit-events.js');
const WIRE_PATH = path.join(ROOT, 'src/agent/AgentCoreWire.js');
const IMMUNE_PATH = path.join(ROOT, 'src/agent/organism/ImmuneSystem.js');

function runScanner(args = []) {
  return spawnSync('node', [SCANNER_PATH, ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000,
  });
}

describe('v7.6.8 frequently-emitted events listener wiring', () => {

  test('AgentCoreWire STATUS_BRIDGE contains goal:stalled with state:warning', () => {
    const src = fs.readFileSync(WIRE_PATH, 'utf8');
    assert(/event:\s*'goal:stalled'[^}]*state:\s*'warning'/.test(src),
      'STATUS_BRIDGE must declare goal:stalled with state:warning');
  });

  test('AgentCoreWire STATUS_BRIDGE contains model:unavailable-cleared with state:ready', () => {
    const src = fs.readFileSync(WIRE_PATH, 'utf8');
    assert(/event:\s*'model:unavailable-cleared'[^}]*state:\s*'ready'/.test(src),
      'STATUS_BRIDGE must declare model:unavailable-cleared with state:ready');
  });

  test('ImmuneSystem subscribes to error:trend', () => {
    const src = fs.readFileSync(IMMUNE_PATH, 'utf8');
    assert(src.includes("_sub('error:trend'"),
      "ImmuneSystem must call _sub('error:trend', ...) — feeds error window");
  });

  test('ImmuneSystem subscribes to memory:consolidation-failed', () => {
    const src = fs.readFileSync(IMMUNE_PATH, 'utf8');
    assert(src.includes("_sub('memory:consolidation-failed'"),
      "ImmuneSystem must call _sub('memory:consolidation-failed', ...) — health signal");
  });

  test('audit-events.js declares RESERVED_TELEMETRY_ONLY with 4 expected events', () => {
    const src = fs.readFileSync(SCANNER_PATH, 'utf8');
    assert(src.includes('RESERVED_TELEMETRY_ONLY'),
      'RESERVED_TELEMETRY_ONLY constant must be present');

    const expected = ['lesson:learned', 'narrative:updated',
                      'reasoning:started', 'symbolic:resolved'];
    for (const ev of expected) {
      assert(src.includes(`'${ev}'`),
        `RESERVED_TELEMETRY_ONLY must contain '${ev}' as explicit telemetry-only`);
    }
  });

  test('scanner reports 0 frequently-emitted-but-never-listened events', () => {
    const result = runScanner();
    assert.strictEqual(result.status, 0, 'scanner must run successfully');
    // Output must NOT contain the FREQUENTLY EMITTED section header at all
    // — it only prints when the array is non-empty.
    assert(!/FREQUENTLY EMITTED/.test(result.stdout || ''),
      'scanner output must not contain FREQUENTLY EMITTED section ' +
      `(v7.6.8 baseline = 0). stdout excerpt: ${(result.stdout || '').slice(-500)}`);
  });
});

if (require.main === module) run();
