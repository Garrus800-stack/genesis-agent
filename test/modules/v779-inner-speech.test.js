#!/usr/bin/env node
// v7.7.9 — InnerSpeech contract
//
// Background: v7.7.9 introduces InnerSpeech as a first-person thought
// channel — a bounded, in-memory ring buffer with multi-subscriber
// async delivery and persistent overflow to selfStatementLog.
//
// This is a foundational substrate. Everything else in v7.7.9
// (ProactiveSelfExpression, the proactive trigger kinds, the chat-side
// self-message rendering) layers on top of it. If InnerSpeech is broken,
// nothing else can work.
//
// Self-Gate-Asymmetry: emit() never throws and never blocks. Subscriber
// errors do not propagate. Genesis is never gated against thinking.

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');

const { InnerSpeech } = require('../../src/agent/cognitive/InnerSpeech');
const { RingBuffer } = require('../../src/agent/cognitive/innerSpeech/RingBuffer');

// ── helper: tiny in-memory bus mock ─────────────────────────
function mockBus() {
  const fired = [];
  return {
    fired,
    fire(type, payload, meta) {
      fired.push({ type, payload, meta });
    },
  };
}

function mockSelfStatementLog() {
  const appended = [];
  return {
    appended,
    append(entry) { appended.push(entry); },
  };
}

// ── RingBuffer ──────────────────────────────────────────────

describe('RingBuffer — bounded ring with displacement', () => {
  test('rejects invalid capacity', () => {
    let threw = false;
    try { new RingBuffer(0); } catch (_e) { threw = true; }
    assert(threw, 'capacity 0 should throw');

    threw = false;
    try { new RingBuffer(-5); } catch (_e) { threw = true; }
    assert(threw, 'negative capacity should throw');

    threw = false;
    try { new RingBuffer('foo'); } catch (_e) { threw = true; }
    assert(threw, 'non-integer capacity should throw');
  });

  test('push under capacity returns null, no displacement', () => {
    const r = new RingBuffer(3);
    assertEqual(r.push('a'), null);
    assertEqual(r.push('b'), null);
    assertEqual(r.push('c'), null);
    assertEqual(r.size, 3);
  });

  test('push at capacity displaces oldest', () => {
    const r = new RingBuffer(3);
    r.push('a'); r.push('b'); r.push('c');
    assertEqual(r.push('d'), 'a');
    assertEqual(r.push('e'), 'b');
    assertEqual(r.size, 3);
  });

  test('toArray returns chronological order (oldest first)', () => {
    const r = new RingBuffer(3);
    r.push('a'); r.push('b'); r.push('c');
    const arr = r.toArray();
    assertEqual(arr.length, 3);
    assertEqual(arr[0], 'a');
    assertEqual(arr[2], 'c');
  });

  test('toArray after wrap returns correct order', () => {
    const r = new RingBuffer(3);
    r.push('a'); r.push('b'); r.push('c');  // ring: [a, b, c]
    r.push('d');                              // ring: [d, b, c], head wrapped
    const arr = r.toArray();
    assertEqual(arr.length, 3);
    assertEqual(arr[0], 'b');
    assertEqual(arr[1], 'c');
    assertEqual(arr[2], 'd');
  });

  test('clear empties the ring', () => {
    const r = new RingBuffer(3);
    r.push('a'); r.push('b');
    r.clear();
    assertEqual(r.size, 0);
    assertEqual(r.toArray().length, 0);
  });
});

// ── InnerSpeech.emit ────────────────────────────────────────

