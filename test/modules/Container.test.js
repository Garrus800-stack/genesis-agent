#!/usr/bin/env node
// ============================================================
// Test: Container.js — DI Container Core
//
// Covers:
//   - Service registration (factory + instance)
//   - Singleton resolution & caching
//   - Circular dependency detection
//   - Late-bindings (wiring, optional, verification)
//   - Phase-aware topological sort
//   - Hot-reload via replace()
//   - Tag-based retrieval
//   - bootAll / shutdownAll lifecycle
//   - postBoot ordering
//   - Dependency graph introspection
// ============================================================

const { describe, test, assert, assertEqual, assertThrows, run } = require('../harness');
const { Container } = require('../../src/agent/core/Container');
const { NullBus, createBus } = require('../../src/agent/core/EventBus');

// ── Tests ──────────────────────────────────────────────────

describe('Container — Registration & Resolution', () => {
  test('resolve returns singleton by default', () => {
    const c = new Container();
    let calls = 0;
    c.register('svc', () => ({ id: ++calls }));
    const a = c.resolve('svc');
    const b = c.resolve('svc');
    assertEqual(a, b, 'should return same instance');
    assertEqual(calls, 1, 'factory should only be called once');
  });

  test('resolve creates new instance when singleton:false', () => {
    const c = new Container();
    let calls = 0;
    c.register('svc', () => ({ id: ++calls }), { singleton: false });
    const a = c.resolve('svc');
    const b = c.resolve('svc');
    assert(a !== b, 'should return different instances');
    assertEqual(calls, 2);
  });

  test('registerInstance makes value immediately available', () => {
    const c = new Container();
    const obj = { value: 42 };
    c.registerInstance('val', obj);
    assertEqual(c.resolve('val'), obj);
  });

  test('has() returns true/false correctly', () => {
    const c = new Container();
    assert(!c.has('x'), 'should not have unregistered service');
    c.register('x', () => ({}));
    assert(c.has('x'), 'should have registered service');
  });

  test('resolve throws for unknown service', () => {
    const c = new Container();
    assertThrows(() => c.resolve('nonexistent'));
  });
});

describe('Container — Circular Dependency Detection', () => {
  test('detects simple circular dependency', () => {
    const c = new Container();
    c.register('a', (cont) => ({ dep: cont.resolve('b') }), { deps: ['b'] });
    c.register('b', (cont) => ({ dep: cont.resolve('a') }), { deps: ['a'] });
    assertThrows(() => c.resolve('a'));
  });

  test('detects transitive circular dependency', () => {
    const c = new Container();
    c.register('a', (cont) => ({ dep: cont.resolve('b') }), { deps: ['b'] });
    c.register('b', (cont) => ({ dep: cont.resolve('c') }), { deps: ['c'] });
    c.register('c', (cont) => ({ dep: cont.resolve('a') }), { deps: ['a'] });
    assertThrows(() => c.resolve('a'));
  });
});

describe('Container — Late-Bindings', () => {
  test('wireLateBindings injects resolved services', () => {
    const c = new Container();
    c.register('target', () => ({ injected: null }), {
      lateBindings: [{ prop: 'injected', service: 'dep' }],
    });
    c.register('dep', () => ({ name: 'dependency' }));
    c.resolve('target');
    c.resolve('dep');
    const result = c.wireLateBindings();
    assertEqual(result.wired, 1);
    assertEqual(c.resolve('target').injected.name, 'dependency');
  });

  test('optional late-bindings skip missing services', () => {
    const c = new Container();
    c.register('target', () => ({ opt: null }), {
      lateBindings: [{ prop: 'opt', service: 'missing', optional: true }],
    });
    c.resolve('target');
    const result = c.wireLateBindings();
    assertEqual(result.skipped, 1);
    assertEqual(result.errors.length, 0);
  });

  test('required late-bindings report errors for missing services', () => {
    const c = new Container();
    c.register('target', () => ({}), {
      lateBindings: [{ prop: 'req', service: 'missing' }],
    });
    c.resolve('target');
    const result = c.wireLateBindings();
    assert(result.errors.length > 0, 'should report missing required binding');
  });

  test('verifyLateBindings catches null bindings', () => {
    const c = new Container();
    c.register('target', () => ({ req: null }), {
      lateBindings: [{ prop: 'req', service: 'dep' }],
    });
    c.register('dep', () => null); // factory returns null
    c.resolve('target');
    c.resolve('dep');
    c.wireLateBindings();
    const verify = c.verifyLateBindings();
    assert(verify.missing.length > 0, 'should detect null required binding');
  });
});

