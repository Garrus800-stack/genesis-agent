// @ts-checked-v5.8
// ============================================================
// GENESIS — ShellOSAdapter.js (v7.5.4)
//
// Pure OS-adaptation functions. POSIX → Windows command translation,
// LLM-hallucination rewrites, shell selection, command tokenization.
//
// Extracted from ShellAgent.js as part of the v7.5.4 split.
// Takes `platform` parameter (e.g. 'win32', 'linux', 'darwin') instead
// of an isWindows boolean — readier for future macOS-specific branches.
// ============================================================

'use strict';

/**
 * Resolve the platform-appropriate shell binary and flag.
 *
 * @returns {{shell: string, shellFlag: string, isWindows: boolean, platform: string}}
 */
function resolveShell() {
  const platform = process.platform;
  const isWindows = platform === 'win32';
  return {
    shell: isWindows ? 'cmd.exe' : '/bin/sh',
    shellFlag: isWindows ? '/c' : '-c',
    isWindows,
    platform,
  };
}

/**
 * v7.9.11: classifier for adaptPaths. Returns true when a token looks
 * like a multi-segment filesystem path that needs forward-slash → backslash
 * conversion on Windows. Returns false for cmd.exe switches (e.g. /V, /c,
 * /verbose, /q), single-/ tokens, and anything without slashes.
 *
 * Rules:
 *   - false if no '/' at all (most tokens — command names, options, args)
 *   - true  if starts with './' or '../' (explicit relative path)
 *   - false if matches /<letter><up to 14 word chars> (cmd switches: /V /e /verbose /q etc.)
 *   - true  if contains <[\w.-]{2,}/[\w.-]+> (multi-segment path like src/agent/X.js)
 *   - false otherwise
 *
 * @param {string} tok
 * @returns {boolean}
 */
function _looksLikePath(tok) {
  if (!tok.includes('/')) return false;
  if (tok.startsWith('./') || tok.startsWith('../')) return true;
  if (/^\/[a-zA-Z]\w{0,14}$/.test(tok)) return false;
  if (/[\w.-]{2,}\/[\w.-]+/.test(tok)) return true;
  return false;
}

/**
 * v7.9.11: convert forward-slash paths to backslashes in a Windows command.
 *
 * Why: cmd.exe interprets /foo as a switch (e.g. /agent → /a /g /e /n /t),
 * producing "Die Syntax für den Dateinamen ist falsch" on commands like
 * `type src/agent/X.js`. LLMs generate Unix-style paths by default; the
 * existing program-name swaps (cat→type, ls→dir, etc.) translate the
 * binary but leave argument paths intact.
 *
 * Approach: token-based with quote awareness. Walk the command splitting
 * on whitespace, preserving quoted strings as single tokens. For each
 * non-quoted token: if _looksLikePath says yes AND it isn't a POSIX
 * system path AND it isn't a protocol URL, replace / with \.
 *
 * POSIX absolute system paths (/var, /etc, /usr, /tmp, /home, /root,
 * /opt, /mnt, /sys, /proc, /dev) are deliberately preserved — they
 * should fail loudly on Windows instead of being silently rewritten to
 * a non-existent location.
 *
 * @param {string} cmd
 * @returns {string}
 */
