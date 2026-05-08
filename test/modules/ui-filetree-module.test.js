// ============================================================
// GENESIS test/modules/ui-filetree-module.test.js (v7.7.0)
//
// Pins v7.7.0 (A9): icon hierarchy 🔒 protected → ◈ module → 📄 file
// (3 icons; SelfModel.getFileTree() has no isDir field, so the
// previous `📁 / 📄` branch was effectively dead — always 📄).
// ============================================================

'use strict';

const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const { createMiniDOM } = require(path.join(ROOT, 'test', 'helpers', 'dom-shim'));
const { createGenesisMock } = require(path.join(ROOT, 'test', 'helpers', 'genesis-mock'));

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(
        () => { console.log(`    ✅ ${name}`); passed++; },
        (e) => { console.log(`    ❌ ${name}: ${e.message}`); failed++; }
      );
    }
    console.log(`    ✅ ${name}`); passed++;
  } catch (e) { console.log(`    ❌ ${name}: ${e.message}`); failed++; }
}

function setup(mockFiles) {
  const dom = createMiniDOM();
  const genesis = createGenesisMock();
  genesis.setHandler('agent:get-file-tree', () => mockFiles);
  global.document = dom.doc;
  global.window = { genesis: genesis.mock };
  delete require.cache[require.resolve(path.join(ROOT, 'src', 'ui', 'modules', 'filetree'))];
  return {
    filetree: require(path.join(ROOT, 'src', 'ui', 'modules', 'filetree')),
    dom, genesis,
  };
}

(async () => {

await test('loadFileTree fetches via IPC', async () => {
  const { filetree, genesis } = setup([{ path: 'a.js', protected: false, isModule: false }]);
  await filetree.loadFileTree();
  assert.strictEqual(genesis.calls.invoke[0].channel, 'agent:get-file-tree');
});

await test('A9: protected file gets 🔒 icon', async () => {
  const { filetree, dom } = setup([
    { path: 'main.js', lines: 100, protected: true, isModule: false },
  ]);
  await filetree.loadFileTree();
  const tree = dom.elements['file-tree'];
  assert.ok(tree.children[0].textContent.includes('🔒'),
    `expected 🔒, got: ${tree.children[0].textContent}`);
});

await test('A9: module file gets ◈ icon', async () => {
  const { filetree, dom } = setup([
    { path: 'src/agent/Brain.js', lines: 200, protected: false, isModule: true },
  ]);
  await filetree.loadFileTree();
  const tree = dom.elements['file-tree'];
  assert.ok(tree.children[0].textContent.includes('◈'),
    `expected ◈, got: ${tree.children[0].textContent}`);
});

await test('A9: regular file gets 📄 icon', async () => {
  const { filetree, dom } = setup([
    { path: 'README.md', lines: 50, protected: false, isModule: false },
  ]);
  await filetree.loadFileTree();
  const tree = dom.elements['file-tree'];
  assert.ok(tree.children[0].textContent.includes('📄'),
    `expected 📄, got: ${tree.children[0].textContent}`);
});

await test('A9: protected wins over isModule (priority)', async () => {
  const { filetree, dom } = setup([
    { path: 'src/core/SafeGuard.js', lines: 100, protected: true, isModule: true },
  ]);
  await filetree.loadFileTree();
  const tree = dom.elements['file-tree'];
  // Protected status is more important than module marker — show 🔒.
  assert.ok(tree.children[0].textContent.includes('🔒'),
    `protected wins: ${tree.children[0].textContent}`);
  assert.ok(!tree.children[0].textContent.includes('◈'),
    `must NOT show module icon when protected: ${tree.children[0].textContent}`);
});

await test('multiple files all rendered', async () => {
  const { filetree, dom } = setup([
    { path: 'a.js', protected: true, isModule: false },
    { path: 'b.js', protected: false, isModule: true },
    { path: 'c.md', protected: false, isModule: false },
  ]);
  await filetree.loadFileTree();
  const tree = dom.elements['file-tree'];
  assert.strictEqual(tree.children.length, 3);
});

await test('IPC failure is caught (no throw)', async () => {
  const dom = createMiniDOM();
  const genesis = createGenesisMock();
  genesis.setHandler('agent:get-file-tree', () => { throw new Error('IPC fail'); });
  global.document = dom.doc;
  global.window = { genesis: genesis.mock };
  delete require.cache[require.resolve(path.join(ROOT, 'src', 'ui', 'modules', 'filetree'))];
  const filetree = require(path.join(ROOT, 'src', 'ui', 'modules', 'filetree'));
  let threw = false;
  try { await filetree.loadFileTree(); } catch { threw = true; }
  assert.ok(!threw, 'IPC failure must not propagate');
});

await test('protected files get protected CSS class', async () => {
  const { filetree, dom } = setup([
    { path: 'main.js', protected: true, isModule: false },
  ]);
  await filetree.loadFileTree();
  const tree = dom.elements['file-tree'];
  assert.ok(tree.children[0].className.includes('protected'),
    `expected 'protected' class: ${tree.children[0].className}`);
});

await new Promise(r => setTimeout(r, 10));
console.log(`\n    ${passed} passed · ${failed} failed · v7.7.0 ui-filetree-module`);
process.exit(failed > 0 ? 1 : 0);
})();
