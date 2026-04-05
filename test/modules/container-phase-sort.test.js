// ============================================================
// TEST: Container — Phase-Aware Topological Sort (F-11)
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');

describe('Container — Phase-Aware Sort (v4.0.0)', () => {
  const { Container } = require('../../src/agent/core/Container');

  test('services boot in phase order', () => {
    const c = new Container();
    c.register('phase8svc', () => ({ name: 'p8' }), { phase: 8, deps: [] });
    c.register('phase1svc', () => ({ name: 'p1' }), { phase: 1, deps: [] });
    c.register('phase3svc', () => ({ name: 'p3' }), { phase: 3, deps: [] });
    c.register('phase0svc', () => ({ name: 'p0' }), { phase: 0, deps: [] });

    const order = c._topologicalSort();
    const p0idx = order.indexOf('phase0svc');
    const p1idx = order.indexOf('phase1svc');
    const p3idx = order.indexOf('phase3svc');
    const p8idx = order.indexOf('phase8svc');

    assert(p0idx < p1idx, `phase0 (${p0idx}) should come before phase1 (${p1idx})`);
    assert(p1idx < p3idx, `phase1 (${p1idx}) should come before phase3 (${p3idx})`);
    assert(p3idx < p8idx, `phase3 (${p3idx}) should come before phase8 (${p8idx})`);
  });

  test('deps within same phase are still respected', () => {
    const c = new Container();
    c.register('b', () => ({ name: 'b' }), { phase: 2, deps: ['a'] });
    c.register('a', () => ({ name: 'a' }), { phase: 2, deps: [] });

    const order = c._topologicalSort();
    assert(order.indexOf('a') < order.indexOf('b'), 'a should come before b (dep)');
  });

  test('cross-phase deps still resolve correctly', () => {
    const c = new Container();
    c.register('high', () => ({ name: 'high' }), { phase: 5, deps: ['low'] });
    c.register('low', () => ({ name: 'low' }), { phase: 1, deps: [] });

    const order = c._topologicalSort();
    assert(order.indexOf('low') < order.indexOf('high'), 'low-phase dep should resolve first');
  });

  test('all registered services appear in sort output', () => {
    const c = new Container();
    for (let i = 0; i < 10; i++) {
      c.register(`svc${i}`, () => ({}), { phase: i % 4, deps: [] });
    }
    const order = c._topologicalSort();
    assertEqual(order.length, 10);
  });
});

run();
