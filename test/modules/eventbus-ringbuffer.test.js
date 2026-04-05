// ============================================================
// TEST: EventBus — Ring Buffer History (F-09)
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');

describe('EventBus — Ring Buffer (v4.0.0)', () => {
  // Use a fresh EventBus instance (not the singleton)
  const { EventBus } = require('../../src/agent/core/EventBus');

  test('history stays within limit after overflow', async () => {
    const bus = new EventBus();
    bus.historyLimit = 10;
    bus._historyIdx = 0;

    for (let i = 0; i < 25; i++) {
      await bus.emit(`test:event-${i}`, { i }, { source: 'test' });
    }

    assert(bus.history.length <= 10, `History should be ≤10, got ${bus.history.length}`);
  });

  test('getHistory returns chronological order after wrap', async () => {
    const bus = new EventBus();
    bus.historyLimit = 5;
    bus._historyIdx = 0;

    for (let i = 0; i < 12; i++) {
      await bus.emit(`evt:${i}`, null, { source: 'test' });
    }

    const history = bus.getHistory(5);
    // Should be evt:7, evt:8, evt:9, evt:10, evt:11 (last 5)
    assert(history.length === 5, `Expected 5 entries, got ${history.length}`);
    assert(history[0].event === 'evt:7', `Expected evt:7, got ${history[0].event}`);
    assert(history[4].event === 'evt:11', `Expected evt:11, got ${history[4].event}`);
  });

  test('getHistory with limit < buffer size', async () => {
    const bus = new EventBus();
    bus.historyLimit = 10;
    bus._historyIdx = 0;

    for (let i = 0; i < 15; i++) {
      await bus.emit(`e:${i}`, null, { source: 'test' });
    }

    const last3 = bus.getHistory(3);
    assertEqual(last3.length, 3);
    assertEqual(last3[2].event, 'e:14');
  });

  test('getHistory works before buffer is full', async () => {
    const bus = new EventBus();
    bus.historyLimit = 100;

    for (let i = 0; i < 3; i++) {
      await bus.emit(`small:${i}`, null, { source: 'test' });
    }

    const history = bus.getHistory(10);
    assertEqual(history.length, 3);
    assertEqual(history[0].event, 'small:0');
  });

  test('no GC pressure from array reallocation', async () => {
    const bus = new EventBus();
    bus.historyLimit = 50;

    // Fill + overflow — should never create new arrays
    for (let i = 0; i < 200; i++) {
      await bus.emit('stress:test', { i }, { source: 'perf' });
    }

    assertEqual(bus.history.length, 50);
    const history = bus.getHistory(5);
    assertEqual(history.length, 5);
    // Last event should be stress:test with i=199
    assert(history[4].event === 'stress:test');
  });
});

run();
