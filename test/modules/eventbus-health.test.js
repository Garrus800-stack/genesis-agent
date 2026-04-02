// ============================================================
// Test: EventBus.getListenerReport() — v3.8.0
// Listener health monitoring and leak detection.
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const { EventBus, NullBus } = require('../../src/agent/core/EventBus');

describe('EventBus: getListenerReport', () => {

  test('empty bus returns zero totals', () => {
    const bus = new EventBus();
    const report = bus.getListenerReport();
    assertEqual(report.total, 0);
    assertEqual(report.events, 0);
    assertEqual(report.suspects.length, 0);
  });

  test('counts listeners across events', () => {
    const bus = new EventBus();
    bus.on('a', () => {}, { source: 'test' });
    bus.on('a', () => {}, { source: 'test' });
    bus.on('b', () => {}, { source: 'other' });

    const report = bus.getListenerReport();
    assertEqual(report.total, 3);
    assertEqual(report.events, 2);
    assertEqual(report.breakdown['a'].count, 2);
    assertEqual(report.breakdown['b'].count, 1);
  });

  test('source breakdown is correct', () => {
    const bus = new EventBus();
    bus.on('x', () => {}, { source: 'moduleA' });
    bus.on('x', () => {}, { source: 'moduleA' });
    bus.on('x', () => {}, { source: 'moduleB' });

    const report = bus.getListenerReport();
    assertEqual(report.breakdown['x'].sources['moduleA'], 2);
    assertEqual(report.breakdown['x'].sources['moduleB'], 1);
  });

  test('flags suspects above threshold', () => {
    const bus = new EventBus();
    for (let i = 0; i < 15; i++) {
      bus.on('crowded', () => {}, { source: `src-${i}` });
    }
    bus.on('normal', () => {}, { source: 'ok' });

    const report = bus.getListenerReport({ warnThreshold: 10 });
    assertEqual(report.suspects.length, 1);
    assertEqual(report.suspects[0].event, 'crowded');
    assertEqual(report.suspects[0].count, 15);
  });

  test('no suspects when below threshold', () => {
    const bus = new EventBus();
    for (let i = 0; i < 5; i++) {
      bus.on('fine', () => {}, { source: 'ok' });
    }
    const report = bus.getListenerReport({ warnThreshold: 10 });
    assertEqual(report.suspects.length, 0);
  });

  test('respects custom warnThreshold', () => {
    const bus = new EventBus();
    bus.on('a', () => {}, { source: 'x' });
    bus.on('a', () => {}, { source: 'y' });
    bus.on('a', () => {}, { source: 'z' });

    const strict = bus.getListenerReport({ warnThreshold: 2 });
    assertEqual(strict.suspects.length, 1);

    const relaxed = bus.getListenerReport({ warnThreshold: 5 });
    assertEqual(relaxed.suspects.length, 0);
  });

  test('unsubscribed listeners do not appear in report', () => {
    const bus = new EventBus();
    const unsub1 = bus.on('temp', () => {}, { source: 'a' });
    const unsub2 = bus.on('temp', () => {}, { source: 'b' });
    bus.on('temp', () => {}, { source: 'c' });

    unsub1();
    unsub2();

    const report = bus.getListenerReport();
    assertEqual(report.total, 1);
    assertEqual(report.breakdown['temp'].count, 1);
    assertEqual(report.breakdown['temp'].sources['c'], 1);
  });

  test('removeBySource cleans up in report', () => {
    const bus = new EventBus();
    bus.on('e1', () => {}, { source: 'moduleX' });
    bus.on('e1', () => {}, { source: 'moduleX' });
    bus.on('e1', () => {}, { source: 'moduleY' });
    bus.on('e2', () => {}, { source: 'moduleX' });

    bus.removeBySource('moduleX');

    const report = bus.getListenerReport();
    assertEqual(report.total, 1, 'Only moduleY listener should remain');
    assertEqual(report.breakdown['e1'].count, 1);
    assertEqual(report.breakdown['e1'].sources['moduleY'], 1);
    assert(!report.breakdown['e2'], 'e2 had only moduleX listeners — should be gone');
  });

  test('wildcard listeners appear in report', () => {
    const bus = new EventBus();
    bus.on('agent:*', () => {}, { source: 'watcher' });
    bus.on('agent:status', () => {}, { source: 'ui' });

    const report = bus.getListenerReport();
    assertEqual(report.total, 2);
    assert(report.breakdown['agent:*'], 'Wildcard should appear in breakdown');
  });

  test('NullBus.getListenerReport returns empty report', () => {
    const report = NullBus.getListenerReport();
    assertEqual(report.total, 0);
    assertEqual(report.events, 0);
    assertEqual(report.suspects.length, 0);
  });
});

run();
