// ============================================================
// CognitiveEvents — Typed Event Facade Tests (v7.0.4)
// Verifies constructor, emit delegation, and subscribe delegation.
// ============================================================
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('CognitiveEvents', () => {
  /** Minimal mock bus that records calls */
  function mockBus() {
    const calls = { emit: [], on: [] };
    return {
      emit(event, data, meta) { calls.emit.push({ event, data, meta }); },
      on(event, handler, opts) { calls.on.push({ event, handler, opts }); return () => {}; },
      calls,
    };
  }

  it('constructs with bus reference', () => {
    const { CognitiveEvents } = require('../../src/agent/cognitive/CognitiveEvents');
    const bus = mockBus();
    const ce = new CognitiveEvents(bus);
    assert.ok(ce);
    assert.strictEqual(ce._bus, bus);
  });

  it('emit methods delegate to bus.emit with correct event string', () => {
    const { CognitiveEvents } = require('../../src/agent/cognitive/CognitiveEvents');
    const { EVENTS } = require('../../src/agent/core/EventTypes');
    const bus = mockBus();
    const ce = new CognitiveEvents(bus);

    ce.emitStarted({ foo: 1 });
    ce.emitDreamComplete({ bar: 2 });
    ce.emitLessonRecorded({ baz: 3 });

    assert.strictEqual(bus.calls.emit.length, 3);
    assert.strictEqual(bus.calls.emit[0].event, EVENTS.COGNITIVE.STARTED);
    assert.deepStrictEqual(bus.calls.emit[0].data, { foo: 1 });
    assert.strictEqual(bus.calls.emit[1].event, EVENTS.DREAM.COMPLETE);
    assert.strictEqual(bus.calls.emit[2].event, EVENTS.LESSONS.RECORDED);
  });

  it('on methods delegate to bus.on and return unsubscribe handle', () => {
    const { CognitiveEvents } = require('../../src/agent/cognitive/CognitiveEvents');
    const bus = mockBus();
    const ce = new CognitiveEvents(bus);
    const handler = () => {};

    const unsub = ce.onDreamComplete(handler);
    assert.strictEqual(typeof unsub, 'function');
    assert.strictEqual(bus.calls.on.length, 1);
    assert.strictEqual(bus.calls.on[0].handler, handler);
  });

  it('all emit methods are functions', () => {
    const { CognitiveEvents } = require('../../src/agent/cognitive/CognitiveEvents');
    const bus = mockBus();
    const ce = new CognitiveEvents(bus);
    const proto = Object.getOwnPropertyNames(CognitiveEvents.prototype);
    const emitters = proto.filter(m => m.startsWith('emit'));
    assert.ok(emitters.length >= 30, `Expected >=30 emit methods, got ${emitters.length}`);
    for (const m of emitters) {
      assert.strictEqual(typeof ce[m], 'function', `${m} should be a function`);
    }
  });

  it('all on methods are functions', () => {
    const { CognitiveEvents } = require('../../src/agent/cognitive/CognitiveEvents');
    const bus = mockBus();
    const ce = new CognitiveEvents(bus);
    const proto = Object.getOwnPropertyNames(CognitiveEvents.prototype);
    const subscribers = proto.filter(m => m.startsWith('on') && m !== 'constructor');
    assert.ok(subscribers.length >= 8, `Expected >=8 on methods, got ${subscribers.length}`);
    for (const m of subscribers) {
      assert.strictEqual(typeof ce[m], 'function', `${m} should be a function`);
    }
  });
});
