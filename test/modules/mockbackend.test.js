// ============================================================
// GENESIS — test/modules/mockbackend.test.js (v4.10.0)
//
// Tests for the MockBackend and its integration with ModelBridge.
// Validates all 4 mock modes and the call-history API.
// ============================================================

const { describe, test, assert, assertEqual, assertRejects, run } = require('../harness');

// Direct require — tests don't go through Container
const { MockBackend } = require('../../src/agent/foundation/backends/MockBackend');

describe('MockBackend — Echo Mode', () => {
  test('echoes last user message', async () => {
    const mock = new MockBackend({ mode: 'echo' });
    const result = await mock.chat('system', [{ role: 'user', content: 'hello world' }], 0.7, 'test');
    assertEqual(result, 'hello world');
  });

  test('returns placeholder when no user message', async () => {
    const mock = new MockBackend({ mode: 'echo' });
    const result = await mock.chat('system', [{ role: 'assistant', content: 'hi' }], 0.7, 'test');
    assertEqual(result, '[no user message]');
  });

  test('records call history', async () => {
    const mock = new MockBackend({ mode: 'echo' });
    await mock.chat('sys1', [{ role: 'user', content: 'a' }], 0.5, 'model1');
    await mock.chat('sys2', [{ role: 'user', content: 'b' }], 0.3, 'model2');
    assertEqual(mock.callCount, 2);
    assertEqual(mock.getCall(0).systemPrompt, 'sys1');
    assertEqual(mock.lastCall.systemPrompt, 'sys2');
  });
});

describe('MockBackend — Scripted Mode', () => {
  test('returns responses in sequence', async () => {
    const mock = new MockBackend({ mode: 'scripted', responses: ['first', 'second', 'third'] });
    assertEqual(await mock.chat('s', [{ role: 'user', content: 'x' }], 0.5, 't'), 'first');
    assertEqual(await mock.chat('s', [{ role: 'user', content: 'x' }], 0.5, 't'), 'second');
    assertEqual(await mock.chat('s', [{ role: 'user', content: 'x' }], 0.5, 't'), 'third');
  });

  test('wraps around when responses exhausted', async () => {
    const mock = new MockBackend({ mode: 'scripted', responses: ['A', 'B'] });
    await mock.chat('s', [{ role: 'user', content: '1' }], 0.5, 't'); // A
    await mock.chat('s', [{ role: 'user', content: '2' }], 0.5, 't'); // B
    const result = await mock.chat('s', [{ role: 'user', content: '3' }], 0.5, 't'); // wraps to A
    assertEqual(result, 'A');
  });

  test('reset() restarts sequence', async () => {
    const mock = new MockBackend({ mode: 'scripted', responses: ['X', 'Y'] });
    await mock.chat('s', [{ role: 'user', content: '1' }], 0.5, 't'); // X
    mock.reset();
    const result = await mock.chat('s', [{ role: 'user', content: '2' }], 0.5, 't');
    assertEqual(result, 'X');
    assertEqual(mock.callCount, 1); // history also reset
  });
});

describe('MockBackend — JSON Mode', () => {
  test('returns stringified JSON', async () => {
    const mock = new MockBackend({
      mode: 'json',
      jsonResponses: [{ action: 'test', value: 42 }],
    });
    const raw = await mock.chat('s', [{ role: 'user', content: 'x' }], 0.5, 't');
    const parsed = JSON.parse(raw);
    assertEqual(parsed.action, 'test');
    assertEqual(parsed.value, 42);
  });
});

describe('MockBackend — Error Mode', () => {
  test('always throws', async () => {
    const mock = new MockBackend({ mode: 'error', errorMessage: 'LLM down' });
    await assertRejects(
      () => mock.chat('s', [{ role: 'user', content: 'x' }], 0.5, 't'),
      'Expected error mode to throw'
    );
  });
});

describe('MockBackend — Streaming', () => {
  test('streams tokens via onChunk', async () => {
    const mock = new MockBackend({ mode: 'scripted', responses: ['hello world test'] });
    const chunks = [];
    await mock.stream('sys', [{ role: 'user', content: 'x' }], (chunk) => chunks.push(chunk), null, 0.5, 'test');
    assert(chunks.length >= 2, `Expected multiple chunks, got ${chunks.length}`);
    const reassembled = chunks.join('').trim();
    assertEqual(reassembled, 'hello world test');
  });

  test('respects abort signal', async () => {
    const mock = new MockBackend({ mode: 'scripted', responses: ['a b c d e f g h i j'], latencyMs: 5 });
    const chunks = [];
    const controller = new AbortController();

    // Abort after 15ms (should cut short)
    setTimeout(() => controller.abort(), 15);

    await mock.stream('sys', [{ role: 'user', content: 'x' }], (chunk) => chunks.push(chunk), controller.signal, 0.5, 'test');
    // Should have fewer chunks than total words due to abort
    assert(chunks.length < 10, `Expected abort to cut short streaming, got ${chunks.length} chunks`);
  });
});

describe('MockBackend — Configuration API', () => {
  test('isConfigured returns true', () => {
    const mock = new MockBackend();
    assert(mock.isConfigured());
  });

  test('getModels returns mock model', () => {
    const mock = new MockBackend();
    const models = mock.getModels();
    assertEqual(models.length, 1);
    assertEqual(models[0].name, 'mock-model');
  });

  test('setResponses replaces and resets index', async () => {
    const mock = new MockBackend({ mode: 'scripted', responses: ['old'] });
    await mock.chat('s', [{ role: 'user', content: 'x' }], 0.5, 't'); // 'old'
    mock.setResponses(['new1', 'new2']);
    const result = await mock.chat('s', [{ role: 'user', content: 'x' }], 0.5, 't');
    assertEqual(result, 'new1');
  });

  test('setMode switches behavior', async () => {
    const mock = new MockBackend({ mode: 'echo' });
    const r1 = await mock.chat('s', [{ role: 'user', content: 'test' }], 0.5, 't');
    assertEqual(r1, 'test'); // echo

    mock.setMode('scripted');
    mock.setResponses(['scripted!']);
    const r2 = await mock.chat('s', [{ role: 'user', content: 'test' }], 0.5, 't');
    assertEqual(r2, 'scripted!');
  });

  test('latency simulation works', async () => {
    const mock = new MockBackend({ mode: 'echo', latencyMs: 50 });
    const start = Date.now();
    await mock.chat('s', [{ role: 'user', content: 'x' }], 0.5, 't');
    const elapsed = Date.now() - start;
    assert(elapsed >= 40, `Expected >=40ms latency, got ${elapsed}ms`);
  });
});

run();
