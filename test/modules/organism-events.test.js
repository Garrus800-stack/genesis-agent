// ============================================================
// OrganismEvents — Typed Event Facade Tests (v7.0.4)
// Verifies constructor, emit delegation, and subscribe delegation.
// ============================================================
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('OrganismEvents', () => {
  function mockBus() {
    const calls = { emit: [], on: [] };
    return {
      emit(event, data, meta) { calls.emit.push({ event, data, meta }); },
      on(event, handler, opts) { calls.on.push({ event, handler, opts }); return () => {}; },
      calls,
    };
  }

  it('constructs with bus reference', () => {
    const { OrganismEvents } = require('../../src/agent/organism/OrganismEvents');
    const bus = mockBus();
    const oe = new OrganismEvents(bus);
    assert.ok(oe);
    assert.strictEqual(oe._bus, bus);
  });

  it('emit methods delegate to bus.emit with correct event string', () => {
    const { OrganismEvents } = require('../../src/agent/organism/OrganismEvents');
    const { EVENTS } = require('../../src/agent/core/EventTypes');
    const bus = mockBus();
    const oe = new OrganismEvents(bus);

    oe.emitMoodShift({ mood: 'curious' });
    oe.emitCritical({ vital: 'errorRate' });
    oe.emitIntervention({ level: 2 });

    assert.strictEqual(bus.calls.emit.length, 3);
    assert.strictEqual(bus.calls.emit[0].event, EVENTS.EMOTION.SHIFT);
    assert.deepStrictEqual(bus.calls.emit[0].data, { mood: 'curious' });
    assert.strictEqual(bus.calls.emit[1].event, EVENTS.HOMEOSTASIS.CRITICAL);
    assert.strictEqual(bus.calls.emit[2].event, EVENTS.IMMUNE.INTERVENTION);
  });

  it('on methods delegate to bus.on and return unsubscribe handle', () => {
    const { OrganismEvents } = require('../../src/agent/organism/OrganismEvents');
    const bus = mockBus();
    const oe = new OrganismEvents(bus);
    const handler = () => {};

    const unsub = oe.onMoodShift(handler);
    assert.strictEqual(typeof unsub, 'function');
    assert.strictEqual(bus.calls.on.length, 1);
    assert.strictEqual(bus.calls.on[0].handler, handler);
  });

  it('all emit methods are functions', () => {
    const { OrganismEvents } = require('../../src/agent/organism/OrganismEvents');
    const bus = mockBus();
    const oe = new OrganismEvents(bus);
    const proto = Object.getOwnPropertyNames(OrganismEvents.prototype);
    const emitters = proto.filter(m => m.startsWith('emit'));
    assert.ok(emitters.length >= 20, `Expected >=20 emit methods, got ${emitters.length}`);
    for (const m of emitters) {
      assert.strictEqual(typeof oe[m], 'function', `${m} should be a function`);
    }
  });

  it('all on/onAny methods are functions', () => {
    const { OrganismEvents } = require('../../src/agent/organism/OrganismEvents');
    const bus = mockBus();
    const oe = new OrganismEvents(bus);
    const proto = Object.getOwnPropertyNames(OrganismEvents.prototype);
    const subscribers = proto.filter(m => m.startsWith('on') && m !== 'constructor');
    assert.ok(subscribers.length >= 7, `Expected >=7 on methods, got ${subscribers.length}`);
    for (const m of subscribers) {
      assert.strictEqual(typeof oe[m], 'function', `${m} should be a function`);
    }
  });

  it('cross-layer subscriptions use correct event strings', () => {
    const { OrganismEvents } = require('../../src/agent/organism/OrganismEvents');
    const bus = mockBus();
    const oe = new OrganismEvents(bus);

    oe.onChatCompleted(() => {});
    oe.onChatError(() => {});
    oe.onUIHeartbeat(() => {});

    assert.strictEqual(bus.calls.on[0].event, 'chat:completed');
    assert.strictEqual(bus.calls.on[1].event, 'chat:error');
    assert.strictEqual(bus.calls.on[2].event, 'ui:heartbeat');
  });
});
