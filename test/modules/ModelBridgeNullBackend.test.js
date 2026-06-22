#!/usr/bin/env node
// Test: ModelBridge null-backend fail-soft — P3 (v7.9.25)
// During the boot window the active backend can be null. _dispatch now falls soft
// to ollama (debug, no failover) instead of throwing "No model backend configured"
// — a throw is reserved for genuine misconfiguration (ollama also absent).
const { describe, test, assert, assertEqual, run } = require('../harness');
const { ModelBridge } = require('../../src/agent/foundation/ModelBridge');

const dispatch = ModelBridge.prototype._dispatch;

function ctx(backends) {
  return { backends, _getModelForBackend: () => 'test-model' };
}
function fakeBackend(tag) {
  const calls = [];
  return { calls, chat: (sp, msgs, temp, model) => { calls.push({ sp, model }); return tag; } };
}
const base = { mode: 'chat', systemPrompt: 's', messages: [], temp: 0.7, taskType: 'chat' };

describe('ModelBridge P3 — null-backend fail-soft', () => {

  test('a null backend falls soft to ollama instead of throwing', () => {
    const ollama = fakeBackend('OLLAMA');
    const out = dispatch.call(ctx({ ollama }), { ...base, backendName: null });
    assertEqual(out, 'OLLAMA', 'routed to ollama');
    assertEqual(ollama.calls.length, 1, 'ollama.chat called once');
  });

  test('an unknown backend name falls soft to ollama', () => {
    const ollama = fakeBackend('OLLAMA');
    const out = dispatch.call(ctx({ ollama }), { ...base, backendName: 'anthropic' });
    assertEqual(out, 'OLLAMA', 'unknown name → ollama');
  });

  test('a valid backend is used as-is (no spurious ollama fallback)', () => {
    const anthropic = fakeBackend('ANTH');
    const ollama = fakeBackend('OLLAMA');
    const out = dispatch.call(ctx({ anthropic, ollama }), { ...base, backendName: 'anthropic' });
    assertEqual(out, 'ANTH', 'used the requested backend');
    assertEqual(ollama.calls.length, 0, 'ollama not touched');
  });

  test('an unresolved backend with NO ollama still throws (genuine misconfig)', () => {
    let threw = false, msg = '';
    try { dispatch.call(ctx({}), { ...base, backendName: null }); }
    catch (e) { threw = true; msg = e.message; }
    assert(threw, 'throws when nothing can serve the call');
    assert(/no model backend/i.test(msg), 'the genuine-misconfig error is preserved');
  });
});

run();
