'use strict';

// ============================================================
// v7.7.1 — README + engines.node contract test
//
// Pins the v7.7.1 changes:
//   - B5: README dependencies block was replaced by package.json reference
//   - B6: engines.node bumped to >=22.0.0; README references Node 22+
// ============================================================

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..', '..');
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf-8');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`    ✅ ${name}`); passed++; }
  catch (e) { console.log(`    ❌ ${name}: ${e.message}`); failed++; }
}

test('v7.7.1 B5: README no longer hardcodes Optional/Dev dependency versions', () => {
  assert.doesNotMatch(README, /\*\*Optional\*\*\s*\(3\s*—\s*try\/catch/,
    'old "**Optional** (3 — try/catch" block must be removed');
  assert.doesNotMatch(README, /\*\*Dev\*\*\s*\(6\):/,
    'old "**Dev** (6):" block must be removed');
  assert.match(README, /\*\*Optional \/ Dev\*\*[^.]*\[package\.json\]\(\.\/package\.json\)/,
    'replacement text with package.json reference must be present');
});

test('v7.7.1 B5: no Optional/Dev JSON snippet listing electron+puppeteer', () => {
  assert.doesNotMatch(README, /"electron":\s*"\^\d+\.\d+\.\d+"[^}]*"electron-builder"/,
    'no JSON snippet should list electron + electron-builder versions');
  assert.doesNotMatch(README, /"puppeteer":\s*"\^\d+\.\d+\.\d+"[^}]*"monaco-editor"/,
    'no JSON snippet should list puppeteer + monaco-editor versions');
});

test('v7.7.1 B6: package.json engines.node is >=22.0.0', () => {
  assert.ok(PKG.engines && PKG.engines.node, 'engines.node must be set');
  const m = PKG.engines.node.match(/(\d+)/);
  assert.ok(m, 'engines.node must contain a numeric version');
  const floor = parseInt(m[1], 10);
  assert.ok(floor >= 22,
    `engines.node floor must be >= 22 (Active LTS), got ${floor}`);
});

test('v7.7.1 B6: README Node version requirement matches engines.node floor', () => {
  const enginesFloor = parseInt(PKG.engines.node.match(/(\d+)/)[1], 10);
  const readmeMatch = README.match(/Requires \*\*Node\.js (\d+)\+\*\*/);
  assert.ok(readmeMatch, 'README must state "Requires **Node.js NN+**"');
  const readmeFloor = parseInt(readmeMatch[1], 10);
  assert.strictEqual(readmeFloor, enginesFloor,
    `README claim (Node ${readmeFloor}+) must match engines.node floor (${enginesFloor})`);
});

test('v7.7.1 B6: test/index.js header references current Node baseline', () => {
  const testIdx = fs.readFileSync(path.join(ROOT, 'test', 'index.js'), 'utf-8');
  assert.doesNotMatch(testIdx, /Compatible with Node 18\+/,
    'test/index.js must not declare Node 18+ as supported (Node 18 is EoL)');
});

console.log(`\n    ${passed} passed · ${failed} failed · v7.7.1 readme-and-engine`);
process.exit(failed > 0 ? 1 : 0);
