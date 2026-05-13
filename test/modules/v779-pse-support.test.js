#!/usr/bin/env node
// v7.7.9 Phase 2 — coverage tests for support modules
//
// Three modules in this release didn't have direct test coverage —
// the pipeline tests in v779-pse-integration exercise them indirectly,
// but the architectural-fitness Test Coverage Gap check wants a test
// file per source file. These are short unit tests that hit each
// public function once.

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── ContentGeneration ──────────────────────────────────────

describe('ContentGeneration', () => {
  const { generate, composeSystemPrompt, buildStateBlock } =
    require('../../src/agent/cognitive/proactiveSelfExpression/ContentGeneration');

  test('composeSystemPrompt assembles A + B + C blocks', () => {
    const p = composeSystemPrompt('plan-failure-reflection', {
      thought: { text: 'Plan failed', kind: 'plan-failure-reflection' },
    });
    assert(typeof p === 'string', 'must return string');
    assert(p.includes('You are Genesis'), 'must include identity block');
    assert(p.includes('plan you formed'), 'must include kind-specific block (plan-failure-reflection)');
  });

  test('composeSystemPrompt handles unknown kind with fallback', () => {
    const p = composeSystemPrompt('totally-new-kind', { thought: { text: 'x' } });
    assert(p.length > 0, 'must produce some output');
  });

  test('buildStateBlock includes skalars when given', () => {
    const b = buildStateBlock({
      emotionalSkalars: { curiosity: 0.7, frustration: 0.3 },
    });
    assert(b.includes('curiosity'), 'must list curiosity skalar');
    assert(b.includes('0.70'), 'must format skalar value');
  });

  test('buildStateBlock omits skalars when missing', () => {
    const b = buildStateBlock({});
    assert(!b.includes('curiosity'), 'must not invent skalars');
  });

  test('buildStateBlock includes thought reference text', () => {
    const b = buildStateBlock({
      thought: {
        text: 'The plan to refactor failed',
        kind: 'plan-failure-reflection',
        contextRefs: { goalId: 'goal_abc12345' },
      },
    });
    assert(b.includes('refactor'), 'must include thought text');
    assert(b.includes('plan-failure-reflection'), 'must list thought kind');
  });

  test('generate throws when modelBridge missing', async () => {
    let threw = false;
    try {
      await generate({}, { thought: { kind: 'idle-thought', text: 'x' }, dyn: {}, settings: {} });
    } catch (_e) { threw = true; }
    assert(threw, 'must throw when no modelBridge');
  });

  test('generate calls modelBridge.chat and returns text', async () => {
    let chatCallArgs = null;
    const fakeBridge = {
      chat: async (sys, msgs, taskType, opts) => {
        chatCallArgs = { sys, msgs, taskType, opts };
        return 'a quiet observation about the goal';
      },
    };
    const { text, prompt } = await generate({ modelBridge: fakeBridge }, {
      thought: { kind: 'idle-thought', text: 'observation', contextRefs: {} },
      dyn: {},
      settings: {},
    });
    assert(typeof text === 'string', 'must return string text');
    assert(text.includes('quiet observation'), 'must reflect modelBridge output');
    assert(typeof prompt === 'string' && prompt.length > 0, 'must return prompt');
    assertEqual(chatCallArgs.taskType, 'self-expression');
  });

  test('generate strips quoted preamble from LLM output', async () => {
    const fakeBridge = {
      chat: async () => '"This is what I want to say."',
    };
    const { text } = await generate({ modelBridge: fakeBridge }, {
      thought: { kind: 'idle-thought', text: 'x', contextRefs: {} },
      dyn: {},
      settings: {},
    });
    assert(!text.startsWith('"') && !text.endsWith('"'), 'must strip surrounding quotes');
  });
});

// ── StateStore ──────────────────────────────────────────────

