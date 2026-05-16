// ============================================================
// GENESIS — backends/TruncationDetector.js (v7.8.9)
//
// llm-resilience-v789 contract: pure functions that decide whether
// an LLM-streamed response is structurally complete. Used by
// ContinuationLoop to determine whether another round-trip is
// needed.
//
// Why this exists:
//   Ollama's `done_reason: "stop"` is not authoritative — Ollama
//   has known bugs (#11892) where num_predict silently truncates
//   below requested values, and the model can also emit a clean
//   EOS mid-structure when confused. Structural validation is
//   the only reliable "complete" signal for code/JSON outputs.
//
// Detection strategy:
//   detectShape(content) infers the expected output shape from
//   the content itself:
//     - 'code-with-manifest'  — both ```json and ```javascript blocks
//                                expected (SkillManager pattern)
//     - 'code-single-block'   — exactly one ```language block
//     - 'json-bare'           — starts with { or [ and no fences
//     - 'code-bare'           — JS-like braces/keywords, no fences
//     - 'free'                — anything else
//
// isComplete(content, doneReason, shape?) returns:
//   { complete: boolean, reason: string }
//   The 'reason' field is for diagnostic logging.
//
// Heuristics:
//   - Conservative bias toward "incomplete" when doneReason is
//     'length' / 'first-chunk-timeout' / 'chunk-timeout' / 'total-timeout'
//     / null. Structural completeness can still rescue these if the
//     model happens to emit a balanced output before the cap.
//   - Short responses (<200 bytes) with doneReason='stop' and no
//     unclosed brackets are accepted as complete (shell commands,
//     one-liners, etc.).
// ============================================================

'use strict';

// ── Public API ─────────────────────────────────────────────

/**
 * Determine the most likely expected output shape from content.
 *
 * @param {string} content - Accumulated response so far
 * @returns {'code-with-manifest'|'code-single-block'|'json-bare'|'code-bare'|'free'}
 */
