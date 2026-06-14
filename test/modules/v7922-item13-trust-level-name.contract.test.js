'use strict';
// v7.9.22 Item 13 — approval reasons name the trust level, not only the number. A reverse
// map drives all four reason strings and getStatus; the approval logic is unchanged.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const ROOT = path.resolve(__dirname, '..', '..');
const { TrustLevelSystem } = require(path.join(ROOT, 'src/agent/foundation/TrustLevelSystem'));
const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/TrustLevelSystem.js'), 'utf8');
const NAMES = /SUPERVISED|AUTONOMOUS|FULL_AUTONOMY/;
let passed = 0, failed = 0;
function test(n, fn) { try { fn(); console.log('    \u2705 ' + n); passed++; } catch (e) { console.log('    \u274c ' + n + ': ' + e.message); failed++; } }

test('getStatus reports a level name', () => {
  const tls = new TrustLevelSystem({});
  assert.ok(NAMES.test(tls.getStatus().levelName));
});
test('a real approval reason carries the level name; logic stays boolean', () => {
  const tls = new TrustLevelSystem({});
  const r = tls.checkApproval('SOME_ACTION');
  assert.ok(NAMES.test(r.reason), 'reason includes a level name');
  assert.strictEqual(typeof r.approved, 'boolean');
  assert.strictEqual(typeof r.needsUserApproval, 'boolean');
});
test('all four reason strings and getStatus draw on TRUST_LEVEL_NAMES', () => {
  const uses = (src.match(/TRUST_LEVEL_NAMES\[/g) || []).length;
  assert.ok(uses >= 5, `expected >=5 TRUST_LEVEL_NAMES lookups, got ${uses}`);
  assert.ok(/levelName: TRUST_LEVEL_NAMES\[this\._level\]/.test(src), 'getStatus uses the map');
});

console.log('\n    ' + passed + ' passed \u00b7 ' + failed + ' failed \u00b7 v7.9.22 Item 13 trust-level-name');
process.exit(failed > 0 ? 1 : 0);
