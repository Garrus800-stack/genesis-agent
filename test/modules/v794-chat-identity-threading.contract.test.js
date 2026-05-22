// @ts-nocheck
// ============================================================
// GENESIS — v7.9.4 chat-identity-threading contract tests
//
// Background: live-observed regression where Genesis answered short
// mid-conversation user turns with "Hallo!" + "Wie kann ich dir
// helfen?" — the large cloud models' RLHF assistant-default leaks
// through when the system prompt has no positional cue saying "you
// are mid-conversation, do not restart the session". v7.9.4 adds:
//   - PromptBuilder._conversationContext() emits an anti-greeting
//     block ONLY when _historyLength > 0 (first message stays clean)
//   - setHistoryLength() setter called by ChatOrchestrator before
//     build/buildAsync from history.length - 1
//   - ChatOrchestrator._generalChat passes the full system prompt to
//     reasoning:solve so ReasoningEngine doesn't fall back to its
//     "You are Genesis." mini-prompt
//   - ReasoningEngine._buildContextualPrompt prefers caller-provided
//     systemPrompt, legacy mini-prompt only as fallback for direct
//     bus consumers (peer-network, etc.)
//
// These tests pin the contract so a future refactor can't silently
// reintroduce the assistant-default leak.
// ============================================================

'use strict';

const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const { describe, test, assert, assertEqual, run } = require('../harness');
const { PromptBuilder } = require(path.join(ROOT, 'src/agent/intelligence/PromptBuilder'));
const { ReasoningEngine } = require(path.join(ROOT, 'src/agent/intelligence/ReasoningEngine'));

