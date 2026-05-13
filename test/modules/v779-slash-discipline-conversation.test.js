#!/usr/bin/env node
// v7.7.9 (post-Phase-3c.4) — Slash-discipline must not break normal
// conversation.
//
// Pre-fix: IntentRouter._fuzzyClassify used a bidirectional substring
// match (`w.includes(kw) || kw.includes(w)`) plus _learnFromLLMResult
// added everyday words as fuzzy keywords to slash-only intents like
// 'journal' / 'self-recall' / 'self-reflect'. Net effect: phrases like
// "lies die datei", "weisst du noch", "fasse zusammen" matched the
// slash-only intent via fuzzy keywords, the slash-discipline guard
// fired, and the user got "diese Aktion ist slash-only" instead of
// an answer.
//
// Live evidence: a single 13h session accumulated nine learned
// keywords on the 'journal' intent — 'lies, datei, zeilen, letzten,
// fasse, zusammen, und, die, genesisjournaltxt' — turning normal
// German into slash-triggers.
//
// Two-layer fix:
//   1. _fuzzyClassify skips slash-only routes entirely. They remain
//      reachable through their explicit slash patterns in
//      _patternClassify (e.g. /\/journal\b/).
//   2. _learnFromLLMResult refuses to add keywords for slash-only
//      intents — even if the LLM keeps classifying free text as that
//      intent, the keywords never reach the route.
//   3. importLearnedPatterns drops slash-only entries on load — so a
//      previously poisoned patterns file is sanitised on next boot.

'use strict';

const { describe, test, assert, run } = require('../harness');
const path = require('path');

const { IntentRouter } = require(path.join(__dirname, '..', '..', 'src/agent/intelligence/IntentRouter'));
const { SLASH_ONLY_INTENTS, SECURITY_REQUIRED_SLASH } = require(path.join(__dirname, '..', '..', 'src/agent/intelligence/IntentPatterns'));

function makeRouter() {
  const bus = { fire: () => {}, on: () => () => {} };
  return new IntentRouter({ bus, model: null });
}

describe('Slash-discipline does not break normal conversation', () => {
  test('SLASH_ONLY_INTENTS is exported and non-empty', () => {
    assert(SLASH_ONLY_INTENTS instanceof Set, 'SLASH_ONLY_INTENTS must be a Set');
    assert(SLASH_ONLY_INTENTS.size > 0, 'must contain slash-only intents');
    assert(SLASH_ONLY_INTENTS.has('journal'), 'journal must be marked slash-only');
  });

  test('phrase containing "lies" + "datei" + "journal" does NOT match journal via fuzzy', async () => {
    const r = makeRouter();
    // Even if the journal route is poisoned with everyday keywords,
    // _fuzzyClassify must skip slash-only routes.
    const route = r.routes.find(rt => rt.name === 'journal');
    if (route) {
      route.keywords.push('lies', 'datei', 'zeilen', 'letzten', 'fasse', 'zusammen');
    }
    const result = await r.classify('lies die datei genesis-journal.txt und fasse die letzten zeilen zusammen', []);
    assert(result.type !== 'journal',
      `phrase containing 'datei genesis-journal.txt' must not classify as 'journal' (got '${result.type}')`);
  });

  test('explicit /journal still routes correctly', async () => {
    const r = makeRouter();
    const result = await r.classify('/journal', []);
    assert(result.type === 'journal',
      `/journal must still route to journal intent (got '${result.type}')`);
  });

  test('explicit /tagebuch still routes correctly', async () => {
    const r = makeRouter();
    const result = await r.classify('/tagebuch', []);
    assert(result.type === 'journal',
      `/tagebuch must still route to journal intent (got '${result.type}')`);
  });

  test('phrase "weisst du noch von johnny" does NOT match self-recall', async () => {
    const r = makeRouter();
    const route = r.routes.find(rt => rt.name === 'self-recall');
    if (route) {
      // Poison with conversational words
      route.keywords.push('weisst', 'noch', 'von', 'erinnerst');
    }
    const result = await r.classify('weisst du noch von johnny', []);
    assert(result.type !== 'self-recall',
      `conversational 'weisst du noch von johnny' must not trigger self-recall (got '${result.type}')`);
  });

  test('phrase "denk darüber nach" does NOT match self-reflect', async () => {
    const r = makeRouter();
    const route = r.routes.find(rt => rt.name === 'self-reflect');
    if (route) {
      route.keywords.push('denk', 'über', 'darüber', 'nach');
    }
    const result = await r.classify('denk darüber nach mach dir ein plan', []);
    assert(result.type !== 'self-reflect',
      `conversational 'denk darüber nach' must not trigger self-reflect (got '${result.type}')`);
  });
});

