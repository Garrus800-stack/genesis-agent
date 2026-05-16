// ============================================================
// GENESIS — test/modules/v789-llm-resilience-integration.contract.test.js
// End-to-end integration test for the v7.8.9 LLM-resilience layer.
//
// Verifies that the full stack — ModelBridge.chat() with taskType='code'
// → _dispatch → ContinuationLoop → StreamingCompletion → TruncationDetector
// — actually delivers complete output when the underlying backend
// truncates partway through.
//
// Scenarios:
//   • SkillManager-style skill build: truncated mid-JS-block, two re-calls,
//     final result is complete and parseable.
//   • taskType !== 'code' is unaffected (still goes through the
//     classic non-streaming chat path, no Continuation).
//   • Non-Ollama backend is unaffected even for taskType='code'.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const { ModelBridge } = require(path.join(ROOT, 'src/agent/foundation/ModelBridge'));
const { MockBackend } = require(path.join(ROOT, 'src/agent/foundation/backends/MockBackend'));

process.env.GENESIS_OFFLINE_TESTS = '1';

// ── Helpers ───────────────────────────────────────────────

function makeChunkedMock(scripts) {
  const mock = new MockBackend({
    mode: 'chunked',
    chunkedScripts: scripts,
  });
  // ModelBridge expects backend to have isConfigured + getModels
  return mock;
}

/**
 * Stand up a ModelBridge with one chunked-mock Ollama backend and a
 * stubbed capability detector that returns 'verified-prefill' for any
 * model — so we test the prefill path without making real HTTP calls.
 */
function makeBridge(mockBackend) {
  const bridge = new ModelBridge();
  bridge.backends.ollama = mockBackend;
  bridge.activeBackend = 'ollama';
  bridge.activeModel = 'mock-code-model';
  bridge.availableModels = [{ name: 'mock-code-model', backend: 'ollama' }];
  // Inject a stub capability detector so we don't try to /api/show
  bridge._capabilityDetector = {
    detectCapability: async () => ({
      status: 'verified-prefill',
      template: 'messages-loop',
      digest: 'sha256:stub',
      verifiedAt: Date.now(),
    }),
  };
  return bridge;
}

// ── E2E: SkillManager-style truncation recovery ──────────

describe('llm-resilience-v789 contract: end-to-end skill-build resilience', () => {

  test('llm-resilience-v789 contract: truncated skill build recovers across re-calls', async () => {
    // Realistic SkillManager output: ```json + ```javascript blocks
    const round1 = '```json\n{"name":"timer-skill","version":"1.0"}\n```\n```javascript\nclass TimerSkill {\n  constructor() { this.start = Date.now(); }\n  ';
    const round2 = 'elapsed() { return Date.now() - this.start; }\n}\nmodule.exports = { TimerSkill };\n```';

    const mock = makeChunkedMock([
      { chunks: [round1], delayMs: 0, doneReason: 'length' },
      { chunks: [round2], delayMs: 0, doneReason: 'stop' },
    ]);
    const bridge = makeBridge(mock);

    const result = await bridge.chat(
      'You are a skill-building assistant.',
      [{ role: 'user', content: 'Create a TimerSkill' }],
      'code'
    );

    assert(result.includes('```json'), 'manifest fence present');
    assert(result.includes('```javascript'), 'js fence present');
    assert(result.includes('module.exports'), 'module.exports present');
    assert(result.endsWith('```'), 'response ends with closing fence');
    // Two backend calls — one initial + one continuation
    assertEqual(mock.callCount, 2, 'two underlying stream calls');
  });

  test('llm-resilience-v789 contract: regex extraction works on continuation result', async () => {
    // This is the actual pattern SkillManager uses:
    // const codeMatch = response.match(/```(?:javascript|js)\n([\s\S]+?)```/)
    const round1 = '```json\n{"name":"x"}\n```\n```javascript\nclass X {\n  hello() { return ';
    const round2 = '"hi"; }\n}\nmodule.exports = { X };\n```';

    const mock = makeChunkedMock([
      { chunks: [round1], delayMs: 0, doneReason: 'length' },
      { chunks: [round2], delayMs: 0, doneReason: 'stop' },
    ]);
    const bridge = makeBridge(mock);

    const result = await bridge.chat('sys', [], 'code');

    const jsonMatch = result.match(/```json\n([\s\S]+?)```/);
    const codeMatch = result.match(/```(?:javascript|js)\n([\s\S]+?)```/);
    assert(jsonMatch !== null, 'json block extractable');
    assert(codeMatch !== null, 'js block extractable');
    // Verify the JSON parses
    let parsed;
    try { parsed = JSON.parse(jsonMatch[1]); } catch (e) { parsed = null; }
    assert(parsed !== null && parsed.name === 'x', 'extracted JSON parses');
    // Verify the JS code includes both halves
    assert(codeMatch[1].includes('hello()') && codeMatch[1].includes('module.exports'), 'JS block complete');
  });

  test('llm-resilience-v789 contract: fast-path (no truncation) returns immediately', async () => {
    const completeResponse = '```json\n{"name":"x"}\n```\n```javascript\nclass X {}\nmodule.exports = { X };\n```';
    const mock = makeChunkedMock([
      { chunks: [completeResponse], delayMs: 0, doneReason: 'stop' },
    ]);
    const bridge = makeBridge(mock);

    const result = await bridge.chat('sys', [], 'code');
    assertEqual(result, completeResponse, 'fast-path preserves full content');
    assertEqual(mock.callCount, 1, 'only one underlying call');
  });

});

