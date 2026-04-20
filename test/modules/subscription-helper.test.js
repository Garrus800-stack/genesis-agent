// Test: subscription-helper mixin
const { describe, test, run } = require('../harness');
const { applySubscriptionHelper, _sub, _unsubAll } = require('../../src/agent/core/subscription-helper');

// Minimal bus stub
function makeBus() {
  const listeners = new Map();
  return {
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      return () => {
        const arr = listeners.get(event) || [];
        const idx = arr.indexOf(handler);
        if (idx >= 0) arr.splice(idx, 1);
      };
    },
    emit(event, data) {
      for (const h of (listeners.get(event) || [])) h(data);
    },
    _count(event) { return (listeners.get(event) || []).length; },
  };
}

describe('subscription-helper', () => {
  test('applySubscriptionHelper adds _sub and _unsubAll', () => {
    class Service {}
    applySubscriptionHelper(Service);
    if (typeof Service.prototype._sub !== 'function') throw new Error('_sub missing');
    if (typeof Service.prototype._unsubAll !== 'function') throw new Error('_unsubAll missing');
  });

  test('_sub registers handler and tracks unsub', () => {
    class Service {
      constructor(bus) { this.bus = bus; this._unsubs = []; }
    }
    applySubscriptionHelper(Service);

    const bus = makeBus();
    const svc = new Service(bus);
    let calls = 0;
    svc._sub('test:event', () => { calls++; });

    if (bus._count('test:event') !== 1) throw new Error('handler not registered');
    bus.emit('test:event', {});
    if (calls !== 1) throw new Error('handler not invoked');
    if (svc._unsubs.length !== 1) throw new Error('unsub not tracked');
  });

  test('_unsubAll removes all subscriptions', () => {
    class Service {
      constructor(bus) { this.bus = bus; this._unsubs = []; }
    }
    applySubscriptionHelper(Service);

    const bus = makeBus();
    const svc = new Service(bus);
    svc._sub('a', () => {});
    svc._sub('b', () => {});
    svc._sub('c', () => {});

    if (svc._unsubs.length !== 3) throw new Error('pre: 3 subs expected');
    svc._unsubAll();
    if (svc._unsubs.length !== 0) throw new Error('post: unsubs not cleared');
    if (bus._count('a') !== 0) throw new Error('handler a still attached');
    if (bus._count('b') !== 0) throw new Error('handler b still attached');
    if (bus._count('c') !== 0) throw new Error('handler c still attached');
  });

  test('_unsubAll is idempotent', () => {
    class Service {
      constructor(bus) { this.bus = bus; this._unsubs = []; }
    }
    applySubscriptionHelper(Service);

    const bus = makeBus();
    const svc = new Service(bus);
    svc._sub('x', () => {});
    svc._unsubAll();
    // second call should not throw
    svc._unsubAll();
    if (svc._unsubs.length !== 0) throw new Error('still cleared');
  });

  test('_unsubAll swallows individual unsub errors', () => {
    class Service {
      constructor() { this.bus = null; this._unsubs = []; }
    }
    applySubscriptionHelper(Service);

    const svc = new Service();
    svc._unsubs.push(() => { throw new Error('boom'); });
    svc._unsubs.push(() => {}); // good one after the bad one
    let cleanupRan = false;
    svc._unsubs.push(() => { cleanupRan = true; });

    svc._unsubAll(); // must not throw
    if (!cleanupRan) throw new Error('later unsubs should still run after earlier failure');
    if (svc._unsubs.length !== 0) throw new Error('cleared despite error');
  });

  test('applySubscriptionHelper does not overwrite existing methods', () => {
    class Service {
      _sub() { return 'custom-sub'; }
    }
    applySubscriptionHelper(Service);
    const svc = new Service();
    if (svc._sub() !== 'custom-sub') throw new Error('custom _sub was overwritten');
  });

  test('_sub returns the underlying unsub function', () => {
    class Service {
      constructor(bus) { this.bus = bus; this._unsubs = []; }
    }
    applySubscriptionHelper(Service);

    const bus = makeBus();
    const svc = new Service(bus);
    const unsub = svc._sub('y', () => {});
    if (typeof unsub !== 'function') throw new Error('unsub should be function');
    unsub();
    if (bus._count('y') !== 0) throw new Error('unsub should remove handler');
  });

  test('defaultSource option tags every _sub() automatically', () => {
    class Service {
      constructor(bus) { this.bus = bus; this._unsubs = []; }
    }
    applySubscriptionHelper(Service, { defaultSource: 'MyService' });

    const seen = [];
    const bus = {
      on(event, handler, opts) { seen.push(opts); return () => {}; },
    };
    const svc = new Service(bus);
    svc._sub('a', () => {});
    if (seen[0].source !== 'MyService') throw new Error('default source not applied');
  });

  test('defaultSource does not overwrite explicit opts.source', () => {
    class Service {
      constructor(bus) { this.bus = bus; this._unsubs = []; }
    }
    applySubscriptionHelper(Service, { defaultSource: 'Default' });

    const seen = [];
    const bus = {
      on(event, handler, opts) { seen.push(opts); return () => {}; },
    };
    const svc = new Service(bus);
    svc._sub('a', () => {}, { source: 'Explicit' });
    if (seen[0].source !== 'Explicit') throw new Error('explicit source was overridden');
  });
});

run();
