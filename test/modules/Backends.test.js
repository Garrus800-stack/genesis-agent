#!/usr/bin/env node
// ============================================================
// Test: LLM Backends — MockBackend, OllamaBackend, AnthropicBackend, OpenAIBackend
//
// Tests the backend interface contract without real network calls.
// MockBackend is tested directly; Ollama/Anthropic/OpenAI are
// tested for construction, configuration, and interface shape.
// ============================================================

const { describe, test, assert, assertEqual, assertRejects, run } = require('../harness');

const { MockBackend } = require('../../src/agent/foundation/backends/MockBackend');
const { OllamaBackend } = require('../../src/agent/foundation/backends/OllamaBackend');
const { AnthropicBackend } = require('../../src/agent/foundation/backends/AnthropicBackend');
const { OpenAIBackend } = require('../../src/agent/foundation/backends/OpenAIBackend');

// ── MockBackend ────────────────────────────────────────────

describe('MockBackend — Echo Mode', () => {
  test('echo mode returns last user message', async () => {
    const mock = new MockBackend({ mode: 'echo' });
    const result = await mock.chat('system', [{ role: 'user', content: 'hello' }], 0.7, 'mock');
    assertEqual(result, 'hello');
  });

  test('echo mode returns fallback when no user message', async () => {
    const mock = new MockBackend({ mode: 'echo' });
    const result = await mock.chat('system', [{ role: 'assistant', content: 'hi' }], 0.7, 'mock');
    assertEqual(result, '[no user message]');
  });

  test('records call history', async () => {
    const mock = new MockBackend();
    await mock.chat('sys', [{ role: 'user', content: 'test' }], 0.5, 'model');
    assertEqual(mock.callCount, 1);
    assertEqual(mock.lastCall.method, 'chat');
    assertEqual(mock.lastCall.systemPrompt, 'sys');
    assertEqual(mock.lastCall.temperature, 0.5);
  });
});

describe('MockBackend — Scripted Mode', () => {
  test('returns responses in sequence', async () => {
    const mock = new MockBackend({ mode: 'scripted', responses: ['A', 'B', 'C'] });
    assertEqual(await mock.chat('', [], 0, ''), 'A');
    assertEqual(await mock.chat('', [], 0, ''), 'B');
    assertEqual(await mock.chat('', [], 0, ''), 'C');
  });

  test('wraps around when exhausted', async () => {
    const mock = new MockBackend({ mode: 'scripted', responses: ['X'] });
    assertEqual(await mock.chat('', [], 0, ''), 'X');
    assertEqual(await mock.chat('', [], 0, ''), 'X');
  });

  test('setResponses resets index', async () => {
    const mock = new MockBackend({ mode: 'scripted', responses: ['old'] });
    await mock.chat('', [], 0, '');
    mock.setResponses(['new1', 'new2']);
    assertEqual(await mock.chat('', [], 0, ''), 'new1');
  });
});

describe('MockBackend — JSON Mode', () => {
  test('returns stringified JSON', async () => {
    const mock = new MockBackend({ mode: 'json', jsonResponses: [{ key: 'value' }] });
    const result = await mock.chat('', [], 0, '');
    const parsed = JSON.parse(result);
    assertEqual(parsed.key, 'value');
  });
});

describe('MockBackend — Error Mode', () => {
  test('always throws with configured message', async () => {
    const mock = new MockBackend({ mode: 'error', errorMessage: 'test failure' });
    await assertRejects(async () => {
      await mock.chat('', [], 0, '');
    });
  });
});

describe('MockBackend — Streaming', () => {
  test('stream calls onChunk for each word', async () => {
    const mock = new MockBackend({ mode: 'scripted', responses: ['hello world'] });
    const chunks = [];
    await mock.stream('sys', [{ role: 'user', content: 'hi' }], (c) => chunks.push(c), null, 0.7, 'mock');
    assert(chunks.length >= 2, 'should have multiple chunks');
    assert(chunks.join('').includes('hello'), 'chunks should contain response');
  });

  test('stream respects abort signal', async () => {
    const mock = new MockBackend({ mode: 'scripted', responses: ['a b c d e f g h i j'] });
    const chunks = [];
    const abort = { aborted: true };
    await mock.stream('', [], (c) => chunks.push(c), abort, 0, 'mock');
    assertEqual(chunks.length, 0, 'should produce no chunks when aborted');
  });
});

