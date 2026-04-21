// ============================================================
// v7.3.6 — Slash-Discipline LLM-Guard
//
// Tests the post-classification guard that prevents LLM/LocalClassifier
// from bypassing slash-discipline. The original #1 implementation only
// fixed the sync regex path (INTENT_DEFINITIONS), but classifyAsync()
// also consults a local fuzzy classifier and an LLM, both of which
// route "kannst du mir deine settings geben" → settings semantically.
//
// Garrus caught this live on Windows after the v7.3.6 release.
// This test locks the fix: no slash-command intent may be returned
// from classifyAsync() unless the user's message contains a '/'.
// ============================================================

'use strict';

const assert = require('assert');
const { describe, test, run } = require('../harness');

const { IntentRouter } = require('../../src/agent/intelligence/IntentRouter');
const { allCommandNames } = require('../../src/agent/intelligence/slash-commands');

describe('#1 Slash-Discipline: sync regex path (classify)', () => {
  const r = new IntentRouter();

  // Every slash-command tested with a free-text variant that previously leaked.
  const leakCases = [
    // journal (had keyword-imperative regex until v7.3.6 regex-fix)
    { input: 'zeig mir dein tagebuch',                       expectNot: 'journal' },
    { input: 'show me the journal please',                   expectNot: 'journal' },
    { input: 'list journal entries',                         expectNot: 'journal' },
    // plans (had keyword-imperative regex until v7.3.6 regex-fix)
    { input: 'zeig mir deine plans',                         expectNot: 'plans' },
    { input: 'show me the plans',                            expectNot: 'plans' },
    { input: 'list plans',                                   expectNot: 'plans' },
    { input: 'zeig mir deinen plan',                         expectNot: 'plans' },
    // settings (had keyword-imperative regex until v7.3.6 regex-fix)
    { input: 'zeig mir settings',                            expectNot: 'settings' },
    { input: 'show settings',                                expectNot: 'settings' },
    { input: 'open settings',                                expectNot: 'settings' },
    { input: 'öffne die einstellungen',                      expectNot: 'settings' },
    { input: 'kannst du mir deine settings geben',           expectNot: 'settings' },
    // 9 slash-only handlers from v7.3.6 #1 — regression tests
    { input: 'zeig mir deine module',                        expectNot: 'self-inspect' },
    { input: 'kannst du dich selbst inspizieren',            expectNot: 'self-inspect' },
    { input: 'reflect on your weaknesses',                   expectNot: 'self-reflect' },
    { input: 'modifiziere deinen code',                      expectNot: 'self-modify' },
    { input: 'repariere dich selbst',                        expectNot: 'self-repair' },
    { input: 'erstelle einen neuen skill',                   expectNot: 'create-skill' },
    { input: 'analyze this code',                            expectNot: 'analyze-code' },
    { input: 'clone yourself',                               expectNot: 'clone' },
    { input: 'starte den daemon',                            expectNot: 'daemon' },
    { input: 'scan peer network',                            expectNot: 'peer' },
  ];

  for (const { input, expectNot } of leakCases) {
    test(`free-text "${input}" does NOT trigger ${expectNot}`, () => {
      const result = r.classify(input);
      assert.notStrictEqual(result.type, expectNot,
        `leaked to ${expectNot}: ${JSON.stringify(result)}`);
    });
  }

  // Slash-commands must still work — including embedded.
  const passCases = [
    { input: '/settings',                          expect: 'settings' },
    { input: '/einstellungen',                     expect: 'settings' },
    { input: '/journal',                           expect: 'journal' },
    { input: '/tagebuch',                          expect: 'journal' },
    { input: '/plans',                             expect: 'plans' },
    { input: '/plan',                              expect: 'plans' },
    { input: '/vorhaben',                          expect: 'plans' },
    { input: '/self-inspect',                      expect: 'self-inspect' },
    { input: '/self-reflect',                      expect: 'self-reflect' },
    { input: '/daemon',                            expect: 'daemon' },
    { input: 'kannst du mal /settings öffnen',     expect: 'settings' },
    { input: 'bitte /self-inspect ausführen',      expect: 'self-inspect' },
  ];

  for (const { input, expect } of passCases) {
    test(`slash-command "${input}" routes to ${expect}`, () => {
      const result = r.classify(input);
      assert.strictEqual(result.type, expect);
    });
  }

  // API-key auto-setup is an explicit exception kept intentionally.
  test('API-key paste pattern still routes to settings (intentional)', () => {
    const r2 = new IntentRouter();
    const res = r2.classify('Anthropic API-Key: sk-ant-xyz123');
    assert.strictEqual(res.type, 'settings');
  });
});