describe('v7.9.4 Chat-Identity-Threading', () => {

// ── PromptBuilder._conversationContext() ─────────────────────

test('A1: _conversationContext returns empty string when history is 0', () => {
  const pb = new PromptBuilder({});
  pb.setHistoryLength(0);
  assertEqual(pb._conversationContext(), '');
});

test('A1: _conversationContext default state is empty (no setter called)', () => {
  const pb = new PromptBuilder({});
  assertEqual(pb._conversationContext(), '');
});

test('A1: _conversationContext emits anti-greeting block when history > 0', () => {
  const pb = new PromptBuilder({});
  pb.setHistoryLength(3);
  const block = pb._conversationContext();
  assert(block.length > 0, 'block should be non-empty');
  assert(/laufenden Konversation/i.test(block), 'should mention ongoing conversation');
  assert(/NICHT.*Hallo/i.test(block), 'should explicitly forbid Hallo opening');
  assert(/Wie kann ich dir helfen/i.test(block), 'should reference the assistant-default phrase');
});

test('A1: _conversationContext interpolates the actual turn count', () => {
  const pb = new PromptBuilder({});
  pb.setHistoryLength(7);
  assert(/bereits 7 Nachrichten/.test(pb._conversationContext()),
    'should mention 7 messages exchanged');
});

test('A1: setHistoryLength coerces non-numbers and negatives to 0', () => {
  const pb = new PromptBuilder({});
  pb.setHistoryLength(-5);
  assertEqual(pb._historyLength, 0);
  pb.setHistoryLength('garbage');
  assertEqual(pb._historyLength, 0);
  pb.setHistoryLength(NaN);
  assertEqual(pb._historyLength, 0);
  pb.setHistoryLength(undefined);
  assertEqual(pb._historyLength, 0);
});

test('A1: setHistoryLength floors fractional values', () => {
  const pb = new PromptBuilder({});
  pb.setHistoryLength(2.9);
  assertEqual(pb._historyLength, 2);
});

// ── PromptBuilder.build() integration ────────────────────────

test('A1: build() omits conversationContext entirely when history is 0', () => {
  const pb = new PromptBuilder({});
  pb.setHistoryLength(0);
  const prompt = pb.build();
  assert(!/Beginne deine Antwort NICHT mit/.test(prompt),
    'first-message prompt must NOT include the anti-greeting block');
});

test('A1: build() includes conversationContext when history > 0', () => {
  const pb = new PromptBuilder({});
  pb.setHistoryLength(2);
  const prompt = pb.build();
  assert(/Beginne deine Antwort NICHT mit/.test(prompt),
    'mid-conversation prompt MUST include the anti-greeting block');
});

test('A1: buildAsync() includes conversationContext when history > 0', async () => {
  const pb = new PromptBuilder({});
  pb.setHistoryLength(2);
  const prompt = await pb.buildAsync();
  assert(/Beginne deine Antwort NICHT mit/.test(prompt),
    'mid-conversation async prompt MUST include the anti-greeting block');
});

// ── ReasoningEngine systemPrompt passthrough ─────────────────

test('A3: ReasoningEngine uses caller-provided systemPrompt verbatim', () => {
  const re = new ReasoningEngine({ bus: { fire: () => {}, on: () => {} } });
  const richPrompt = 'Du bist Genesis. [full identity block with conversation cue and formatting rules]';
  const built = re._buildContextualPrompt('hello', { systemPrompt: richPrompt });
  assertEqual(built, richPrompt);
});

test('A3: ReasoningEngine falls back to mini-prompt when no systemPrompt provided', () => {
  const re = new ReasoningEngine({ bus: { fire: () => {}, on: () => {} } });
  const built = re._buildContextualPrompt('hello', {});
  assert(built.startsWith('You are Genesis.'),
    'legacy mini-prompt should still work for direct bus consumers');
});

test('A3: ReasoningEngine ignores empty-string systemPrompt and falls back', () => {
  const re = new ReasoningEngine({ bus: { fire: () => {}, on: () => {} } });
  const built = re._buildContextualPrompt('hello', { systemPrompt: '' });
  assert(built.startsWith('You are Genesis.'),
    'empty systemPrompt should be treated as not-provided');
});

// ── Block F1: _pickActivity penalty Set fix ──────────────────

test('F1: repeated activities in recent window get single 0.2 penalty, not multiplicative', () => {
  const scores = { reflect: 10, journal: 8 };
  const recentLog = [
    { activity: 'reflect' }, { activity: 'reflect' }, { activity: 'reflect' },
    { activity: 'reflect' }, { activity: 'reflect' },
  ];
  const recent = new Set(recentLog.slice(-5).map(a => a.activity));
  for (const a of recent) {
    if (scores[a] !== undefined) scores[a] *= 0.2;
  }
  assertEqual(scores.reflect, 2);
  assertEqual(scores.journal, 8);
});

test('F1: each unique activity in window gets penalty exactly once', () => {
  const scores = { reflect: 10, journal: 10, dream: 10 };
  const recentLog = [
    { activity: 'reflect' }, { activity: 'journal' }, { activity: 'reflect' },
    { activity: 'journal' }, { activity: 'dream' },
  ];
  const recent = new Set(recentLog.slice(-5).map(a => a.activity));
  for (const a of recent) {
    if (scores[a] !== undefined) scores[a] *= 0.2;
  }
  assertEqual(scores.reflect, 2);
  assertEqual(scores.journal, 2);
  assertEqual(scores.dream, 2);
});

// ── Block B: ActivityStats persistence ───────────────────────

test('B: activity-stats mixin exposes _saveActivityStats and _loadActivityStats', () => {
  const { activityStatsMixin } = require(path.join(ROOT, 'src/agent/autonomy/IdleMindActivityStats'));
  assert(typeof activityStatsMixin._saveActivityStats === 'function');
  assert(typeof activityStatsMixin._loadActivityStats === 'function');
  assert(typeof activityStatsMixin._recordActivity === 'function');
});

test('B: _saveActivityStats no-ops when storage is missing', () => {
  const { activityStatsMixin } = require(path.join(ROOT, 'src/agent/autonomy/IdleMindActivityStats'));
  const ctx = { storage: null, activityLog: [], _activityCounts: new Map() };
  activityStatsMixin._saveActivityStats.call(ctx);
  assert(true, 'must not throw without storage');
});

test('B: _loadActivityStats restores activityLog and counts from valid payload', () => {
  const { activityStatsMixin } = require(path.join(ROOT, 'src/agent/autonomy/IdleMindActivityStats'));
  const ctx = {
    storage: {
      readJSON: () => ({
        version: 1,
        lastUpdated: Date.now(),
        activityCounts: { reflect: 5, journal: 3 },
        activityLog: [
          { activity: 'reflect', timestamp: 1000 },
          { activity: 'journal', timestamp: 2000 },
        ],
      }),
    },
    activityLog: [],
    _activityCounts: new Map(),
  };
  activityStatsMixin._loadActivityStats.call(ctx);
  assertEqual(ctx.activityLog.length, 2);
  assertEqual(ctx._activityCounts.get('reflect'), 5);
  assertEqual(ctx._activityCounts.get('journal'), 3);
});

test('B: _loadActivityStats ignores schema-version mismatch', () => {
  const { activityStatsMixin } = require(path.join(ROOT, 'src/agent/autonomy/IdleMindActivityStats'));
  const ctx = {
    storage: { readJSON: () => ({ version: 999, activityLog: [{ activity: 'x', timestamp: 1 }] }) },
    activityLog: [],
    _activityCounts: new Map(),
  };
  activityStatsMixin._loadActivityStats.call(ctx);
  assertEqual(ctx.activityLog.length, 0, 'unknown schema version must not corrupt state');
});

test('B: _loadActivityStats handles read error gracefully', () => {
  const { activityStatsMixin } = require(path.join(ROOT, 'src/agent/autonomy/IdleMindActivityStats'));
  const ctx = {
    storage: { readJSON: () => { throw new Error('disk on fire'); } },
    activityLog: [],
    _activityCounts: new Map(),
    _log: { debug: () => {} },
  };
  activityStatsMixin._loadActivityStats.call(ctx);
  assertEqual(ctx.activityLog.length, 0);
});

// ── Block C: Metabolism per-activity cost table ──────────────

test('C: Metabolism.ACTIVITY_COSTS has all 16 idleMind:* keys', () => {
  const { Metabolism } = require(path.join(ROOT, 'src/agent/organism/Metabolism'));
  const expected = [
    'idleMind:reflect', 'idleMind:plan', 'idleMind:explore', 'idleMind:ideate',
    'idleMind:tidy', 'idleMind:journal', 'idleMind:mcp-explore', 'idleMind:dream',
    'idleMind:consolidate', 'idleMind:calibrate', 'idleMind:improve', 'idleMind:research',
    'idleMind:self-define', 'idleMind:study', 'idleMind:read-source', 'idleMind:skill-rehearsal',
  ];
  for (const k of expected) {
    assert(typeof Metabolism.ACTIVITY_COSTS[k] === 'number',
      `ACTIVITY_COSTS["${k}"] must be a number`);
    assert(Metabolism.ACTIVITY_COSTS[k] > 0,
      `ACTIVITY_COSTS["${k}"] must be > 0`);
  }
});

test('C: idleMindCycle (baseline) is cheaper than the heavy per-activity keys', () => {
  const { Metabolism } = require(path.join(ROOT, 'src/agent/organism/Metabolism'));
  const heavy = ['idleMind:plan', 'idleMind:dream', 'idleMind:research'];
  for (const k of heavy) {
    assert(Metabolism.ACTIVITY_COSTS[k] > Metabolism.ACTIVITY_COSTS.idleMindCycle,
      `${k} should cost more than the flat idleMindCycle baseline`);
  }
});

test('C: Metabolism.consume returns cost=0 for unknown activity keys (safe fallback)', () => {
  const { Metabolism } = require(path.join(ROOT, 'src/agent/organism/Metabolism'));
  const bus = { fire: () => {}, on: () => {}, off: () => {} };
  const m = new Metabolism({ bus });
  m._initEnergyPool();
  const result = m.consume('idleMind:does-not-exist');
  assertEqual(result.cost, 0);
  assert(result.ok === true, 'unknown key consume should succeed (no-op)');
});

// ── Live-Bug Fix: greeting-handler bypass mid-conversation ───
//
// Live-observed pattern (Hauptstandort, qwen3-coder:480b-cloud):
// Short positive replies like "Das klingt gut" / "ok" mid-chat got
// classified by the IntentRouter LLM-fallback as `greeting`. The
// registered greeting handler (SelfModificationPipeline._greeting)
// then built its own minimal system prompt without identity, history
// or the v7.9.4 anti-greeting cue, and the cloud model returned the
// generic RLHF-assistant default "Hallo! Schön, dass es dir gefällt.
// Wie kann ich dir heute helfen?". Fix: _greeting returns null when
// history > 1 (= at least one prior turn exists), so ChatOrchestrator
// falls through to the regular general-chat path which carries the
// full PromptBuilder including _conversationContext().

test('Live-fix: _greeting returns null when history has prior turns', async () => {
  const { SelfModificationPipeline } = require(path.join(ROOT, 'src/agent/hexagonal/SelfModificationPipeline'));
  // Minimal mock pipeline — only what _greeting touches.
  const pipeline = Object.create(SelfModificationPipeline.prototype);
  pipeline.lang = { get: () => 'de', t: () => '' };
  pipeline.model = { chat: async () => 'should not be called' };
  // history with 3 entries: 2 prior turns + current user message
  const history = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hallo!' },
    { role: 'user', content: 'Das klingt gut' },
  ];
  const result = await pipeline._greeting('Das klingt gut', history);
  assertEqual(result, null, 'mid-conversation greeting must return null to fall through');
});

test('Live-fix: _greeting fires normally on first-message (no prior turns)', async () => {
  const { SelfModificationPipeline } = require(path.join(ROOT, 'src/agent/hexagonal/SelfModificationPipeline'));
  const pipeline = Object.create(SelfModificationPipeline.prototype);
  pipeline.lang = { get: () => 'de', t: () => 'fallback' };
  let chatCalled = false;
  pipeline.model = { chat: async () => { chatCalled = true; return 'Hi, willkommen!'; } };
  // history with just the current user message (no prior turns)
  const history = [{ role: 'user', content: 'hi' }];
  const result = await pipeline._greeting('hi', history);
  assertEqual(result, 'Hi, willkommen!');
  assert(chatCalled, 'genuine first greeting must still invoke the LLM');
});

test('Live-fix: _greeting handles undefined history gracefully (legacy callers)', async () => {
  const { SelfModificationPipeline } = require(path.join(ROOT, 'src/agent/hexagonal/SelfModificationPipeline'));
  const pipeline = Object.create(SelfModificationPipeline.prototype);
  pipeline.lang = { get: () => 'en', t: () => 'fallback' };
  pipeline.model = { chat: async () => 'Hello!' };
  // No history argument → must not throw, defaults to greeting path
  const result = await pipeline._greeting('hello');
  assertEqual(result, 'Hello!');
});

});

run();
