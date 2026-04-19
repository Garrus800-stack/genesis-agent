// ============================================================
// Test: IntentRouter memory-mark/list/veto intents
// v7.3.4: Memory intents match ONLY on slash-commands.
// Free-text phrases must NOT trigger memory actions —
// they should fall through to 'general' and go to the LLM.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const { IntentRouter } = require('../../src/agent/intelligence/IntentRouter');

function makeRouter() {
  const router = new IntentRouter({ bus: null });
  router.llmEnabled = false; // force regex-only for determinism
  return router;
}

describe('IntentRouter: memory-mark (slash-only)', () => {
  test('matches /mark prefix', async () => {
    const router = makeRouter();
    const intent = await router.classify('/mark Johnny war der Vorgänger');
    assertEqual(intent.type, 'memory-mark');
  });

  test('does NOT match German "merk dir"', async () => {
    const router = makeRouter();
    const intent = await router.classify('merk dir das bitte');
    assertEqual(intent.type, 'general');
  });

  test('does NOT match English "remember this"', async () => {
    const router = makeRouter();
    const intent = await router.classify('Remember this moment');
    assertEqual(intent.type, 'general');
  });

  test('does NOT match "erinnere dich an"', async () => {
    const router = makeRouter();
    const intent = await router.classify('erinnere dich an diesen Moment');
    assertEqual(intent.type, 'general');
  });
});

describe('IntentRouter: memory-list (slash-only)', () => {
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

  test('does NOT match "zeig deine Kernerinnerungen"', async () => {
    const router = makeRouter();
    const intent = await router.classify('zeig mir deine Kernerinnerungen');
    assertEqual(intent.type, 'general');
  });

  test('does NOT match "welche Kernerinnerungen"', async () => {
    const router = makeRouter();
    const intent = await router.classify('welche Kernerinnerungen hast du?');
    assertEqual(intent.type, 'general');
  });
});

describe('IntentRouter: memory-veto (slash-only)', () => {
  test('matches /veto prefix', async () => {
    const router = makeRouter();
    const intent = await router.classify('/veto cm_test_1');
    assertEqual(intent.type, 'memory-veto');
  });

  test('does NOT match "nicht als Kern"', async () => {
    const router = makeRouter();
    const intent = await router.classify('das ist nicht als kern wichtig');
    assertEqual(intent.type, 'general');
  });

  test('does NOT match "das will ich nicht sehen"', async () => {
    const router = makeRouter();
    const intent = await router.classify('das will ich nicht sehen');
    assertEqual(intent.type, 'general');
  });

  test('does NOT match "in worten"', async () => {
    const router = makeRouter();
    const intent = await router.classify('in worten');
    assertEqual(intent.type, 'general');
  });
});

describe('IntentRouter: does not hijack conversational phrases', () => {
  test('"was möchtest du machen" stays general', async () => {
    const router = makeRouter();
    const intent = await router.classify('was möchtest du machen?');
    assertEqual(intent.type, 'general');
  });

  test('plain greeting still works', async () => {
    const router = makeRouter();
    const intent = await router.classify('hallo');
    assertEqual(intent.type, 'greeting');
  });
});

run();
