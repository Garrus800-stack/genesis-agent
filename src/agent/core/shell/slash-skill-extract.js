'use strict';
// ════════════════════════════════════════════════════════════
// core/shell/slash-skill-extract.js  (v7.9.30)
//
// Two small pure utilities for the chat tool-loop, neighbours of
// shell-fence-extract.js:
//
//   extractSlashSkillCalls — the prompt teaches the model to invoke skills
//     via `/run-skill <name>` and `/run-skill <name> {json}` (Befund 3), but
//     nothing in the chat loop executed those lines, so a model following the
//     taught format emitted text nothing reacted to — very likely the seedbed
//     of the four-fold emission. This turns those lines into tool calls that
//     the existing executeToolCalls path runs (skills are registered as tools
//     since v7.9.27), so the taught path becomes real instead of being cut.
//
//   dedupeToolCalls — collapses identical tool calls (same name + same input)
//     within ONE response to a single execution (Befund 2). It sits at the
//     unified point of the loop, after the primary-parser, fence, and slash
//     channels have merged into one list, so a stuttering model that repeats
//     the same call N times produces exactly one run. Complementary to the
//     loop's cross-round callSignature guard.
// ════════════════════════════════════════════════════════════

// Exactly the syntax the prompt teaches and CommandHandlersCode.runSkill
// understands: /run-skill <name> [optional single-line JSON object].
const SLASH_SKILL_RE = /^\s*\/run-skill\s+([\w-]+)(?:\s+(\{.*\}))?\s*$/;

/**
 * Extract `/run-skill <name> [{json}]` lines from model output into tool calls.
 * Invalid or non-object JSON leaves the line untouched (no rate-guessing).
 * @param {string} text
 * @returns {Array<{name: string, input: object}>}
 */
function extractSlashSkillCalls(text) {
  if (typeof text !== 'string' || text.indexOf('/run-skill') === -1) return [];
  const calls = [];
  for (const line of text.split('\n')) {
    const m = line.match(SLASH_SKILL_RE);
    if (!m) continue;
    const name = m[1];
    let input = {};
    if (m[2]) {
      try {
        const parsed = JSON.parse(m[2]);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue; // leave as text
        input = parsed;
      } catch (_e) {
        continue; // invalid JSON → leave the line as text
      }
    }
    calls.push({ name, input });
  }
  return calls;
}

/** Stable, key-order-insensitive signature for a tool call. */
function toolCallSignature(tc) {
  const input = (tc && tc.input && typeof tc.input === 'object') ? tc.input : {};
  return `${tc && tc.name}:${JSON.stringify(input, Object.keys(input).sort())}`;
}

/**
 * Collapse identical tool calls (same name + same input, key-order-insensitive)
 * within one response to a single execution. First occurrence wins; order of
 * the surviving calls is preserved.
 * @param {Array} toolCalls
 * @returns {{ calls: Array, collapsed: number }} collapsed = duplicates removed
 */
function dedupeToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length < 2) {
    return { calls: Array.isArray(toolCalls) ? toolCalls : [], collapsed: 0 };
  }
  const seen = new Set();
  const calls = [];
  for (const tc of toolCalls) {
    const sig = toolCallSignature(tc);
    if (seen.has(sig)) continue;
    seen.add(sig);
    calls.push(tc);
  }
  return { calls, collapsed: toolCalls.length - calls.length };
}

module.exports = { extractSlashSkillCalls, dedupeToolCalls, toolCallSignature };
