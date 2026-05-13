#!/usr/bin/env node
// v7.7.9 Phase 2 — manifest registration + integration smoke test
//
// Confirms PSE is registered in phase9-cognitive, has the required
// late-bindings declared, and that the appendSelfMessage path works
// end-to-end with stubbed dependencies.

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const fs = require('fs');
const path = require('path');

describe('PSE manifest registration', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'src/agent/manifest/phase9-cognitive.js'), 'utf-8');

  // Extract the proactiveSelfExpression entry block: from the start of
  // its registration ['proactiveSelfExpression', { … }] up to the
  // matching '],' that closes the top-level array entry. We look for
  // the next `['` that starts a new manifest entry as the end marker.
  function pseBlock() {
    const startIdx = SRC.indexOf("'proactiveSelfExpression'");
    assert(startIdx >= 0, 'proactiveSelfExpression registration not found');
    // Find the next manifest entry start (or end of file)
    const after = SRC.slice(startIdx + 'proactiveSelfExpression'.length);
    const nextEntryMatch = after.match(/\n\s*\/\/[^\n]*\n\s*\[\s*['"][a-z]/i);
    const end = nextEntryMatch ? nextEntryMatch.index : after.length;
    return after.slice(0, end);
  }

  test('proactiveSelfExpression entry exists in phase9-cognitive', () => {
    assert(/['"]proactiveSelfExpression['"]/.test(SRC),
      'proactiveSelfExpression must be registered in phase9-cognitive');
  });

  test('PSE declares modelBridge late-binding', () => {
    const block = pseBlock();
    assert(/modelBridge/.test(block),
      `modelBridge late-binding missing in PSE manifest block (block length: ${block.length})`);
  });

  test('PSE declares chatOrchestrator late-binding', () => {
    const block = pseBlock();
    assert(/chatOrchestrator/.test(block), 'chatOrchestrator late-binding missing');
  });

  test('PSE depends on innerSpeech', () => {
    const block = pseBlock();
    assert(/deps:\s*\[\s*['"]innerSpeech['"]/.test(block),
      `PSE must declare innerSpeech as a dep; block excerpt: ${block.slice(0, 500)}`);
  });
});

describe('PSE integration — pipeline with stubbed deps', () => {
  test('thought below threshold → suppressed, no chat append', async () => {
    const { ProactiveSelfExpression } = require('../../src/agent/cognitive/ProactiveSelfExpression');
    const { InnerSpeech } = require('../../src/agent/cognitive/InnerSpeech');

    const events = [];
    const fakeBus = {
      fire: (evt, payload) => events.push({ evt, payload }),
      on: () => () => {},
    };
    const innerSpeech = new InnerSpeech({ bus: fakeBus, capacity: 50 });

    let appended = null;
    const fakeChat = {
      appendSelfMessage: (msg) => { appended = msg; },
      getHistory: () => [],
    };

    const pse = new ProactiveSelfExpression({
      bus: fakeBus,
      innerSpeech,
      storageDir: null,
    });
    pse.modelBridge = { chat: async () => 'unused' };
    pse.chatOrchestrator = fakeChat;

    // Significance way below 0.5 floor
    innerSpeech.emit('uninteresting thought', 'plan-failure-reflection', {
      sourceModule: 'test',
      significance: 0.1,
      novelty: 0.1,
    });

    // Allow microtask queue to drain
    await new Promise(r => setTimeout(r, 30));

    assertEqual(appended, null, 'should NOT have appended below-threshold thought');
    const suppressed = events.find(e => e.evt === 'agent:self-message-suppressed');
    assert(suppressed, 'expected agent:self-message-suppressed event');
  });

  test('disallowed kind → suppressed', async () => {
    const { ProactiveSelfExpression } = require('../../src/agent/cognitive/ProactiveSelfExpression');
    const { InnerSpeech } = require('../../src/agent/cognitive/InnerSpeech');

    const events = [];
    const fakeBus = { fire: (evt, payload) => events.push({ evt, payload }), on: () => () => {} };
    const innerSpeech = new InnerSpeech({ bus: fakeBus, capacity: 50 });

    let appended = null;
    const fakeChat = { appendSelfMessage: (msg) => { appended = msg; }, getHistory: () => [] };

    const pse = new ProactiveSelfExpression({ bus: fakeBus, innerSpeech, storageDir: null });
    pse.modelBridge = { chat: async () => 'unused' };
    pse.chatOrchestrator = fakeChat;
    // Test runs at any wall-clock — explicitly disable quiet-hours so the
    // kind-not-allowed gate is reached (otherwise tests run at night fail
    // with reason='quiet-hours' before kind-allowlist is checked).
    pse.settings = { get: (k) => {
      if (k === 'proactive.quietHours') return { start: '00:00', end: '00:00' };
      return undefined;
    }};

    // 'idle-thought' is not in default allowedKinds for Phase 2
    innerSpeech.emit('Random thought.', 'idle-thought', {
      sourceModule: 'test',
      significance: 0.9,
      novelty: 0.9,
    });

    await new Promise(r => setTimeout(r, 30));

    assertEqual(appended, null);
    const suppressed = events.find(e => e.evt === 'agent:self-message-suppressed');
    assert(suppressed);
    assertEqual(suppressed.payload.reason, 'kind-not-allowed');
  });

  test('mute via setMute("30m") then thought → suppressed with user-muted', async () => {
    const { ProactiveSelfExpression } = require('../../src/agent/cognitive/ProactiveSelfExpression');
    const { InnerSpeech } = require('../../src/agent/cognitive/InnerSpeech');

    const events = [];
    const fakeBus = { fire: (evt, payload) => events.push({ evt, payload }), on: () => () => {} };
    const innerSpeech = new InnerSpeech({ bus: fakeBus, capacity: 50 });
    const fakeChat = { appendSelfMessage: () => {}, getHistory: () => [] };

    const pse = new ProactiveSelfExpression({ bus: fakeBus, innerSpeech, storageDir: null });
    pse.modelBridge = { chat: async () => 'unused' };
    pse.chatOrchestrator = fakeChat;
    // Disable quiet-hours so mute is reached (see note above).
    pse.settings = { get: (k) => {
      if (k === 'proactive.quietHours') return { start: '00:00', end: '00:00' };
      return undefined;
    }};

    pse.setMute('30m');

    innerSpeech.emit('important plan failure for cognitive load', 'plan-failure-reflection', {
      sourceModule: 'test',
      significance: 0.9,
      novelty: 0.9,
      contextRefs: { goalDescription: 'cognitive load index' },
    });

    await new Promise(r => setTimeout(r, 30));

    const suppressed = events.find(e => e.evt === 'agent:self-message-suppressed');
    assert(suppressed, 'expected suppression event');
    assertEqual(suppressed.payload.reason, 'user-muted');
  });

  test('setMute("off") clears the mute', async () => {
    const { ProactiveSelfExpression } = require('../../src/agent/cognitive/ProactiveSelfExpression');
    const { InnerSpeech } = require('../../src/agent/cognitive/InnerSpeech');

    const innerSpeech = new InnerSpeech({ bus: { fire: () => {} }, capacity: 50 });
    const pse = new ProactiveSelfExpression({
      bus: { fire: () => {} }, innerSpeech, storageDir: null,
    });

    pse.setMute('1h');
    assert(pse.stateStore.getMutedUntilMs() !== null, 'should be muted after 1h');
    pse.setMute('off');
    assertEqual(pse.stateStore.getMutedUntilMs(), null, 'should be unmuted after off');
  });

  test('getStatus returns multiline report', () => {
    const { ProactiveSelfExpression } = require('../../src/agent/cognitive/ProactiveSelfExpression');
    const { InnerSpeech } = require('../../src/agent/cognitive/InnerSpeech');

    const innerSpeech = new InnerSpeech({ bus: { fire: () => {} }, capacity: 50 });
    const pse = new ProactiveSelfExpression({
      bus: { fire: () => {} }, innerSpeech, storageDir: null,
    });

    const status = pse.getStatus();
    assert(typeof status === 'string', 'status must be a string');
    assert(/proactive\.enabled/.test(status), 'status must mention proactive.enabled');
    assert(/proactive\.baseThreshold/.test(status), 'status must mention baseThreshold');
    assert(/recent suppressions/i.test(status), 'status must show suppression-log section');
  });
});

run();
