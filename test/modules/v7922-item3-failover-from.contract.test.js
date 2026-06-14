'use strict';
// v7.9.22 Item 3 — both failover events carry a non-empty `from` even on the no-origin
// path, so the from:required schema is satisfied.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const ROOT = path.resolve(__dirname, '..', '..');
let passed = 0, failed = 0;
function test(n, fn) { try { fn(); console.log('    \u2705 ' + n); passed++; } catch (e) { console.log('    \u274c ' + n + ': ' + e.message); failed++; } }
const bridge = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/ModelBridge.js'), 'utf8');
const failover = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/ModelBridgeFailover.js'), 'utf8');

test('model:failover from falls back when the origin backend is falsy', () => {
  assert.ok(/from: targetBackend \|\| calledModel \|\| 'unknown'/.test(bridge));
});
test('model:failover-unavailable from falls back when the origin backend is falsy', () => {
  assert.ok(/from: failedBackend \|\| 'unknown'/.test(failover));
});

console.log('\n    ' + passed + ' passed \u00b7 ' + failed + ' failed \u00b7 v7.9.22 Item 3 failover-from');
process.exit(failed > 0 ? 1 : 0);
