// ============================================================
// GENESIS — test/modules/v7910-detector-offline.contract.test.js
// v7.9.10: LLMCapabilityDetector honors GENESIS_OFFLINE_TESTS=1.
//
// Pre-fix every bridge.chat() in tests triggered detectCapability →
// _fetchModelInfo → http.request('localhost:11434/api/show'). When
// Ollama wasn't running, req.setTimeout(VERIFICATION_TIMEOUT_MS=15000)
// held for 15 seconds before rejecting. v752-fix (~10 chat() calls)
// blocked the test runner for ~150s.
//
// Fix mirrors OllamaBackend's existing test-mode guard (v7.8.4):
// _fetchModelInfo throws immediately on GENESIS_OFFLINE_TESTS=1.
// _verifyPrefill returns false on the same flag (conservative default).
// ============================================================

'use strict';

const { describe, test, assert, run } = require('../harness');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const DETECTOR_PATH = path.join(ROOT, 'src/agent/foundation/backends/LLMCapabilityDetector');
const { LLMCapabilityDetector } = require(DETECTOR_PATH);

describe('v7.9.10 — LLMCapabilityDetector offline test-mode guard', () => {

  test('_fetchModelInfo throws fast when GENESIS_OFFLINE_TESTS=1', async () => {
    const prev = process.env.GENESIS_OFFLINE_TESTS;
    process.env.GENESIS_OFFLINE_TESTS = '1';
    try {
      const detector = new LLMCapabilityDetector({
        baseUrl: 'http://localhost:11434',
        genesisDir: null,
      });
      const start = Date.now();
      let threw = false;
      try {
        await detector._fetchModelInfo('qwen3:8b');
      } catch (err) {
        threw = true;
        assert(/offline|test mode|GENESIS_OFFLINE/i.test(err.message),
          'error message must indicate offline test mode, got: ' + err.message);
      }
      const elapsed = Date.now() - start;
      assert(threw, '_fetchModelInfo must throw when offline flag is set');
      assert(elapsed < 100, `must throw in < 100ms (got ${elapsed}ms) — would otherwise wait full 15s timeout`);
    } finally {
      if (prev === undefined) delete process.env.GENESIS_OFFLINE_TESTS;
      else process.env.GENESIS_OFFLINE_TESTS = prev;
    }
  });

  test('_verifyPrefill returns false fast when GENESIS_OFFLINE_TESTS=1', async () => {
    const prev = process.env.GENESIS_OFFLINE_TESTS;
    process.env.GENESIS_OFFLINE_TESTS = '1';
    try {
      const detector = new LLMCapabilityDetector({
        baseUrl: 'http://localhost:11434',
        genesisDir: null,
      });
      const start = Date.now();
      const result = await detector._verifyPrefill('qwen3:8b');
      const elapsed = Date.now() - start;
      assert(result === false, '_verifyPrefill must return false in test mode (conservative)');
      assert(elapsed < 100, `must return in < 100ms (got ${elapsed}ms) — would otherwise wait full 15s timeout`);
    } finally {
      if (prev === undefined) delete process.env.GENESIS_OFFLINE_TESTS;
      else process.env.GENESIS_OFFLINE_TESTS = prev;
    }
  });

  test('_fetchImpl mock still honored over offline guard', async () => {
    // Explicit test mocks should take precedence over the offline guard
    // — _fetchImpl is the documented way to inject test behavior.
    const prev = process.env.GENESIS_OFFLINE_TESTS;
    process.env.GENESIS_OFFLINE_TESTS = '1';
    try {
      const detector = new LLMCapabilityDetector({
        baseUrl: 'http://localhost:11434',
        genesisDir: null,
        fetchImpl: () => Promise.resolve({
          template: '{{.System}} {{.Prompt}}',
          digest: 'sha256:test',
          hasRenderer: false,
        }),
      });
      const result = await detector._fetchModelInfo('mock-model');
      assert(result && result.digest === 'sha256:test',
        '_fetchImpl mock must run even with offline guard set');
    } finally {
      if (prev === undefined) delete process.env.GENESIS_OFFLINE_TESTS;
      else process.env.GENESIS_OFFLINE_TESTS = prev;
    }
  });

  test('offline guard is documented in source (mirrors OllamaBackend pattern)', () => {
    const src = fs.readFileSync(DETECTOR_PATH + '.js', 'utf8');
    // Both methods must guard — count occurrences
    const occurrences = (src.match(/GENESIS_OFFLINE_TESTS/g) || []).length;
    assert(occurrences >= 2,
      `GENESIS_OFFLINE_TESTS must appear at least twice (one per method), got ${occurrences}`);
  });

});

if (require.main === module) run();
