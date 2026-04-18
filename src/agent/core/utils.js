// ============================================================
// GENESIS — utils.js
// Shared utility functions used across multiple modules.
// FIX v3.5.0: Extracted duplicate _robustJsonParse from
// ModelBridge.js and ToolRegistry.js.
// ============================================================

// @ts-checked-v5.6

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const { createLogger } = require('../core/Logger');
const _log = createLogger('utils');
/**
 * Robust JSON parser handling common LLM output issues:
 * - Markdown code fences (```json ... ```)
 * - Trailing commas
 * - Single quotes → double quotes
 * - Unquoted keys
 * - Newlines in strings
 * @param {string} text - Raw text that should contain JSON
 * @returns {object|null} Parsed JSON or null if unfixable
 */
function robustJsonParse(text) {
  if (!text || typeof text !== 'string') return null;

  // Strip markdown code fences
  let cleaned = text
    .replace(/^```(?:json)?\s*\n?/gm, '')
    .replace(/\n?```\s*$/gm, '')
    .trim();

  // Try to extract JSON from surrounding text
  const jsonStart = cleaned.indexOf('{');
  const jsonEnd = cleaned.lastIndexOf('}');
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    cleaned = cleaned.slice(jsonStart, jsonEnd + 1);
  } else {
    // Try array
    const arrStart = cleaned.indexOf('[');
    const arrEnd = cleaned.lastIndexOf(']');
    if (arrStart >= 0 && arrEnd > arrStart) {
      cleaned = cleaned.slice(arrStart, arrEnd + 1);
    }
  }

  // Try direct parse first
  try { return JSON.parse(cleaned); } catch (err) { /* intentional fallback to next parse strategy */ }

  // Fix common issues
  let fixed = cleaned
    .replace(/,\s*([}\]])/g, '$1')                  // trailing commas
    .replace(/'/g, '"')                               // single quotes -> double
    .replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":')       // unquoted keys
    .replace(/\n/g, ' ');                              // newlines in strings
  try { return JSON.parse(fixed); } catch (err) { /* intentional fallback — all parse strategies exhausted */ }

  return null;
}

/**
 * FIX v4.0.0: Safe JSON.parse wrapper for structured/file data.
 * Unlike robustJsonParse (which fixes LLM output), this is a
 * drop-in replacement for JSON.parse that:
 *   1. Returns a fallback instead of throwing
 *   2. Optionally logs the failure context
 *
 * Usage:
 *   const data = safeJsonParse(raw, {});          // → {} on failure
 *   const arr  = safeJsonParse(raw, []);           // → [] on failure
 *   const data = safeJsonParse(raw, null, 'McpClient'); // logs source
 *
 * @param {string} text - Raw JSON string
 * @param {*} fallback - Value to return on parse failure
 * @param {string} [source] - Module name for debug logging
 * @returns {*} Parsed JSON or fallback
 */
function safeJsonParse(text, fallback = null, source = '') {
  if (text === null || text === undefined || typeof text !== 'string') {
    return fallback;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    if (source) {
      _log.debug(`[${source}] JSON parse failed: ${err.message} (input: ${String(text).slice(0, 120)})`);
    }
    return fallback;
  }
}

/**
 * Round to 3 decimal places. Used across consciousness/planning layers.
 * @param {number} v
 * @returns {number}
 */
function _round(v) { return Math.round((v || 0) * 1000) / 1000; }

/**
 * Fire-and-forget promise wrapper with debug logging.
 * Replaces bare `.catch(() => {})` — same semantics, but failures
 * are visible in debug logs instead of silently swallowed.
 *
 * v6.1.0: Centralised fire-and-forget pattern. 10 call sites migrated.
 *
 * @param {Promise} promise - Promise to swallow
 * @param {string} [label='swallow'] - Context label for debug output
 * @returns {Promise<void>}
 */
function swallow(promise, label = 'swallow') {
  return promise.then(() => {}, e => {
    _log.debug(`[${label}] swallowed: ${e.message || e}`);
  });
}

// v7.2.8: Shared stop word list for KG concept extraction and preference parsing (DE + EN)
const STOP_WORDS = new Set([
  'ich', 'du', 'er', 'sie', 'es', 'wir', 'ihr', 'das', 'die', 'der',
  'den', 'dem', 'des', 'ein', 'eine', 'einer', 'einem', 'einen',
  'nicht', 'nur', 'auch', 'noch', 'schon', 'aber', 'und', 'oder',
  'wenn', 'dass', 'weil', 'hier', 'dort', 'jetzt', 'dann', 'so',
  'wie', 'was', 'wer', 'wo', 'sehr', 'gut', 'mehr', 'viel', 'ganz',
  'oft', 'froh', 'recht', 'ja', 'nein', 'doch', 'mal', 'man',
  'this', 'that', 'the', 'is', 'are', 'was', 'were', 'not', 'just',
  'also', 'but', 'and', 'or', 'if', 'then', 'here', 'there', 'now',
  'very', 'well', 'more', 'much', 'yes', 'no', 'can', 'will',
]);

function isValidLabel(label) {
  if (!label || label.length < 4) return false;
  const words = label.toLowerCase().split(/\s+/);
  if (words.every(w => STOP_WORDS.has(w))) return false;
  return true;
}

module.exports = { robustJsonParse, safeJsonParse, atomicWriteFile, atomicWriteFileSync, _round, swallow, STOP_WORDS, isValidLabel };

// ── Atomic File Write Utilities (v4.10.0) ─────────────────
// Write to temp file in same directory, then rename.
// rename() is atomic on POSIX and near-atomic on NTFS.
// Prevents half-written files on crash/power loss.

/**
 * Async atomic write. Use in all runtime (non-boot) write paths.
 * @param {string} filePath - Target file path
 * @param {string|Buffer} content - File content
 * @param {string} [encoding='utf-8'] - Encoding
 */
async function atomicWriteFile(filePath, content, encoding = 'utf-8') {
  const dir = path.dirname(filePath);
  const tmpName = `.genesis-tmp-${crypto.randomBytes(6).toString('hex')}`;
  const tmpPath = path.join(dir, tmpName);
  try {
    // FIX v4.10.0 (H-5): Open → write → fsync → close → rename.
    // Without fsync, data may reside only in the page cache after rename().
    // On power loss the renamed file could be empty or truncated.
    const fh = await fsp.open(tmpPath, 'w');
    await fh.writeFile(content, encoding);
    await fh.datasync();          // flush data to disk (not metadata — faster than fsync)
    await fh.close();
    await fsp.rename(tmpPath, filePath);
  } catch (err) {
    try { await fsp.unlink(tmpPath); } catch { /* best effort */ }
    throw err;
  }
}

/**
 * Sync atomic write. Use only where async is not possible (boot, shutdown).
 * @param {string} filePath - Target file path
 * @param {string|Buffer} content - File content
 * @param {string} [encoding='utf-8'] - Encoding
 */
function atomicWriteFileSync(filePath, content, encoding = 'utf-8') {
  const dir = path.dirname(filePath);
  const tmpName = `.genesis-tmp-${crypto.randomBytes(6).toString('hex')}`;
  const tmpPath = path.join(dir, tmpName);
  try {
    // FIX v4.10.0 (H-5): fsync before rename — same rationale as async variant.
    const fd = fs.openSync(tmpPath, 'w');
    fs.writeFileSync(fd, content, encoding);
    fs.fdatasyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
    throw err;
  }
}
