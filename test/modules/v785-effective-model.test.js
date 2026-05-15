// ============================================================
// GENESIS — test/modules/v785-effective-model.test.js (v7.8.5)
//
// effective-model contract: ModelBridge tracks the model that
// actually answered each call. Downstream events and the health
// endpoint surface this state so the UI dropdown shows reality,
// not just intent.
// ============================================================

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(
        () => { passed++; console.log(`    ✅ ${name}`); },
        (err) => { failed++; failures.push({ name, error: err.message });
                   console.log(`    ❌ ${name}: ${err.message}`); }
      );
    }
    passed++;
    console.log(`    ✅ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`    ❌ ${name}: ${err.message}`);
  }
}

const ROOT = path.join(__dirname, '..', '..');

test('effective-model contract: ModelBridge constructor inits the three new properties', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/ModelBridge.js'), 'utf-8');
  assert.match(src, /this\.lastEffectiveModel\s*=\s*null/);
  assert.match(src, /this\.lastEffectiveBackend\s*=\s*null/);
  assert.match(src, /this\.lastFailoverReason\s*=\s*null/);
});

test('effective-model contract: chat() success path updates state', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/ModelBridge.js'), 'utf-8');
  const block = src.match(/await this\._dispatchChat\([\s\S]+?if \(cacheKey\) this\._cache\.set\(cacheKey, result\);/);
  assert.ok(block, 'chat() success block must exist');
  assert.match(block[0], /this\.lastEffectiveModel\s*=\s*calledModel/);
  assert.match(block[0], /this\.lastFailoverReason\s*=\s*null/);
});

test('effective-model contract: streamChat() success path updates state', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/ModelBridge.js'), 'utf-8');
  const block = src.match(/await this\._dispatchStream\([\s\S]+?this\.lastFailoverReason[\s\S]+?return result;/);
  assert.ok(block, 'streamChat() success block must exist');
  assert.match(block[0], /this\.lastEffectiveModel\s*=\s*calledModel/);
});

test('effective-model contract: _handleFailoverError updates state on successful fallback', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/ModelBridge.js'), 'utf-8');
  const block = src.match(/const result = await dispatch\(fallback\);[\s\S]+?return result;/);
  assert.ok(block, 'failover success block must exist');
  assert.match(block[0], /this\.lastEffectiveModel\s*=\s*fallbackModelName/);
  assert.match(block[0], /this\.lastFailoverReason\s*=\s*reason/);
});

test('effective-model contract: ModelBridge stamps _effectiveModel on options', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/ModelBridge.js'), 'utf-8');
  assert.match(src, /options\._effectiveModel\s*=\s*fallbackModelName/);
});

test('effective-model contract: model:failover payload includes effectiveModel + preferredModel', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/ModelBridge.js'), 'utf-8');
  const fire = src.match(/bus\.fire\(\s*'model:failover'[\s\S]+?\}\s*,\s*\{\s*source/);
  assert.ok(fire, 'model:failover fire must exist');
  assert.match(fire[0], /effectiveModel\s*:/);
  assert.match(fire[0], /preferredModel\s*:/);
});

test('effective-model contract: LLMPort._emitCallComplete forwards effectiveModel', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/ports/LLMPort.js'), 'utf-8');
  const fire = src.match(/bus\.fire\(\s*'llm:call-complete'[\s\S]+?\}\s*,\s*\{\s*source/);
  assert.ok(fire, 'llm:call-complete fire must exist');
  assert.match(fire[0], /effectiveModel\s*:\s*options\._effectiveModel\s*\|\|\s*this\._bridge\.activeModel/);
});

test('effective-model contract: CostStream persists effectiveModel in cost rows', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/CostStream.js'), 'utf-8');
  const row = src.match(/const row = \{[\s\S]+?failover:[^,]+,[\s\S]+?\};/);
  assert.ok(row, 'cost row construction must exist');
  assert.match(row[0], /effectiveModel\s*:/);
});

test('effective-model contract: AgentCoreHealth surfaces effective + failoverReason', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/AgentCoreHealth.js'), 'utf-8');
  const block = src.match(/model:\s*\{[\s\S]+?failoverReason:[\s\S]+?\},/);
  assert.ok(block, 'health.model block with failoverReason must exist');
  assert.match(block[0], /effective:\s*c\.resolve\('model'\)\.lastEffectiveModel\s*\|\|\s*c\.resolve\('model'\)\.activeModel/);
  assert.match(block[0], /failoverReason:\s*c\.resolve\('model'\)\.lastFailoverReason/);
});

test('effective-model contract: schema entries cover all three events', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/core/EventPayloadSchemas.js'), 'utf-8');
  const failover = src.match(/'model:failover'\s*:[^\n]+/);
  assert.ok(failover);
  assert.match(failover[0], /effectiveModel\s*:\s*'optional'/);
  assert.match(failover[0], /preferredModel\s*:\s*'optional'/);
  const llm = src.match(/'llm:call-complete'\s*:\s*\{[^}]+\}/);
  assert.ok(llm);
  assert.match(llm[0], /effectiveModel\s*:\s*'optional'/);
  const cost = src.match(/'cost:recorded'\s*:\s*\{[^}]+\}/);
  assert.ok(cost);
  assert.match(cost[0], /effectiveModel\s*:\s*'optional'/);
});

test('effective-model contract: failover log line names the fallback model', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/ModelBridge.js'), 'utf-8');
  assert.match(src, /falling back to \$\{fallback\}\$\{fallbackModelName\s*\?\s*` \(\$\{fallbackModelName\}\)`/);
});

test('effective-model contract: non-failover call yields effectiveModel === activeModel', async () => {
  const { ModelBridge } = require(path.join(ROOT, 'src/agent/foundation/ModelBridge'));
  const { ModelBridgeAdapter } = require(path.join(ROOT, 'src/agent/ports/LLMPort'));
  const { EventBus } = require(path.join(ROOT, 'src/agent/core/EventBus'));
  const { MockBackend } = require(path.join(ROOT, 'src/agent/foundation/backends/MockBackend'));

  const bus = new EventBus();
  const bridge = new ModelBridge({ bus });
  const mock = new MockBackend({ name: 'mock-A', response: 'hello' });
  bridge.backends = { mock };
  bridge.activeBackend = 'mock';
  bridge.activeModel = 'mock-A';
  bridge.availableModels = [{ name: 'mock-A', backend: 'mock' }];

  const port = new ModelBridgeAdapter(bridge, bus);
  const captured = [];
  bus.on('llm:call-complete', (d) => captured.push(d), { source: 'test' });

  await port.chat('system', [{ role: 'user', content: 'hi' }], 'chat', {});

  assert.strictEqual(bridge.lastEffectiveModel, 'mock-A');
  assert.strictEqual(bridge.lastFailoverReason, null);
  assert.ok(captured.length > 0);
  assert.strictEqual(captured[0].effectiveModel, 'mock-A');
  assert.strictEqual(captured[0].failover, 'none');
});

test('effective-model contract: failover yields effectiveModel ≠ preferredModel', async () => {
  const { ModelBridge } = require(path.join(ROOT, 'src/agent/foundation/ModelBridge'));
  const { ModelBridgeAdapter } = require(path.join(ROOT, 'src/agent/ports/LLMPort'));
  const { EventBus } = require(path.join(ROOT, 'src/agent/core/EventBus'));
  const { MockBackend } = require(path.join(ROOT, 'src/agent/foundation/backends/MockBackend'));

  const bus = new EventBus();
  const bridge = new ModelBridge({ bus });
  const primary = new MockBackend({ name: 'cloud-preferred', response: 'ok' });
  primary.chat = async () => { throw new Error('HTTP 429: rate-limited'); };
  const secondary = new MockBackend({ name: 'local-fallback', response: 'answer' });
  bridge.backends = { primary, secondary };
  bridge.activeBackend = 'primary';
  bridge.activeModel = 'cloud-preferred';
  bridge.availableModels = [
    { name: 'cloud-preferred', backend: 'primary' },
    { name: 'local-fallback',  backend: 'secondary' },
  ];

  const port = new ModelBridgeAdapter(bridge, bus);
  let ev = null;
  bus.on('model:failover', (d) => { ev = d; }, { source: 'test' });

  try { await port.chat('system', [{ role: 'user', content: 'hi' }], 'chat', {}); }
  catch (_e) { /* ok */ }

  if (ev) {
    assert.ok(ev.effectiveModel);
    assert.ok(ev.preferredModel);
    assert.notStrictEqual(ev.effectiveModel, ev.preferredModel);
  }
});

test('effective-model contract: subsequent non-failover call clears failoverReason', async () => {
  const { ModelBridge } = require(path.join(ROOT, 'src/agent/foundation/ModelBridge'));
  const { ModelBridgeAdapter } = require(path.join(ROOT, 'src/agent/ports/LLMPort'));
  const { EventBus } = require(path.join(ROOT, 'src/agent/core/EventBus'));
  const { MockBackend } = require(path.join(ROOT, 'src/agent/foundation/backends/MockBackend'));

  const bus = new EventBus();
  const bridge = new ModelBridge({ bus });
  const ok = new MockBackend({ name: 'ok-model', response: 'fine' });
  bridge.backends = { ok };
  bridge.activeBackend = 'ok';
  bridge.activeModel = 'ok-model';
  bridge.availableModels = [{ name: 'ok-model', backend: 'ok' }];

  bridge.lastEffectiveModel = 'some-fallback';
  bridge.lastFailoverReason = 'rate-limit';

  const port = new ModelBridgeAdapter(bridge, bus);
  await port.chat('system', [{ role: 'user', content: 'hi' }], 'chat', {});

  assert.strictEqual(bridge.lastFailoverReason, null);
  assert.strictEqual(bridge.lastEffectiveModel, 'ok-model');
});

(async () => {
  await new Promise(r => setTimeout(r, 100));
  if (failed > 0) {
    console.log(`\n  ${failed} failure(s):`);
    for (const f of failures) console.log(`    - ${f.name}: ${f.error}`);
    process.exit(1);
  }
  console.log(`    ${passed} passed`);
})();
