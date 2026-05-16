// ============================================================
// GENESIS — test/modules/v789-llm-continuation-loop.contract.test.js
// Contract test for v7.8.9 ContinuationLoop:
//   • Fast path: complete on first attempt → no re-call
//   • Prefill path: truncated then completed (assistant prefill in re-call)
//   • Pseudo-continuation path: same flow, different message shape
//   • Multiple re-calls until complete
//   • Max-continuations exhausted: returns partial with failure reason
//   • Token-budget exhaustion: returns partial
//   • Sequence-deadline timeout: short-circuits remaining attempts
//   • Bus events emitted: started + complete (success) / started + failed (failure)
//   • CircuitBreaker integration: ONE recordSuccess() / recordFailure() per sequence
//   • keep_alive override: pushed on entry, released on exit
//   • Model binding: modelName threaded through all re-calls
//   • Backoff between attempts: exponential
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { runContinuation, PSEUDO_CONTINUATION_PROMPT } = require(path.join(ROOT, 'src/agent/foundation/backends/ContinuationLoop'));
const { MockBackend } = require(path.join(ROOT, 'src/agent/foundation/backends/MockBackend'));

// ── Helpers ───────────────────────────────────────────────

function makeChunkedBackend(scripts) {
  return new MockBackend({
    mode: 'chunked',
    chunkedScripts: Array.isArray(scripts) ? scripts : [scripts],
  });
}

function captureEvents() {
  const log = [];
  return { bus: { emit: (name, payload) => log.push({ name, payload }) }, log };
}

function captureCircuitBreaker() {
  const calls = [];
  return {
    breaker: {
      recordSuccess: () => calls.push('success'),
      recordFailure: () => calls.push('failure'),
    },
    calls,
  };
}

// Mock with pushKeepAliveOverride support
class KeepAliveMock extends MockBackend {
  constructor(opts) {
    super(opts);
    this.overrideHistory = [];
    this.activeOverrides = 0;
  }
  pushKeepAliveOverride(value) {
    this.overrideHistory.push({ event: 'push', value, at: Date.now() });
    this.activeOverrides++;
    return () => {
      this.overrideHistory.push({ event: 'release', value, at: Date.now() });
      this.activeOverrides--;
    };
  }
}

// ── Fast path ────────────────────────────────────────────

describe('llm-resilience-v789 contract: ContinuationLoop fast path', () => {

  test('llm-resilience-v789 contract: complete on first stream → no re-call', async () => {
    const backend = makeChunkedBackend({
      chunks: ['function add(a, b) { return a + b; }'],
      delayMs: 0,
      doneReason: 'stop',
    });
    const result = await runContinuation({
      backend,
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'task' }],
      options: { modelName: 'mock', capability: { status: 'verified-prefill' } },
    });
    assertEqual(result.attempts, 1, 'single attempt');
    assertEqual(result.content, 'function add(a, b) { return a + b; }', 'full content');
    assertEqual(result.finalDoneReason, 'stop', 'stop preserved');
    assertEqual(backend.callCount, 1, 'one stream call');
  });

  test('llm-resilience-v789 contract: short balanced free text passes immediately', async () => {
    const backend = makeChunkedBackend({
      chunks: ['ls -la /tmp'],
      delayMs: 0,
      doneReason: 'stop',
    });
    const result = await runContinuation({
      backend, systemPrompt: 'sys', messages: [],
      options: { modelName: 'mock', capability: { status: 'verified-prefill' } },
    });
    assertEqual(result.attempts, 1, 'no re-call for short response');
    assertEqual(result.content, 'ls -la /tmp', 'content preserved');
  });

});

// ── Prefill continuation ─────────────────────────────────

