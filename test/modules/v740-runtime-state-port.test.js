// ============================================================
// v7.4.0 Session 1 — RuntimeStatePort
//
// Tests for the port's core mechanics. Does not yet touch
// real services (those get tested in Session 2) or the
// PromptBuilder integration (Session 3).
//
// Covers:
//   - Constructor defaults (clock)
//   - register() — valid, invalid, null, duplicate
//   - unregister()
//   - snapshot() — empty, full, timestamps, defensive
//     null handling, throw-safety, non-object rejection
//   - Lazy registration from late-bound slots
//   - size() and sourceNames()
// ============================================================

const { describe, it } = require('node:test');
const assert = require('assert');
const { RuntimeStatePort } = require('../../src/agent/ports/RuntimeStatePort');

// ════════════════════════════════════════════════════════════
// Construction
// ════════════════════════════════════════════════════════════

describe('v7.4.0 — RuntimeStatePort construction', () => {

  it('constructs with no arguments', () => {
    const p = new RuntimeStatePort();
    assert.strictEqual(p.size(), 0);
    assert.deepStrictEqual(p.sourceNames(), []);
  });

  it('accepts an injectable clock', () => {
    const fixedClock = { now: () => 12345 };
    const p = new RuntimeStatePort({ clock: fixedClock });
    // Register a source so snapshot produces output.
    p.register('x', { getRuntimeSnapshot: () => ({ v: 1 }) });
    const snap = p.snapshot();
    assert.strictEqual(snap.x._capturedAt, 12345);
  });

  it('initialises all 8 late-binding slots to null', () => {
    const p = new RuntimeStatePort();
    const slots = [
      'settings', 'daemon', 'idleMind', 'peerNetwork',
      'emotionalState', 'needsSystem', 'metabolism', 'goalStack',
    ];
    for (const slot of slots) {
      assert.strictEqual(p[slot], null, `slot ${slot} should start null`);
    }
  });
});

// ════════════════════════════════════════════════════════════
// register() and unregister()
// ════════════════════════════════════════════════════════════

describe('v7.4.0 — RuntimeStatePort.register', () => {

  it('registers a valid service', () => {
    const p = new RuntimeStatePort();
    const ok = p.register('foo', { getRuntimeSnapshot: () => ({}) });
    assert.strictEqual(ok, true);
    assert.strictEqual(p.size(), 1);
    assert.deepStrictEqual(p.sourceNames(), ['foo']);
  });

  it('rejects a service without getRuntimeSnapshot()', () => {
    const p = new RuntimeStatePort();
    const ok = p.register('foo', { getStatus: () => ({}) });
    assert.strictEqual(ok, false);
    assert.strictEqual(p.size(), 0);
  });

  it('rejects null service', () => {
    const p = new RuntimeStatePort();
    assert.strictEqual(p.register('foo', null), false);
    assert.strictEqual(p.register('foo', undefined), false);
    assert.strictEqual(p.size(), 0);
  });

  it('rejects non-string name', () => {
    const p = new RuntimeStatePort();
    const svc = { getRuntimeSnapshot: () => ({}) };
    assert.strictEqual(p.register(null, svc), false);
    assert.strictEqual(p.register('', svc), false);
    assert.strictEqual(p.register(42, svc), false);
    assert.strictEqual(p.size(), 0);
  });

  it('overwrites a previous registration with the same name', () => {
    const p = new RuntimeStatePort();
    p.register('foo', { getRuntimeSnapshot: () => ({ v: 1 }) });
    p.register('foo', { getRuntimeSnapshot: () => ({ v: 2 }) });
    assert.strictEqual(p.size(), 1);
    assert.strictEqual(p.snapshot().foo.v, 2);
  });

  it('unregister() removes a source', () => {
    const p = new RuntimeStatePort();
    p.register('foo', { getRuntimeSnapshot: () => ({}) });
    assert.strictEqual(p.unregister('foo'), true);
    assert.strictEqual(p.size(), 0);
    assert.strictEqual(p.unregister('foo'), false); // idempotent
  });
});

// ════════════════════════════════════════════════════════════
// snapshot()
// ════════════════════════════════════════════════════════════

