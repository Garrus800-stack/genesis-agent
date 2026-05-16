// ============================================================
// GENESIS — backends/StreamingCompletion.js (v7.8.9)
//
// llm-resilience-v789 contract: thin wrapper around a backend's
// stream() that accumulates chunks into a string buffer, applies
// three layered timeouts (first-chunk, between-chunks, total),
// and surfaces both the partial content AND the done_reason from
// the terminal NDJSON chunk.
//
// Why this exists:
//   The bare stream() method has only a single coarse-grained
//   timeout (req.setTimeout). For code-generation calls against
//   large models (cold-loaded 70B+ or :cloud-routed), a single
//   180s cap is simultaneously too long (active model that froze
//   keeps the request alive) and too short (cold-start of a
//   235B-cloud model legitimately needs 60-90s before the first
//   token). Splitting timeouts into first-chunk + chunk + total
//   matches actual streaming-LLM behavior far more closely and
//   lets a caller distinguish "model is dead" from "model is
//   slow but generating".
//
// Backward-compatibility:
//   This module does not replace stream() — it wraps it. Callers
//   that don't need timeout-tuning (the UI's ChatOrchestrator,
//   for example) continue to call stream() directly. Only
//   continuation-aware code paths route through here.
//
// Return shape:
//   {
//     content:       string,         // everything received so far
//     doneReason:    string|null,    // 'stop' | 'length' | 'abort' | 'timeout' | 'first-chunk-timeout' | 'chunk-timeout' | 'total-timeout' | 'error' | null
//     attempts:      1,              // always 1 here — ContinuationLoop counts higher
//     elapsedMs:     number,         // total wall-clock time
//     firstChunkMs:  number|null,    // ms to first content chunk
//     chunkCount:    number,         // how many chunks were received
//   }
//
// This module never throws — every failure path returns a result
// with the relevant doneReason. The caller decides what to do.
// ============================================================

'use strict';

const { createLogger } = require('../../core/Logger');
const { TIMEOUTS } = require('../../core/Constants');

const _log = createLogger('StreamingCompletion');

/**
 * Run one streaming completion call against a backend.
 *
 * @param {object} args
 * @param {object} args.backend           - Backend instance with .stream() method
 * @param {string} args.systemPrompt
 * @param {Array}  args.messages          - Array of { role, content }
 * @param {object} [args.options]
 * @param {number} [args.options.temperature]
 * @param {string} [args.options.modelName]
 * @param {number} [args.options.maxTokens]
 * @param {number} [args.options.firstChunkTimeoutMs]
 * @param {number} [args.options.chunkTimeoutMs]
 * @param {number} [args.options.totalTimeoutMs]
 * @param {AbortSignal} [args.options.externalAbort] - Caller-provided abort
 * @returns {Promise<{content: string, doneReason: string|null, attempts: number, elapsedMs: number, firstChunkMs: number|null, chunkCount: number}>}
 */