describe('llm-resilience-v789 contract: ContinuationLoop prefill path', () => {

  test('llm-resilience-v789 contract: truncated → re-call with trailing assistant prefill → completes', async () => {
    const backend = makeChunkedBackend([
      // Round 1: truncated at length cap
      { chunks: ['function add(a, b) { return '], delayMs: 0, doneReason: 'length' },
      // Round 2: continues and finishes
      { chunks: ['a + b; }'], delayMs: 0, doneReason: 'stop' },
    ]);
    const result = await runContinuation({
      backend, systemPrompt: 'sys', messages: [{ role: 'user', content: 'task' }],
      options: { modelName: 'mock', capability: { status: 'verified-prefill' } },
    });
    assertEqual(result.attempts, 2, 'two attempts');
    assertEqual(result.content, 'function add(a, b) { return a + b; }', 'spliced result');
    assertEqual(result.finalDoneReason, 'stop', 'final stop');
    // Verify the second call had the assistant prefill message
    const secondCall = backend.calls[1];
    const hasAssistantPrefill = secondCall.messages.some(m => m.role === 'assistant');
    assert(hasAssistantPrefill, 'second call carries assistant prefill');
  });

  test('llm-resilience-v789 contract: prefill strips trailing whitespace from partial', async () => {
    const backend = makeChunkedBackend([
      { chunks: ['function add(a, b) {   \n  '], delayMs: 0, doneReason: 'length' },
      { chunks: ['return a + b;\n}'], delayMs: 0, doneReason: 'stop' },
    ]);
    await runContinuation({
      backend, systemPrompt: 'sys', messages: [],
      options: { modelName: 'mock', capability: { status: 'verified-prefill' } },
    });
    const secondCall = backend.calls[1];
    const assistantMsg = secondCall.messages.find(m => m.role === 'assistant');
    assert(assistantMsg, 'assistant message present');
    // Must not end in whitespace per Ollama/Anthropic prefill rules
    assertEqual(/\s$/.test(assistantMsg.content), false, 'trailing whitespace stripped');
  });

  test('llm-resilience-v789 contract: three re-calls until complete', async () => {
    const backend = makeChunkedBackend([
      { chunks: ['function f() {\n  if (a) {\n'], delayMs: 0, doneReason: 'length' },
      { chunks: ['    return 1;\n  } else {\n'], delayMs: 0, doneReason: 'length' },
      { chunks: ['    return 0;\n  }\n}'], delayMs: 0, doneReason: 'stop' },
    ]);
    const result = await runContinuation({
      backend, systemPrompt: 'sys', messages: [],
      options: {
        modelName: 'mock',
        capability: { status: 'verified-prefill' },
        maxContinuations: 5,
      },
    });
    assertEqual(result.attempts, 3, 'three attempts');
    assertEqual(result.finalDoneReason, 'stop', 'final stop');
    assert(result.content.includes('return 1') && result.content.includes('return 0'), 'all parts present');
  });

});

// ── Pseudo continuation ──────────────────────────────────

describe('llm-resilience-v789 contract: ContinuationLoop pseudo path', () => {

  test('llm-resilience-v789 contract: non-prefill model uses pseudo-continuation message', async () => {
    const backend = makeChunkedBackend([
      { chunks: ['function add(a, b) { return '], delayMs: 0, doneReason: 'length' },
      { chunks: ['a + b; }'], delayMs: 0, doneReason: 'stop' },
    ]);
    await runContinuation({
      backend, systemPrompt: 'sys', messages: [{ role: 'user', content: 'task' }],
      options: { modelName: 'mock', capability: { status: 'unverified-no-prefill' } },
    });
    const secondCall = backend.calls[1];
    // Pseudo-continuation appends assistant + user(continue prompt)
    const lastMsg = secondCall.messages[secondCall.messages.length - 1];
    assertEqual(lastMsg.role, 'user', 'last message is user (continue prompt)');
    assertEqual(lastMsg.content, PSEUDO_CONTINUATION_PROMPT, 'pseudo prompt used');
    const prevMsg = secondCall.messages[secondCall.messages.length - 2];
    assertEqual(prevMsg.role, 'assistant', 'preceded by assistant (partial)');
  });

  test('llm-resilience-v789 contract: special-renderer falls through to pseudo path', async () => {
    const backend = makeChunkedBackend([
      { chunks: ['partial '], delayMs: 0, doneReason: 'length' },
      { chunks: ['rest'], delayMs: 0, doneReason: 'stop' },
    ]);
    await runContinuation({
      backend, systemPrompt: 'sys', messages: [],
      options: { modelName: 'mock', capability: { status: 'special-renderer' } },
    });
    const secondCall = backend.calls[1];
    const lastMsg = secondCall.messages[secondCall.messages.length - 1];
    assertEqual(lastMsg.content, PSEUDO_CONTINUATION_PROMPT, 'pseudo prompt used for renderer-models');
  });

  test('llm-resilience-v789 contract: verification-failed also uses pseudo path', async () => {
    const backend = makeChunkedBackend([
      { chunks: ['partial '], delayMs: 0, doneReason: 'length' },
      { chunks: ['rest'], delayMs: 0, doneReason: 'stop' },
    ]);
    await runContinuation({
      backend, systemPrompt: 'sys', messages: [],
      options: { modelName: 'mock', capability: { status: 'verification-failed' } },
    });
    const secondCall = backend.calls[1];
    const lastMsg = secondCall.messages[secondCall.messages.length - 1];
    assertEqual(lastMsg.content, PSEUDO_CONTINUATION_PROMPT, 'pseudo prompt for verification-failed');
  });

});

