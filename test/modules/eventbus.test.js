// ============================================================
// Test: EventBus.js — pub/sub, wildcards, middleware, history
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

const { EventBus } = require('../../src/agent/core/EventBus');

// Disable dev-mode event validation for tests (test events like 'test', 'ping' etc. are not in EventTypes catalog)
const _createBus = () => { const b = new EventBus(); b._devMode = false; return b; };

console.log('\n  📦 EventBus');

async function runAsync() {
  await test('on/emit delivers data to handler', async () => {
    const bus = _createBus();
    let received = null;
    bus.on('test', (data) => { received = data; });
    await bus.emit('test', { x: 1 });
    assert(received !== null);
    assert(received.x === 1);
  });

  await test('once fires only once', async () => {
    const bus = _createBus();
    let count = 0;
    bus.once('ping', () => { count++; });
    await bus.emit('ping');
    await bus.emit('ping');
    assert(count === 1, `Expected 1, got ${count}`);
  });

  await test('unsubscribe function works', async () => {
    const bus = _createBus();
    let count = 0;
    const unsub = bus.on('evt', () => { count++; });
    await bus.emit('evt');
    unsub();
    await bus.emit('evt');
    assert(count === 1, `Expected 1, got ${count}`);
  });

  await test('wildcard matching (agent:*)', async () => {
    const bus = _createBus();
    const received = [];
    bus.on('agent:*', (data) => { received.push(data); });
    await bus.emit('agent:chat', { msg: 'hi' });
    await bus.emit('agent:repair', { msg: 'fix' });
    await bus.emit('other:event', { msg: 'skip' });
    assert(received.length === 2, `Expected 2, got ${received.length}`);
  });

  await test('priority ordering (higher first)', async () => {
    const bus = _createBus();
    const order = [];
    bus.on('pri', () => order.push('low'), { priority: 1 });
    bus.on('pri', () => order.push('high'), { priority: 10 });
    bus.on('pri', () => order.push('mid'), { priority: 5 });
    await bus.emit('pri');
    assert(order[0] === 'high', `Expected high first, got ${order[0]}`);
    assert(order[1] === 'mid');
    assert(order[2] === 'low');
  });

  await test('middleware can block events', async () => {
    const bus = _createBus();
    let received = false;
    bus.use((event) => { if (event === 'blocked') return false; });
    bus.on('blocked', () => { received = true; });
    await bus.emit('blocked');
    assert(!received, 'Handler should not have been called');
  });

  await test('middleware can transform data', async () => {
    const bus = _createBus();
    let received = null;
    bus.use((event, data) => ({ ...data, extra: true }));
    bus.on('transform', (data) => { received = data; });
    await bus.emit('transform', { original: true });
    assert(received.original === true);
    assert(received.extra === true);
  });

  await test('pause/resume blocks and resumes events', async () => {
    const bus = _createBus();
    let count = 0;
    bus.on('p', () => { count++; });
    bus.pause('p');
    await bus.emit('p');
    assert(count === 0, 'Should be blocked');
    bus.resume('p');
    await bus.emit('p');
    assert(count === 1, `Expected 1, got ${count}`);
  });

  await test('request returns first non-null result', async () => {
    const bus = _createBus();
    bus.on('query', () => null);
    bus.on('query', () => ({ answer: 42 }));
    bus.on('query', () => ({ answer: 99 }));
    const result = await bus.request('query');
    assert(result.answer === 42, `Expected 42, got ${result?.answer}`);
  });

  await test('removeBySource cleans up handlers', async () => {
    const bus = _createBus();
    let count = 0;
    bus.on('x', () => { count++; }, { source: 'moduleA' });
    bus.on('x', () => { count++; }, { source: 'moduleB' });
    const removed = bus.removeBySource('moduleA');
    assert(removed === 1, `Expected 1 removed, got ${removed}`);
    await bus.emit('x');
    assert(count === 1, 'Only moduleB handler should fire');
  });

  await test('getHistory records emissions', async () => {
    const bus = _createBus();
    await bus.emit('h1', { a: 1 });
    await bus.emit('h2', { b: 2 });
    const history = bus.getHistory();
    assert(history.length >= 2);
    assert(history.some(h => h.event === 'h1'));
    assert(history.some(h => h.event === 'h2'));
  });

  await test('getStats tracks emit counts', async () => {
    const bus = _createBus();
    await bus.emit('counted', {});
    await bus.emit('counted', {});
    await bus.emit('counted', {});
    const stats = bus.getStats();
    assert(stats.counted.emitCount === 3, `Expected 3, got ${stats.counted?.emitCount}`);
  });

  await test('getRegisteredEvents lists all events', async () => {
    const bus = _createBus();
    bus.on('alpha', () => {});
    bus.on('beta', () => {});
    const events = bus.getRegisteredEvents();
    assert(events.includes('alpha'));
    assert(events.includes('beta'));
  });

  await test('handler errors do not crash other handlers', async () => {
    const bus = _createBus();
    let secondRan = false;
    bus.on('err', () => { throw new Error('handler crash'); });
    bus.on('err', () => { secondRan = true; });
    await bus.emit('err');
    assert(secondRan, 'Second handler should still run');
  });

  await test('history limit is respected', async () => {
    const bus = _createBus();
    bus.historyLimit = 5;
    for (let i = 0; i < 10; i++) await bus.emit(`evt-${i}`);
    assert(bus.history.length <= 5, `Expected <=5 history entries, got ${bus.history.length}`);
  });
}

runAsync().then(() => {
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failures.length > 0) failures.forEach(f => console.log(`    FAIL: ${f.name} — ${f.error}`));
  process.exit(failed > 0 ? 1 : 0);
});
