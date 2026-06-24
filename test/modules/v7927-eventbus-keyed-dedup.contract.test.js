// ============================================================
// v7.9.27 #4 — keyed-dedup index is cleaned on removal.
//
// on(event, handler, { key }) records a compositeKey `${event}::${key}`
// in _keyedEntries. off() and removeBySource() removed the listener from
// the listener set but left the compositeKey behind, pointing at a
// removed listener — a slow leak and a stale-replace hazard on the next
// keyed subscribe for the same key. Both paths now drop the index entry.
// ============================================================

'use strict';

const path = require('path');
const { describe, test, run, assert, assertEqual } = require('../harness');

const ROOT = path.join(__dirname, '../..');
const { EventBus } = require(path.join(ROOT, 'src/agent/core/EventBus'));

describe('v7.9.27 #4 — keyed-dedup index cleanup', () => {
  test('off(handler) drops the keyed entry', () => {
    const bus = new EventBus();
    const h = () => {};
    bus.on('e', h, { key: 'k', source: 'S' });
    assert(bus._keyedEntries.has('e::k'), 'keyed entry present after on()');
    bus.off('e', h);
    assert(!bus._keyedEntries.has('e::k'), 'keyed entry gone after off(handler)');
  });

  test('off(source) drops the keyed entry', () => {
    const bus = new EventBus();
    bus.on('e', () => {}, { key: 'k', source: 'S' });
    bus.off('e', 'S');
    assert(!bus._keyedEntries.has('e::k'), 'keyed entry gone after off(source)');
  });

  test('removeBySource drops the keyed entry', () => {
    const bus = new EventBus();
    bus.on('e', () => {}, { key: 'k', source: 'S' });
    assert(bus._keyedEntries.has('e::k'), 'keyed entry present after on()');
    bus.removeBySource('S');
    assert(!bus._keyedEntries.has('e::k'), 'keyed entry gone after removeBySource');
  });

  test('re-subscribing the same key after removal leaves exactly one listener', () => {
    const bus = new EventBus();
    let calls = 0;
    bus.on('e', () => { calls++; }, { key: 'k', source: 'S' });
    bus.removeBySource('S');
    bus.on('e', () => { calls++; }, { key: 'k', source: 'S' });
    bus.emit('e', {});
    assertEqual(calls, 1, 'exactly one live listener after remove + re-add');
    assertEqual(bus.getListenerCount(), 1, 'no leaked listener');
  });
});

if (require.main === module) run();
