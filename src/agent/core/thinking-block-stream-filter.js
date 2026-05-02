'use strict';
// ============================================================
// GENESIS — thinking-block-stream-filter.js (v7.5.6)
//
// Strips <think>...</think> and <thinking>...</thinking> blocks
// from streaming-LLM output. Reasoning models (DeepSeek-R1, QwQ,
// nemotron-3-nano, etc.) emit these blocks before the actual
// answer; without filtering they render as duplicate output and —
// worse — `parseToolCalls` would scan them and execute phantom
// tool calls the model only "thought about".
//
// Two exports:
//   createThinkingBlockStreamFilter()  — stateful filter for
//     streaming pipelines (push(chunk), flush(), getReasoning())
//   stripThinkingBlocks(text)          — pure function for
//     non-streaming model.chat() responses
//
// Same architecture pattern as tool-call-stream-filter.js: a tiny
// state machine that buffers across chunk boundaries to handle
// tag-splitting (e.g. "<thi" / "nk>" arriving in separate chunks).
// ============================================================

const TAGS = ['think', 'thinking'];

const _OPEN_PATTERNS = TAGS.map(t => `<${t}>`);
const _CLOSE_PATTERNS = TAGS.map(t => `</${t}>`);
const _MAX_OPEN_LEN = Math.max(..._OPEN_PATTERNS.map(p => p.length));
const _MAX_CLOSE_LEN = Math.max(..._CLOSE_PATTERNS.map(p => p.length));

function _findEarliest(text, patterns) {
  let best = { idx: -1, tag: null };
  const lower = text.toLowerCase();
  for (const tag of patterns) {
    const idx = lower.indexOf(tag.toLowerCase());
    if (idx !== -1 && (best.idx === -1 || idx < best.idx)) {
      best = { idx, tag };
    }
  }
  return best;
}

/**
 * Create a stateful streaming filter that strips thinking-blocks
 * across chunks. Returns { push, flush, getReasoning }.
 */
function createThinkingBlockStreamFilter() {
  let inside = false;
  let buffer = '';
  let reasoning = '';

  return {
    /**
     * Feed a chunk. Returns the cleaned slice that's safe to forward
     * downstream. May return '' if the chunk was entirely inside a
     * thinking-block, or if too short to disambiguate (held in buffer).
     */
    push(chunk) {
      if (!chunk) return '';
      buffer += chunk;
      let out = '';
      while (buffer.length > 0) {
        if (!inside) {
          const open = _findEarliest(buffer, _OPEN_PATTERNS);
          if (open.idx === -1) {
            // No open tag yet. Keep the last MAX_OPEN_LEN chars in case
            // the open tag straddles the next chunk boundary.
            if (buffer.length > _MAX_OPEN_LEN) {
              out += buffer.slice(0, -_MAX_OPEN_LEN);
              buffer = buffer.slice(-_MAX_OPEN_LEN);
            }
            break;
          }
          out += buffer.slice(0, open.idx);
          buffer = buffer.slice(open.idx + open.tag.length);
          inside = true;
        } else {
          const close = _findEarliest(buffer, _CLOSE_PATTERNS);
          if (close.idx === -1) {
            // No close tag yet — buffer everything except the trailing
            // MAX_CLOSE_LEN chars (which might be the start of </think>).
            if (buffer.length > _MAX_CLOSE_LEN) {
              reasoning += buffer.slice(0, -_MAX_CLOSE_LEN);
              buffer = buffer.slice(-_MAX_CLOSE_LEN);
            }
            break;
          }
          reasoning += buffer.slice(0, close.idx);
          buffer = buffer.slice(close.idx + close.tag.length);
          inside = false;
        }
      }
      return out;
    },

    /**
     * Call after the stream ends. Returns any tail text that was
     * buffered for boundary-checking. If the stream ended while still
     * inside a thinking-block (no closing tag), the buffered content
     * is treated as reasoning, not as visible output.
     */
    flush() {
      if (inside) {
        reasoning += buffer;
        buffer = '';
        return '';
      }
      const tail = buffer;
      buffer = '';
      return tail;
    },

    /**
     * The accumulated thinking-block content, after one or more push()
     * calls (and ideally a flush()).
     */
    getReasoning() { return reasoning; },
  };
}

/**
 * Pure-function variant for non-streaming responses. Wraps the
 * stream-filter for one-shot use on a complete string.
 *
 * @param {string} text
 * @returns {{ clean: string, reasoning: string }}
 */
function stripThinkingBlocks(text) {
  if (typeof text !== 'string' || !text) {
    return { clean: '', reasoning: '' };
  }
  const filter = createThinkingBlockStreamFilter();
  const main = filter.push(text);
  const tail = filter.flush();
  return { clean: main + tail, reasoning: filter.getReasoning() };
}

module.exports = { createThinkingBlockStreamFilter, stripThinkingBlocks };
