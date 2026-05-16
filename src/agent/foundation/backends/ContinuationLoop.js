// ============================================================
// GENESIS — backends/ContinuationLoop.js (v7.8.9)
//
// llm-resilience-v789 contract: orchestrates streaming + truncation
// detection + capability-aware continuation re-calls so that
// long code-generation outputs survive Ollama timeouts and
// token-cap truncations.
//
// Flow:
//   1. Initial streaming call (via StreamingCompletion).
//   2. TruncationDetector.isComplete(content, doneReason).
//   3. If complete → return immediately (fast path).
//   4. If truncated:
//      a. Check capability (LLMCapabilityDetector cached lookup).
//      b. If 'verified-prefill' → re-call with trailing assistant
//         message containing the partial content.
//      c. If 'unverified-no-prefill' / 'verification-failed' /
//         'special-renderer' → re-call with pseudo-continuation
//         prompt (extra user message asking model to continue).
//      d. Exponential backoff between re-calls: 1s, 2s, 4s, 8s.
//      e. Repeat up to MAX_CONTINUATIONS times.
//   5. Model binding: the model captured at sequence start is used
//      for ALL re-calls; user-initiated model switches mid-sequence
//      are ignored.
//   6. keep_alive override: temporarily set "15m" on the backend so
//      the model stays loaded between re-calls (released on exit).
//   7. CircuitBreaker integration: a sequence is reported as ONE
//      logical call (single success/failure record) regardless of
//      how many re-calls happened internally.
//   8. Bus events: continuation-started / -complete / -failed.
//
// Returns:
//   {
//     content:         string,
//     attempts:        number,           // 1 = no continuation needed
//     totalElapsedMs:  number,
//     finalDoneReason: string | null,
//     totalTokens:     number | undefined,  // sum of evalCount if available
//   }
//
// Never throws — error paths return partial content with a
// failure-indicating finalDoneReason. The caller decides whether
// the partial content is usable.
// ============================================================

'use strict';

const { createLogger } = require('../../core/Logger');
const { TIMEOUTS } = require('../../core/Constants');
const { streamingCompletion } = require('./StreamingCompletion');
const { isComplete } = require('./TruncationDetector');

const _log = createLogger('ContinuationLoop');

const MAX_CONTINUATIONS_DEFAULT = 4;
const KEEP_ALIVE_OVERRIDE = '15m';
const BACKOFF_BASE_MS = 1000;
const PSEUDO_CONTINUATION_PROMPT =
  'Your previous response was truncated at the output token limit. ' +
  'Continue exactly from where you stopped. Do NOT repeat any prior text, ' +
  'do NOT re-emit code fences, do NOT add a preamble. Resume mid-token if necessary.';

/**
 * Run a continuation-aware completion against an Ollama backend.
 *
 * @param {object} args
 * @param {object} args.backend               - Backend instance (OllamaBackend or MockBackend)
 * @param {string} args.systemPrompt
 * @param {Array}  args.messages              - [{ role, content }, ...]
 * @param {object} args.options
 * @param {string} args.options.modelName     - Bound for the entire sequence
 * @param {number} [args.options.temperature]
 * @param {number} [args.options.maxTokens]
 * @param {object} [args.options.capability]  - Pre-fetched capability entry
 * @param {string} [args.options.taskType]    - For telemetry only
 * @param {number} [args.options.maxContinuations]
 * @param {number} [args.options.numCtx]      - For budget calculation (default 8192)
 * @param {number} [args.options.continuationTotalTimeoutMs]
 * @param {number} [args.options.firstChunkTimeoutMs]
 * @param {number} [args.options.chunkTimeoutMs]
 * @param {number} [args.options.totalTimeoutMs]
 * @param {object} [args.options.eventBus]    - .emit(name, payload)
 * @param {object} [args.options.circuitBreaker] - .recordSuccess() / .recordFailure()
 * @returns {Promise<{content: string, attempts: number, totalElapsedMs: number, finalDoneReason: string|null, totalTokens?: number}>}
 */
