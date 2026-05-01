// ============================================================
// Test: /recall slash command (v7.5.5)
//
// Verifies:
//   - Intent-classifier maps /recall to self-recall
//   - Slash-Discipline guard rewrites bare 'recall' to general
//   - selfRecall handler reads the log and formats output
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { describe, test, assertEqual, assert, assertIncludes, run } = require('../harness');
const { SelfStatementLog } = require('../../src/agent/cognitive/SelfStatementLog');
const { commandHandlersSelf } = require('../../src/agent/hexagonal/CommandHandlersSelf');
const { IntentRouter } = require('../../src/agent/intelligence/IntentRouter');

function freshDir() {
  const dir = path.join(os.tmpdir(), 'genesis-stmt-recall-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function mockBus() {
  return { fire: () => {}, emit: () => {}, on: () => () => {} };
}

function makeContextWithLog(records = []) {
  const log = new SelfStatementLog({
    bus: mockBus(),
    storageDir: freshDir(),
    flushDebounceMs: 0,
  });
  // Seed the log with provided records
  for (const r of records) {
    log._writeQueue.push({
      ts: r.ts || new Date().toISOString(),
      text: r.text,
      type: r.type || 'uncertain',
      confidence: r.confidence || 0.5,
      intent: r.intent || 'general',
      introspectionPopulated: r.introspectionPopulated !== undefined
        ? r.introspectionPopulated : false,
      userMessageHash: r.userMessageHash || 'abcd1234',
    });
  }
  log._flush();
  return {
    selfStatementLog: log,
    lang: { current: 'en', t: (k) => k },
  };
}

// ────────────────────────────────────────────────────────
// Intent classification
// ────────────────────────────────────────────────────────

describe('/recall: intent classification', () => {
  test('/recall maps to self-recall', async () => {
    const router = new IntentRouter();
    const intent = await router.classifyAsync('/recall');
    assertEqual(intent.type, 'self-recall');
  });

  test('/recall structural maps to self-recall', async () => {
    const router = new IntentRouter();
    const intent = await router.classifyAsync('/recall structural');
    assertEqual(intent.type, 'self-recall');
  });

  test('bare "recall" without slash is rewritten to general', async () => {
    const router = new IntentRouter();
    const intent = await router.classifyAsync('recall what I said');
    // Slash-Discipline should kick in: no /, so falls back to general.
    assert(intent.type !== 'self-recall', 'must not be self-recall without slash');
  });
});

// ────────────────────────────────────────────────────────
// Handler behavior
// ────────────────────────────────────────────────────────

describe('/recall: handler behavior', () => {
  test('returns "not available" when selfStatementLog missing', async () => {
    const ctx = { selfStatementLog: null, lang: { current: 'en', t: (k) => k } };
    const out = await commandHandlersSelf.selfRecall.call(ctx, '/recall');
    assert(out.includes('not currently available') || out.includes('nicht verfügbar'));
  });

  test('returns empty-state message when log has nothing', async () => {
    const ctx = makeContextWithLog([]);
    const out = await commandHandlersSelf.selfRecall.call(ctx, '/recall');
    assert(out.toLowerCase().includes('no matching') || out.toLowerCase().includes('noch keine'));
  });

  test('returns formatted lines with type + dataMarker', async () => {
    const ctx = makeContextWithLog([{
      text: 'Mein Modul X ist hier',
      type: 'strukturell',
      introspectionPopulated: false,
    }]);
    const out = await commandHandlersSelf.selfRecall.call(ctx, '/recall');
    assertIncludes(out, 'strukturell');
    assertIncludes(out, 'no-data');
    assertIncludes(out, 'Mein Modul X');
  });

  test('shows ✓verified marker when introspection was populated', async () => {
    const ctx = makeContextWithLog([{
      text: 'Mein Modul Y ist verifiziert',
      type: 'strukturell',
      introspectionPopulated: true,
    }]);
    const out = await commandHandlersSelf.selfRecall.call(ctx, '/recall');
    assertIncludes(out, '✓verified');
  });

  test('filters by type argument', async () => {
    const ctx = makeContextWithLog([
      { text: 'Mein Modul A',     type: 'strukturell' },
      { text: 'Ich freue mich B', type: 'emotional' },
    ]);
    const outStruct = await commandHandlersSelf.selfRecall.call(ctx, '/recall structural');
    assertIncludes(outStruct, 'Mein Modul A');
    assert(!outStruct.includes('Ich freue mich B'), 'emotional excluded');

    const outEmo = await commandHandlersSelf.selfRecall.call(ctx, '/recall emotional');
    assertIncludes(outEmo, 'Ich freue mich B');
    assert(!outEmo.includes('Mein Modul A'), 'structural excluded');
  });

  test('respects numeric limit argument', async () => {
    const ctx = makeContextWithLog([
      { text: 'A statement here',  type: 'strukturell' },
      { text: 'B statement here',  type: 'strukturell' },
      { text: 'C statement here',  type: 'strukturell' },
      { text: 'D statement here',  type: 'strukturell' },
      { text: 'E statement here',  type: 'strukturell' },
    ]);
    const out = await commandHandlersSelf.selfRecall.call(ctx, '/recall 2');
    // Header: "Last 2 self-statements" + 2 records → 4 lines (incl. blank)
    const lines = out.split('\n').filter(l => l.includes('statement here'));
    assertEqual(lines.length, 2);
  });

  test('output language follows lang.current', async () => {
    const ctx = makeContextWithLog([{ text: 'Mein Modul X', type: 'strukturell' }]);
    ctx.lang.current = 'de';
    const out = await commandHandlersSelf.selfRecall.call(ctx, '/recall');
    assertIncludes(out, 'Self-Statements');
  });
});

run();