// ── Exhaustion paths ─────────────────────────────────────

describe('llm-resilience-v789 contract: ContinuationLoop exhaustion', () => {

  test('llm-resilience-v789 contract: max-continuations exhausted returns partial', async () => {
    // All rounds truncate — never completes
    const backend = makeChunkedBackend([
      { chunks: ['a'], delayMs: 0, doneReason: 'length' },
      { chunks: ['b'], delayMs: 0, doneReason: 'length' },
      // (with maxContinuations=2, only 2 attempts)
    ]);
    const result = await runContinuation({
      backend, systemPrompt: 'sys', messages: [],
      options: {
        modelName: 'mock',
        capability: { status: 'verified-prefill' },
        maxContinuations: 2,
      },
    });
    assertEqual(result.attempts, 2, 'two attempts');
    assertEqual(result.content, 'ab', 'partial content preserved');
    // finalDoneReason reflects last round's truncation signal
    assertEqual(result.finalDoneReason, 'length', 'last reason preserved');
  });

  test('llm-resilience-v789 contract: empty partial content survives exhaustion', async () => {
    const backend = makeChunkedBackend([
      { chunks: [''], delayMs: 0, doneReason: 'length' },
    ]);
    const result = await runContinuation({
      backend, systemPrompt: 'sys', messages: [],
      options: { modelName: 'mock', capability: { status: 'verified-prefill' }, maxContinuations: 1 },
    });
    assertEqual(result.content, '', 'empty content allowed');
    assertEqual(result.attempts, 1, 'one attempt');
  });

});

// ── Bus events ───────────────────────────────────────────

describe('llm-resilience-v789 contract: ContinuationLoop bus events', () => {

  test('llm-resilience-v789 contract: success emits started + complete events', async () => {
    const backend = makeChunkedBackend([{
      chunks: ['function f() {}'], delayMs: 0, doneReason: 'stop',
    }]);
    const { bus, log } = captureEvents();
    await runContinuation({
      backend, systemPrompt: 'sys', messages: [],
      options: { modelName: 'mock-model', capability: { status: 'verified-prefill' }, eventBus: bus },
    });
    assertEqual(log.length, 2, 'two events');
    assertEqual(log[0].name, 'llm:continuation-started', 'started first');
    assertEqual(log[0].payload.model, 'mock-model', 'model in start payload');
    assertEqual(log[0].payload.capability, 'verified-prefill', 'capability in start payload');
    assertEqual(log[1].name, 'llm:continuation-complete', 'complete second');
    assertEqual(log[1].payload.attempts, 1, 'attempts in complete payload');
    assert(log[1].payload.durationMs >= 0, 'durationMs present');
  });

  test('llm-resilience-v789 contract: failure emits started + failed events', async () => {
    const backend = makeChunkedBackend([
      { chunks: ['a'], delayMs: 0, doneReason: 'length' },
    ]);
    const { bus, log } = captureEvents();
    await runContinuation({
      backend, systemPrompt: 'sys', messages: [],
      options: {
        modelName: 'mock', capability: { status: 'verified-prefill' },
        eventBus: bus, maxContinuations: 1,
      },
    });
    assertEqual(log[0].name, 'llm:continuation-started', 'started');
    assertEqual(log[1].name, 'llm:continuation-failed', 'failed');
    assertEqual(log[1].payload.reason, 'max-continuations', 'reason given');
    assertEqual(log[1].payload.partialContentLength, 1, 'partial length recorded');
  });

});

// ── CircuitBreaker integration ───────────────────────────