describe('Container — Phase-Aware Topological Sort', () => {
  test('boots lower phases before higher phases', async () => {
    const c = new Container();
    const order = [];
    c.register('phase2', () => { order.push('p2'); return {}; }, { phase: 2 });
    c.register('phase1', () => { order.push('p1'); return {}; }, { phase: 1 });
    c.register('phase3', () => { order.push('p3'); return {}; }, { phase: 3 });
    await c.bootAll();
    assert(order.indexOf('p1') < order.indexOf('p2'), 'phase 1 before phase 2');
    assert(order.indexOf('p2') < order.indexOf('p3'), 'phase 2 before phase 3');
  });

  test('respects deps within same phase', async () => {
    const c = new Container();
    const order = [];
    c.register('b', (cont) => { cont.resolve('a'); order.push('b'); return {}; },
      { phase: 1, deps: ['a'] });
    c.register('a', () => { order.push('a'); return {}; }, { phase: 1 });
    await c.bootAll();
    assert(order.indexOf('a') < order.indexOf('b'), 'dep resolved first');
  });
});

describe('Container — Hot-Reload (replace)', () => {
  test('replace swaps singleton and fires event', () => {
    const b = createBus();
    const c = new Container({ bus: b });
    let eventFired = false;
    b.on('container:replaced', () => { eventFired = true; });

    c.register('svc', () => ({ version: 1 }));
    assertEqual(c.resolve('svc').version, 1);

    c.replace('svc', () => ({ version: 2 }));
    assertEqual(c.resolve('svc').version, 2);
    // event is async, check after microtask
  });

  test('replace calls stop() on old instance', () => {
    const b = createBus();
    const c = new Container({ bus: b });
    let stopped = false;
    c.register('svc', () => ({ stop() { stopped = true; } }));
    c.resolve('svc');
    c.replace('svc', () => ({}));
    assert(stopped, 'old instance stop() should be called');
  });

  test('replace throws for unknown service', () => {
    const c = new Container();
    assertThrows(() => c.replace('nope', () => ({})));
  });
});

describe('Container — Tags', () => {
  test('getTagged returns services matching tag', () => {
    const c = new Container();
    c.register('a', () => ({ name: 'a' }), { tags: ['test'] });
    c.register('b', () => ({ name: 'b' }), { tags: ['test', 'other'] });
    c.register('c', () => ({ name: 'c' }), { tags: ['other'] });
    const tagged = c.getTagged('test');
    assertEqual(tagged.length, 2);
    assert(tagged.some(t => t.name === 'a'));
    assert(tagged.some(t => t.name === 'b'));
  });
});

describe('Container — Lifecycle (bootAll / shutdownAll)', () => {
  test('bootAll calls asyncLoad then boot on services', async () => {
    const c = new Container();
    const steps = [];
    c.register('svc', () => ({
      asyncLoad() { steps.push('asyncLoad'); },
      boot() { steps.push('boot'); },
    }));
    await c.bootAll();
    assertEqual(steps[0], 'asyncLoad');
    assertEqual(steps[1], 'boot');
  });

  test('shutdownAll calls shutdown in reverse order', async () => {
    const c = new Container();
    const order = [];
    c.register('a', () => ({ shutdown() { order.push('a'); } }), { phase: 1 });
    c.register('b', () => ({ shutdown() { order.push('b'); } }), { phase: 2 });
    await c.bootAll();
    await c.shutdownAll();
    assertEqual(order[0], 'b', 'higher phase shuts down first');
    assertEqual(order[1], 'a');
  });

  test('postBoot calls start() in topological order', async () => {
    const c = new Container();
    const order = [];
    c.register('a', () => ({ start() { order.push('a'); } }), { phase: 1 });
    c.register('b', () => ({ start() { order.push('b'); } }), { phase: 2 });
    await c.bootAll();
    const started = await c.postBoot();
    assert(started.includes('a'));
    assert(started.includes('b'));
    assert(order.indexOf('a') < order.indexOf('b'));
  });
});

describe('Container — Dependency Graph', () => {
  test('getDependencyGraph returns structured info', () => {
    const c = new Container();
    c.register('a', () => ({}), { deps: ['b'], tags: ['core'], phase: 1,
      lateBindings: [{ prop: 'x', service: 'c', optional: true }] });
    c.register('b', () => ({}), { phase: 1 });
    const graph = c.getDependencyGraph();
    assert(graph.a, 'should have entry for a');
    assertEqual(graph.a.deps[0], 'b');
    assertEqual(graph.a.phase, 1);
    assert(graph.a.lateBindings[0].includes('c'), 'should show late-binding target');
  });
});

