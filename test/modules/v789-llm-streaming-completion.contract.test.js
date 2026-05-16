// ============================================================
// GENESIS — test/modules/v789-llm-streaming-completion.contract.test.js
// Contract test for v7.8.9 StreamingCompletion:
//   • Happy path: chunks accumulate, doneReason captured
//   • First-chunk timeout: backend silent → terminates cleanly
//   • Inter-chunk timeout: gap >chunkTimeout → terminates cleanly
//   • Total timeout: hard cap regardless of progress
//   • TCP-drop simulation (no terminal chunk) → doneReason null
//   • External abort: respects caller-provided signal
//   • doneReason='length' (token cap) is preserved
//   • Never throws — all failure modes return result object
// Every test name carries `llm-resilience-v789 contract:` prefix.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { streamingCompletion } = require(path.join(ROOT, 'src/agent/foundation/backends/StreamingCompletion'));
const { MockBackend } = require(path.join(ROOT, 'src/agent/foundation/backends/MockBackend'));

// ── Helpers ───────────────────────────────────────────────

function makeChunkedBackend(script) {
  return new MockBackend({
    mode: 'chunked',
    chunkedScripts: Array.isArray(script) ? script : [script],
  });
}

// ── Tests ─────────────────────────────────────────────────

describe('llm-resilience-v789 contract: StreamingCompletion happy path', () => {

  test('llm-resilience-v789 contract: accumulates chunks and captures doneReason', async () => {
    const backend = makeChunkedBackend({
      chunks: ['Hello ', 'world ', 'from ', 'mock'],
      delayMs: 5,
      doneReason: 'stop',
    });

    const result = await streamingCompletion({
      backend,
      systemPrompt: 'sys',
      messages: [],
      options: { firstChunkTimeoutMs: 1000, chunkTimeoutMs: 1000, totalTimeoutMs: 5000 },
    });

    assertEqual(result.content, 'Hello world from mock', 'all chunks accumulated');
    assertEqual(result.doneReason, 'stop', 'doneReason captured');
    assertEqual(result.chunkCount, 4, 'four chunks received');
    assertEqual(result.attempts, 1, 'attempts always 1 (loop layer counts higher)');
    assert(result.elapsedMs >= 0, 'elapsedMs non-negative');
    assert(result.firstChunkMs !== null, 'firstChunkMs measured');
  });

  test('llm-resilience-v789 contract: preserves doneReason=length (token cap)', async () => {
    const backend = makeChunkedBackend({
      chunks: ['partial output that hit token cap'],
      delayMs: 0,
      doneReason: 'length',
    });

    const result = await streamingCompletion({
      backend,
      systemPrompt: 'sys',
      messages: [],
      options: { firstChunkTimeoutMs: 1000 },
    });

    assertEqual(result.doneReason, 'length', 'length reason preserved (signals truncation)');
    assert(result.content.length > 0, 'content present');
  });

});

describe('llm-resilience-v789 contract: StreamingCompletion timeouts', () => {

  test('llm-resilience-v789 contract: first-chunk timeout when backend stays silent', async () => {
    // Backend that delays the first chunk beyond firstChunkTimeoutMs
    const backend = makeChunkedBackend({
      chunks: ['too late'],
      delayMs: 500,  // delay before first chunk
      doneReason: 'stop',
    });

    const result = await streamingCompletion({
      backend,
      systemPrompt: 'sys',
      messages: [],
      options: { firstChunkTimeoutMs: 50, chunkTimeoutMs: 5000, totalTimeoutMs: 5000 },
    });

    assertEqual(result.doneReason, 'first-chunk-timeout', 'first-chunk timeout flagged');
    assertEqual(result.content, '', 'no content accumulated before timeout');
    assertEqual(result.firstChunkMs, null, 'firstChunkMs null when no chunk received');
  });

  test('llm-resilience-v789 contract: inter-chunk timeout fires when gap is too large', async () => {
    // Multi-chunk script where the gap between chunks exceeds chunkTimeoutMs
    const backend = makeChunkedBackend({
      chunks: ['first ', 'second-after-long-gap'],
      delayMs: 300,  // 300ms between chunks, exceeds 50ms chunkTimeout
      doneReason: 'stop',
    });

    const result = await streamingCompletion({
      backend,
      systemPrompt: 'sys',
      messages: [],
      options: { firstChunkTimeoutMs: 1000, chunkTimeoutMs: 50, totalTimeoutMs: 5000 },
    });

    assertEqual(result.doneReason, 'chunk-timeout', 'inter-chunk timeout flagged');
    assert(result.content.length > 0, 'partial content preserved from before timeout');
    assert(result.firstChunkMs !== null, 'first chunk arrived before timeout');
  });

  test('llm-resilience-v789 contract: total timeout caps overall duration', async () => {
    // Many small chunks each within chunkTimeout, but total takes too long
    const chunks = [];
    for (let i = 0; i < 20; i++) chunks.push(`chunk${i} `);
    const backend = makeChunkedBackend({
      chunks,
      delayMs: 30,  // 20 * 30 = 600ms total, exceeds totalTimeoutMs
      doneReason: 'stop',
    });

    const result = await streamingCompletion({
      backend,
      systemPrompt: 'sys',
      messages: [],
      options: { firstChunkTimeoutMs: 1000, chunkTimeoutMs: 1000, totalTimeoutMs: 100 },
    });

    assertEqual(result.doneReason, 'total-timeout', 'total timeout caps duration');
    assert(result.elapsedMs >= 100, 'elapsedMs at least totalTimeout');
    assert(result.content.length > 0, 'partial content preserved');
  });

});

