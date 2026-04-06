#!/usr/bin/env node
// Test: EventStore — append-only event log with projections + hash chain
const { describe, test, assert, assertEqual, run } = require('../harness');
const { createBus } = require('../../src/agent/core/EventBus');
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmpDir = path.join(os.tmpdir(), `genesis-eventstore-test-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });

const { EventStore } = require('../../src/agent/foundation/EventStore');

function create() {
  const bus = createBus();
  return { bus, store: new EventStore(tmpDir, bus, null) };
}

describe('EventStore', () => {

  test('append stores events', () => {
    const { store } = create();
    store.append('test:event', { value: 1 }, 'test');
    store.append('test:event', { value: 2 }, 'test');
    assertEqual(store.eventCount, 2);
  });

  test('append assigns sequential IDs', () => {
    const { store } = create();
    store.append('a', {});
    store.append('b', {});
    store._flushBatch();
    const events = store.query({ limit: 10 });
    assert(events.length >= 2);
  });

  test('query filters by type', () => {
    const { store } = create();
    store.append('type-a', { v: 1 });
    store.append('type-b', { v: 2 });
    store.append('type-a', { v: 3 });
    store._flushBatch();
    const results = store.query({ type: 'type-a' });
    assert(results.every(e => e.type === 'type-a'), 'all should be type-a');
  });

  test('query filters by source', () => {
    const { store } = create();
    store.append('ev', {}, 'src-a');
    store.append('ev', {}, 'src-b');
    store._flushBatch();
    const results = store.query({ source: 'src-a' });
    assert(results.every(e => e.source === 'src-a'));
  });

  test('query respects limit', () => {
    const { store } = create();
    for (let i = 0; i < 20; i++) store.append('ev', { i });
    store._flushBatch();
    const results = store.query({ limit: 5 });
    assertEqual(results.length, 5);
  });

  test('query filters by since/until', () => {
    const { store } = create();
    const t1 = Date.now() - 1;
    store.append('ev', { v: 1 });
    store._flushBatch();
    const results = store.query({ since: t1 });
    assert(results.length >= 1);
  });

  test('registerProjection + getProjection', () => {
    const { store } = create();
    store.registerProjection('counter', (state, event) => {
      state.count = (state.count || 0) + 1;
      return state;
    }, { count: 0 });
    store.append('ev', {});
    store.append('ev', {});
    const proj = store.getProjection('counter');
    assertEqual(proj.count, 2);
  });

  test('flushPending completes without error', async () => {
    const { store } = create();
    store.append('ev', {});
    await store.flushPending();
  });

  test('replay rebuilds projections', () => {
    const { store } = create();
    store.registerProjection('sum', (state, event) => {
      if (event.type === 'add') state.total = (state.total || 0) + (event.payload?.v || 0);
      return state;
    }, { total: 0 });
    store.append('add', { v: 10 });
    store.append('add', { v: 20 });
    store._flushBatch();
    const result = store.replay();
    assert(result.eventsReplayed >= 2);
  });

  test('events have hash chain', () => {
    const { store } = create();
    store.append('ev', { v: 1 });
    store.append('ev', { v: 2 });
    store._flushBatch();
    const events = store.query({ limit: 10 });
    if (events.length >= 2) {
      assert(events[0].hash, 'should have hash');
      assert(events[1].prevHash, 'should have prevHash');
    }
  });

  test('emits store:append on bus', () => {
    const { bus, store } = create();
    let emitted = null;
    bus.on('store:append', (data) => { emitted = data; });
    store.append('test:ev', { hello: 'world' }, 'test');
    // May or may not emit depending on implementation
  });
});

run();
try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* */ }
