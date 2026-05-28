#!/usr/bin/env node
// ============================================================
// GENESIS — test/modules/v7913-stream-timeouts.contract.test.js
//
// v7.9.13 (Item A): stream timeouts made settings-driven.
//
// The Constants.js comment had long promised that the streaming
// timeouts were overridable via settings.json llm.streamTimeouts.*,
// but no code ever read that setting — the override interface existed
// only at options level (StreamingCompletion / ContinuationLoop read
// options.* with a TIMEOUTS fallback). This release wires settings.json
// into those options, the same pattern as llm.continuation.maxAttempts.
//
// Scope (verified): these only affect Ollama code-generation
// (taskType === 'code'), the single path routing through
// ContinuationLoop -> StreamingCompletion. Not standard chat/stream,
// not non-Ollama backends.
//
// Anti-drift: the settings defaults reference the TIMEOUTS constants
// rather than hardcoding the numbers, so a default can never drift
// from its constant. This test is the guard that catches it if someone
// later replaces a reference with a literal. It also covers the two
// v7.9.12 timeouts (local/cloud) which were hardcoded duplicates until
// v7.9.13 and are now constant-referenced too.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { TIMEOUTS } = require(path.join(ROOT, 'src/agent/core/Constants'));
const { Settings } = require(path.join(ROOT, 'src/agent/foundation/Settings'));

function freshSettings(prefix, storage) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return new Settings(tmpDir, storage);
}

describe('v7.9.13 (Item A) — stream-timeout settings', () => {

  test('all four streamTimeouts defaults equal their constants (no drift)', () => {
    const s = freshSettings('v7913-a-def-');
    assertEqual(s.get('llm.streamTimeouts.firstChunk'), TIMEOUTS.LLM_STREAM_FIRST_CHUNK, 'firstChunk');
    assertEqual(s.get('llm.streamTimeouts.chunk'), TIMEOUTS.LLM_STREAM_CHUNK, 'chunk');
    assertEqual(s.get('llm.streamTimeouts.total'), TIMEOUTS.LLM_STREAM_TOTAL, 'total');
    assertEqual(s.get('llm.streamTimeouts.continuationTotal'), TIMEOUTS.LLM_CONTINUATION_TOTAL, 'continuationTotal');
  });

  test('v7.9.12 local/cloud timeouts also equal their constants (drift cleaned up)', () => {
    const s = freshSettings('v7913-a-v12-');
    assertEqual(s.get('llm.localTimeoutMs'), TIMEOUTS.LLM_RESPONSE_LOCAL, 'localTimeoutMs');
    assertEqual(s.get('llm.cloudTimeoutMs'), TIMEOUTS.LLM_RESPONSE_CLOUD_OLLAMA, 'cloudTimeoutMs');
  });

  test('source: Settings references the constants, does not hardcode the numbers', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/Settings.js'), 'utf8');
    // The streamTimeouts block must use TIMEOUTS.* references.
    assert(/firstChunk:\s*TIMEOUTS\.LLM_STREAM_FIRST_CHUNK/.test(src), 'firstChunk must reference the constant');
    assert(/chunk:\s*TIMEOUTS\.LLM_STREAM_CHUNK/.test(src), 'chunk must reference the constant');
    assert(/total:\s*TIMEOUTS\.LLM_STREAM_TOTAL/.test(src), 'total must reference the constant');
    assert(/continuationTotal:\s*TIMEOUTS\.LLM_CONTINUATION_TOTAL/.test(src), 'continuationTotal must reference the constant');
    assert(/localTimeoutMs:\s*TIMEOUTS\.LLM_RESPONSE_LOCAL/.test(src), 'localTimeoutMs must reference the constant');
    assert(/cloudTimeoutMs:\s*TIMEOUTS\.LLM_RESPONSE_CLOUD_OLLAMA/.test(src), 'cloudTimeoutMs must reference the constant');
  });

  test('clamps bound out-of-range values on load', () => {
    const bad = { llm: { streamTimeouts: {
      firstChunk: 5000,        // below min 10000
      chunk: 999999,           // above max 120000
      total: 9999999,          // above max 1800000
      continuationTotal: 100,  // below min 120000
    } } };
    const storage = { readJSON: () => bad, writeJSONDebounced: () => {} };
    const s = freshSettings('v7913-a-clamp-', storage);
    assertEqual(s.get('llm.streamTimeouts.firstChunk'), 10000, 'firstChunk clamped to min');
    assertEqual(s.get('llm.streamTimeouts.chunk'), 120000, 'chunk clamped to max');
    assertEqual(s.get('llm.streamTimeouts.total'), 1800000, 'total clamped to max');
    assertEqual(s.get('llm.streamTimeouts.continuationTotal'), 120000, 'continuationTotal clamped to min');
  });

  test('a valid in-range override survives', () => {
    const good = { llm: { streamTimeouts: { firstChunk: 200000 } } };
    const storage = { readJSON: () => good, writeJSONDebounced: () => {} };
    const s = freshSettings('v7913-a-ovr-', storage);
    assertEqual(s.get('llm.streamTimeouts.firstChunk'), 200000, 'valid override kept');
  });

  test('source: ModelBridgeContinuation bridges all four into the options', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/ModelBridgeContinuation.js'), 'utf8');
    assert(/firstChunkTimeoutMs:\s*Number\(this\._settings\?\.get\?\.\('llm\.streamTimeouts\.firstChunk'\)/.test(src),
      'firstChunkTimeoutMs must read from settings');
    assert(/chunkTimeoutMs:\s*Number\(this\._settings\?\.get\?\.\('llm\.streamTimeouts\.chunk'\)/.test(src),
      'chunkTimeoutMs must read from settings');
    assert(/totalTimeoutMs:\s*Number\(this\._settings\?\.get\?\.\('llm\.streamTimeouts\.total'\)/.test(src),
      'totalTimeoutMs must read from settings');
    assert(/continuationTotalTimeoutMs:\s*Number\(this\._settings\?\.get\?\.\('llm\.streamTimeouts\.continuationTotal'\)/.test(src),
      'continuationTotalTimeoutMs must read from settings');
  });

  test('source: Constants comment names the exact scope (Ollama code-generation)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/core/Constants.js'), 'utf8');
    // The comment must not promise generic "streaming"; it must scope to
    // Ollama code-generation so we do not replace one half-truth with another.
    assert(/taskType === 'code'/.test(src),
      'Constants comment must scope streamTimeouts to taskType === code');
  });

});

if (require.main === module) run();