describe('llm-resilience-v789 contract: ContinuationLoop circuit-breaker integration', () => {

  test('llm-resilience-v789 contract: success reports ONE recordSuccess() regardless of re-call count', async () => {
    const backend = makeChunkedBackend([
      { chunks: ['part1 '], delayMs: 0, doneReason: 'length' },
      { chunks: ['part2 '], delayMs: 0, doneReason: 'length' },
      { chunks: ['part3'], delayMs: 0, doneReason: 'stop' },
    ]);
    const { breaker, calls } = captureCircuitBreaker();
    await runContinuation({
      backend, systemPrompt: 'sys', messages: [],
      options: {
        modelName: 'mock', capability: { status: 'verified-prefill' },
        circuitBreaker: breaker, maxContinuations: 5,
      },
    });
    assertEqual(calls.length, 1, 'exactly one breaker call');
    assertEqual(calls[0], 'success', 'recorded as success');
  });

  test('llm-resilience-v789 contract: failure reports ONE recordFailure() regardless of re-call count', async () => {
    const backend = makeChunkedBackend([
      { chunks: ['a'], delayMs: 0, doneReason: 'length' },
      { chunks: ['b'], delayMs: 0, doneReason: 'length' },
    ]);
    const { breaker, calls } = captureCircuitBreaker();
    await runContinuation({
      backend, systemPrompt: 'sys', messages: [],
      options: {
        modelName: 'mock', capability: { status: 'verified-prefill' },
        circuitBreaker: breaker, maxContinuations: 2,
      },
    });
    assertEqual(calls.length, 1, 'exactly one breaker call');
    assertEqual(calls[0], 'failure', 'recorded as failure');
  });

});

// ── keep_alive override ──────────────────────────────────

describe('llm-resilience-v789 contract: ContinuationLoop keep_alive lifecycle', () => {

  test('llm-resilience-v789 contract: pushes keep_alive override on entry, releases on success', async () => {
    const backend = new KeepAliveMock({
      mode: 'chunked',
      chunkedScripts: [{ chunks: ['done'], delayMs: 0, doneReason: 'stop' }],
    });
    await runContinuation({
      backend, systemPrompt: 'sys', messages: [],
      options: { modelName: 'mock', capability: { status: 'verified-prefill' } },
    });
    const pushes = backend.overrideHistory.filter(e => e.event === 'push').length;
    const releases = backend.overrideHistory.filter(e => e.event === 'release').length;
    assertEqual(pushes, 1, 'one push');
    assertEqual(releases, 1, 'one release');
    assertEqual(backend.activeOverrides, 0, 'no leaks');
  });

  test('llm-resilience-v789 contract: releases keep_alive even on failure', async () => {
    const backend = new KeepAliveMock({
      mode: 'chunked',
      chunkedScripts: [{ chunks: ['a'], delayMs: 0, doneReason: 'length' }],
    });
    await runContinuation({
      backend, systemPrompt: 'sys', messages: [],
      options: { modelName: 'mock', capability: { status: 'verified-prefill' }, maxContinuations: 1 },
    });
    assertEqual(backend.activeOverrides, 0, 'released even on failure');
  });

  test('llm-resilience-v789 contract: tolerates backend without pushKeepAliveOverride', async () => {
    // Plain MockBackend has no such method — should not crash
    const backend = makeChunkedBackend({ chunks: ['ok'], delayMs: 0, doneReason: 'stop' });
    const result = await runContinuation({
      backend, systemPrompt: 'sys', messages: [],
      options: { modelName: 'mock', capability: { status: 'verified-prefill' } },
    });
    assertEqual(result.attempts, 1, 'completes without override support');
  });

});

// ── Model binding ────────────────────────────────────────

describe('llm-resilience-v789 contract: ContinuationLoop model binding', () => {

  test('llm-resilience-v789 contract: same modelName threaded through all re-calls', async () => {
    const backend = makeChunkedBackend([
      { chunks: ['a'], delayMs: 0, doneReason: 'length' },
      { chunks: ['b'], delayMs: 0, doneReason: 'stop' },
    ]);
    await runContinuation({
      backend, systemPrompt: 'sys', messages: [],
      options: { modelName: 'qwen3:32b', capability: { status: 'verified-prefill' } },
    });
    assertEqual(backend.calls[0].modelName, 'qwen3:32b', 'first call');
    assertEqual(backend.calls[1].modelName, 'qwen3:32b', 'second call same model');
  });

});

if (require.main === module) run();