describe('MockBackend — Utilities', () => {
  test('reset clears history and index', async () => {
    const mock = new MockBackend({ mode: 'scripted', responses: ['A', 'B'] });
    await mock.chat('', [], 0, '');
    mock.reset();
    assertEqual(mock.callCount, 0);
    assertEqual(await mock.chat('', [], 0, ''), 'A'); // restarted
  });

  test('getCall returns nth call', async () => {
    const mock = new MockBackend();
    await mock.chat('s1', [{ role: 'user', content: 'q1' }], 0, 'a');
    await mock.chat('s2', [{ role: 'user', content: 'q2' }], 0, 'b');
    assertEqual(mock.getCall(0).systemPrompt, 's1');
    assertEqual(mock.getCall(1).systemPrompt, 's2');
    assertEqual(mock.getCall(99), null);
  });

  test('isConfigured always returns true', () => {
    const mock = new MockBackend();
    assert(mock.isConfigured());
  });
});

// ── OllamaBackend ─────────────────────────────────────────

describe('OllamaBackend — Interface', () => {
  test('constructs with default baseUrl', () => {
    const backend = new OllamaBackend();
    assertEqual(backend.baseUrl, 'http://127.0.0.1:11434');
    assertEqual(backend.type, 'ollama');
    assertEqual(backend.name, 'Ollama');
  });

  test('constructs with custom baseUrl', () => {
    const backend = new OllamaBackend({ baseUrl: 'http://custom:1234' });
    assertEqual(backend.baseUrl, 'http://custom:1234');
  });

  test('isConfigured returns true when baseUrl set', () => {
    assert(new OllamaBackend().isConfigured());
    // Note: OllamaBackend({ baseUrl: '' }) falls back to default via || operator
    assert(new OllamaBackend({ baseUrl: '' }).isConfigured(), 'empty string falls back to default');
  });

  test('has required interface methods', () => {
    const backend = new OllamaBackend();
    assert(typeof backend.listModels === 'function');
    assert(typeof backend.chat === 'function');
    assert(typeof backend.stream === 'function');
  });
});

// ── AnthropicBackend ──────────────────────────────────────

describe('AnthropicBackend — Interface', () => {
  test('constructs with defaults', () => {
    const backend = new AnthropicBackend();
    assertEqual(backend.type, 'anthropic');
    assertEqual(backend.baseUrl, 'https://api.anthropic.com');
    assertEqual(backend.apiKey, null);
  });

  test('isConfigured requires apiKey', () => {
    assert(!new AnthropicBackend().isConfigured(), 'no key = not configured');
    assert(new AnthropicBackend({ apiKey: 'sk-test' }).isConfigured(), 'with key = configured');
  });

  test('has required interface methods', () => {
    const backend = new AnthropicBackend({ apiKey: 'test' });
    assert(typeof backend.chat === 'function');
    assert(typeof backend.stream === 'function');
  });

  test('accepts custom baseUrl', () => {
    const backend = new AnthropicBackend({ baseUrl: 'https://custom.api.com' });
    assertEqual(backend.baseUrl, 'https://custom.api.com');
  });
});

// ── OpenAIBackend ─────────────────────────────────────────

describe('OpenAIBackend — Interface', () => {
  test('constructs with defaults', () => {
    const backend = new OpenAIBackend();
    assertEqual(backend.type, 'openai');
    assertEqual(backend.apiKey, null);
    assertEqual(backend.baseUrl, null);
  });

  test('isConfigured requires baseUrl and apiKey', () => {
    assert(!new OpenAIBackend().isConfigured());
    assert(!new OpenAIBackend({ apiKey: 'key' }).isConfigured());
    assert(new OpenAIBackend({ apiKey: 'key', baseUrl: 'http://x' }).isConfigured());
  });

  test('has required interface methods', () => {
    const backend = new OpenAIBackend({ apiKey: 'k', baseUrl: 'http://x' });
    assert(typeof backend.chat === 'function');
    assert(typeof backend.stream === 'function');
  });

  test('accepts configurable model list', () => {
    const backend = new OpenAIBackend({ models: ['gpt-4', 'gpt-3.5'] });
    assert(backend._models.length === 2);
  });
});

run();
