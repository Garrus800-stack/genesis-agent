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
  // Find absolute path tokens. Two patterns per platform — one for quoted
  // paths (which may contain spaces, e.g. "C:\Program Files\..." or
  // "/home/My Files/Genesis"), and one for unquoted paths (which terminate
  // at the first whitespace).
  //
  // The unquoted pattern uses [^\s"';|&<>] which deliberately excludes
  // whitespace — paths with spaces in shell commands MUST be quoted to be
  // parsed correctly by the shell itself. The quoted pattern captures the
  // full content between matching quotes, so spaces are preserved.
  //
  // Pre-fix this function had only the unquoted pattern, which caused
  // false-positive "outside rootDir" rejections when rootDir itself
  // contained spaces — the regex would extract only the prefix up to the
  // first space and that prefix would not startsWith the full rootDir.
  // Live-evidence: rootDir "C:\Users\Danie\OneDrive\Desktop\Github v5.9.3
  // \Genesis-v5_9_3" extracted just "C:\Users\Danie\OneDrive\Desktop\Github"
  // from `dir /b "<rootDir>\src"` and rejected legitimate paths inside the
  // working directory. Symmetric fix on Linux: rootDir like
  // "/home/user/My Files/Genesis" had the same shape of failure for any
  // command that quoted an absolute path inside it.
  //
  // Quoted-path matching uses [^"'] to terminate, which accepts ANY char
  // (including spaces) until the closing quote. Whitelisted-roots check
  // is intentionally NOT applied to quoted paths — explicit quoting by
  // the user means it IS a path, no flag-token confusion possible.
  // Windows-style paths: matched regardless of platform — Windows paths
  // can appear in commands run on any host (WSL, cross-mounts, scripts
  // that build paths conditionally). Pre-fix this was ungated, so we
  // preserve that to keep `process.platform`-driven tests stable across
  // CI environments (the existing v7.4.6 test #31 on a Linux container
  // exercises a Windows path string).
  const winQuoted = [...command.matchAll(/["']([A-Za-z]:[\\/][^"']*)["']/g)].map(m => m[1]);
  const winUnquoted = (command.match(/(?:^|\s)([A-Za-z]:[\\/](?:[^\s"';|&<>]*))/g) || [])
    .map(s => s.trim());
  const posixQuoted = !isWindows
    ? [...command.matchAll(/["'](\/[^"']*)["']/g)].map(m => m[1])
    : [];
  const posixUnquoted = !isWindows
    ? (command.match(/(?:^|\s)(\/(?:home|usr|var|etc|opt|tmp|root|mnt|srv|bin|sbin|lib|proc|sys|run|boot)\/[^\s"';|&<>]*)/g) || [])
        .map(s => s.trim())
    : [];
  const candidates = [...winQuoted, ...winUnquoted, ...posixQuoted, ...posixUnquoted];
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
