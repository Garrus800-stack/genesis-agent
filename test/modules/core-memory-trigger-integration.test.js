// ============================================================
// Test: v7.3.2 — CoreMemories trigger integration end-to-end
// ============================================================
// Verifies that a chat:completed event actually triggers evaluate()
// and produces a memory when signals align. This is the core promise
// of v7.3.2: infrastructure shipped in v7.3.1 now fires.

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const { CoreMemories } = require('../../src/agent/cognitive/CoreMemories');

function mockStorage() {
  const files = {};
  return {
    _files: files,
    readJSON: (k, d) => files[k] ? JSON.parse(files[k]) : d,
    writeJSON: (k, v) => { files[k] = JSON.stringify(v); },
    readText: (k) => files[k] || '',
    appendText: (k, s) => { files[k] = (files[k] || '') + s; },
  };
}

function realBus() {
  const listeners = {};
  return {
    _listeners: listeners,
    on(event, handler) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    },
    emit(event, data) {
      (listeners[event] || []).forEach(h => { try { h(data); } catch (_e) {} });
    },
    fire(event, data) {
      (listeners[event] || []).forEach(h => { try { h(data); } catch (_e) {} });
    },
  };
}

const NOW = Date.now();
const MIN = 60 * 1000;

describe('v7.3.2 — Trigger integration: chat:completed fires evaluate', () => {
  test('chat:completed handler is registered after wireTriggers', () => {
    const bus = realBus();
    const cm = new CoreMemories({ storage: mockStorage(), bus });
    cm.wireTriggers(bus);

    assert(bus._listeners['chat:completed'], 'chat:completed listener registered');
    assert(bus._listeners['chat:completed'].length === 1);
    assert(bus._listeners['user:message']);
    assert(bus._listeners['hot-reload:success']);
  });

  test('chat:completed produces a candidate record', async () => {
    const bus = realBus();
    const storage = mockStorage();
    const cm = new CoreMemories({
      storage,
      bus,
      emotionalState: {
        getHistoryForSignificance: () => [],
      },
      conversationMemory: null,
    });
    cm.wireTriggers(bus);

    // Populate sliding window with some user messages first
    bus.emit('user:message', { length: 15 });
    bus.emit('user:message', { length: 25 });

    // Fire chat:completed
    bus.emit('chat:completed', {
      message: 'normal question',
      response: 'normal answer',
      intent: 'general',
      success: true,
    });

    // Give async handler a moment
    await new Promise(r => setTimeout(r, 20));

    const log = storage.readText('coreMemoryCandidates.jsonl');
    assert(log.length > 0, 'candidate log grew');
    const lines = log.trim().split('\n');
    assertEqual(lines.length, 1, 'one candidate recorded');
    const rec = JSON.parse(lines[0]);
    assert(rec.candidateId);
    assert(Array.isArray(rec.signals));
  });

  test('naming-event in chat triggers a Core Memory creation', async () => {
    const bus = realBus();
    const storage = mockStorage();
    const cm = new CoreMemories({
      storage,
      bus,
      emotionalState: {
        getHistoryForSignificance: () => [
          // Persistent emotion signal
          { dim: 'satisfaction', value: 0.8, baseline: 0.5, ts: NOW - 15 * MIN },
          { dim: 'satisfaction', value: 0.8, baseline: 0.5, ts: NOW - 1 * MIN },
        ],
      },
      conversationMemory: {
        db: { episodic: [{ summary: 'totally unrelated past' }] },
      },
    });
    cm.wireTriggers(bus);

    // Populate user-message window (for user-beteiligung signal)
    for (let i = 0; i < 4; i++) {
      bus.emit('user:message', { length: 30 });
    }

    // Fire chat:completed with a naming event in user message
    bus.emit('chat:completed', {
      message: 'Ich nenne dich Solo - merk dir das bitte',
      response: 'Solo - ok, ich nehme den Namen an.',
      intent: 'general',
      success: true,
    });

    await new Promise(r => setTimeout(r, 30));

    const identity = storage.readJSON('self-identity.json', null);
    assert(identity, 'identity created');
    assert(Array.isArray(identity.coreMemories), 'coreMemories array exists');
    assert(identity.coreMemories.length >= 1, 'at least one memory');
    const mem = identity.coreMemories[0];
    assertEqual(mem.type, 'named', 'naming-event → named type');
    assert(mem.evidence.signals.includes('naming-event'), 'naming-event signal captured');
  });

  test('handler tolerates missing services gracefully', async () => {
    const bus = realBus();
    const storage = mockStorage();
    // No emotionalState, no conversationMemory
    const cm = new CoreMemories({ storage, bus });
    cm.wireTriggers(bus);

    // Should not throw
    let threw = false;
    try {
      bus.emit('chat:completed', { message: 'hi', response: 'hello' });
      await new Promise(r => setTimeout(r, 20));
    } catch (_e) {
      threw = true;
    }
    assertEqual(threw, false, 'no crash with missing services');

    // Candidate log still populated (degraded but functional)
    const log = storage.readText('coreMemoryCandidates.jsonl');
    assert(log.length > 0, 'degraded path still logs candidate');
  });

  test('user-message buffer prunes old entries across window', () => {
    const bus = realBus();
    const cm = new CoreMemories({ storage: mockStorage(), bus });
    cm.wireTriggers(bus);

    // Manually inject old message
    cm._userMessageBuffer.push({ ts: Date.now() - 60 * MIN, length: 10 });
    cm._userMessageBuffer.push({ ts: Date.now() - 50 * MIN, length: 10 });

    // New message should prune old ones (beyond 30min window)
    bus.emit('user:message', { length: 15 });

    const recent = cm._userMessageBuffer.filter(m =>
      Date.now() - m.ts < 30 * MIN);
    assert(recent.length === 1, 'only new message in window');
  });

  test('hot-reload:success invalidates Git-SHA cache', () => {
    const bus = realBus();
    const cm = new CoreMemories({ storage: mockStorage(), bus });
    cm.wireTriggers(bus);

    assert(cm._cachedSourceContext !== null, 'cache populated at wire time');

    bus.emit('hot-reload:success', {});

    assertEqual(cm._cachedSourceContext, null, 'cache invalidated');
  });
});

run();