describe('InnerSpeech.emit — basic shape and contract', () => {
  test('emit returns a thought id', () => {
    const is = new InnerSpeech({ bus: mockBus() });
    const id = is.emit('hello world', 'idle-thought');
    assert(typeof id === 'string' && id.length > 0, 'emit must return non-empty id');
    assert(id.startsWith('t_'), 'id should have t_ prefix');
  });

  test('emit fires telemetry on bus', () => {
    const bus = mockBus();
    const is = new InnerSpeech({ bus });
    is.emit('hello', 'idle-thought', { sourceModule: 'IdleMind' });
    assertEqual(bus.fired.length, 1);
    assertEqual(bus.fired[0].type, 'agent:inner-thought');
    assertEqual(bus.fired[0].payload.kind, 'idle-thought');
    assertEqual(bus.fired[0].payload.sourceModule, 'IdleMind');
    assertEqual(bus.fired[0].payload.textLength, 5);
  });

  test('emit telemetry payload does not include full text', () => {
    const bus = mockBus();
    const is = new InnerSpeech({ bus });
    is.emit('a very long thought that should not appear in telemetry', 'idle-thought');
    const payload = bus.fired[0].payload;
    assert(!('text' in payload), 'telemetry must not include text');
    assert(typeof payload.textLength === 'number', 'must include textLength');
  });

  test('emit caps text at 4000 chars', () => {
    const is = new InnerSpeech({ bus: mockBus() });
    const longText = 'x'.repeat(5000);
    is.emit(longText, 'idle-thought');
    const recent = is.recent(1);
    assertEqual(recent[0].text.length, 4000);
  });

  test('emit on malformed input does not throw, degrades gracefully', () => {
    const is = new InnerSpeech({ bus: mockBus() });
    // null text → empty string
    is.emit(null, 'idle-thought');
    is.emit(undefined, 'idle-thought');
    // null kind → 'unknown'
    is.emit('text', null);
    is.emit('text', undefined);
    // no metadata
    is.emit('text', 'kind');
    // all should have produced thoughts
    assertEqual(is.stats().totalEmitted, 5);
  });
});

// ── InnerSpeech.subscribe ───────────────────────────────────

describe('InnerSpeech.subscribe — async multi-subscriber delivery', () => {
  test('wildcard subscribe receives all kinds', async () => {
    const is = new InnerSpeech({ bus: mockBus() });
    const received = [];
    is.subscribe('*', (t) => received.push(t));
    is.emit('a', 'idle-thought');
    is.emit('b', 'plan-failure-reflection');
    // delivery is async via queueMicrotask
    await new Promise(r => queueMicrotask(r));
    await new Promise(r => queueMicrotask(r));
    assertEqual(received.length, 2);
    assertEqual(received[0].kind, 'idle-thought');
    assertEqual(received[1].kind, 'plan-failure-reflection');
  });

  test('kind-specific subscribe filters', async () => {
    const is = new InnerSpeech({ bus: mockBus() });
    const idleOnly = [];
    is.subscribe('idle-thought', (t) => idleOnly.push(t));
    is.emit('a', 'idle-thought');
    is.emit('b', 'plan-failure-reflection');
    is.emit('c', 'idle-thought');
    await new Promise(r => queueMicrotask(r));
    await new Promise(r => queueMicrotask(r));
    assertEqual(idleOnly.length, 2);
    assertEqual(idleOnly[0].text, 'a');
    assertEqual(idleOnly[1].text, 'c');
  });

  test('unsubscribe stops delivery', async () => {
    const is = new InnerSpeech({ bus: mockBus() });
    const received = [];
    const unsub = is.subscribe('*', (t) => received.push(t));
    is.emit('first', 'kind');
    await new Promise(r => queueMicrotask(r));
    unsub();
    is.emit('second', 'kind');
    await new Promise(r => queueMicrotask(r));
    assertEqual(received.length, 1);
    assertEqual(received[0].text, 'first');
  });

  test('subscriber errors do not propagate to emit', async () => {
    const is = new InnerSpeech({ bus: mockBus() });
    is.subscribe('*', () => { throw new Error('subscriber broke'); });
    let threw = false;
    try {
      is.emit('text', 'kind');
      await new Promise(r => queueMicrotask(r));
    } catch (_e) { threw = true; }
    assert(!threw, 'emit must not propagate subscriber errors');
    assertEqual(is.stats().totalEmitted, 1);
  });

  test('subscribe rejects non-function callback', () => {
    const is = new InnerSpeech({ bus: mockBus() });
    let threw = false;
    try { is.subscribe('*', 'not a function'); } catch (_e) { threw = true; }
    assert(threw, 'non-function callback should throw');
  });
});

// ── InnerSpeech.recent ──────────────────────────────────────

describe('InnerSpeech.recent — newest-first read', () => {
  test('recent returns newest first', () => {
    const is = new InnerSpeech({ bus: mockBus() });
    is.emit('first', 'kind');
    is.emit('second', 'kind');
    is.emit('third', 'kind');
    const recent = is.recent(10);
    assertEqual(recent.length, 3);
    assertEqual(recent[0].text, 'third');
    assertEqual(recent[2].text, 'first');
  });

  test('recent with kind filter', () => {
    const is = new InnerSpeech({ bus: mockBus() });
    is.emit('a', 'idle-thought');
    is.emit('b', 'plan-failure-reflection');
    is.emit('c', 'idle-thought');
    const recent = is.recent(10, { kind: 'idle-thought' });
    assertEqual(recent.length, 2);
    assertEqual(recent[0].text, 'c');
    assertEqual(recent[1].text, 'a');
  });

  test('recent caps at requested n', () => {
    const is = new InnerSpeech({ bus: mockBus() });
    for (let i = 0; i < 50; i++) is.emit(`t${i}`, 'kind');
    const recent = is.recent(5);
    assertEqual(recent.length, 5);
  });
});