// ── E2E: non-code paths unchanged ────────────────────────

describe('llm-resilience-v789 contract: non-code paths bypass continuation', () => {

  test('llm-resilience-v789 contract: taskType=analysis uses classic chat path', async () => {
    // For non-code task types, ModelBridge calls backend.chat() (not stream()),
    // so chunked-mode scripts are not consumed. Use scripted mode instead.
    const mock = new MockBackend({
      mode: 'scripted',
      responses: ['Analysis result: 42'],
    });
    const bridge = makeBridge(mock);

    const result = await bridge.chat('sys', [{ role: 'user', content: 'analyze' }], 'analysis');
    assertEqual(result, 'Analysis result: 42', 'analysis returns scripted response');
    // Backend was called via chat(), not stream()
    const lastCall = mock.lastCall;
    assertEqual(lastCall.method, 'chat', 'classic chat path used');
  });

  test('llm-resilience-v789 contract: taskType=creative uses classic chat path', async () => {
    const mock = new MockBackend({
      mode: 'scripted',
      responses: ['Once upon a time...'],
    });
    const bridge = makeBridge(mock);

    const result = await bridge.chat('sys', [{ role: 'user', content: 'tell a story' }], 'creative');
    assertEqual(result, 'Once upon a time...', 'creative returns scripted response');
  });

});

// ── E2E: non-Ollama backends unchanged ──────────────────

describe('llm-resilience-v789 contract: non-Ollama backends unaffected by code routing', () => {

  test('llm-resilience-v789 contract: Anthropic backend bypasses continuation even for code', async () => {
    const mock = new MockBackend({
      mode: 'scripted',
      responses: ['function complete() { return true; }'],
    });
    const bridge = new ModelBridge();
    // Register as 'anthropic' — continuation is OllamaBackend-only
    bridge.backends.anthropic = mock;
    bridge.activeBackend = 'anthropic';
    bridge.activeModel = 'claude-mock';
    bridge.availableModels = [{ name: 'claude-mock', backend: 'anthropic' }];

    const result = await bridge.chat('sys', [], 'code');
    assertEqual(result, 'function complete() { return true; }', 'classic chat for Anthropic');
    assertEqual(mock.lastCall.method, 'chat', 'classic chat path');
  });

});

if (require.main === module) run();