describe('StateStore', () => {
  const { StateStore, SUPPRESSION_LOG_MAX } =
    require('../../src/agent/cognitive/proactiveSelfExpression/StateStore');

  function tmpDir() {
    const d = path.join(os.tmpdir(), 'genesis-statestore-' + Date.now() + '-' + Math.random().toString(36).slice(2));
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  test('load with no state file → defaults', () => {
    const s = new StateStore({ storageDir: tmpDir() });
    s.load();
    assertEqual(s.getLastSelfMessageMs(), null);
    assertEqual(s.getDailyCount(), 0);
    assertEqual(s.getMutedUntilMs(), null);
    assertEqual(s.getSuppressionLog().length, 0);
  });

  test('recordPublished updates lastSelfMessage + per-kind + dailyCount', () => {
    const s = new StateStore({ storageDir: tmpDir() });
    s.load();
    const now = 1000000;
    s.recordPublished('plan-failure-reflection', now);
    assertEqual(s.getLastSelfMessageMs(), now);
    assertEqual(s.getLastSelfMessageOfKindMs('plan-failure-reflection'), now);
    assertEqual(s.getDailyCount(now), 1);
  });

  test('dailyCount resets across local-day boundary', () => {
    const s = new StateStore({ storageDir: tmpDir() });
    s.load();
    const yesterday = new Date('2026-05-09T20:00:00').getTime();
    const today = new Date('2026-05-10T08:00:00').getTime();
    s.recordPublished('idle-thought', yesterday);
    s.recordPublished('idle-thought', yesterday);
    assertEqual(s.getDailyCount(yesterday), 2);
    // Cross midnight
    assertEqual(s.getDailyCount(today), 0);
  });

  test('recordSuppression keeps newest first, capped at MAX', () => {
    const s = new StateStore({ storageDir: tmpDir() });
    s.load();
    for (let i = 0; i < SUPPRESSION_LOG_MAX + 5; i++) {
      s.recordSuppression({
        thoughtId: `t${i}`, kind: 'idle-thought', reason: 'below-threshold',
      }, 1000000 + i);
    }
    const log = s.getSuppressionLog();
    assertEqual(log.length, SUPPRESSION_LOG_MAX, 'must cap log length');
    assertEqual(log[0].thoughtId, `t${SUPPRESSION_LOG_MAX + 4}`, 'newest must be first');
  });

  test('setMute then clearMute', () => {
    const s = new StateStore({ storageDir: tmpDir() });
    s.load();
    s.setMute(60 * 60 * 1000, 1000000);
    assertEqual(s.getMutedUntilMs(), 1000000 + 60 * 60 * 1000);
    s.clearMute();
    assertEqual(s.getMutedUntilMs(), null);
  });

  test('setMute(null) clears', () => {
    const s = new StateStore({ storageDir: tmpDir() });
    s.load();
    s.setMute(1000, 1000000);
    s.setMute(null, 1000000);
    assertEqual(s.getMutedUntilMs(), null);
  });

  test('save then reload roundtrips state', () => {
    const dir = tmpDir();
    const s1 = new StateStore({ storageDir: dir });
    s1.load();
    s1.recordPublished('idle-thought', 1000000);
    s1.recordSuppression({ thoughtId: 't1', kind: 'plan-failure-reflection', reason: 'min-interval' }, 1000000);
    s1.save();

    const s2 = new StateStore({ storageDir: dir });
    s2.load();
    assertEqual(s2.getLastSelfMessageMs(), 1000000);
    assertEqual(s2.getSuppressionLog().length, 1);
  });
});

// ── ChatHistoryMapper ───────────────────────────────────────

describe('ChatHistoryMapper', () => {
  const { mapHistoryEntry, mapHistoryForPersistence, buildSelfMessageEntry } =
    require('../../src/agent/hexagonal/ChatHistoryMapper');

  test('mapHistoryEntry preserves legacy entries (role + content only)', () => {
    const e = mapHistoryEntry({ role: 'user', content: 'hi' });
    assertEqual(e.role, 'user');
    assertEqual(e.content, 'hi');
    assertEqual(e.timestamp, undefined);
    assertEqual(e.initiatedBy, undefined);
  });

  test('mapHistoryEntry truncates content to 2000 chars', () => {
    const long = 'A'.repeat(3000);
    const e = mapHistoryEntry({ role: 'user', content: long });
    assertEqual(e.content.length, 2000);
  });

  test('mapHistoryEntry preserves timestamp when given', () => {
    const e = mapHistoryEntry({ role: 'user', content: 'hi', timestamp: 1234567890 });
    assertEqual(e.timestamp, 1234567890);
  });

  test('mapHistoryEntry preserves initiatedBy + selfMeta for self-messages', () => {
    const e = mapHistoryEntry({
      role: 'assistant', content: 'thought',
      timestamp: 1000, initiatedBy: 'self',
      selfMeta: { kind: 'idle-thought', score: 0.7, sourceRef: { goalId: 'g1' }, thoughtId: 't1' },
    });
    assertEqual(e.initiatedBy, 'self');
    assertEqual(e.selfMeta.kind, 'idle-thought');
    assertEqual(e.selfMeta.score, 0.7);
    assertEqual(e.selfMeta.thoughtId, 't1');
  });

  test('mapHistoryForPersistence respects maxPersisted slice', () => {
    const history = Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: `msg-${i}` }));
    const result = mapHistoryForPersistence(history, 5);
    assertEqual(result.length, 5);
    assertEqual(result[0].content, 'msg-15');
    assertEqual(result[4].content, 'msg-19');
  });

  test('buildSelfMessageEntry returns null for invalid input', () => {
    assertEqual(buildSelfMessageEntry(null), null);
    assertEqual(buildSelfMessageEntry({}), null);
    assertEqual(buildSelfMessageEntry({ text: '' }), null);
  });

  test('buildSelfMessageEntry shapes valid input correctly', () => {
    const e = buildSelfMessageEntry({
      text: 'plan failed',
      kind: 'plan-failure-reflection',
      score: 0.6,
      sourceRef: { goalId: 'g1' },
      thoughtId: 't1',
    });
    assertEqual(e.role, 'assistant');
    assertEqual(e.content, 'plan failed');
    assertEqual(e.initiatedBy, 'self');
    assertEqual(e.selfMeta.kind, 'plan-failure-reflection');
    assertEqual(e.selfMeta.score, 0.6);
    assert(typeof e.timestamp === 'number', 'timestamp must be set automatically');
  });

  test('buildSelfMessageEntry sets sane defaults for missing meta', () => {
    const e = buildSelfMessageEntry({ text: 'just text' });
    assertEqual(e.selfMeta.kind, 'unknown');
    assertEqual(e.selfMeta.score, null);
    assertEqual(e.selfMeta.sourceRef, null);
    assertEqual(e.selfMeta.thoughtId, null);
  });
});

run();
