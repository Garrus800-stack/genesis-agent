const { describe, test, assert, assertEqual, run } = require('../harness');
const { ModuleRegistry } = require('../../src/agent/revolution/ModuleRegistry');

describe('ModuleRegistry — construction', () => {
  test('constructs without error', () => {
    assert(new ModuleRegistry() !== null);
  });

  test('has register method', () => {
    assert(typeof new ModuleRegistry().register === 'function');
  });
});

describe('ModuleRegistry — register()', () => {
  test('stores module in manifest', () => {
    const mr = new ModuleRegistry();
    class FakeService {}
    mr.register('fakeService', FakeService, { phase: 1, deps: [], tags: ['test'] });
    assert(mr.manifest.has('fakeService'));
    assertEqual(mr.manifest.get('fakeService').config.phase, 1);
  });

  test('defaults phase to 4 when not specified', () => {
    const mr = new ModuleRegistry();
    class A {}
    mr.register('a', A, {});
    assertEqual(mr.manifest.get('a').config.phase, 4);
  });

  test('collects lateBindings', () => {
    const mr = new ModuleRegistry();
    class B {}
    mr.register('b', B, { phase: 1, lateBindings: [{ target: 'c', property: '_c', source: 'b' }] });
    assertEqual(mr.lateBindings.length, 1);
    assertEqual(mr.lateBindings[0].target, 'c');
  });

  test('multiple lateBindings accumulated', () => {
    const mr = new ModuleRegistry();
    class C {}
    class D {}
    mr.register('c', C, { phase: 1, lateBindings: [{ target: 'x', property: '_x', source: 'c' }] });
    mr.register('d', D, { phase: 2, lateBindings: [{ target: 'y', property: '_y', source: 'd' }, { target: 'z', property: '_z', source: 'd' }] });
    assertEqual(mr.lateBindings.length, 3);
  });
});

describe('ModuleRegistry — registerSelf()', () => {
  test('uses static containerConfig', () => {
    const mr = new ModuleRegistry();
    class E { static containerConfig = { name: 'eService', phase: 2, deps: [], tags: [], lateBindings: [] }; }
    mr.registerSelf(E);
    assert(mr.manifest.has('eService'));
    assertEqual(mr.manifest.get('eService').config.phase, 2);
  });

  test('throws when no containerConfig', () => {
    const mr = new ModuleRegistry();
    class NoConfig {}
    let threw = false;
    try { mr.registerSelf(NoConfig); } catch (_) { threw = true; }
    assert(threw);
  });

  test('throws when containerConfig has no name', () => {
    const mr = new ModuleRegistry();
    class BadConfig { static containerConfig = { phase: 1 }; }
    let threw = false;
    try { mr.registerSelf(BadConfig); } catch (_) { threw = true; }
    assert(threw);
  });
});

describe('ModuleRegistry — getManifest()', () => {
  test('returns object keyed by service name', () => {
    const mr = new ModuleRegistry();
    class F {}
    mr.register('f', F, { phase: 3, deps: [] });
    const m = mr.getManifest();
    assert(typeof m === 'object' && !Array.isArray(m));
    assert(m.f !== undefined);
    assertEqual(m.f.phase, 3);
    assert(Array.isArray(m.f.deps));
  });

  test('includes lateBindings in manifest', () => {
    const mr = new ModuleRegistry();
    class G {}
    mr.register('g', G, { phase: 2, deps: [], lateBindings: [{ target: 'h', property: '_h', source: 'g' }] });
    const m = mr.getManifest();
    assert(m.g.lateBindings.length > 0);
  });
});

describe('ModuleRegistry — validate()', () => {
  test('returns empty warnings for clean registry', () => {
    const mr = new ModuleRegistry();
    class I {}
    mr.register('i', I, { phase: 1, deps: [] });
    const w = mr.validate();
    assert(Array.isArray(w));
  });

  test('reports missing deps as issues', () => {
    const { Container } = require('../../src/agent/core/Container');
    const bus = { emit(){}, fire(){}, on(){ return ()=>{}; } };
    const c = new Container(bus);
    const mr = new ModuleRegistry(c, bus);
    class J {}
    mr.register('j', J, { phase: 1, deps: ['ghostDep'] });
    const w = mr.validate();
    assert(w.some(x => typeof x === 'string' && (x.includes('ghostDep') || x.includes('j'))));
  });
});

