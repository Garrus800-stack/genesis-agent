// ============================================================
// Test: v7.3.2 — IntentRouter memory-mark/list/veto intents
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const { IntentRouter } = require('../../src/agent/intelligence/IntentRouter');

function makeRouter() {
  const router = new IntentRouter({ bus: null });
  router.llmEnabled = false; // force regex-only for determinism
  return router;
}

describe('v7.3.2 — IntentRouter: memory-mark', () => {
  test('matches /mark prefix (slash form)', async () => {
    const router = makeRouter();
    const intent = await router.classify('/mark Johnny war der Vorgänger');
    assertEqual(intent.type, 'memory-mark');
  });

  test('matches German "merk dir"', async () => {
    const router = makeRouter();
    const intent = await router.classify('merk dir das bitte');
    assertEqual(intent.type, 'memory-mark');
  });

  test('matches English "remember this"', async () => {
    const router = makeRouter();
    const intent = await router.classify('Remember this moment');
    assertEqual(intent.type, 'memory-mark');
  });

  test('matches "erinnere dich an"', async () => {
    const router = makeRouter();
    const intent = await router.classify('erinnere dich an diesen Moment');
    assertEqual(intent.type, 'memory-mark');
  });
});

describe('v7.3.2 — IntentRouter: memory-list', () => {
  test('matches /memories prefix', async () => {
    const router = makeRouter();
    const intent = await router.classify('/memories');
    assertEqual(intent.type, 'memory-list');
  });

  test('matches /mem shortcut', async () => {
    const router = makeRouter();
    const intent = await router.classify('/mem');
    assertEqual(intent.type, 'memory-list');
  });

  test('matches German "zeig deine Kernerinnerungen"', async () => {
    const router = makeRouter();
    const intent = await router.classify('zeig mir deine Kernerinnerungen');
    assertEqual(intent.type, 'memory-list');
  });

  test('matches "welche Kernerinnerungen"', async () => {
    const router = makeRouter();
    const intent = await router.classify('welche Kernerinnerungen hast du?');
    assertEqual(intent.type, 'memory-list');
  });
});

describe('v7.3.2 — IntentRouter: memory-veto', () => {
  test('matches /veto prefix', async () => {
    const router = makeRouter();
    const intent = await router.classify('/veto cm_test_1');
    assertEqual(intent.type, 'memory-veto');
  });

  test('matches "nicht als Kern"', async () => {
    const router = makeRouter();
    const intent = await router.classify('das ist nicht als kern wichtig');
    assertEqual(intent.type, 'memory-veto');
  });
});

describe('v7.3.2 — IntentRouter: does not collide with other intents', () => {
  test('"remember this" does not trigger self-inspect', async () => {
    const router = makeRouter();
    const intent = await router.classify('Remember this about your architecture');
    // Should be memory-mark, not self-inspect
    assertEqual(intent.type, 'memory-mark');
  });

  test('plain greeting still works', async () => {
    const router = makeRouter();
    const intent = await router.classify('hallo');
    assertEqual(intent.type, 'greeting');
  });
});

run();