function adaptPaths(cmd) {
  const out = [];
  let inSingle = false, inDouble = false, current = '';
  for (const ch of cmd) {
    if (!inDouble && ch === "'") { inSingle = !inSingle; current += ch; continue; }
    if (!inSingle && ch === '"') { inDouble = !inDouble; current += ch; continue; }
    if (!inSingle && !inDouble && ch === ' ') {
      if (current) out.push(current);
      out.push(' ');
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) out.push(current);

  return out.map(tok => {
    if (tok === ' ' || tok.startsWith("'") || tok.startsWith('"')) return tok;
    if (!_looksLikePath(tok)) return tok;
    if (/^\/(?:var|etc|usr|tmp|home|root|opt|mnt|sys|proc|dev)\b/.test(tok)) return tok;
    if (/^https?:\/\/|^file:\/\/|^ftp:\/\//.test(tok)) return tok;
    return tok.replace(/\//g, '\\');
  }).join('');
}

/**
 * Translate a POSIX command into Windows form when running on Windows.
 * No-op on non-Windows platforms.
 *
 * @param {string} cmd
 * @param {string} platform — 'win32' | 'linux' | 'darwin' | etc.
 * @returns {string}
 */
function adaptCommand(cmd, platform) {
  if (platform !== 'win32') return cmd;

  let out = cmd;
  // Simple program-name swaps (start of command only)
  out = out
    .replace(/^ls\b/, 'dir')
    .replace(/^cat\s/, 'type ')
    .replace(/^rm\s+-rf\s/, 'rmdir /s /q ')
    .replace(/^rm\s/, 'del ')
    .replace(/^cp\s+-r\s/, 'xcopy /e /i ')
    .replace(/^cp\s/, 'copy ')
    .replace(/^mv\s/, 'move ')
    .replace(/^mkdir\s+-p\s/, 'mkdir ')
    .replace(/^which\s/, 'where ')
    .replace(/^touch\s/, 'type nul > ')
    .replace(/^pwd\b/, 'cd')
    .replace(/^clear$/, 'cls')
    .replace(/^echo\s+\$([A-Z_][A-Z0-9_]*)\b/, 'echo %$1%');

  // v7.9.11: convert forward-slash paths to backslashes. Must run AFTER
  // the program-name swaps above (so `cat src/X.js` first becomes
  // `type src/X.js`, then `type src\X.js`) and BEFORE the find/grep
  // rewrites below (those produce literal cmd switches like `/V /C` in
  // their output, which adaptPaths's _looksLikePath classifier would
  // correctly skip anyway — but doing the path adapt earlier means we
  // operate on shorter strings and the order of intent is clearer).
  out = adaptPaths(out);

  // Quote-safe line counting:
  // `find /C /V ""` → mangled by cmd.exe quote-escaping → reads file `"\"`.
  // `find /V /C ":"` counts lines NOT containing colon — Windows filenames
  // cannot contain ':' so this counts all lines correctly.
  out = out.replace(/\|\s*wc\s+-l\s*$/, '| find /V /C ":"');
  out = out.replace(/find\s+\/[Cc]\s+\/[Vv]\s+""/g, 'find /V /C ":"');
  out = out.replace(/find\s+\/[Vv]\s+\/[Cc]\s+""/g, 'find /V /C ":"');

  // LLMs hallucinate other broken find-counter forms — rewrite to canonical:
  out = out.replace(/\bfind\s+\/[Cc]\s+"[*.]"/g, 'find /V /C ":"');
  out = out.replace(/\bfind\s+\/[Cc]\s+"\s*"/g, 'find /V /C ":"');
  out = out.replace(/\bfind\s+\/[Vv]\s+""\s*$/, 'find /V /C ":"');
  out = out.replace(/\bfind\s+\/count\b[^|&;<>]*$/i, 'find /V /C ":"');
  out = out.replace(/\bfindstr\s+\/c:"[*.]"/g, 'find /V /C ":"');

  // grep — basic mapping to findstr (not 1:1 but covers common cases)
  out = out.replace(/\bgrep\s+(-[A-Za-z]+\s+)?/g, 'findstr ');
  // /dev/null → NUL
  out = out.replace(/\/dev\/null/g, 'NUL');

  return out;
}

/**
 * Tokenize a command string into [binary, ...args] for execFile.
 * Handles quoted arguments. Does NOT adapt — call adaptCommand first
 * if needed, or use parseCommand which composes both.
 *
 * @param {string} cmd
 * @returns {string[]}
 */
function parseTokens(cmd) {
  const parts = [];
  let current = '';
  let inSingle = false, inDouble = false;
  for (const ch of cmd) {
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (ch === ' ' && !inSingle && !inDouble) {
      if (current) { parts.push(current); current = ''; }
      continue;
    }
    current += ch;
  }
  if (current) parts.push(current);
  return parts.length > 0 ? parts : [cmd];
}

/**
 * Adapt + tokenize. Equivalent to v7.5.3's _parseCommand.
 *
 * @param {string} cmd
 * @param {string} platform
 * @returns {string[]}
 */
function parseCommand(cmd, platform) {
  return parseTokens(adaptCommand(cmd, platform));
}

module.exports = {
  resolveShell,
  adaptCommand,
  parseTokens,
  parseCommand,
};
