// ============================================================
// GENESIS — test/modules/v757-fix-phase2.test.js
//
// Tests for v7.5.7-fix Phase 2:
//  - Auto-Routing default false (changed from true)
//  - keep_alive option in OllamaBackend
//  - unloadModel method on OllamaBackend
//  - switchTo unloads previous Ollama model
//  - models.maxConcurrent setting flows from Settings → ModelBridge
//  - models.ollamaKeepAlive setting flows to OllamaBackend
//  - GraphStore.pruneNodes LRU pruning
//  - KnowledgeGraph triggers prune when over maxNodes
//  - SelfStatementLog count-based cap in prune()
//  - Settings has new defaults: knowledgeGraph, selfStatementLog,
//    episodicMemory, selfSpawner, models.ollamaKeepAlive,
//    models.maxConcurrent
//  - Settings UI has tab markup + all new field IDs
// ============================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`    ✅ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`    ❌ ${name}: ${err.message}`);
  }
}

const ROOT = path.join(__dirname, '..', '..');

// ── Settings defaults ──────────────────────────────────────

test('Settings: agency.autoRouteByTask default is false', () => {
  const { Settings } = require(path.join(ROOT, 'src/agent/foundation/Settings'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-p2-'));
  const s = new Settings(dir);
  assert.strictEqual(s.get('agency.autoRouteByTask'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Settings: models.maxConcurrent default is 3', () => {
  const { Settings } = require(path.join(ROOT, 'src/agent/foundation/Settings'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-p2-'));
  const s = new Settings(dir);
  assert.strictEqual(s.get('models.maxConcurrent'), 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Settings: models.ollamaKeepAlive default is null (use Ollama default)', () => {
  const { Settings } = require(path.join(ROOT, 'src/agent/foundation/Settings'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-p2-'));
  const s = new Settings(dir);
  assert.strictEqual(s.get('models.ollamaKeepAlive'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Settings: selfSpawner.maxWorkers default is 3', () => {
  const { Settings } = require(path.join(ROOT, 'src/agent/foundation/Settings'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-p2-'));
  const s = new Settings(dir);
  assert.strictEqual(s.get('selfSpawner.maxWorkers'), 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Settings: knowledgeGraph.maxNodes default is 5000', () => {
  const { Settings } = require(path.join(ROOT, 'src/agent/foundation/Settings'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-p2-'));
  const s = new Settings(dir);
  assert.strictEqual(s.get('knowledgeGraph.maxNodes'), 5000);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Settings: selfStatementLog.maxStatements default is 5000', () => {
  const { Settings } = require(path.join(ROOT, 'src/agent/foundation/Settings'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-p2-'));
  const s = new Settings(dir);
  assert.strictEqual(s.get('selfStatementLog.maxStatements'), 5000);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Settings: episodicMemory.maxEpisodes default is 500', () => {
  const { Settings } = require(path.join(ROOT, 'src/agent/foundation/Settings'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-p2-'));
  const s = new Settings(dir);
  assert.strictEqual(s.get('episodicMemory.maxEpisodes'), 500);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── OllamaBackend keep_alive + unloadModel ─────────────────

test('OllamaBackend: keepAlive option stored on instance', () => {
  const { OllamaBackend } = require(path.join(ROOT, 'src/agent/foundation/backends/OllamaBackend'));
  const ob = new OllamaBackend({ keepAlive: '30s' });
  assert.strictEqual(ob.keepAlive, '30s');
  const ob2 = new OllamaBackend();
  assert.strictEqual(ob2.keepAlive, null);
});

test('OllamaBackend: unloadModel method exists', () => {
  const { OllamaBackend } = require(path.join(ROOT, 'src/agent/foundation/backends/OllamaBackend'));
  const ob = new OllamaBackend();
  assert.strictEqual(typeof ob.unloadModel, 'function');
});

test('OllamaBackend: unloadModel returns false on empty name', async () => {
  const { OllamaBackend } = require(path.join(ROOT, 'src/agent/foundation/backends/OllamaBackend'));
  const ob = new OllamaBackend();
  const res = await ob.unloadModel('');
  assert.strictEqual(res, false);
  const res2 = await ob.unloadModel(null);
  assert.strictEqual(res2, false);
});

// ── ModelBridge constructor accepts ollamaKeepAlive ────────

test('ModelBridge: ollamaKeepAlive option flows to OllamaBackend', () => {
  const { ModelBridge } = require(path.join(ROOT, 'src/agent/foundation/ModelBridge'));
  const mb = new ModelBridge({ ollamaKeepAlive: '30s' });
  assert.strictEqual(mb.backends.ollama.keepAlive, '30s');
});

test('ModelBridge: switchTo unloads previous Ollama model (best-effort)', async () => {
  const { ModelBridge } = require(path.join(ROOT, 'src/agent/foundation/ModelBridge'));
  const mb = new ModelBridge();
  // Stub unloadModel so we can verify it was called
  let unloadedWith = null;
  mb.backends.ollama.unloadModel = async (name) => { unloadedWith = name; return true; };
  // Setup state: previous model is "old-model" on ollama
  mb.activeModel = 'old-model';
  mb.activeBackend = 'ollama';
  mb.availableModels = [{ name: 'new-model', backend: 'ollama' }];
  await mb.switchTo('new-model');
  assert.strictEqual(unloadedWith, 'old-model', 'should call unloadModel with previous model name');
  assert.strictEqual(mb.activeModel, 'new-model');
});

test('ModelBridge: switchTo does NOT unload if same model', async () => {
  const { ModelBridge } = require(path.join(ROOT, 'src/agent/foundation/ModelBridge'));
  const mb = new ModelBridge();
  let called = false;
  mb.backends.ollama.unloadModel = async () => { called = true; };
  mb.activeModel = 'model-a';
  mb.activeBackend = 'ollama';
  mb.availableModels = [{ name: 'model-a', backend: 'ollama' }];
  await mb.switchTo('model-a');
  assert.strictEqual(called, false, 'should not unload when switching to same model');
});

test('ModelBridge: switchTo does NOT unload non-Ollama backends', async () => {
  const { ModelBridge } = require(path.join(ROOT, 'src/agent/foundation/ModelBridge'));
  const mb = new ModelBridge();
  let called = false;
  mb.backends.ollama.unloadModel = async () => { called = true; };
  mb.activeModel = 'claude-sonnet';
  mb.activeBackend = 'anthropic';
  mb.availableModels = [{ name: 'gpt-4', backend: 'openai' }];
  await mb.switchTo('gpt-4');
  assert.strictEqual(called, false, 'should not call unloadModel for non-Ollama prev');
});

// ── GraphStore.pruneNodes ──────────────────────────────────

test('GraphStore.pruneNodes: no-op when below maxNodes', () => {
  const { GraphStore } = require(path.join(ROOT, 'src/agent/foundation/GraphStore'));
  const g = new GraphStore();
  for (let i = 0; i < 3; i++) g.addNode('concept', `node-${i}`);
  const removed = g.pruneNodes(10);
  assert.strictEqual(removed, 0);
  assert.strictEqual(g.nodes.size, 3);
});

test('GraphStore.pruneNodes: returns 0 when maxNodes is 0 (unlimited)', () => {
  const { GraphStore } = require(path.join(ROOT, 'src/agent/foundation/GraphStore'));
  const g = new GraphStore();
  for (let i = 0; i < 100; i++) g.addNode('concept', `node-${i}`);
  const removed = g.pruneNodes(0);
  assert.strictEqual(removed, 0);
  assert.strictEqual(g.nodes.size, 100);
});

test('GraphStore.pruneNodes: prunes excess nodes, keeps high-access ones', () => {
  const { GraphStore } = require(path.join(ROOT, 'src/agent/foundation/GraphStore'));
  const g = new GraphStore();
  const ids = [];
  for (let i = 0; i < 10; i++) ids.push(g.addNode('concept', `node-${i}`));
  // Boost access count for last 3 nodes
  for (let i = 7; i < 10; i++) {
    for (let n = 0; n < 5; n++) g.getNode(ids[i]); // increments accessCount
  }
  const removed = g.pruneNodes(5);
  assert.strictEqual(removed, 5);
  assert.strictEqual(g.nodes.size, 5);
  // The high-access nodes should still be there
  for (let i = 7; i < 10; i++) {
    assert.ok(g.nodes.has(ids[i]), `node ${i} (high access) should survive`);
  }
});

test('GraphStore.pruneNodes: removes connected edges', () => {
  const { GraphStore } = require(path.join(ROOT, 'src/agent/foundation/GraphStore'));
  const g = new GraphStore();
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(g.addNode('concept', `node-${i}`));
  // Connect node-0 to node-4 — node-0 will be pruned
  g.addEdge(ids[0], ids[4], 'relates-to', 0.5);
  // Boost access on node-4
  for (let n = 0; n < 10; n++) g.getNode(ids[4]);
  const edgesBefore = g.edges.size;
  assert.strictEqual(edgesBefore, 1);
  g.pruneNodes(2); // keep only 2 (node-4 high access + 1 other)
  // Edge should be gone since node-0 was pruned
  assert.strictEqual(g.edges.size, 0);
});

// ── KnowledgeGraph integration ─────────────────────────────

test('KnowledgeGraph: respects maxNodes from settings', () => {
  const { KnowledgeGraph } = require(path.join(ROOT, 'src/agent/foundation/KnowledgeGraph'));
  const fakeSettings = { get: (key) => key === 'knowledgeGraph.maxNodes' ? 10 : undefined };
  const fakeStorage = {
    read: () => null,
    write: () => {},
    writeJSON: () => {},
    writeJSONDebounced: () => {},
  };
  const kg = new KnowledgeGraph({ storage: fakeStorage, settings: fakeSettings });
  for (let i = 0; i < 15; i++) kg.addNode('concept', `n-${i}`);
  // After 15 inserts with cap 10, KG should have at most 10 nodes
  assert.ok(kg.graph.nodes.size <= 10, `expected ≤10 nodes, got ${kg.graph.nodes.size}`);
});

test('KnowledgeGraph: 0 maxNodes means unlimited', () => {
  const { KnowledgeGraph } = require(path.join(ROOT, 'src/agent/foundation/KnowledgeGraph'));
  const fakeSettings = { get: (key) => key === 'knowledgeGraph.maxNodes' ? 0 : undefined };
  const fakeStorage = {
    read: () => null,
    write: () => {},
    writeJSON: () => {},
    writeJSONDebounced: () => {},
  };
  const kg = new KnowledgeGraph({ storage: fakeStorage, settings: fakeSettings });
  for (let i = 0; i < 50; i++) kg.addNode('concept', `n-${i}`);
  assert.strictEqual(kg.graph.nodes.size, 50, '0 cap = no pruning');
});

// ── SelfStatementLog count-cap ─────────────────────────────

test('SelfStatementLog: maxStatements stored on instance', () => {
  const { SelfStatementLog } = require(path.join(ROOT, 'src/agent/cognitive/SelfStatementLog'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-ssl-'));
  const ssl = new SelfStatementLog({
    bus: { on: () => {}, emit: () => {} },
    storageDir: dir,
    maxStatements: 100,
  });
  assert.strictEqual(ssl._maxStatements, 100);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('SelfStatementLog: maxStatements 0 means unlimited', () => {
  const { SelfStatementLog } = require(path.join(ROOT, 'src/agent/cognitive/SelfStatementLog'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-ssl-'));
  const ssl = new SelfStatementLog({
    bus: { on: () => {}, emit: () => {} },
    storageDir: dir,
    maxStatements: 0,
  });
  assert.strictEqual(ssl._maxStatements, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Settings UI new fields ─────────────────────────────────

test('UI HTML: settings-tab markup exists', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/ui/index.html'), 'utf8');
  assert.ok(/<div class="settings-tabs">/.test(html), 'settings-tabs container missing');
  assert.ok(/data-tab="models"/.test(html), 'models tab missing');
  assert.ok(/data-tab="behavior"/.test(html), 'behavior tab missing');
  assert.ok(/data-tab="limits"/.test(html), 'limits tab missing');
  assert.ok(/data-tab="mcp"/.test(html), 'mcp tab missing');
  assert.ok(/data-tab="advanced"/.test(html), 'advanced tab missing');
});

test('UI HTML: all new field IDs present', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/ui/index.html'), 'utf8');
  // v7.5.7-fix Phase 2 round 3: Liste der wirklich verkabelten UI-Felder.
  // set-em-max, set-shell-timeout, set-http-timeout, set-git-timeout,
  // set-emotion-decay, set-emotion-watchdog wurden entfernt (waren UI-Theater
  // ohne Backend-Reader). set-emotion-decay-interval und
  // set-loneliness-interval ersetzen die alten emotion-Felder.
  const required = [
    'set-auto-route', 'set-negotiate', 'set-cognitive-strict',
    'set-max-concurrent', 'set-max-workers', 'set-keep-alive',
    'set-kg-max-nodes', 'set-sslog-max',
    'set-sim-branches', 'set-sim-depth',
    'set-emotion-decay-interval', 'set-loneliness-interval',
    'set-idle-minutes', 'set-think-minutes', 'set-daemon-cycle',
    // v7.5.7-fix Phase 3 Etappe 2: replaced read-only mcp-servers-info
    // with editable mcp-servers-list (Add/Remove rows)
    'mcp-servers-list',
  ];
  for (const id of required) {
    assert.ok(html.includes(`id="${id}"`), `missing field id="${id}"`);
  }
  // Verify the dead fields are GONE
  const removed = ['set-em-max', 'set-shell-timeout', 'set-http-timeout',
                   'set-git-timeout', 'set-emotion-decay\"', 'set-emotion-watchdog'];
  for (const id of removed) {
    assert.ok(!html.includes(`id="${id}`), `dead UI field still present: id="${id}"`);
  }
});

test('UI bundled.html: tabs + new fields present', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/ui/index.html'), 'utf8');
  assert.ok(/<div class="settings-tabs">/.test(html), 'tabs missing in bundled');
  assert.ok(/id="set-auto-route"/.test(html), 'set-auto-route missing in bundled');
  assert.ok(/id="set-max-concurrent"/.test(html), 'set-max-concurrent missing in bundled');
});

test('UI CSS: settings-tab styles exist', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src/ui/styles.css'), 'utf8');
  assert.ok(/\.settings-tabs\s*\{/.test(css), '.settings-tabs CSS missing');
  assert.ok(/\.settings-tab\.active/.test(css), '.settings-tab.active state missing');
  assert.ok(/\.settings-tab-panel\.hidden/.test(css), '.settings-tab-panel.hidden missing');
});

// ── Done ───────────────────────────────────────────────────

console.log('');
console.log(`  ${passed} passed${failed > 0 ? `, ${failed} failed` : ''}`);
if (failed > 0) {
  console.log('');
  console.log('  Failures:');
  for (const f of failures) console.log(`    - ${f.name}: ${f.error}`);
  process.exit(1);
}
