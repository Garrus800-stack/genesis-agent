// ============================================================
// v7.3.7 #8 — IntentRouter Cascade + ChatOrchestrator ReadSource-Hint
//
// Verified:
//   IntentRouter._conversationalSignalsCheck:
//     - Greetings recognized
//     - Pure reactions (ja, nein, danke, ok)
//     - Question-word without action verb
//     - Ends with "?" soft signal
//     - Meta-curiosity patterns
//     - Action verbs block the cascade
//     - null/empty input returns null
//
//   classifyAsync integration:
//     - Cascade decision returns before regex classify
//     - Cascade emits intent:cascade-decision event
//     - No cascade match → falls through to normal pipeline
//
//   PromptBuilder sourceHint:
//     - attachSourceHint stores, clearSourceHint removes
//     - _getSourceHintBlock returns prompt text
//
//   ChatOrchestrator _maybeAttachSourceHint:
//     - "was hat sich geändert" → CHANGELOG.md hint
//     - "welche version" → package.json hint
//     - Non-general intent → no hint
//     - Unrelated query → no hint
// ============================================================

const { describe, it, beforeEach } = require('node:test');
const assert = require('assert');

const { IntentRouter } = require('../../src/agent/intelligence/IntentRouter');
const { PromptBuilder } = require('../../src/agent/intelligence/PromptBuilder');

function makeMockBus() {
  const events = [];
  return {
    emit: (name, payload) => events.push({ name, payload }),
    fire: (name, payload) => events.push({ name, payload, fire: true }),
    on: () => {},
    events,
  };
}

// ════════════════════════════════════════════════════════════
// IntentRouter — Stage 1 Conversational Signals
// ════════════════════════════════════════════════════════════

describe('v7.3.7 #8a — IntentRouter _conversationalSignalsCheck', () => {

  let router;
  beforeEach(() => {
    router = new IntentRouter({ bus: makeMockBus() });
  });

  // ── Greetings ─────────────────────────────────────────────

  it('detects "hi" as greeting', () => {
    const r = router._conversationalSignalsCheck('hi');
    assert.strictEqual(r.type, 'general');
    assert.strictEqual(r.stage, 'conversational-greeting');
    assert.ok(r.confidence >= 0.9);
  });

  it('detects "Hallo!" with punctuation', () => {
    const r = router._conversationalSignalsCheck('Hallo!');
    assert.strictEqual(r.stage, 'conversational-greeting');
  });

  it('detects "Guten Morgen"', () => {
    const r = router._conversationalSignalsCheck('Guten Morgen');
    assert.strictEqual(r.stage, 'conversational-greeting');
  });

  // ── Pure reactions ────────────────────────────────────────

  it('detects "ja" as reaction', () => {
    const r = router._conversationalSignalsCheck('ja');
    assert.strictEqual(r.stage, 'conversational-reaction');
  });

  it('detects "okay" as reaction', () => {
    const r = router._conversationalSignalsCheck('okay');
    assert.strictEqual(r.stage, 'conversational-reaction');
  });

  it('detects "danke" as reaction', () => {
    const r = router._conversationalSignalsCheck('Danke!');
    assert.strictEqual(r.stage, 'conversational-reaction');
  });

  // ── Question patterns ─────────────────────────────────────

  it('question-word without action verb → conversational-question', () => {
    const r = router._conversationalSignalsCheck('Was ist der Unterschied zwischen X und Y?');
    assert.strictEqual(r.stage, 'conversational-question');
  });

  it('"Wie funktioniert das" → conversational-question', () => {
    const r = router._conversationalSignalsCheck('Wie funktioniert das eigentlich');
    assert.strictEqual(r.stage, 'conversational-question');
  });

  it('short "?" message → conversational-question-soft', () => {
    const r = router._conversationalSignalsCheck('Kannst du das kurz erklären?');
    assert.strictEqual(r.stage, 'conversational-question-soft');
  });

  it('action verb BLOCKS cascade even with question word', () => {
    const r = router._conversationalSignalsCheck('Wie erstelle ich eine neue Datei?');
    assert.strictEqual(r, null);
  });

  // ── Meta-curiosity ───────────────────────────────────────

  it('"was hat sich geändert" → conversational-meta', () => {
    const r = router._conversationalSignalsCheck('was hat sich geändert in der neuen Version');
    assert.strictEqual(r.stage, 'conversational-meta');
  });

  it('"wie fühlst du dich" → conversational-meta', () => {
    const r = router._conversationalSignalsCheck('wie fühlst du dich heute');
    assert.strictEqual(r.stage, 'conversational-meta');
  });

  // ── Null/edge cases ──────────────────────────────────────

  it('empty string returns null', () => {
    assert.strictEqual(router._conversationalSignalsCheck(''), null);
    assert.strictEqual(router._conversationalSignalsCheck('   '), null);
  });

  it('non-string input returns null', () => {
    assert.strictEqual(router._conversationalSignalsCheck(null), null);
    assert.strictEqual(router._conversationalSignalsCheck(undefined), null);
    assert.strictEqual(router._conversationalSignalsCheck(123), null);
  });

  it('long technical command does NOT match', () => {
    const r = router._conversationalSignalsCheck('Deploy the app to production and run the migration scripts');
    assert.strictEqual(r, null);
  });
});

// ════════════════════════════════════════════════════════════
// IntentRouter — classifyAsync Cascade Integration
// ════════════════════════════════════════════════════════════

