// Test: ResourceRegistry.js — v7.4.5 Baustein C
const path = require('path');
const fs = require('fs');
const os = require('os');

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => {
        passed++; console.log(`    ✅ ${name}`);
      }).catch(err => {
        failed++; failures.push({ name, error: err.message });
        console.log(`    ❌ ${name}: ${err.message}`);
      });
    }
    passed++; console.log(`    ✅ ${name}`);
  } catch (err) {
    failed++; failures.push({ name, error: err.message });
    console.log(`    ❌ ${name}: ${err.message}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }

const { ResourceRegistry } = require('../../src/agent/foundation/ResourceRegistry');
const { EventBus } = require('../../src/agent/core/EventBus');

function fakeWorldState(ollamaStatus) {
  return { state: { runtime: { ollamaStatus } } };
}
function fakeBridge(activeBackend) {
  return { activeBackend };
}

(async () => {

  await test('isAvailable() returns false for unknown token (no probe yet)', () => {
    const bus = new EventBus({ verbose: false });
    const rr = new ResourceRegistry({ bus });
    assert(rr.isAvailable('service:foo') === false, 'unknown token should be unavailable');
  });

  await test('register() flips state and emits resource:available', () => {
    const bus = new EventBus({ verbose: false });
    const rr = new ResourceRegistry({ bus });
    let evt = null;
    bus.on('resource:available', (d) => { evt = d; });
    rr.register('service:custom', true);
    assert(evt && evt.token === 'service:custom', 'should emit available with token');
    assert(rr.isAvailable('service:custom') === true);
  });

  await test('flip from available → unavailable emits resource:unavailable', () => {
    const bus = new EventBus({ verbose: false });
    const rr = new ResourceRegistry({ bus });
    rr.register('service:x', true);
    let unav = null;
    bus.on('resource:unavailable', (d) => { unav = d; });
    rr.register('service:x', false, 'lost connection');
    assert(unav && unav.token === 'service:x', 'should emit unavailable');
    assert(unav.reason === 'lost connection', 'reason forwarded');
  });

  await test('same-state re-register does NOT emit (idempotent)', () => {
    const bus = new EventBus({ verbose: false });
    const rr = new ResourceRegistry({ bus });
    rr.register('service:y', true);
    let count = 0;
    bus.on('resource:available', () => { count++; });
    rr.register('service:y', true);  // no flip
    rr.register('service:y', true);
    assert(count === 0, `should not re-emit on same state, got ${count}`);
  });

  await test('requireAll: empty list → ok=true', () => {
    const bus = new EventBus({ verbose: false });
    const rr = new ResourceRegistry({ bus });
    assert(rr.requireAll([]).ok === true);
    assert(rr.requireAll(null).ok === true);
  });

  await test('requireAll: missing tokens reported in .missing', () => {
    const bus = new EventBus({ verbose: false });
    const rr = new ResourceRegistry({ bus });
    rr.register('network', true);
    const r = rr.requireAll(['network', 'service:llm']);
    assert(r.ok === false, 'should not be ok');
    assert(r.missing.length === 1 && r.missing[0] === 'service:llm', `wrong missing: ${JSON.stringify(r.missing)}`);
  });

  await test('service:llm resolves to active backend', () => {
    const bus = new EventBus({ verbose: false });
    const rr = new ResourceRegistry({
      bus,
      modelBridge: fakeBridge('ollama'),
      worldState: fakeWorldState('running'),
    });
    rr._probeOllama();
    assert(rr.isAvailable('service:llm') === true, 'service:llm should be available when ollama running');
  });

  await test('service:llm unavailable when active backend (ollama) down', () => {
    const bus = new EventBus({ verbose: false });
    const rr = new ResourceRegistry({
      bus,
      modelBridge: fakeBridge('ollama'),
      worldState: fakeWorldState('stopped'),
    });
    rr._probeOllama();
    assert(rr.isAvailable('service:llm') === false);
    assert(rr.isAvailable('service:ollama') === false);
  });

  await test('file:<path> probes existence at query time', () => {
    const tmp = path.join(os.tmpdir(), 'rr-test-' + Date.now() + '.txt');
    fs.writeFileSync(tmp, 'hi');
    try {
      const bus = new EventBus({ verbose: false });
      const rr = new ResourceRegistry({ bus });
      assert(rr.isAvailable(`file:${tmp}`) === true, 'existing file should be available');
      fs.unlinkSync(tmp);
      // bypass cache by making path different
      const newPath = tmp + '-other';
      assert(rr.isAvailable(`file:${newPath}`) === false, 'missing file should be unavailable');
    } finally {
      try { fs.unlinkSync(tmp); } catch (_e) { /* swallow */ }
    }
  });

  await test('boot:complete triggers re-probe (cache cleared, re-emits)', async () => {
    const bus = new EventBus({ verbose: false });
    const rr = new ResourceRegistry({
      bus,
      modelBridge: fakeBridge('ollama'),
      worldState: fakeWorldState('running'),
    });
    await rr.asyncLoad();

    // After asyncLoad, service:ollama is available (already emitted).
    // Subscribe AFTER initial emit, then fire boot:complete.
    let seen = false;
    bus.on('resource:available', (d) => {
      if (d.token === 'service:ollama') seen = true;
    });
    bus.fire('boot:complete', {});
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    assert(seen, 'boot:complete should re-emit resource:available for already-up resources');

    rr.stop();
  });

  await test('stop() unsubscribes — no further events recorded', async () => {
    const bus = new EventBus({ verbose: false });
    const rr = new ResourceRegistry({ bus });
    await rr.asyncLoad();
    rr.stop();

    let count = 0;
    bus.on('resource:unavailable', () => { count++; });
    bus.fire('network:status', { online: false });
    await new Promise(r => setImmediate(r));
    assert(count === 0, `stop should detach listeners, got ${count} events`);
  });

  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\n  Failures:');
    for (const f of failures) console.log(`    - ${f.name}: ${f.error}`);
    process.exit(1);
  }
})();
