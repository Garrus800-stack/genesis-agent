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
