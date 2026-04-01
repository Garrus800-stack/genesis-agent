#!/usr/bin/env node
// Test: CancellationToken.js — Structured concurrency primitive
const { describe, test, assert, assertEqual, assertThrows, assertRejects, run } = require('../harness');
const { CancellationToken } = require('../../src/agent/core/CancellationToken');

describe('CancellationToken — Basic', () => {
  test('starts not cancelled', () => {
    const t = new CancellationToken();
    assertEqual(t.isCancelled, false);
    assertEqual(t.reason, null);
  });

  test('cancel sets state and reason', () => {
    const t = new CancellationToken();
    t.cancel('user abort');
    assertEqual(t.isCancelled, true);
    assertEqual(t.reason, 'user abort');
  });

  test('double cancel is safe', () => {
    const t = new CancellationToken();
    t.cancel('first');
    t.cancel('second');
    assertEqual(t.reason, 'first', 'first reason preserved');
  });
});

describe('CancellationToken — Callbacks', () => {
  test('onCancel fires on cancel', () => {
    const t = new CancellationToken();
    let fired = false;
    t.onCancel(() => { fired = true; });
    t.cancel();
    assert(fired);
  });

  test('onCancel fires immediately if already cancelled', () => {
    const t = new CancellationToken();
    t.cancel('done');
    let reason = null;
    t.onCancel((r) => { reason = r; });
    assertEqual(reason, 'done');
  });

  test('unsubscribe prevents callback', () => {
    const t = new CancellationToken();
    let fired = false;
    const unsub = t.onCancel(() => { fired = true; });
    unsub();
    t.cancel();
    assertEqual(fired, false);
  });
});

describe('CancellationToken — Children', () => {
  test('child is cancelled when parent cancels', () => {
    const parent = new CancellationToken();
    const child = parent.child();
    parent.cancel('parent done');
    assert(child.isCancelled);
    assert(child.reason.includes('parent'));
  });

  test('child cancel does NOT propagate to parent', () => {
    const parent = new CancellationToken();
    const child = parent.child();
    child.cancel('child done');
    assert(child.isCancelled);
    assertEqual(parent.isCancelled, false);
  });

  test('child of cancelled parent is immediately cancelled', () => {
    const parent = new CancellationToken();
    parent.cancel();
    const child = parent.child();
    assert(child.isCancelled);
  });
});

describe('CancellationToken — Guards', () => {
  test('throwIfCancelled throws when cancelled', () => {
    const t = new CancellationToken();
    t.cancel();
    assertThrows(() => t.throwIfCancelled());
  });

  test('throwIfCancelled does nothing when not cancelled', () => {
    const t = new CancellationToken();
    t.throwIfCancelled(); // should not throw
    assert(true);
  });

  test('toAbortSignal reflects state', () => {
    const t = new CancellationToken();
    const signal = t.toAbortSignal();
    assertEqual(signal.aborted, false);
    t.cancel();
    assertEqual(signal.aborted, true);
  });
});

describe('CancellationToken — Factories', () => {
  test('withTimeout auto-cancels', async () => {
    const t = CancellationToken.withTimeout(50);
    assertEqual(t.isCancelled, false);
    await new Promise(r => setTimeout(r, 80));
    assert(t.isCancelled, 'should auto-cancel after timeout');
    assert(t.reason.includes('timeout'));
  });

  test('CANCELLED is pre-cancelled', () => {
    assert(CancellationToken.CANCELLED.isCancelled);
  });

  test('NONE is never cancelled', () => {
    assertEqual(CancellationToken.NONE.isCancelled, false);
  });
});

describe('CancellationToken — Promise', () => {
  test('toPromise rejects on cancel', async () => {
    const t = new CancellationToken();
    setTimeout(() => t.cancel('async'), 20);
    await assertRejects(async () => {
      await t.toPromise();
    });
  });

  test('toPromise rejects immediately if already cancelled', async () => {
    const t = new CancellationToken();
    t.cancel();
    await assertRejects(async () => {
      await t.toPromise();
    });
  });
});

run();