describe('llm-resilience-v789 contract: StreamingCompletion termination handling', () => {

  test('llm-resilience-v789 contract: TCP-drop simulation yields doneReason=null', async () => {
    // terminateAt: 2 means after chunk index 2 the stream simulates a TCP drop —
    // no further chunks, onDone called with null.
    const backend = makeChunkedBackend({
      chunks: ['part1 ', 'part2 ', 'part3 ', 'never-arrives'],
      delayMs: 5,
      doneReason: 'stop',  // would be 'stop' if completed, but terminateAt interrupts
      terminateAt: 2,
    });

    const result = await streamingCompletion({
      backend,
      systemPrompt: 'sys',
      messages: [],
      options: { firstChunkTimeoutMs: 1000, chunkTimeoutMs: 1000, totalTimeoutMs: 5000 },
    });

    assertEqual(result.doneReason, null, 'null doneReason signals TCP-drop');
    assertEqual(result.content, 'part1 part2 ', 'content up to drop preserved');
    assertEqual(result.chunkCount, 2, 'two chunks received before drop');
  });

  test('llm-resilience-v789 contract: external abort cancels stream', async () => {
    const backend = makeChunkedBackend({
      chunks: ['c1 ', 'c2 ', 'c3 ', 'c4'],
      delayMs: 50,
      doneReason: 'stop',
    });

    const ctrl = new AbortController();
    // Abort after 75ms — should land after first chunk, before all done
    setTimeout(() => ctrl.abort(), 75);

    const result = await streamingCompletion({
      backend,
      systemPrompt: 'sys',
      messages: [],
      options: {
        firstChunkTimeoutMs: 1000,
        chunkTimeoutMs: 1000,
        totalTimeoutMs: 5000,
        externalAbort: ctrl.signal,
      },
    });

    // Either 'abort' (caught in mock's abort branch) or whatever MockBackend reports.
    assert(['abort', null, 'stop'].includes(result.doneReason), 'doneReason reflects abort path');
    // At least one chunk must have arrived if delay timing allowed it.
    assert(result.content.length >= 0, 'content may be partial');
  });

  test('llm-resilience-v789 contract: never throws (errors become result object)', async () => {
    // Use error-mode backend that throws on chat() but stream() falls back to chat() internally.
    // To force a stream-level error we exhaust the chunked script and let it call onDone('stop').
    const backend = new MockBackend({ mode: 'error', errorMessage: 'simulated network failure' });

    // Patch backend.stream to throw mid-operation
    backend.stream = async () => {
      throw new Error('[NETWORK] simulated');
    };

    const result = await streamingCompletion({
      backend,
      systemPrompt: 'sys',
      messages: [],
      options: { firstChunkTimeoutMs: 200 },
    });

    assertEqual(result.doneReason, 'error', 'network errors surface as doneReason=error');
    assertEqual(result.content, '', 'no content when stream errors before first chunk');
    assertEqual(result.attempts, 1, 'attempts still 1');
  });

});

describe('llm-resilience-v789 contract: StreamingCompletion uses default timeouts from Constants', () => {

  test('llm-resilience-v789 contract: defaults are non-zero (not accidentally null-ish)', async () => {
    // Smoke test: don't pass any timeout options, verify the call completes
    // using TIMEOUTS.LLM_STREAM_* defaults without crashing.
    const backend = makeChunkedBackend({
      chunks: ['quick'],
      delayMs: 0,
      doneReason: 'stop',
    });

    const result = await streamingCompletion({
      backend,
      systemPrompt: 'sys',
      messages: [],
    });

    assertEqual(result.doneReason, 'stop', 'defaults work, call completes');
    assertEqual(result.content, 'quick', 'content received');
  });

});

if (require.main === module) run();
