// ============================================================
// Test: Container.js — DI container, boot order, circular detection
// ============================================================
let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  // v3.5.2: Fixed — try/catch around fn() for sync errors
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

const { Container } = require('../../src/agent/core/Container');

console.log('\n  📦 Container (DI)');

test('register and resolve a service', () => {
  const c = new Container();
  c.register('foo', () => ({ name: 'foo-service' }));
  const foo = c.resolve('foo');
  assert(foo.name === 'foo-service');
});

test('singleton by default (same instance on re-resolve)', () => {
  const c = new Container();
  let callCount = 0;
  c.register('counter', () => ({ id: ++callCount }));
  const a = c.resolve('counter');
  const b = c.resolve('counter');
  assert(a === b, 'Should return same instance');
  assert(callCount === 1, 'Factory should only be called once');
});

test('registerInstance stores pre-built instance', () => {
  const c = new Container();
  const obj = { x: 42 };
  c.registerInstance('obj', obj);
  assert(c.resolve('obj') === obj);
  assert(c.resolve('obj').x === 42);
});

test('has() checks registration', () => {
  const c = new Container();
  assert(!c.has('nope'));
  c.register('yes', () => 'y');
  assert(c.has('yes'));
});

test('throws on unregistered service', () => {
  const c = new Container();
  let threw = false;
  try { c.resolve('missing'); }
  catch (e) { threw = true; assert(e.message.includes('missing')); }
  assert(threw, 'Should throw for missing service');
});

test('detects circular dependencies', () => {
  const c = new Container();
  c.register('a', (ct) => ct.resolve('b'));
  c.register('b', (ct) => ct.resolve('a'));
  let threw = false;
  try { c.resolve('a'); }
  catch (e) { threw = true; assert(e.message.includes('Circular')); }
  assert(threw, 'Should detect circular dependency');
});

test('factory receives container for dependency injection', () => {
  const c = new Container();
  c.register('db', () => ({ query: () => 'data' }));
  c.register('repo', (ct) => ({ fetch: () => ct.resolve('db').query() }));
  assert(c.resolve('repo').fetch() === 'data');
});

test('replace swaps singleton', () => {
  const c = new Container();
  c.register('svc', () => ({ version: 1 }));
  assert(c.resolve('svc').version === 1);
  c.replace('svc', () => ({ version: 2 }));
  assert(c.resolve('svc').version === 2);
});

test('replace throws for unknown service', () => {
  const c = new Container();
  let threw = false;
  try { c.replace('ghost', () => 'x'); }
  catch { threw = true; }
  assert(threw);
});

test('getTagged returns services with matching tag', () => {
  const c = new Container();
  c.register('a', () => 'A', { tags: ['fast'] });
  c.register('b', () => 'B', { tags: ['slow'] });
  c.register('c', () => 'C', { tags: ['fast'] });
  const fast = c.getTagged('fast');
  assert(fast.length === 2, `Expected 2 fast services, got ${fast.length}`);
  assert(fast.some(s => s.name === 'a'));
  assert(fast.some(s => s.name === 'c'));
});

test('getDependencyGraph returns all services', () => {
  const c = new Container();
  c.register('x', () => 1, { deps: ['y'], tags: ['core'] });
  c.register('y', () => 2);
  const graph = c.getDependencyGraph();
  assert(graph.x.deps.includes('y'));
  assert(graph.x.tags.includes('core'));
  assert(graph.x.singleton === true);
  assert(graph.y !== undefined);
});

test('topological sort respects dependencies', () => {
  const c = new Container();
  c.register('db', () => 'db', { deps: [] });
  c.register('cache', () => 'cache', { deps: ['db'] });
  c.register('api', () => 'api', { deps: ['cache', 'db'] });
  const order = c._topologicalSort();
  assert(order.indexOf('db') < order.indexOf('cache'), 'db should boot before cache');
  assert(order.indexOf('cache') < order.indexOf('api'), 'cache should boot before api');
});

// Async tests
async function runAsync() {
  await test('bootAll resolves singletons and calls boot()', async () => {
    const c = new Container();
    const log = [];
    c.register('svc1', () => ({ boot: async () => log.push('svc1') }));
    c.register('svc2', () => ({ boot: async () => log.push('svc2') }), { deps: ['svc1'] });
    const results = await c.bootAll();
    assert(results.length === 2);
    assert(results.every(r => r.status === 'ok'), 'All should succeed');
    assert(log[0] === 'svc1', 'svc1 should boot first');
    assert(log[1] === 'svc2', 'svc2 should boot second');
  });

  await test('bootAll handles boot errors gracefully', async () => {
    const c = new Container();
    c.register('good', () => ({ boot: async () => {} }));
    c.register('bad', () => ({ boot: async () => { throw new Error('boom'); } }));
    const results = await c.bootAll();
    const badResult = results.find(r => r.name === 'bad');
    assert(badResult.status === 'error');
    assert(badResult.error.includes('boom'));
  });

  await test('shutdownAll calls shutdown in reverse order', async () => {
    const c = new Container();
    const log = [];
    c.register('first', () => ({ boot: async () => {}, shutdown: async () => log.push('first') }));
    c.register('second', () => ({ boot: async () => {}, shutdown: async () => log.push('second') }), { deps: ['first'] });
    await c.bootAll();
    await c.shutdownAll();
    assert(log[0] === 'second', 'second should shutdown first (reverse order)');
    assert(log[1] === 'first');
  });
}

runAsync().then(() => {
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failures.length > 0) failures.forEach(f => console.log(`    FAIL: ${f.name} — ${f.error}`));
  process.exit(failed > 0 ? 1 : 0);
});