function detectShape(content) {
  if (typeof content !== 'string' || content.length === 0) return 'free';

  // Count code fences (```) — paired opening + closing
  const fenceMatches = content.match(/```/g);
  const fenceCount = fenceMatches ? fenceMatches.length : 0;

  // Detect language hints right after opening fence
  const jsonFenceCount = (content.match(/```json\b/gi) || []).length;
  const jsFenceCount = (content.match(/```(?:javascript|js)\b/gi) || []).length;

  // SkillManager pattern: both json and js blocks expected
  if (jsonFenceCount > 0 && jsFenceCount > 0) return 'code-with-manifest';

  // Single typed code block (any language hint or bare ```)
  if (fenceCount >= 1) return 'code-single-block';

  // Bare JSON (starts with { or [, no fences)
  const trimmed = content.trim();
  if (/^[{[]/.test(trimmed)) return 'json-bare';

  // Bare JS code (function/class/const/let/var keywords near start)
  if (/^(?:function|class|const|let|var|async|module\.exports|import|require\()/.test(trimmed)) {
    return 'code-bare';
  }

  return 'free';
}

/**
 * Decide whether content is structurally complete.
 *
 * @param {string} content
 * @param {string|null} doneReason - From StreamingCompletion result
 * @param {string} [shapeOverride] - Force a specific shape; else auto-detect
 * @returns {{ complete: boolean, reason: string, shape: string }}
 */
function isComplete(content, doneReason, shapeOverride) {
  const shape = shapeOverride || detectShape(content);

  // Empty content is never complete (regardless of doneReason)
  if (!content || content.length === 0) {
    return { complete: false, reason: 'empty-content', shape };
  }

  // ── Truncation indicators ────────────────────────────────
  // These doneReasons are explicit truncation signals from
  // StreamingCompletion. Even with structurally-balanced content,
  // we treat them as incomplete (the model may have stopped
  // mid-thought even if syntactically valid).
  const TRUNCATED_REASONS = new Set([
    'length',                 // token cap hit
    'first-chunk-timeout',    // no chunks at all
    'chunk-timeout',          // inter-chunk gap
    'total-timeout',          // overall cap
    'timeout',                // TCP socket timeout
    'abort',                  // external abort
    'error',                  // network/protocol error
    null,                     // TCP-drop, no terminal chunk
  ]);

  if (TRUNCATED_REASONS.has(doneReason)) {
    return { complete: false, reason: `truncation-signal:${doneReason}`, shape };
  }

  // ── Per-shape structural checks (run BEFORE short-threshold) ──
  // Short-threshold trust only applies to free-form text, NOT to
  // code/JSON shapes — those need structural validation regardless
  // of length.
  switch (shape) {
    case 'code-with-manifest': {
      // Need at least one ```json fence and one ```javascript fence,
      // both with matching closing ```.
      const fences = content.match(/```/g);
      const fenceCount = fences ? fences.length : 0;
      const hasJsonOpen = /```json\b/i.test(content);
      const hasJsOpen = /```(?:javascript|js)\b/i.test(content);
      // Each opened fence needs its closing partner → even count.
      if (!hasJsonOpen || !hasJsOpen) {
        return { complete: false, reason: 'manifest:missing-block-type', shape };
      }
      if (fenceCount % 2 !== 0) {
        return { complete: false, reason: 'manifest:unclosed-fence', shape };
      }
      // Extract code block content and validate brace balance
      const jsBlock = content.match(/```(?:javascript|js)\b[\s\S]*?\n([\s\S]+?)```/i);
      if (jsBlock && !bracketsBalanced(jsBlock[1])) {
        return { complete: false, reason: 'manifest:js-brackets-unbalanced', shape };
      }
      // JSON block must parse
      const jsonBlock = content.match(/```json\b[\s\S]*?\n([\s\S]+?)```/i);
      if (jsonBlock && !canParseJson(jsonBlock[1])) {
        return { complete: false, reason: 'manifest:json-unparseable', shape };
      }
      return { complete: true, reason: 'manifest:both-blocks-valid', shape };
    }

    case 'code-single-block': {
      const fences = content.match(/```/g);
      const fenceCount = fences ? fences.length : 0;
      if (fenceCount % 2 !== 0) {
        return { complete: false, reason: 'single:unclosed-fence', shape };
      }
      const block = content.match(/```\w*\n([\s\S]+?)```/);
      if (block && !bracketsBalanced(block[1])) {
        return { complete: false, reason: 'single:brackets-unbalanced', shape };
      }
      return { complete: true, reason: 'single:fence-pair-balanced', shape };
    }

    case 'json-bare': {
      if (!canParseJson(content)) {
        return { complete: false, reason: 'json:unparseable', shape };
      }
      return { complete: true, reason: 'json:parseable', shape };
    }

    case 'code-bare': {
      if (!bracketsBalanced(content)) {
        return { complete: false, reason: 'code:brackets-unbalanced', shape };
      }
      return { complete: true, reason: 'code:brackets-balanced', shape };
    }

    case 'free':
    default: {
      // Free-form text: short responses with balanced brackets pass through.
      // (Already filtered out truncation signals above.)
      const SHORT_THRESHOLD = 200;
      if (content.length < SHORT_THRESHOLD && bracketsBalanced(content)) {
        return { complete: true, reason: 'short-stop-balanced', shape };
      }
      // Longer free-form: just trust doneReason='stop'.
      return { complete: true, reason: 'free-stop', shape };
    }
  }
}

// ── Internals ──────────────────────────────────────────────

/**
 * Check whether (), [], {} are balanced AND properly nested in code,
 * accounting for strings and comments. Uses a stack to detect type
 * mismatches like `({[}])` where depth counters would falsely pass.
 *
 * @param {string} code
 * @returns {boolean}
 */
function bracketsBalanced(code) {
  const stack = [];
  const PAIRS = { ')': '(', ']': '[', '}': '{' };
  let i = 0;
  const n = code.length;

  while (i < n) {
    const ch = code[i];
    const next = code[i + 1];

    // ── String literals ─────────────────────────────────
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i++;
      while (i < n && code[i] !== quote) {
        if (code[i] === '\\') i++; // skip escaped char
        i++;
      }
      i++;
      continue;
    }

    // ── Line comments ────────────────────────────────────
    if (ch === '/' && next === '/') {
      while (i < n && code[i] !== '\n') i++;
      continue;
    }

    // ── Block comments ───────────────────────────────────
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n - 1 && !(code[i] === '*' && code[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    // ── Bracket tracking (stack-based for proper nesting) ──
    if (ch === '(' || ch === '[' || ch === '{') {
      stack.push(ch);
    } else if (ch === ')' || ch === ']' || ch === '}') {
      const expected = PAIRS[ch];
      if (stack.length === 0 || stack[stack.length - 1] !== expected) {
        return false; // type mismatch or closing without opener
      }
      stack.pop();
    }

    i++;
  }

  return stack.length === 0;
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function canParseJson(text) {
  if (typeof text !== 'string') return false;
  try {
    JSON.parse(text);
    return true;
  } catch (_e) {
    return false;
  }
}

module.exports = { isComplete, detectShape, bracketsBalanced, canParseJson };