describe('v7.3.7 #8b — classifyAsync cascade integration', () => {

  it('cascade match short-circuits the pipeline', async () => {
    const bus = makeMockBus();
    const router = new IntentRouter({ bus });
    const r = await router.classifyAsync('hi');
    assert.strictEqual(r.stage, 'conversational-greeting');
    assert.strictEqual(r.type, 'general');
  });

  it('cascade emits intent:cascade-decision event', async () => {
    const bus = makeMockBus();
    const router = new IntentRouter({ bus });
    await router.classifyAsync('hallo');
    const ev = bus.events.find(e => e.name === 'intent:cascade-decision');
    assert.ok(ev, 'intent:cascade-decision event must fire');
    assert.strictEqual(ev.payload.stage, 'conversational-greeting');
    assert.strictEqual(ev.payload.verdict, 'general');
  });

  it('no cascade match → falls through to normal classify', async () => {
    const bus = makeMockBus();
    const router = new IntentRouter({ bus });
    // No cascade match → normal regex classifies as 'general' (low confidence)
    const r = await router.classifyAsync('Build me a REST API in Go');
    assert.ok(!r.stage || !r.stage.startsWith('conversational-'));
  });
});

// ════════════════════════════════════════════════════════════
// PromptBuilder — attachSourceHint
// ════════════════════════════════════════════════════════════

describe('v7.3.7 #8c — PromptBuilder attachSourceHint', () => {

  it('attachSourceHint stores the hint', () => {
    const pb = new PromptBuilder({});
    pb.attachSourceHint({ path: 'CHANGELOG.md', reason: 'recent changes' });
    const block = pb._getSourceHintBlock();
    assert.ok(block.includes('CHANGELOG.md'));
    assert.ok(block.includes('recent changes'));
    assert.ok(block.includes('read-source'));
  });

  it('clearSourceHint removes the hint', () => {
    const pb = new PromptBuilder({});
    pb.attachSourceHint({ path: 'x.md', reason: 'y' });
    pb.clearSourceHint();
    assert.strictEqual(pb._getSourceHintBlock(), '');
  });

  it('attachSourceHint with null clears previous', () => {
    const pb = new PromptBuilder({});
    pb.attachSourceHint({ path: 'x.md', reason: 'y' });
    pb.attachSourceHint(null);
    assert.strictEqual(pb._getSourceHintBlock(), '');
  });

  it('attachSourceHint with no path clears', () => {
    const pb = new PromptBuilder({});
    pb.attachSourceHint({ path: 'x.md', reason: 'y' });
    pb.attachSourceHint({ reason: 'y' });
    assert.strictEqual(pb._getSourceHintBlock(), '');
  });

  it('no hint set → empty block', () => {
    const pb = new PromptBuilder({});
    assert.strictEqual(pb._getSourceHintBlock(), '');
  });
});

// ════════════════════════════════════════════════════════════
// ChatOrchestrator — _maybeAttachSourceHint
// ════════════════════════════════════════════════════════════

// Light harness that mimics just what _maybeAttachSourceHint needs
class ChatHarness {
  constructor() {
    this.hints = [];
    this.cleared = 0;
    this.promptBuilder = {
      attachSourceHint: (h) => { this.hints.push(h); },
      clearSourceHint: () => { this.cleared++; },
    };
  }
}

// Import the method directly from the class
const { ChatOrchestrator } = require('../../src/agent/hexagonal/ChatOrchestrator');

describe('v7.3.7 #8d — ChatOrchestrator _maybeAttachSourceHint', () => {

  it('"was hat sich geändert" → CHANGELOG.md hint', () => {
    const h = new ChatHarness();
    ChatOrchestrator.prototype._maybeAttachSourceHint.call(
      h, 'Was hat sich geändert seit gestern', { type: 'general' }
    );
    assert.strictEqual(h.hints.length, 1);
    assert.strictEqual(h.hints[0].path, 'CHANGELOG.md');
    assert.ok(h.hints[0].reason.toLowerCase().includes('änder'));
  });

  it('"was ist neu" → CHANGELOG.md hint', () => {
    const h = new ChatHarness();
    ChatOrchestrator.prototype._maybeAttachSourceHint.call(
      h, 'was ist neu in der Version', { type: 'general' }
    );
    assert.strictEqual(h.hints.length, 1);
    assert.strictEqual(h.hints[0].path, 'CHANGELOG.md');
  });

  it('"welche version" → package.json hint', () => {
    const h = new ChatHarness();
    ChatOrchestrator.prototype._maybeAttachSourceHint.call(
      h, 'welche version läuft gerade', { type: 'general' }
    );
    assert.strictEqual(h.hints.length, 1);
    assert.strictEqual(h.hints[0].path, 'package.json');
  });

  it('non-general intent → no hint attached', () => {
    const h = new ChatHarness();
    ChatOrchestrator.prototype._maybeAttachSourceHint.call(
      h, 'was hat sich geändert', { type: 'goals' }
    );
    assert.strictEqual(h.hints.length, 0);
  });

  it('unrelated query → no hint, but clearSourceHint is called', () => {
    const h = new ChatHarness();
    ChatOrchestrator.prototype._maybeAttachSourceHint.call(
      h, 'Erzähl mir was über Katzen', { type: 'general' }
    );
    assert.strictEqual(h.hints.length, 0);
    assert.strictEqual(h.cleared, 1, 'previous hint should always be cleared');
  });

  it('non-string message is safely ignored', () => {
    const h = new ChatHarness();
    assert.doesNotThrow(() => {
      ChatOrchestrator.prototype._maybeAttachSourceHint.call(h, null, { type: 'general' });
      ChatOrchestrator.prototype._maybeAttachSourceHint.call(h, 42, { type: 'general' });
    });
    assert.strictEqual(h.hints.length, 0);
  });

  it('missing promptBuilder.attachSourceHint → safe no-op', () => {
    const h = { promptBuilder: {} };
    assert.doesNotThrow(() => {
      ChatOrchestrator.prototype._maybeAttachSourceHint.call(
        h, 'was hat sich geändert', { type: 'general' }
      );
    });
  });
});
