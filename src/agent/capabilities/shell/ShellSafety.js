// @ts-checked-v5.8
// ============================================================
// GENESIS — ShellSafety.js (v7.5.4)
//
// Pure security functions for shell command execution. No state,
// no event bus, no i18n — helpers return result codes that the
// orchestrator translates and emits.
//
// Extracted from ShellAgent.js as part of the v7.5.4 split.
// ============================================================

'use strict';

const path = require('path');

// ── Blocked patterns per permission tier ────────────────────
// Frozen so all ShellAgent instances share the same object without
// risk of test-mutation cross-contamination.
const BLOCKED_PATTERNS = Object.freeze({
  observe: /./, // Intentional: observe tier has no shell access — blocks ALL commands
  read: /\b(rm|del|mv|move|cp|copy|mkdir|rmdir|chmod|chown|kill|shutdown|reboot|mkfs|dd\s+if|format|>\s)/i,
  write: new RegExp([
    // Direct system destruction
    /rm\s+-rf\s+\//.source,
    /mkfs/.source,
    /dd\s+if=\/dev/.source,
    /format\s+[a-z]:/.source,
    /shutdown/.source,
    /reboot/.source,
    /kill\s+-9\s+1\b/.source,
    />\s*\/dev/.source,
    // FIX v3.5.0: Bypass vectors via encoding/aliasing
    /\\x[0-9a-f]{2}/i.source,             // hex-encoded chars in commands
    /\$\(.*\b(rm|dd|mkfs|kill)\b/.source, // command substitution wrapping destructive ops
    /`.*\b(rm|dd|mkfs|kill)\b/.source,    // backtick command substitution
    /\|\s*(ba)?sh\b/.source,              // piping to shell (curl|sh, wget|bash)
    /\bsource\s/.source,                  // sourcing unknown scripts
    /\b\.\s+\//.source,                   // dot-sourcing (. /path/script)
    /\bpython\d?\s+-c\s/.source,          // python -c "arbitrary code"
    /\bnode\s+-e\s/.source,               // node -e "arbitrary code"
    /\bperl\s+-e\s/.source,               // perl -e "arbitrary code"
    /\bruby\s+-e\s/.source,               // ruby -e "arbitrary code"
    /\bcurl\s.*\|\s/.source,              // curl piped to anything
    /\bwget\s.*\|\s/.source,              // wget piped to anything
    /\bchmod\s+[0-7]*[67][0-7]{2}/.source, // chmod with setuid/setgid bits
    /\bcrontab\b/.source,                 // crontab manipulation
    /\bsymlink|ln\s+-s/.source,           // symlink creation (can bypass SafeGuard paths)
    /\bmkfifo\b/.source,                  // named pipes (can be used for injection)
    /\biptables\b/.source,                // firewall manipulation
    /\bsystemctl\s+(stop|disable|mask)/.source, // service disruption
    /\bpkill\s/.source,                   // process kill by name
    /\bkillall\s/.source,                 // mass process kill
  ].join('|'), 'i'),
  system: /\b(mkfs|dd\s+if=\/dev\/zero|format\s+[a-z]:.*\/[qy])\b/i,
});

// ── Sanitize ──────────────────────────────────────────────────
/**
 * Sanitize a command string before any further processing.
 * Blocks null bytes, newlines, and excessive length that could bypass
 * blocklist regex or exploit shell parsing.
 *
 * @param {string} command
 * @param {{maxChars?: number}} [opts]
 * @returns {{ ok: boolean, command?: string, error?: string }}
 */
function sanitizeCommand(command, opts = {}) {
  const maxChars = opts.maxChars || 100000;
  if (typeof command !== 'string') return { ok: false, error: 'Command must be a string' };
  if (command.length > maxChars) return { ok: false, error: `Command exceeds ${maxChars / 1024}KB limit` };
  // Null bytes can truncate strings in C-based shell parsers
  if (command.includes('\0')) return { ok: false, error: 'Null byte in command' };
  // Newlines can inject additional commands in shell mode
  const cleaned = command.replace(/[\r\n]+/g, ' ').trim();
  if (!cleaned) return { ok: false, error: 'Empty command' };
  // NFKC normalization — converts Unicode confusables (fullwidth ｒｍ → rm,
  // homoglyphs, etc.) so blocklist regex can match.
  const normalized = cleaned.normalize('NFKC');
  return { ok: true, command: normalized };
}

// ── Sandbox ──────────────────────────────────────────────────
/**
 * Reject commands that contain absolute paths pointing OUTSIDE rootDir.
 *
 * Lenient on purpose: only rejects commands that contain a clear
 * absolute path token outside rootDir. Relative paths and absolute
 * paths inside rootDir always pass.
 *
 * @param {string} command
 * @param {string|null|undefined} rootDir
 * @param {{platform?: string}} [opts]
 * @returns {{ok: boolean, reason?: string}}
 */
function checkRootDirSandbox(command, rootDir, opts = {}) {
  if (!rootDir) return { ok: true };
  const platform = opts.platform || process.platform;
  const isWindows = platform === 'win32';
  const root = path.resolve(rootDir).toLowerCase();
  // Find absolute path tokens. Windows: drive-letter form (C:\, D:\, ...).
  // POSIX: leading slash followed by a known root directory name. We
  // restrict to common roots so flags like "/b", "/s", "/q" don't get
  // mistaken for paths. Absolute paths in shell commands almost always
  // start with one of these top-level dirs.
  const winAbs = command.match(/\b([A-Za-z]):[\\/](?:[^\s"';|&<>]*)/g) || [];
  const posixAbs = !isWindows
    ? (command.match(/(?:^|\s)(\/(?:home|usr|var|etc|opt|tmp|root|mnt|srv|bin|sbin|lib|proc|sys|run|boot)\/[^\s"';|&<>]*)/g) || [])
        .map(s => s.trim())
    : [];
  const candidates = [...winAbs, ...posixAbs];
  for (const raw of candidates) {
    const abs = path.resolve(raw).toLowerCase();
    if (!abs.startsWith(root)) {
      return {
        ok: false,
        reason: `path "${raw}" is outside rootDir (${rootDir}). Use relative paths or absolute paths inside the working directory.`,
      };
    }
  }
  // Also reject the common "dir /s C:\" / "where /r C:\" patterns even
  // if drive root matches rootDir's drive — recursing from C:\ is too
  // broad and inevitably hits access-denied.
  if (/\bdir\s+\/s\s+[A-Za-z]:[\\/]?\s*$/i.test(command)
      || /\bwhere\s+\/r\s+[A-Za-z]:[\\/]?\s/i.test(command)) {
    return {
      ok: false,
      reason: 'recursive scan from a drive root (dir /s C:\\, where /r C:\\) is not allowed. Scope the path to the working directory.',
    };
  }
  return { ok: true };
}

// ── Blocked-pattern check ───────────────────────────────────
/**
 * Check whether a command matches the blocked pattern for a given tier.
 *
 * @param {string} command
 * @param {string} tier — one of 'observe' | 'read' | 'write' | 'system'
 * @param {object} [patterns] — defaults to BLOCKED_PATTERNS
 * @returns {{ok: boolean, reason?: string, tier?: string}}
 */
function checkBlockedPattern(command, tier, patterns = BLOCKED_PATTERNS) {
  const pattern = patterns[tier];
  if (pattern && pattern.test(command)) {
    return { ok: false, reason: 'BLOCKED_TIER', tier };
  }
  return { ok: true };
}

// ── Rate-limit ──────────────────────────────────────────────
/**
 * Build a fresh rate-limit state object pre-initialized for the given tiers.
 * Mirrors the v7.5.3 constructor behavior (one bucket per tier in RATE_LIMITS).
 *
 * @param {string[]} tiers
 * @returns {Object<string, number[]>}
 */
function buildRateLimitState(tiers) {
  const state = {};
  for (const tier of tiers) state[tier] = [];
  return state;
}

/**
 * Check whether a command is allowed under the per-tier rate limit.
 * Mutates `state` by appending the current timestamp on a successful check.
 *
 * @param {Object<string, number[]>} state — mutable rate-limit state
 * @param {string} tier
 * @param {Object<string, number>} limits — { read: 60, write: 20, system: 5 }
 * @param {number} windowMs
 * @returns {{ok: boolean, count?: number, limit?: number}}
 */
function checkRateLimit(state, tier, limits, windowMs) {
  const limit = limits[tier];
  if (!limit) return { ok: true }; // Unknown tier — allow (matches v7.5.3 semantics)
  if (!state[tier]) state[tier] = [];
  const now = Date.now();
  const windowStart = now - windowMs;
  state[tier] = state[tier].filter(ts => ts > windowStart);
  if (state[tier].length >= limit) {
    return { ok: false, count: state[tier].length, limit };
  }
  state[tier].push(now);
  return { ok: true };
}

module.exports = {
  BLOCKED_PATTERNS,
  sanitizeCommand,
  checkRootDirSandbox,
  checkBlockedPattern,
  buildRateLimitState,
  checkRateLimit,
};