// ── Overflow to selfStatementLog ─────────────────────────────

describe('InnerSpeech overflow — displaced thoughts go to selfStatementLog', () => {
  test('overflow fires when ring fills', () => {
    const log = mockSelfStatementLog();
    const is = new InnerSpeech({ bus: mockBus(), capacity: 3 });
    is._selfStatementLog = log;  // simulate late-bind
    is.emit('a', 'kind');
    is.emit('b', 'kind');
    is.emit('c', 'kind');
    assertEqual(log.appended.length, 0);  // not yet at overflow
    is.emit('d', 'kind');
    assertEqual(log.appended.length, 1);
    assertEqual(log.appended[0].text, 'a');
    assertEqual(log.appended[0].overflowedFrom, 'inner-speech-ring');
    assertEqual(log.appended[0].kind, 'kind');
  });

  test('overflow without selfStatementLog is silent', () => {
    const is = new InnerSpeech({ bus: mockBus(), capacity: 2 });
    // _selfStatementLog stays null
    is.emit('a', 'kind');
    is.emit('b', 'kind');
    is.emit('c', 'kind');  // displaces 'a'
    // Should not throw, totalOverflowed counter should still be incremented
    assertEqual(is.stats().totalOverflowed, 1);
  });

  test('overflow target throwing does not break emit', () => {
    const brokenLog = { append() { throw new Error('disk full'); } };
    const is = new InnerSpeech({ bus: mockBus(), capacity: 2 });
    is._selfStatementLog = brokenLog;
    is.emit('a', 'kind');
    is.emit('b', 'kind');
    let threw = false;
    try { is.emit('c', 'kind'); } catch (_e) { threw = true; }
    assert(!threw, 'broken overflow target must not break emit');
  });
});

// ── Stats ────────────────────────────────────────────────────

describe('InnerSpeech.stats — diagnostics', () => {
  test('stats track totals and per-kind', () => {
    const is = new InnerSpeech({ bus: mockBus() });
    is.emit('a', 'idle-thought');
    is.emit('b', 'idle-thought');
    is.emit('c', 'plan-failure-reflection');
    const s = is.stats();
    assertEqual(s.totalEmitted, 3);
    assertEqual(s.totalOverflowed, 0);
    assertEqual(s.byKind['idle-thought'], 2);
    assertEqual(s.byKind['plan-failure-reflection'], 1);
    assertEqual(s.ringUsed, 3);
    assertEqual(s.ringCapacity, 200);
  });
});

// ── clear ────────────────────────────────────────────────────

describe('InnerSpeech.clear — drops ring without touching overflow', () => {
  test('clear empties recent', () => {
    const is = new InnerSpeech({ bus: mockBus() });
    is.emit('a', 'kind');
    is.emit('b', 'kind');
    is.clear();
    assertEqual(is.recent(10).length, 0);
  });

  test('clear does not touch selfStatementLog', () => {
    const log = mockSelfStatementLog();
    const is = new InnerSpeech({ bus: mockBus(), capacity: 2 });
    is._selfStatementLog = log;
    is.emit('a', 'kind');
    is.emit('b', 'kind');
    is.emit('c', 'kind');  // overflow → log gets 'a'
    assertEqual(log.appended.length, 1);
    is.clear();
    assertEqual(log.appended.length, 1);  // unchanged
  });
});

// ── Performance smoke test ──────────────────────────────────

describe('InnerSpeech performance', () => {
  test('1000 emits complete in reasonable time (<200ms)', () => {
    const is = new InnerSpeech({ bus: mockBus() });
    const start = Date.now();
    for (let i = 0; i < 1000; i++) {
      is.emit(`thought ${i}`, 'idle-thought', {
        sourceModule: 'BenchMock',
        significance: 0.5,
        novelty: 0.3,
      });
    }
    const elapsed = Date.now() - start;
    assert(elapsed < 200, `1000 emits took ${elapsed}ms (expected <200ms)`);
    assertEqual(is.stats().totalEmitted, 1000);
  });
});

run();
