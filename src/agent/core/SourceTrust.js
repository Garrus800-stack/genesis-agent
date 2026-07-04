'use strict';
/**
 * SourceTrust — the origin axis for shell/read gating (v7.9.28, F0).
 *
 * A path or command the human names DIRECTLY in chat (USER_CHAT) is trusted
 * and lifts the sandbox SCOPE schranke — behind the absolute system/secret
 * blocks, which always remain. Trust does NOT widen scope (G1); the chat axis
 * is the SOURCE, not the trust level.
 *
 * Deliberately NOT a three-value enum: OBSERVED_CONTENT / AUTONOMOUS are set
 * by nobody (dead values). Source-transitivity through the Planner is sleeping
 * by design (no read->act path exists) and must not be built until one does.
 */
const USER_CHAT = 'user-chat';

/** True only when the origin is a path/command the user named in chat. */
function mayRunDirectly(origin) {
  return origin === USER_CHAT;
}

module.exports = { USER_CHAT, mayRunDirectly };
