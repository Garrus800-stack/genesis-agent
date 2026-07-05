'use strict';
/**
 * SourceTrust — the origin axis for shell/read gating (v7.9.28 F0; v7.9.30 S3).
 *
 * Every shell command carries a declared origin. USER_CHAT is a path/command
 * the human named DIRECTLY in chat — trusted, and lifts the sandbox SCOPE
 * schranke behind the absolute system/secret blocks, which always remain.
 * Trust does NOT widen scope (G1); the chat axis is the SOURCE, not the trust
 * level. mayRunDirectly stays USER_CHAT-only, so the scope lift is unchanged.
 *
 * v7.9.30 (S3): origin is now MANDATORY at the executor. The additional
 * origins label where a command came from, so a forgotten call site — or a
 * future silent path like the run-skill shell fallback removed in S1 — fails
 * the mandatory check instead of running unprovenanced:
 *   TOOL_LOOP  — model-emitted calls in the chat tool-loop (the 'shell' tool
 *                and the read-only fence channel).
 *   AGENT_LOOP — the autonomous path, deployment, and ShellAgent's own
 *                internal capability methods (test/install/search/disk).
 *   TEST       — test harnesses (set via the ShellAgent defaultOrigin option).
 *
 * These reverse the earlier "deliberately single-value" stance for a concrete
 * reason: unlike the old OBSERVED_CONTENT/AUTONOMOUS placeholders (which had no
 * setters and were dead), each of these has real setters wired in this version.
 * And none of them build source-transitivity through the Planner — they only
 * DECLARE provenance, so the read->act path that stays closed by design is not
 * reopened; only the command's origin becomes auditable.
 */
const USER_CHAT = 'user-chat';
const TOOL_LOOP = 'tool-loop';
const AGENT_LOOP = 'agent-loop';
const TEST = 'test';

const _KNOWN_ORIGINS = new Set([USER_CHAT, TOOL_LOOP, AGENT_LOOP, TEST]);

/** True only when the origin is a path/command the user named in chat. */
function mayRunDirectly(origin) {
  return origin === USER_CHAT;
}

/** True when origin is a declared, known provenance (S3 mandatory-origin gate). */
function isKnownOrigin(origin) {
  return _KNOWN_ORIGINS.has(origin);
}

module.exports = { USER_CHAT, TOOL_LOOP, AGENT_LOOP, TEST, mayRunDirectly, isKnownOrigin };