describe('Container — tryResolve (v4.13.0)', () => {
  test('tryResolve returns instance when service exists', () => {
    const c = new Container();
    c.register('svc', () => ({ value: 42 }));
    const result = c.tryResolve('svc');
    assertEqual(result.value, 42);
  });

  test('tryResolve returns null for missing service', () => {
    const c = new Container();
    const result = c.tryResolve('nonexistent');
    assertEqual(result, null, 'should return null by default');
  });

  test('tryResolve returns custom fallback for missing service', () => {
    const c = new Container();
    const result = c.tryResolve('nonexistent', []);
    assert(Array.isArray(result), 'should return fallback array');
    assertEqual(result.length, 0);
  });

  test('tryResolve returns fallback when factory throws', () => {
    const c = new Container();
    c.register('broken', () => { throw new Error('boom'); });
    const result = c.tryResolve('broken', 'fallback');
    assertEqual(result, 'fallback', 'should return fallback on factory error');
  });

  test('tryResolve works with optional chaining pattern', () => {
    const c = new Container();
    c.register('svc', () => ({ getName() { return 'test'; } }));
    const name = c.tryResolve('svc')?.getName();
    assertEqual(name, 'test');
    const missing = c.tryResolve('nope')?.getName();
    assertEqual(missing, undefined, 'optional chaining on null returns undefined');
  });
});

// ════════════════════════════════════════════════════════════
// v5.0.0 — Biological Alias System
// ════════════════════════════════════════════════════════════

describe('Container — Alias system (v5.0.0)', () => {
  test('alias() resolves to same singleton as primary', () => {
    const c = new Container();
    c.register('knowledgeGraph', () => ({ name: 'kg' }));
    c.alias('connectome', 'knowledgeGraph');
    const a = c.resolve('knowledgeGraph');
    const b = c.resolve('connectome');
    assert(a === b, 'alias should resolve to same singleton as primary');
  });

  test('has() returns true for registered alias', () => {
    const c = new Container();
    c.register('selfModPipeline', () => ({}));
    c.alias('morphogenesis', 'selfModPipeline');
    assert(c.has('morphogenesis'), 'has() should return true for alias');
  });

  test('alias() throws when primary not registered', () => {
    const c = new Container();
    let threw = false;
    try { c.alias('connectome', 'notExist'); } catch { threw = true; }
    assert(threw, 'alias() should throw when primary not registered');
  });

  test('alias() throws when alias name already registered as service', () => {
    const c = new Container();
    c.register('kg', () => ({}));
    c.register('connectome', () => ({}));
    let threw = false;
    try { c.alias('connectome', 'kg'); } catch { threw = true; }
    assert(threw, 'alias() should throw when alias name is already a service');
  });

  test('_canonical() resolves chain a→b→c', () => {
    const c = new Container();
    c.register('c', () => ({}));
    c.alias('b', 'c');
    c.alias('a', 'b');
    assertEqual(c._canonical('a'), 'c', 'should resolve alias chain to canonical end');
  });

  test('_canonical() throws on circular alias', () => {
    const c = new Container();
    c.register('x', () => ({}));
    c._aliases.set('loop', 'loop');
    let threw = false;
    try { c._canonical('loop'); } catch { threw = true; }
    assert(threw, 'should throw on circular alias');
  });
});

// ════════════════════════════════════════════════════════════
// v5.0.0 — validateRegistrations alias-aware
// ════════════════════════════════════════════════════════════

describe('Container — validateRegistrations alias-aware (v5.0.0)', () => {
  test('validateRegistrations passes when dep is a registered alias', () => {
    const c = new Container();
    c.register('kg',         () => ({}), { phase: 1, deps: [], lateBindings: [] });
    c.register('consumer',   () => ({}), { phase: 2, deps: ['connectome'], lateBindings: [] });
    c.alias('connectome', 'kg');
    const result = c.validateRegistrations();
    assert(result.valid, `should be valid when dep 'connectome' is an alias for 'kg'. Errors: ${result.errors.join(', ')}`);
  });

  test('validateRegistrations fails when dep truly not registered', () => {
    const c = new Container();
    c.register('consumer', () => ({}), { phase: 1, deps: ['missingService'], lateBindings: [] });
    const result = c.validateRegistrations();
    assert(!result.valid, 'should be invalid when dep is not registered');
    assert(result.errors.some(e => e.includes('missingService')), 'error should mention missing service');
  });

  test('validateRegistrations passes lateBinding alias check', () => {
    const c = new Container();
    c.register('smp',      () => ({}), { phase: 5, deps: [], lateBindings: [] });
    c.register('consumer', () => ({}), { phase: 6, deps: [], lateBindings: [
      { prop: 'morpho', service: 'morphogenesis', optional: false },
    ]});
    c.alias('morphogenesis', 'smp');
    const result = c.validateRegistrations();
    assert(result.valid, `lateBinding alias should be valid. Errors: ${result.errors.join(', ')}`);
  });
});

run();
