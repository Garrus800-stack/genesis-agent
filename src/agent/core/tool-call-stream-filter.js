// ============================================================
// GENESIS — tool-call-stream-filter.js (v7.3.4)
//
// Pure, stateful filter that strips <tool_call>...</tool_call>
// blocks out of a streamed LLM response. The raw markup is
// preserved in the caller's fullResponse (needed by the tool
// execution loop); this filter only shapes what reaches the UI.
//
// Extracted from ChatOrchestrator.handleStream in v7.3.4 to
// make it unit-testable in isolation. Previously the test file
// replicated the state-machine logic inline, so tests verified
// the test's copy instead of the production code. This module
// is the single source of truth; the test calls this function.
//
// ── Usage ────────────────────────────────────────────────────
//
//   const { createToolCallStreamFilter } = require('../core/tool-call-stream-filter');
//
//   const filter = createToolCallStreamFilter();
//   const filteredOnChunk = (chunk) => {
//     const out = filter.push(chunk);
//     if (out) realOnChunk(out);
//   };
//   // ... after stream ends ...
//   const tail = filter.flush();
//   if (tail) realOnChunk(tail);
//
// The filter is a small object holding three fields:
//   - inToolCall  : boolean — are we currently inside a block?
//   - buffer      : string  — lookahead bytes not yet decided
//   - push(chunk) : returns filtered output for this chunk
//   - flush()     : returns final safe tail at end of stream
//
// Tags split across chunk boundaries are handled by retaining
// the last 11 or 12 characters of the buffer (the lengths of
// '<tool_call>' and '</tool_call>' respectively) until a full
// tag either appears or cannot possibly appear.
// ============================================================

const OPEN_TAG = '<tool_call>';
const CLOSE_TAG = '</tool_call>';
const OPEN_LEN = OPEN_TAG.length;   // 11
const CLOSE_LEN = CLOSE_TAG.length; // 12

/**
 * Create a new filter instance. The returned object is stateful
 * and should not be shared across concurrent streams.
 *
 * @returns {{ push(chunk: string): string, flush(): string, get inToolCall(): boolean }}
 */
function createToolCallStreamFilter() {
  const state = { inToolCall: false, buffer: '' };

  function push(chunk) {
    if (!chunk) return '';
    state.buffer += chunk;
    let out = '';
    while (state.buffer.length > 0) {
      if (!state.inToolCall) {
        const openIdx = state.buffer.indexOf(OPEN_TAG);
        if (openIdx === -1) {
          // No open tag seen. We might be mid-tag (e.g. "<tool_" waiting for
          // "call>"). Keep the last OPEN_LEN-1 characters as lookahead so a
          // tag that spans the chunk boundary can still be detected.
          if (state.buffer.length > OPEN_LEN) {
            out += state.buffer.slice(0, -OPEN_LEN);
            state.buffer = state.buffer.slice(-OPEN_LEN);
          }
          break;
        }
        out += state.buffer.slice(0, openIdx);
        state.buffer = state.buffer.slice(openIdx + OPEN_LEN);
        state.inToolCall = true;
      } else {
        const closeIdx = state.buffer.indexOf(CLOSE_TAG);
        if (closeIdx === -1) {
          // Still inside a tool_call block, no close yet. Drop everything
          // except a CLOSE_LEN tail as lookahead for the closing tag.
          if (state.buffer.length > CLOSE_LEN) {
            state.buffer = state.buffer.slice(-CLOSE_LEN);
          }
          break;
        }
        state.buffer = state.buffer.slice(closeIdx + CLOSE_LEN);
        state.inToolCall = false;
      }
    }
    return out;
  }

  function flush() {
    // End of stream. If we ended outside a tool_call block, whatever is
    // still buffered is safe to emit (it cannot possibly be the start of
    // a tag now). If we ended inside a tool_call block, the stream was
    // truncated mid-call — drop the dangling bytes silently.
    if (!state.inToolCall && state.buffer.length > 0) {
      const tail = state.buffer;
      state.buffer = '';
      return tail;
    }
    return '';
  }

  return {
    push,
    flush,
    get inToolCall() { return state.inToolCall; },
  };
}

module.exports = { createToolCallStreamFilter };
