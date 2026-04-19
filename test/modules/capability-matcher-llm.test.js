// ============================================================
// Test: CapabilityMatcher LLM grey-zone resolver (v7.3.3)
//
// When Jaccard scoring lands in the grey zone (0.4-0.8), the LLM
// decides semantically whether the new goal is a duplicate.
// This replaces the "conservative pass" that let lexically-similar
// but semantically-distinct goals slip through (and conversely let
// lexically-distant semantic duplicates pass unchecked).
//
// The resolver is a pure async function that:
//   - returns 'block' for LLM verdict DUPLICATE
//   - returns 'pass' for LLM verdict NOT_DUPLICATE
//   - returns 'grey' (conservative fallback) if LLM unavailable,
//     times out, or produces unparseable output
// ============================================================

'use strict';

const { describe, test, assert, assertIncludes, run } = require('../harness');
const { resolveGreyWithLLM } = require('../../src/agent/planning/CapabilityMatcher');

function makeModel({ response = '', throws = false, delayMs = 0 } = {}) {
  return {
    chat: async (prompt, msgs, role) => {
      if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
      if (throws) throw new Error('llm-failure');
      return response;
    },
    _lastPrompt: null,
  };
}

function makeCapturingModel(response = 'VERDICT: NOT_DUPLICATE\nREASON: different subsystem') {
  const captured = { prompt: null };
  const model = {
    chat: async (prompt) => {
      captured.prompt = prompt;
      return response;
    },
  };
  return { model, captured };
}

const mockMatched = {
  id: 'homeostasis',
  name: 'Homeostatic Regulation',
  description: 'Maintains energy, curiosity, and drive within safe bounds.',
  keywords: ['homeostasis', 'energy', 'regulation', 'balance'],
};

// ── Happy-path: LLM resolves grey cleanly ─────────
describe('v7.3.3 — resolveGreyWithLLM: parses LLM verdicts', () => {
  test('DUPLICATE verdict → decision=block', async () => {
    const model = makeModel({ response: 'VERDICT: DUPLICATE\nREASON: same homeostasis concern' });
    const r = await resolveGreyWithLLM({
      description: 'Add homeostatic throttling for drive saturation',
      matched: mockMatched, score: 0.55, model,
    });
    assert(r.decision === 'block', `expected block, got ${r.decision}`);
    assertIncludes(r.reason, 'homeostasis', 'reason should include LLM explanation');
  });

  test('NOT_DUPLICATE verdict → decision=pass', async () => {
    const model = makeModel({ response: 'VERDICT: NOT_DUPLICATE\nREASON: different subsystem — this is about vectors' });
    const r = await resolveGreyWithLLM({
      description: 'Add vector embedding cache for episodic recall',
      matched: mockMatched, score: 0.45, model,
    });
    assert(r.decision === 'pass', `expected pass, got ${r.decision}`);
    assertIncludes(r.reason, 'vector', 'reason should include LLM explanation');
  });

  test('case-insensitive verdict parsing', async () => {
    const model = makeModel({ response: 'verdict: duplicate\nreason: semantically equivalent' });
    const r = await resolveGreyWithLLM({
      description: 'X', matched: mockMatched, score: 0.5, model,
    });
    assert(r.decision === 'block', 'lowercase verdict should still parse');
  });
});

