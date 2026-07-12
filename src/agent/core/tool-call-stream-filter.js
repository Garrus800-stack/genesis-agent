// ============================================================
// GENESIS — tool-call-stream-filter.js (v7.3.4, generalized v7.9.28)
//
// Pure, stateful filter that strips tool-call blocks out of a
// streamed LLM response so the raw markup never reaches the UI.
// The raw text is preserved in the caller's fullResponse (the
// tool-execution loop parses it); this filter only shapes the
// stream shown to the user.
//
// v7.9.28: generalized from a single <tool_call> pair to a list
// of fixed open/close pairs. A model that emits the Anthropic XML
// form <function_calls><invoke ...></function_calls> used to show
// the raw markup in chat (the parser executed it afterward, but it
// looked broken). Stripping the whole <function_calls> block also
// covers the <invoke>/<parameter> tags nested inside it.
//
// NOTE: bare <tool>...</tool> is intentionally NOT a block — it is
// ordinary text and must pass through unchanged.
//
// ── Usage ────────────────────────────────────────────────────
//   const { createToolCallStreamFilter } = require('../core/tool-call-stream-filter');
//   const filter = createToolCallStreamFilter();
//   const filteredOnChunk = (chunk) => { const out = filter.push(chunk); if (out) realOnChunk(out); };
//   const tail = filter.flush(); if (tail) realOnChunk(tail);
// ============================================================

// Fixed open/close tag pairs to strip. Matching picks the earliest
// open found in the buffer.
const BLOCKS = [
  { open: '<tool_calls>', close: '</tool_calls>' }, // v7.9.37 (Z1): deepseek-v4-pro emits a plural wrapper with empty hulls — field 14 showed nine of them raw in the bubble
  { open: '<tool_call>', close: '</tool_call>' },
  { open: '<function_calls>', close: '</function_calls>' },
];
// Longest open tag — how many trailing chars to retain as lookahead
// so an open tag split across chunk boundaries is still detected.
const MAX_OPEN = BLOCKS.reduce((m, b) => Math.max(m, b.open.length), 0);

/**
 * Create a new filter instance. Stateful; do not share across streams.
 * @returns {{ push(chunk: string): string, flush(): string, get inToolCall(): boolean }}
 */
function createToolCallStreamFilter() {
  // closeTag === null → outside any block. Otherwise it holds the close
  // tag we are currently scanning for.
  const state = { closeTag: null, buffer: '' };

  function push(chunk) {
    if (!chunk) return '';
    state.buffer += chunk;
    let out = '';
    while (state.buffer.length > 0) {
      if (state.closeTag === null) {
        // Find the earliest complete open tag across all block types.
        let bestIdx = -1;
        let bestBlock = null;
        for (const b of BLOCKS) {
          const i = state.buffer.indexOf(b.open);
          if (i !== -1 && (bestIdx === -1 || i < bestIdx)) { bestIdx = i; bestBlock = b; }
        }
        if (bestIdx === -1) {
          // No complete open tag. Keep a MAX_OPEN tail as lookahead for a
          // tag that spans the chunk boundary; emit everything before it.
          if (state.buffer.length > MAX_OPEN) {
            out += state.buffer.slice(0, -MAX_OPEN);
            state.buffer = state.buffer.slice(-MAX_OPEN);
          }
          break;
        }
        out += state.buffer.slice(0, bestIdx);
        state.buffer = state.buffer.slice(bestIdx + bestBlock.open.length);
        state.closeTag = bestBlock.close;
      } else {
        const closeIdx = state.buffer.indexOf(state.closeTag);
        if (closeIdx === -1) {
          // Still inside a block, no close yet. Drop everything except a
          // close-tag-length tail as lookahead for the closing tag.
          if (state.buffer.length > state.closeTag.length) {
            state.buffer = state.buffer.slice(-state.closeTag.length);
          }
          break;
        }
        state.buffer = state.buffer.slice(closeIdx + state.closeTag.length);
        state.closeTag = null;
      }
    }
    return out;
  }

  function flush() {
    // End of stream. Outside a block → whatever is buffered is safe to emit
    // (it cannot be the start of a tag now). Inside a block → the stream was
    // truncated mid-call; drop the dangling bytes silently.
    if (state.closeTag === null && state.buffer.length > 0) {
      const tail = state.buffer;
      state.buffer = '';
      return tail;
    }
    return '';
  }

  return {
    push,
    flush,
    get inToolCall() { return state.closeTag !== null; },
  };
}

module.exports = { createToolCallStreamFilter };