describe('v7.4.0 — RuntimeStatePort.snapshot', () => {

  it('returns empty object when no sources', () => {
    const p = new RuntimeStatePort();
    assert.deepStrictEqual(p.snapshot(), {});
  });

  it('includes _capturedAt timestamp on every entry', () => {
    const p = new RuntimeStatePort({ clock: { now: () => 999 } });
    p.register('a', { getRuntimeSnapshot: () => ({ x: 1 }) });
    p.register('b', { getRuntimeSnapshot: () => ({ y: 2 }) });
    const snap = p.snapshot();
    assert.strictEqual(snap.a._capturedAt, 999);
    assert.strictEqual(snap.b._capturedAt, 999);
    assert.strictEqual(snap.a.x, 1);
    assert.strictEqual(snap.b.y, 2);
  });

  it('re-reads sources on every call (no caching)', () => {
    // Leitprinzip 0.6 enforcement: a changing service must
    // produce changing snapshots even on rapid successive calls.
    const p = new RuntimeStatePort();
    let counter = 0;
    p.register('counter', {
      getRuntimeSnapshot: () => ({ value: ++counter }),
    });
    assert.strictEqual(p.snapshot().counter.value, 1);
    assert.strictEqual(p.snapshot().counter.value, 2);
    assert.strictEqual(p.snapshot().counter.value, 3);
  });

  it('silently skips sources that throw', () => {
    const p = new RuntimeStatePort();
    p.register('broken', {
      getRuntimeSnapshot: () => { throw new Error('kaboom'); },
    });
    p.register('ok', { getRuntimeSnapshot: () => ({ v: 1 }) });
    const snap = p.snapshot();
    assert.ok(!('broken' in snap), 'broken service must not appear');
    assert.strictEqual(snap.ok.v, 1);
  });

  it('rejects non-object snapshot return values', () => {
    const p = new RuntimeStatePort();
    p.register('null',  { getRuntimeSnapshot: () => null });
    p.register('num',   { getRuntimeSnapshot: () => 42 });
    p.register('str',   { getRuntimeSnapshot: () => 'hi' });
    p.register('arr',   { getRuntimeSnapshot: () => [1, 2] });
    p.register('undef', { getRuntimeSnapshot: () => undefined });
    p.register('ok',    { getRuntimeSnapshot: () => ({ v: 1 }) });
    const snap = p.snapshot();
    assert.deepStrictEqual(Object.keys(snap), ['ok']);
  });

  it('does not mutate the original snapshot object', () => {
    const p = new RuntimeStatePort();
    const original = { a: 1 };
    p.register('x', { getRuntimeSnapshot: () => original });
    p.snapshot();
    assert.ok(!('_capturedAt' in original),
      'port must not add _capturedAt to the source object');
  });
});

// ════════════════════════════════════════════════════════════
// Lazy registration (late-binding path)
// ════════════════════════════════════════════════════════════

describe('v7.4.0 — RuntimeStatePort lazy registration', () => {

  it('registers late-bound services on first snapshot() call', () => {
    const p = new RuntimeStatePort();
    assert.strictEqual(p.size(), 0);
    // Simulate Container setting late-binding slots.
    p.settings       = { getRuntimeSnapshot: () => ({ model: 'test' }) };
    p.emotionalState = { getRuntimeSnapshot: () => ({ dom: 'calm' }) };
    assert.strictEqual(p.size(), 0, 'still zero before first snapshot');
    const snap = p.snapshot();
    assert.strictEqual(p.size(), 2, 'both registered after snapshot');
    assert.strictEqual(snap.settings.model, 'test');
    assert.strictEqual(snap.emotionalState.dom, 'calm');
  });

  it('skips late-bound slots without getRuntimeSnapshot()', () => {
    const p = new RuntimeStatePort();
    p.settings  = { getRuntimeSnapshot: () => ({}) };  // valid
    p.daemon    = { getStatus: () => ({}) };           // missing method
    p.idleMind  = null;                                // not bound
    p.snapshot();
    assert.deepStrictEqual(p.sourceNames(), ['settings']);
  });

  it('lazy registration runs only once', () => {
    const p = new RuntimeStatePort();
    let callCount = 0;
    p.settings = {
      getRuntimeSnapshot: () => { callCount++; return { v: 1 }; },
    };
    p.snapshot();
    p.snapshot();
    p.snapshot();
    // Called three times (once per snapshot), but registered once.
    assert.strictEqual(callCount, 3);
    assert.strictEqual(p.size(), 1);
  });

  it('supports mixing manual register() with lazy late-binding', () => {
    const p = new RuntimeStatePort();
    // Manual pre-registration (used in tests).
    p.register('manual', { getRuntimeSnapshot: () => ({ m: 1 }) });
    // Late-binding slot.
    p.settings = { getRuntimeSnapshot: () => ({ s: 1 }) };
    const snap = p.snapshot();
    assert.strictEqual(snap.manual.m, 1);
    assert.strictEqual(snap.settings.s, 1);
    assert.strictEqual(p.size(), 2);
  });
});

// ════════════════════════════════════════════════════════════
// Diagnostic helpers
// ════════════════════════════════════════════════════════════

describe('v7.4.0 — RuntimeStatePort diagnostics', () => {

  it('sourceNames() reflects insertion order', () => {
    const p = new RuntimeStatePort();
    p.register('c', { getRuntimeSnapshot: () => ({}) });
    p.register('a', { getRuntimeSnapshot: () => ({}) });
    p.register('b', { getRuntimeSnapshot: () => ({}) });
    assert.deepStrictEqual(p.sourceNames(), ['c', 'a', 'b']);
  });

  it('size() is accurate after register/unregister cycles', () => {
    const p = new RuntimeStatePort();
    assert.strictEqual(p.size(), 0);
    p.register('a', { getRuntimeSnapshot: () => ({}) });
    p.register('b', { getRuntimeSnapshot: () => ({}) });
    assert.strictEqual(p.size(), 2);
    p.unregister('a');
    assert.strictEqual(p.size(), 1);
    p.unregister('a'); // idempotent
    assert.strictEqual(p.size(), 1);
  });
});
