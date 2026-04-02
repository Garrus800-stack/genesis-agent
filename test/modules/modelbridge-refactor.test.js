// ============================================================
// GENESIS — test/modules/modelbridge-refactor.test.js (v4.10.0)
//
// Tests for the refactored ModelBridge with backend delegation.
// Uses MockBackend to validate orchestration logic without
// requiring actual LLM backends.
// ============================================================

const { describe, test, assert, assertEqual, assertRejects, run } = require('../harness');

const { ModelBridge } = require('../../src/agent/foundation/ModelBridge');
const { MockBackend } = require('../../src/agent/foundation/backends/MockBackend');

function createMockBridge(options = {}) {
  const bridge = new ModelBridge();
  const mock = new MockBackend(options);

  bridge.backends.ollama = mock;
  bridge.activeBackend = 'ollama';
  bridge.activeModel = 'mock-model';
  bridge.availableModels = [{ name: 'mock-model', backend: 'ollama' }];

  return { bridge, mock };
}

describe('ModelBridge — Backend Delegation', () => {
  test('delegates chat to active backend', async () => {
    const { bridge, mock } = createMockBridge({ mode: 'scripted', responses: ['Hello!'] });
    const result = await bridge.chat('system', [{ role: 'user', content: 'hi' }]);
    assertEqual(result, 'Hello!');
    assertEqual(mock.callCount, 1);
    assertEqual(mock.lastCall.systemPrompt, 'system');
  });

  test('delegates streamChat to active backend', async () => {
    const { bridge } = createMockBridge({ mode: 'scripted', responses: ['stream response'] });
    const chunks = [];
    await bridge.streamChat('sys', [{ role: 'user', content: 'hi' }], (c) => chunks.push(c), null);
    assert(chunks.length > 0, 'Expected streaming chunks');
    assert(chunks.join('').includes('stream'), 'Expected stream content');
  });
});

describe('ModelBridge — Failover', () => {
  test('fails over to second backend on error', async () => {
    const bridge = new ModelBridge();

    // Primary: error mode
    bridge.backends.ollama = new MockBackend({ mode: 'error', errorMessage: 'Ollama down' });
    // Fallback: working
    bridge.backends.anthropic = new MockBackend({ mode: 'scripted', responses: ['Fallback works!'] });

    bridge.activeBackend = 'ollama';
    bridge.activeModel = 'mock-model';
    bridge.availableModels = [
      { name: 'mock-model', backend: 'ollama' },
      { name: 'claude-mock', backend: 'anthropic' },
    ];

    const result = await bridge.chat('sys', [{ role: 'user', content: 'test' }]);
    assertEqual(result, 'Fallback works!');
  });

  test('throws when all backends fail', async () => {
    const bridge = new ModelBridge();
    bridge.backends.ollama = new MockBackend({ mode: 'error', errorMessage: 'Ollama down' });
    bridge.backends.anthropic = new MockBackend({ mode: 'error', errorMessage: 'Anthropic down' });
    bridge.backends.openai = new MockBackend({ mode: 'error', errorMessage: 'OpenAI down' });

    bridge.activeBackend = 'ollama';
    bridge.activeModel = 'mock-model';
    bridge.availableModels = [{ name: 'mock-model', backend: 'ollama' }];

    // No fallback configured with isConfigured() — anthropic/openai mock returns true
    // but no models in availableModels for them
    await assertRejects(
      () => bridge.chat('sys', [{ role: 'user', content: 'test' }]),
      'Expected error when all backends fail'
    );
  });
});

describe('ModelBridge — Caching', () => {
  test('caches non-chat results', async () => {
    const { bridge, mock } = createMockBridge({ mode: 'scripted', responses: ['cached!', 'fresh!'] });
    const r1 = await bridge.chat('sys', [{ role: 'user', content: 'x' }], 'analysis');
    const r2 = await bridge.chat('sys', [{ role: 'user', content: 'x' }], 'analysis');
    assertEqual(r1, 'cached!');
    assertEqual(r2, 'cached!'); // Same result from cache
    assertEqual(mock.callCount, 1); // Only called once
  });

  test('does not cache chat taskType', async () => {
    const { bridge, mock } = createMockBridge({ mode: 'scripted', responses: ['first', 'second'] });
    const r1 = await bridge.chat('sys', [{ role: 'user', content: 'x' }], 'chat');
    const r2 = await bridge.chat('sys', [{ role: 'user', content: 'x' }], 'chat');
    assertEqual(r1, 'first');
    assertEqual(r2, 'second'); // Different — not cached
    assertEqual(mock.callCount, 2);
  });
});

describe('ModelBridge — Structured Output', () => {
  test('chatStructured parses JSON response', async () => {
    const { bridge } = createMockBridge({
      mode: 'json',
      jsonResponses: [{ intent: 'code', confidence: 0.95 }],
    });
    const result = await bridge.chatStructured('Classify this');
    assertEqual(result.intent, 'code');
    assertEqual(result.confidence, 0.95);
  });
});

describe('ModelBridge — Temperature Profiles', () => {
  test('uses code temperature for code taskType', async () => {
    const { bridge, mock } = createMockBridge({ mode: 'echo' });
    await bridge.chat('sys', [{ role: 'user', content: 'code' }], 'code');
    assertEqual(mock.lastCall.temperature, 0.1);
  });

  test('uses chat temperature for chat taskType', async () => {
    const { bridge, mock } = createMockBridge({ mode: 'echo' });
    await bridge.chat('sys', [{ role: 'user', content: 'hi' }], 'chat');
    assertEqual(mock.lastCall.temperature, 0.7);
  });
});

describe('ModelBridge — Concurrency Stats', () => {
  test('reports semaphore stats', () => {
    const { bridge } = createMockBridge();
    const stats = bridge.getConcurrencyStats();
    assertEqual(stats.active, 0);
    assertEqual(stats.queued, 0);
    assert(typeof stats.acquired === 'number');
  });
});

run();