// ── Fallback paths ─────────────────────────────────
describe('v7.3.3 — resolveGreyWithLLM: falls back to grey on failure', () => {
  test('no model → decision=grey with reason=no-llm', async () => {
    const r = await resolveGreyWithLLM({
      description: 'X', matched: mockMatched, score: 0.5, model: null,
    });
    assert(r.decision === 'grey', 'no model → grey');
    assert(r.reason === 'no-llm', `reason should be no-llm, got ${r.reason}`);
  });

  test('model without chat method → grey', async () => {
    const r = await resolveGreyWithLLM({
      description: 'X', matched: mockMatched, score: 0.5, model: {},
    });
    assert(r.decision === 'grey', 'broken model → grey');
  });

  test('no matched capability → grey', async () => {
    const model = makeModel({ response: 'VERDICT: DUPLICATE\nREASON: x' });
    const r = await resolveGreyWithLLM({
      description: 'X', matched: null, score: 0.5, model,
    });
    assert(r.decision === 'grey', 'no matched → grey');
    assert(r.reason === 'no-matched-capability', `got ${r.reason}`);
  });

  test('LLM throws → grey with llm-error reason', async () => {
    const model = makeModel({ throws: true });
    const r = await resolveGreyWithLLM({
      description: 'X', matched: mockMatched, score: 0.5, model,
    });
    assert(r.decision === 'grey', 'llm error → grey');
    assertIncludes(r.reason, 'llm-error', `got ${r.reason}`);
  });

  test('LLM returns unparseable text → grey', async () => {
    const model = makeModel({ response: 'I cannot decide this, sorry' });
    const r = await resolveGreyWithLLM({
      description: 'X', matched: mockMatched, score: 0.5, model,
    });
    assert(r.decision === 'grey', 'unparseable → grey');
    assert(r.reason === 'llm-parse-failed', `got ${r.reason}`);
  });

  test('LLM timeout → grey', async () => {
    const model = makeModel({ response: 'VERDICT: DUPLICATE', delayMs: 500 });
    const r = await resolveGreyWithLLM({
      description: 'X', matched: mockMatched, score: 0.5, model,
      timeoutMs: 100,
    });
    assert(r.decision === 'grey', 'timeout → grey');
    assertIncludes(r.reason, 'timeout', `got ${r.reason}`);
  });
});

// ── Prompt construction ───────────────────────────
describe('v7.3.3 — resolveGreyWithLLM: prompt contains required context', () => {
  test('prompt includes both goal descriptions', async () => {
    const { model, captured } = makeCapturingModel();
    await resolveGreyWithLLM({
      description: 'Add vector cache for faster retrieval',
      matched: mockMatched, score: 0.52, model,
    });
    assertIncludes(captured.prompt, 'vector cache', 'new goal description present');
    assertIncludes(captured.prompt, 'Homeostatic', 'existing capability name present');
    assertIncludes(captured.prompt, 'Maintains energy', 'existing capability description present');
    assertIncludes(captured.prompt, '0.52', 'lexical score surfaced to LLM');
  });

  test('prompt instructs LLM against lexical-only judgment', async () => {
    const { model, captured } = makeCapturingModel();
    await resolveGreyWithLLM({
      description: 'X', matched: mockMatched, score: 0.5, model,
    });
    assertIncludes(captured.prompt, 'sharing vocabulary', 'must warn against vocab-only');
    assertIncludes(captured.prompt, 'NOT automatically duplicates', 'must disambiguate overlap vs dup');
  });

  test('prompt requires structured output', async () => {
    const { model, captured } = makeCapturingModel();
    await resolveGreyWithLLM({
      description: 'X', matched: mockMatched, score: 0.5, model,
    });
    assertIncludes(captured.prompt, 'VERDICT:', 'requires verdict line');
    assertIncludes(captured.prompt, 'REASON:', 'requires reason line');
  });
});

// ── Integration with match() decisions ─────────────
describe('v7.3.3 — resolveGreyWithLLM: edge cases', () => {
  test('matched cap with no keywords still works', async () => {
    const model = makeModel({ response: 'VERDICT: NOT_DUPLICATE\nREASON: ok' });
    const r = await resolveGreyWithLLM({
      description: 'X',
      matched: { id: 'cap1', name: 'Cap', description: 'D', keywords: [] },
      score: 0.5, model,
    });
    assert(r.decision === 'pass', 'should handle empty keywords');
  });

  test('matched cap with no description still works', async () => {
    const model = makeModel({ response: 'VERDICT: DUPLICATE\nREASON: identical' });
    const r = await resolveGreyWithLLM({
      description: 'X',
      matched: { id: 'cap1', name: 'Cap', keywords: ['k1'] },
      score: 0.5, model,
    });
    assert(r.decision === 'block', 'should handle missing description');
  });

  test('very long description is truncated (no crash)', async () => {
    const model = makeModel({ response: 'VERDICT: NOT_DUPLICATE\nREASON: ok' });
    const r = await resolveGreyWithLLM({
      description: 'X'.repeat(10000),
      matched: mockMatched, score: 0.5, model,
    });
    assert(r.decision === 'pass', 'should not crash on oversized input');
  });
});

run();
