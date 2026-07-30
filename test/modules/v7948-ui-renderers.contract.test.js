// ============================================================
// GENESIS — v7.9.48 UI renderer contract
//
// Two renderer files carried 966 lines between them and had no test at all,
// while the fitness report said "100%". It was true for the tree it looked
// at: twelve of thirteen checks stop at src/agent, and only the file-size
// guard ever reaches the UI. This suite exists so the widened check has
// something to stand on.
//
// The shape is the one v742-structure.test.js uses for the CommandHandlers
// mixins: apply the mixin to a stub and pin the method set. That is cheap and
// it catches what matters here — a renderer that silently stops attaching a
// method, or a rename that leaves the dashboard calling into nothing.
//
// Modules under test — named in full because architectural-fitness maps
// source to test by filename occurrence in the test text:
//   AgentRenderers.js, IntelRenderers.js
// ============================================================

'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const applyAgent = require(path.join(ROOT, 'src/ui/renderers/AgentRenderers.js'));
const applyIntel = require(path.join(ROOT, 'src/ui/renderers/IntelRenderers.js'));

let pass = 0; let fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (err) { console.log(`  ✗ ${name} — ${err.message}`); fail++; }
}

/** A Dashboard stand-in: the renderers only touch its prototype. */
function makeStub() {
  function Dashboard() {}
  Dashboard.prototype = {};
  return Dashboard;
}

console.log('\nv7.9.48 — UI renderer contract\n');

t('AgentRenderers attaches its seven methods', () => {
  const D = makeStub();
  applyAgent(D);
  const methods = Object.keys(D.prototype);
  assert.strictEqual(methods.length, 7,
    `AgentRenderers: 7 methods expected, got ${methods.length} (${methods.join(', ')})`);
  for (const m of ['_renderAgentLoop', '_showApproval', '_updateLoopProgress',
    '_renderCognitive', '_renderReasoning']) {
    assert.strictEqual(typeof D.prototype[m], 'function', `${m} must be attached`);
  }
});

t('IntelRenderers attaches its 23 methods', () => {
  const D = makeStub();
  applyIntel(D);
  const methods = Object.keys(D.prototype);
  assert.strictEqual(methods.length, 23,
    `IntelRenderers: 23 methods expected, got ${methods.length}`);
  for (const m of ['_renderArchitecture', '_renderProjectIntel',
    '_renderToolSynthesis', '_renderInsightsTimeline']) {
    assert.strictEqual(typeof D.prototype[m], 'function', `${m} must be attached`);
  }
});

t('the two renderers do not collide', () => {
  // Both mix onto the same Dashboard at runtime. A name in both would mean one
  // silently wins depending on load order.
  const A = makeStub(); applyAgent(A);
  const I = makeStub(); applyIntel(I);
  const doppelt = Object.keys(A.prototype).filter((m) => m in I.prototype);
  assert.deepStrictEqual(doppelt, [],
    `these method names exist in both renderers: ${doppelt.join(', ')}`);
});

t('applying a renderer twice is idempotent', () => {
  const D = makeStub();
  applyIntel(D);
  const erste = Object.keys(D.prototype).length;
  applyIntel(D);
  assert.strictEqual(Object.keys(D.prototype).length, erste,
    'a second apply must not add or duplicate methods');
});

t('the widened coverage check reaches src/ui', () => {
  // The point of this suite: without the widening the two files above were
  // invisible, and the report still said 100%.
  const src = require('fs').readFileSync(path.join(ROOT, 'scripts/architectural-fitness.js'), 'utf8');
  const block = src.slice(src.indexOf("check('Test Coverage Gaps'"));
  assert.ok(/walkJs\(path\.join\(SRC, 'ui'\)\)/.test(block.slice(0, 900)),
    'the coverage check must walk src/ui');
  assert.ok(/walkJs\(path\.join\(SRC, 'kernel'\)\)/.test(block.slice(0, 900)),
    'and src/kernel');
});

t('v7.9.50: the graph is whole in the RENDERER, not only in Node', () => {
  // Field bug: the viewport mixin was placed inside `if (typeof module !== ...)`.
  // Node has `module`, so every test stayed green; the renderer does not, so the
  // block was skipped, the mixin never ran, and the graph died with
  // "_addZoomToolbar is not a function". A mixin belongs to the class, never to
  // the export.
  const src = fs.readFileSync(path.join(ROOT, 'src/ui/components/ArchitectureGraph.js'), 'utf8');
  const iMix = src.indexOf('Object.assign(ArchitectureGraph.prototype, _view)');
  const iMod = src.indexOf("if (typeof module !== 'undefined') {");
  assert.ok(iMix > 0, 'the mixin must exist');
  assert.ok(iMix < iMod, 'and it must stand BEFORE the module guard, not inside it');

  // index.html must load the sibling first, or the global is not there yet
  const html = fs.readFileSync(path.join(ROOT, 'src/ui/index.html'), 'utf8');
  assert.ok(html.indexOf('ArchitectureGraphView.js') < html.indexOf('components/ArchitectureGraph.js'),
    'the viewport script must be loaded before the file that mixes it in');

  // no UI file may hide anything but its export behind the module guard
  const walk = (d, a = []) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const q = path.join(d, e.name);
      if (e.isDirectory()) walk(q, a); else if (e.name.endsWith('.js')) a.push(q);
    }
    return a;
  };
  for (const f of walk(path.join(ROOT, 'src/ui'))) {
    const s2 = fs.readFileSync(f, 'utf8');
    for (const m of s2.matchAll(/if\s*\(\s*typeof module[^)]*\)\s*\{([\s\S]*?)\n\}/g)) {
      const zeilen = m[1].split('\n').map((l) => l.trim())
        .filter((l) => l && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'));
      assert.ok(zeilen.every((l) => /^module\.exports/.test(l)),
        `${path.basename(f)}: only the export may sit behind the module guard — the renderer skips it`);
    }
  }
});

console.log(`\n${pass} passed · ${fail} failed`);
if (fail > 0) process.exit(1);