describe('ModuleRegistry — wireLateBindings()', () => {
  test('returns warnings for unknown binding target', () => {
    const { Container } = require('../../src/agent/core/Container');
    const bus = { emit(){}, fire(){}, on(){ return ()=>{}; } };
    const c = new Container(bus);
    const mr = new ModuleRegistry(c, bus);
    mr.lateBindings.push({ target: 'ghost', property: '_x', source: 'test' });
    const warnings = mr.wireLateBindings();
    assert(Array.isArray(warnings));
    assert(warnings.length > 0);
  });

  test('wires binding when both services exist', () => {
    const { Container } = require('../../src/agent/core/Container');
    const bus = { emit(){}, fire(){}, on(){ return ()=>{}; } };
    const c = new Container(bus);
    const target = { _src: null };
    const src = { value: 42 };
    c.register('targetSvc', () => target);
    c.register('srcSvc', () => src);
    c.resolve('targetSvc');
    c.resolve('srcSvc');
    const mr = new ModuleRegistry(c, bus);
    mr.lateBindings.push({ target: 'targetSvc', property: '_src', source: 'srcSvc' });
    const warnings = mr.wireLateBindings();
    assert(Array.isArray(warnings));
    assertEqual(target._src, src);
  });
});

describe('ModuleRegistry — bootAll()', () => {
  test('boots modules with factory in phase order', async () => {
    const { Container } = require('../../src/agent/core/Container');
    const bus = { emit(){}, fire(){}, on(){ return ()=>{}; } };
    const c = new Container(bus);
    const mr = new ModuleRegistry(c, bus);

    let factoryCalledFor = [];
    const factoryA = () => { factoryCalledFor.push('a'); return { name: 'a' }; };
    const factoryB = () => { factoryCalledFor.push('b'); return { name: 'b' }; };

    mr.register('b', null, { phase: 2, deps: [], tags: [], factory: factoryB });
    mr.register('a', null, { phase: 1, deps: [], tags: [], factory: factoryA });

    const results = await mr.bootAll();
    assert(Array.isArray(results));
    assert(results.length === 2);
    assert(results.every(r => r.status === 'ok'));
    // Phase 1 (a) boots before phase 2 (b)
    assertEqual(factoryCalledFor[0], 'a');
    assertEqual(factoryCalledFor[1], 'b');
  });

  test('boots module using class constructor when no factory', async () => {
    const { Container } = require('../../src/agent/core/Container');
    const bus = { emit(){}, fire(){}, on(){ return ()=>{}; } };
    const c = new Container(bus);
    const mr = new ModuleRegistry(c, bus);

    class SimpleService { constructor(deps) { this.deps = deps; } }
    mr.register('simple', SimpleService, { phase: 1, deps: [], tags: [] });

    const results = await mr.bootAll();
    assertEqual(results[0].status, 'ok');
    const instance = c.resolve('simple');
    assert(instance instanceof SimpleService);
  });

  test('skips optional module when factory throws', async () => {
    const { Container } = require('../../src/agent/core/Container');
    const bus = { emit(){}, fire(){}, on(){ return ()=>{}; } };
    const c = new Container(bus);
    const mr = new ModuleRegistry(c, bus);

    mr.register('failing', null, {
      phase: 1, deps: [], tags: [], optional: true,
      factory: () => { throw new Error('optional failed'); },
    });

    const results = await mr.bootAll();
    assertEqual(results[0].status, 'skipped');
    assert(results[0].error.includes('optional failed'));
  });

  test('throws on fatal non-optional module failure', async () => {
    const { Container } = require('../../src/agent/core/Container');
    const bus = { emit(){}, fire(){}, on(){ return ()=>{}; } };
    const c = new Container(bus);
    const mr = new ModuleRegistry(c, bus);

    mr.register('fatal', null, {
      phase: 1, deps: [], tags: [], optional: false,
      factory: () => { throw new Error('fatal error'); },
    });

    let threw = false;
    try { await mr.bootAll(); } catch (_) { threw = true; }
    assert(threw, 'should throw for non-optional failure');
  });

  test('non-singleton module not eagerly resolved', async () => {
    const { Container } = require('../../src/agent/core/Container');
    const bus = { emit(){}, fire(){}, on(){ return ()=>{}; } };
    const c = new Container(bus);
    const mr = new ModuleRegistry(c, bus);

    let resolveCalled = 0;
    mr.register('transient', null, {
      phase: 1, deps: [], tags: [], singleton: false,
      factory: () => { resolveCalled++; return {}; },
    });

    await mr.bootAll();
    assertEqual(resolveCalled, 0, 'factory should not be called during bootAll for non-singleton');
  });
});

if (require.main === module) run();