async function runContinuation(args) {
  const {
    backend,
    systemPrompt,
    messages = [],
    options = {},
  } = args;

  const {
    modelName,
    temperature,
    maxTokens,
    capability,
    taskType,
    maxContinuations = MAX_CONTINUATIONS_DEFAULT,
    numCtx = 8192,
    continuationTotalTimeoutMs = TIMEOUTS.LLM_CONTINUATION_TOTAL,
    firstChunkTimeoutMs,
    chunkTimeoutMs,
    totalTimeoutMs,
    eventBus,
    circuitBreaker,
  } = options;

  const startedAt = Date.now();
  const sequenceDeadline = startedAt + continuationTotalTimeoutMs;
  const tokenBudget = Math.floor(numCtx * 0.8);

  // ── Determine continuation strategy from capability ────
  const capabilityStatus = capability?.status || 'unknown';
  const usePrefill = capabilityStatus === 'verified-prefill';

  // ── keep_alive override (only if backend supports it) ──
  let releaseKeepAlive = null;
  if (typeof backend.pushKeepAliveOverride === 'function') {
    releaseKeepAlive = backend.pushKeepAliveOverride(KEEP_ALIVE_OVERRIDE);
  }

  // ── Emit start event ───────────────────────────────────
  _emit(eventBus, 'llm:continuation-started', {
    model: modelName || 'unknown',
    taskType: taskType || undefined,
    capability: capabilityStatus,
  });

  let partial = '';
  let totalTokens = 0;
  let attempts = 0;
  let lastDoneReason = null;
  let failureReason = null;

  try {
    for (let i = 0; i < maxContinuations; i++) {
      attempts++;

      // ── Build messages for this round ───────────────────
      let roundMessages;
      if (i === 0) {
        roundMessages = messages;
      } else if (usePrefill) {
        // Trailing-assistant prefill (Ollama modern-template magic).
        // Strip trailing whitespace per Anthropic/Ollama prefill rules.
        const prefillContent = partial.replace(/\s+$/, '');
        roundMessages = [
          ...messages,
          { role: 'assistant', content: prefillContent },
        ];
      } else {
        // Pseudo-continuation: assistant turn + user "continue" prompt.
        roundMessages = [
          ...messages,
          { role: 'assistant', content: partial },
          { role: 'user', content: PSEUDO_CONTINUATION_PROMPT },
        ];
      }

      // ── Time-budget check ──────────────────────────────
      if (Date.now() >= sequenceDeadline) {
        failureReason = 'sequence-deadline';
        break;
      }

      // ── Stream the round ───────────────────────────────
      const result = await streamingCompletion({
        backend,
        systemPrompt,
        messages: roundMessages,
        options: {
          temperature,
          modelName,
          maxTokens,
          firstChunkTimeoutMs,
          chunkTimeoutMs,
          totalTimeoutMs,
        },
      });

      partial += result.content;
      lastDoneReason = result.doneReason;
      if (typeof result.evalCount === 'number') totalTokens += result.evalCount;

      // ── Completeness check ─────────────────────────────
      const completeness = isComplete(partial, lastDoneReason);
      if (completeness.complete) {
        // Success — emit complete event, optional circuit-breaker record.
        const durationMs = Date.now() - startedAt;
        _emit(eventBus, 'llm:continuation-complete', {
          model: modelName || 'unknown',
          attempts,
          finalDoneReason: lastDoneReason || undefined,
          totalTokens: totalTokens > 0 ? totalTokens : undefined,
          durationMs,
        });
        if (circuitBreaker && typeof circuitBreaker.recordSuccess === 'function') {
          try { circuitBreaker.recordSuccess(); } catch (_e) { /* swallow */ }
        }
        return {
          content: partial,
          attempts,
          totalElapsedMs: durationMs,
          finalDoneReason: lastDoneReason,
          totalTokens: totalTokens || undefined,
        };
      }

      // ── Token-budget check ─────────────────────────────
      if (tokenBudget > 0 && totalTokens >= tokenBudget) {
        failureReason = 'token-budget';
        break;
      }

      // ── Exponential backoff before next attempt ────────
      if (i < maxContinuations - 1) {
        const backoffMs = BACKOFF_BASE_MS * Math.pow(2, i);
        const remainingTime = sequenceDeadline - Date.now();
        if (remainingTime <= backoffMs) {
          failureReason = 'sequence-deadline';
          break;
        }
        await _sleep(backoffMs);
      }
    }

    if (!failureReason) failureReason = 'max-continuations';
  } finally {
    // ── Always release keep_alive override ───────────────
    if (releaseKeepAlive) {
      try { releaseKeepAlive(); } catch (_e) { /* swallow */ }
    }
  }

  // ── Failure path ─────────────────────────────────────
  const durationMs = Date.now() - startedAt;
  _emit(eventBus, 'llm:continuation-failed', {
    model: modelName || 'unknown',
    attempts,
    reason: failureReason,
    partialContentLength: partial.length,
    durationMs,
  });
  if (circuitBreaker && typeof circuitBreaker.recordFailure === 'function') {
    try { circuitBreaker.recordFailure(); } catch (_e) { /* swallow */ }
  }
  _log.warn(`[CONTINUATION] sequence for "${modelName}" failed: ${failureReason} (attempts=${attempts}, partial=${partial.length} chars)`);
  return {
    content: partial,
    attempts,
    totalElapsedMs: durationMs,
    finalDoneReason: lastDoneReason,
    totalTokens: totalTokens || undefined,
  };
}

// ── Internals ──────────────────────────────────────────

function _emit(bus, eventName, payload) {
  if (!bus || typeof bus.emit !== 'function') return;
  try {
    bus.emit(eventName, payload);
  } catch (err) {
    _log.debug(`[CONTINUATION] event emit failed (${eventName}): ${err.message}`);
  }
}

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  runContinuation,
  // Constants exported for tests
  MAX_CONTINUATIONS_DEFAULT,
  KEEP_ALIVE_OVERRIDE,
  PSEUDO_CONTINUATION_PROMPT,
};