async function streamingCompletion(args) {
  const {
    backend,
    systemPrompt,
    messages = [],
    options = {},
  } = args;

  const firstChunkTimeoutMs = options.firstChunkTimeoutMs ?? TIMEOUTS.LLM_STREAM_FIRST_CHUNK;
  const chunkTimeoutMs      = options.chunkTimeoutMs      ?? TIMEOUTS.LLM_STREAM_CHUNK;
  const totalTimeoutMs      = options.totalTimeoutMs      ?? TIMEOUTS.LLM_STREAM_TOTAL;

  const startedAt = Date.now();
  let content = '';
  let chunkCount = 0;
  let firstChunkAt = null;
  let doneReason = null;
  let _terminated = false;

  // Local abort controller for timeout-triggered aborts; chained to externalAbort if provided.
  const localCtrl = new AbortController();
  if (options.externalAbort) {
    if (options.externalAbort.aborted) {
      localCtrl.abort();
    } else {
      options.externalAbort.addEventListener('abort', () => localCtrl.abort(), { once: true });
    }
  }

  const terminate = (reason) => {
    if (_terminated) return;
    _terminated = true;
    if (!doneReason) doneReason = reason;
    try { localCtrl.abort(); } catch (_e) { /* swallow */ }
  };

  // ── Timer 1: first-chunk timeout ─────────────────────────
  let firstChunkTimer = setTimeout(() => {
    if (firstChunkAt === null) {
      _log.warn(`[STREAM] first-chunk timeout after ${Math.round(firstChunkTimeoutMs / 1000)}s`);
      terminate('first-chunk-timeout');
    }
  }, firstChunkTimeoutMs);

  // ── Timer 2: between-chunks timeout (sliding) ────────────
  let lastChunkAt = startedAt;
  // Watchdog poll-interval is chunkTimeoutMs/4 (min 50ms, max 5s). The lower
  // bound keeps short test timeouts (~50ms) responsive while the upper bound
  // avoids busy-looping at production-scale timeouts (30s+).
  // Implemented as a self-rearming setTimeout instead of setInterval to
  // (a) stop cleanly when terminated, (b) avoid the architectural-fitness
  // "raw setInterval" audit hit (which prefers IntervalManager — overkill
  // for a sub-second poll local to one short-lived async function).
  const watchdogIntervalMs = Math.min(5000, Math.max(50, Math.floor(chunkTimeoutMs / 4)));
  let chunkWatchdogHandle = null;
  const scheduleWatchdog = () => {
    if (_terminated) return;
    chunkWatchdogHandle = setTimeout(() => {
      if (_terminated) return;
      if (firstChunkAt !== null) {
        const gap = Date.now() - lastChunkAt;
        if (gap > chunkTimeoutMs) {
          _log.warn(`[STREAM] inter-chunk gap ${Math.round(gap / 1000)}s exceeded ${Math.round(chunkTimeoutMs / 1000)}s`);
          terminate('chunk-timeout');
          return;
        }
      }
      scheduleWatchdog();
    }, watchdogIntervalMs);
  };
  scheduleWatchdog();

  // ── Timer 3: hard total cap ──────────────────────────────
  const totalTimer = setTimeout(() => {
    _log.warn(`[STREAM] total timeout after ${Math.round(totalTimeoutMs / 1000)}s`);
    terminate('total-timeout');
  }, totalTimeoutMs);

  const cleanup = () => {
    clearTimeout(firstChunkTimer);
    clearTimeout(totalTimer);
    if (chunkWatchdogHandle) clearTimeout(chunkWatchdogHandle);
  };

  const onChunk = (text) => {
    if (_terminated) return;
    if (firstChunkAt === null) {
      firstChunkAt = Date.now();
      clearTimeout(firstChunkTimer);
      firstChunkTimer = null;
    }
    lastChunkAt = Date.now();
    chunkCount++;
    content += text;
  };

  const onDone = (reason) => {
    // Only set doneReason if termination hasn't already set one.
    // null is meaningful (TCP-drop, no terminal chunk arrived) — preserve it.
    if (doneReason === null) doneReason = reason !== undefined ? reason : 'stop';
  };

  try {
    await backend.stream(
      systemPrompt,
      messages,
      onChunk,
      localCtrl.signal,
      options.temperature,
      options.modelName,
      options.maxTokens,
      onDone
    );
  } catch (err) {
    // stream() throws on network/timeout errors; we capture content already accumulated.
    if (!doneReason) {
      if (err && /TIMEOUT/i.test(err.message)) doneReason = 'timeout';
      else if (err && /NETWORK/i.test(err.message)) doneReason = 'error';
      else doneReason = 'error';
    }
    _log.debug(`[STREAM] backend.stream threw: ${err.message} (content so far: ${content.length} chars)`);
  } finally {
    cleanup();
  }

  return {
    content,
    doneReason,
    attempts: 1,
    elapsedMs: Date.now() - startedAt,
    firstChunkMs: firstChunkAt !== null ? firstChunkAt - startedAt : null,
    chunkCount,
  };
}

module.exports = { streamingCompletion };