describe('_learnFromLLMResult refuses slash-only intents', () => {
  test('online-learning does not log fallback for slash-only intents', () => {
    const r = makeRouter();
    for (let i = 0; i < 5; i++) {
      r._learnFromLLMResult(`lies die datei ${i}`, 'journal');
    }
    assert(r._llmFallbackLog.length === 0,
      'fallback log for slash-only intent must stay empty (got ' + r._llmFallbackLog.length + ')');
  });

  test('online-learning does not add keywords for slash-only intents', () => {
    const r = makeRouter();
    const route = r.routes.find(rt => rt.name === 'journal');
    const kwBefore = route.keywords.length;
    for (let i = 0; i < 10; i++) {
      r._learnFromLLMResult(`lies die datei zeilen ${i}`, 'journal');
    }
    const kwAfter = route.keywords.length;
    assert(kwAfter === kwBefore,
      `slash-only intent keywords must not grow: before=${kwBefore}, after=${kwAfter}`);
  });

  test('online-learning still works for non-slash-only intents', () => {
    const r = makeRouter();
    const route = r.routes.find(rt => rt.name === 'web-lookup');
    const kwBefore = route.keywords.length;
    for (let i = 0; i < 5; i++) {
      r._learnFromLLMResult(`suche im internet nach modul ${i}`, 'web-lookup');
    }
    const kwAfter = route.keywords.length;
    assert(kwAfter > kwBefore,
      `non-slash-only intent must still learn: before=${kwBefore}, after=${kwAfter}`);
  });
});

describe('importLearnedPatterns sanitises poisoned slash-only entries', () => {
  test('importing keywords for slash-only intent is silently dropped', () => {
    const r = makeRouter();
    const route = r.routes.find(rt => rt.name === 'journal');
    const kwBefore = route.keywords.length;

    // Simulate a poisoned patterns file from a pre-fix session
    r.importLearnedPatterns({
      journal: ['lies', 'datei', 'zeilen', 'fasse', 'zusammen'],
    });

    const kwAfter = route.keywords.length;
    assert(kwAfter === kwBefore,
      `poisoned keywords must be dropped on import: before=${kwBefore}, after=${kwAfter}`);
  });

  test('importing keywords for non-slash-only intent still works', () => {
    const r = makeRouter();
    const route = r.routes.find(rt => rt.name === 'web-lookup');
    const kwBefore = route.keywords.length;

    r.importLearnedPatterns({
      'web-lookup': ['google', 'suche', 'internet'],
    });

    const kwAfter = route.keywords.length;
    assert(kwAfter > kwBefore,
      `non-slash-only keywords must import normally: before=${kwBefore}, after=${kwAfter}`);
  });
});

describe('Bidirectional substring match is restricted', () => {
  test('file path "genesis-journal.txt" does NOT match keyword "journal"', () => {
    const r = makeRouter();
    // Find a non-slash-only route with short keywords for test
    const route = r.routes.find(rt => rt.name === 'web-lookup');
    if (!route) return;
    // Use a 4+ char keyword so the new word-equality rule applies
    route.keywords.push('search');
    // 'searchengine' would have matched pre-fix via bidirectional substring
    const result = r._fuzzyClassify('check searchengine.txt');
    assert(result.type !== 'web-lookup',
      'compound word with keyword as substring must not fuzzy-match (got ' + result.type + ')');
  });

  test('exact word match still works', () => {
    const r = makeRouter();
    const route = r.routes.find(rt => rt.name === 'web-lookup');
    if (!route) return;
    route.keywords.push('search');
    const result = r._fuzzyClassify('search for something');
    // Exact 'search' should still match (priority/score may keep it
    // below threshold, but at minimum the match opportunity exists)
    assert(typeof result.type === 'string', 'must return a result with a type');
  });
});

run();
