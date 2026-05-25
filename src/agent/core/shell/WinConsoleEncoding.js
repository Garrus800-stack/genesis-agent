// @ts-checked-v5.8
// ============================================================
// GENESIS — src/agent/core/shell/WinConsoleEncoding.js (v7.9.11)
//
// Pure Windows-console-output decoding. Detects the active cmd.exe
// codepage once at boot, caches it, then decodes Buffer outputs from
// execFileAsync into UTF-8 strings.
//
// Why: cmd.exe writes its output in the active console codepage
// (cp850 on DE Windows, cp437 on EN Windows, cp1252 sometimes, etc.).
// Node's `encoding: 'utf-8'` on execFile mistakes those bytes for
// UTF-8 → replacement-character noise like "Die Syntax f\u0307r den
// Dateinamen ist falsch" (verified in Garrus's Win field-trace
// 2026-05-25). After this module: read raw Buffer, decode with the
// detected codepage.
//
// No-op on non-Windows. Helpers safe to call from any platform — they
// just return the input or empty string when not on Windows.
//
// Dependency: iconv-lite for the OEM codepages (cp850, cp437, etc.).
// Node's built-in TextDecoder only supports WHATWG Encoding Standard
// encodings, which excludes the OEM codepages that cmd.exe defaults
// to. iconv-lite is ~40 KB, 0 transitive deps.
//
// Graceful degradation: if iconv-lite isn't installed (minimal install
// without npm dependencies), decodeWinConsole falls back to latin1
// (1:1 byte mapping, never throws, no U+FFFD replacement characters).
// Accented chars may be slightly off but surrounding text reads.
// ============================================================

'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

// Lazy-require iconv-lite. The require may fail in minimal installs;
// in that case decodeWinConsole falls back to latin1.
let iconv = null;
try {
  iconv = require('iconv-lite');
} catch (_e) { /* fall back to latin1 */ }

// Default fallback codepages by locale heuristic. Used only when chcp
// detection fails (process spawn fails, output unparsable).
const FALLBACK_DE = 'cp850';
const FALLBACK_EN = 'cp437';

let _cachedCodepage = null;
let _detectionPromise = null;

/**
 * Detect the active console codepage by running `chcp` once and parsing
 * its output. Caches the result for subsequent calls. Returns 'utf-8'
 * immediately on non-Windows.
 *
 * chcp output is pure ASCII ("Active code page: 850."), safe to read as
 * utf-8 even before we know the real codepage because numbers and Latin
 * letters share byte values across all codepages we care about.
 *
 * @returns {Promise<string>} codepage name (e.g. 'cp850', 'cp1252', 'utf-8')
 */
async function detectConsoleCodepage() {
  if (process.platform !== 'win32') return 'utf-8';
  if (_cachedCodepage) return _cachedCodepage;
  if (_detectionPromise) return _detectionPromise;

  _detectionPromise = (async () => {
    try {
      const { stdout } = await execFileAsync('cmd.exe', ['/c', 'chcp'], {
        timeout: 2000,
        windowsHide: true,
        encoding: 'utf-8',
      });
      const match = stdout.match(/:\s*(\d+)/);
      if (match) {
        const num = Number(match[1]);
        if (num === 65001) _cachedCodepage = 'utf-8';
        else if (num === 1252) _cachedCodepage = 'cp1252';
        else if (num === 850) _cachedCodepage = 'cp850';
        else if (num === 437) _cachedCodepage = 'cp437';
        else _cachedCodepage = `cp${num}`;
      }
    } catch (_e) { /* fall through to locale heuristic */ }

    if (!_cachedCodepage) {
      const lang = process.env.LANG || process.env.LC_ALL || process.env.LANGUAGE || '';
      _cachedCodepage = /^(de|fr|es|it|pt)/i.test(lang) ? FALLBACK_DE : FALLBACK_EN;
    }
    return _cachedCodepage;
  })();
  return _detectionPromise;
}

/**
 * Decode a Buffer from cmd.exe's console output. Safe to call from any
 * platform — returns the input unchanged when it's already a string,
 * returns '' for null/undefined.
 *
 * The codepage parameter is optional. If omitted, uses the cached
 * detected codepage (set by detectConsoleCodepage), or falls back to
 * the locale-default (cp850 for DE/FR/ES/IT/PT, cp437 otherwise).
 *
 * @param {Buffer|Uint8Array|string|null|undefined} buf
 * @param {string} [codepage]
 * @returns {string}
 */
function decodeWinConsole(buf, codepage) {
  if (!buf) return '';
  if (typeof buf === 'string') return buf;
  if (!Buffer.isBuffer(buf) && !(buf instanceof Uint8Array)) return String(buf);

  const cp = codepage || _cachedCodepage || getCachedCodepage();
  const safeBuf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);

  if (cp === 'utf-8') return safeBuf.toString('utf-8');

  if (iconv && iconv.encodingExists(cp)) {
    try {
      return iconv.decode(safeBuf, cp);
    } catch { /* fall through to latin1 */ }
  }

  // Last resort: latin1 (1:1 byte-to-codepoint mapping). Never throws,
  // produces no replacement characters. ASCII characters render correctly;
  // accented characters may be slightly off (e.g. cp850 0x81 = 'ü' becomes
  // the latin1 character at U+0081 instead of U+00FC) but the surrounding
  // readable structure is preserved — vastly better than utf-8 decode of
  // cp850 bytes which produces U+FFFD spam.
  return safeBuf.toString('latin1');
}

/**
 * Synchronous accessor for the cached codepage. Used by callers that
 * can't await detectConsoleCodepage. When no detection has run yet,
 * returns the locale-default fallback.
 *
 * @returns {string}
 */
function getCachedCodepage() {
  if (_cachedCodepage) return _cachedCodepage;
  if (process.platform !== 'win32') return 'utf-8';
  const lang = process.env.LANG || process.env.LC_ALL || process.env.LANGUAGE || '';
  return /^(de|fr|es|it|pt)/i.test(lang) ? FALLBACK_DE : FALLBACK_EN;
}

module.exports = {
  detectConsoleCodepage,
  decodeWinConsole,
  getCachedCodepage,
};