describe('#1 Slash-Discipline: async path guard (classifyAsync)', () => {
  // The critical bug: an LLM that semantically classifies "settings" from
  // free text. The guard must rewrite any slash-command verdict to 'general'
  // when the message has no '/'.

  test('evil-LLM verdict "settings" on free-text gets rewritten to general', async () => {
    const r = new IntentRouter();
    r.setModel({
      chat: async () => 'INTENT: settings\nCONFIDENCE: 0.9',
    });
    r.llmEnabled = true;
    const result = await r.classifyAsync('kannst du mir deine settings geben');
    assert.strictEqual(result.type, 'general',
      `LLM-bypass re-enabled — got ${JSON.stringify(result)}`);
  });

  test('evil-LLM verdict "journal" on free-text gets rewritten to general', async () => {
    const r = new IntentRouter();
    r.setModel({
      chat: async () => 'INTENT: journal\nCONFIDENCE: 0.95',
    });
    r.llmEnabled = true;
    const result = await r.classifyAsync('was hast du heute erlebt');
    assert.strictEqual(result.type, 'general');
  });

  test('evil-LLM verdict "plans" on free-text gets rewritten to general', async () => {
    const r = new IntentRouter();
    r.setModel({
      chat: async () => 'INTENT: plans\nCONFIDENCE: 0.95',
    });
    r.llmEnabled = true;
    const result = await r.classifyAsync('welche pläne hast du');
    assert.strictEqual(result.type, 'general');
  });

  // All 13 slash-only intents: simulate evil LLM for each, verify all block.
  for (const name of allCommandNames()) {
    test(`evil-LLM verdict "${name}" on free-text gets rewritten to general`, async () => {
      const r = new IntentRouter();
      r.setModel({
        chat: async () => `INTENT: ${name}\nCONFIDENCE: 0.9`,
      });
      r.llmEnabled = true;
      // A message with NO slash, semantically about the intent
      const result = await r.classifyAsync('erzähl mir bitte davon');
      assert.strictEqual(result.type, 'general',
        `slash-only intent "${name}" was returned from async path without slash`);
    });
  }

  test('slash-command with actual / still passes through async path', async () => {
    const r = new IntentRouter();
    r.setModel({
      chat: async () => 'INTENT: general\nCONFIDENCE: 0.5',
    });
    r.llmEnabled = true;
    // Regex path hits first (confidence 1.0), LLM never consulted
    const result = await r.classifyAsync('/settings');
    assert.strictEqual(result.type, 'settings');
  });

  test('LocalClassifier learned-sample for slash-intent is also filtered', async () => {
    const r = new IntentRouter();
    // No LLM — only LocalClassifier path exercised
    r.llmEnabled = false;
    // Fake a LocalClassifier that votes settings confidently
    r._localClassifier = {
      classify: () => ({ type: 'settings', confidence: 0.8 }),
      addSample: () => {},
    };
    const result = await r.classifyAsync('gib mir deine konfiguration');
    assert.strictEqual(result.type, 'general',
      `LocalClassifier bypass re-enabled — got ${JSON.stringify(result)}`);
  });
});

describe('#1 Slash-Discipline: guard does not affect non-slash intents', () => {
  test('greeting passes through async path unchanged', async () => {
    const r = new IntentRouter();
    r.setModel({ chat: async () => 'INTENT: greeting\nCONFIDENCE: 0.9' });
    r.llmEnabled = true;
    const result = await r.classifyAsync('Hallo Genesis');
    assert.strictEqual(result.type, 'greeting');
  });

  test('execute-code passes through when content is code', async () => {
    const r = new IntentRouter();
    const result = await r.classifyAsync('```js\nconsole.log("hi")\n```');
    assert.strictEqual(result.type, 'execute-code');
  });
});

run();
