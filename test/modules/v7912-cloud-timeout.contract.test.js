#!/usr/bin/env node
// ============================================================
// GENESIS — test/modules/v7912-cloud-timeout.contract.test.js
//
// v7.9.12: OllamaBackend distinguishes local vs cloud-proxied models and
// applies a longer HTTP idle-timeout to the latter. qwen3-vl:235b-cloud was
// field-traced hitting the 180s LOCAL ceiling before its first chunk; the
// real timeout that fired was OllamaBackend's req.setTimeout (NOT the
// StreamingCompletion first-chunk timer, which only runs in the
// code-generation ContinuationLoop path).
//
// Under test:
//   - _isCloudModel matches *-cloud / *:cloud, rejects local names
//   - _timeoutForModel returns cloudTimeoutMs for cloud, localTimeoutMs else
//   - constructor defaults (180s local, 300s cloud) from TIMEOUTS
//   - explicit overrides honored
//   - ModelBridge passes ollamaCloudTimeoutMs through to the backend
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const { OllamaBackend } = require('../../src/agent/foundation/backends/OllamaBackend');
const { ModelBridge } = require('../../src/agent/foundation/ModelBridge');
const { TIMEOUTS } = require('../../src/agent/core/Constants');
const { createBus } = require('../../src/agent/core/EventBus');

describe('v7.9.12 — Ollama cloud-timeout differentiation', () => {

  test('_isCloudModel detection', () => {
    const ob = new OllamaBackend();
    assert(ob._isCloudModel('qwen3-vl:235b-cloud'), 'colon-cloud suffix is cloud');
    assert(ob._isCloudModel('some-model-cloud'), 'dash-cloud suffix is cloud');
    assert(ob._isCloudModel('gpt-oss:120b-cloud'), 'colon-cloud with size is cloud');
    assert(!ob._isCloudModel('qwen3:32b'), 'local model is not cloud');
    assert(!ob._isCloudModel('llama3.1:8b'), 'local model is not cloud');
    assert(!ob._isCloudModel('cloudy-with-meatballs'), 'cloud not at boundary is not matched');
    assert(!ob._isCloudModel(null), 'null is not cloud');
    assert(!ob._isCloudModel(undefined), 'undefined is not cloud');
  });

  test('_timeoutForModel picks the right ceiling', () => {
    const ob = new OllamaBackend();
    assertEqual(ob._timeoutForModel('qwen3-vl:235b-cloud'), ob.cloudTimeoutMs,
      'cloud model → cloudTimeoutMs');
    assertEqual(ob._timeoutForModel('qwen3:32b'), ob.localTimeoutMs,
      'local model → localTimeoutMs');
  });

  test('constructor defaults from TIMEOUTS constants', () => {
    const ob = new OllamaBackend();
    assertEqual(ob.localTimeoutMs, TIMEOUTS.LLM_RESPONSE_LOCAL, 'local default = 180s constant');
    assertEqual(ob.cloudTimeoutMs, TIMEOUTS.LLM_RESPONSE_CLOUD_OLLAMA, 'cloud default = 300s constant');
    assertEqual(ob.cloudTimeoutMs, 300000, 'cloud default is 300s');
    assert(ob.cloudTimeoutMs > ob.localTimeoutMs, 'cloud ceiling exceeds local');
  });

  test('explicit overrides honored', () => {
    const ob = new OllamaBackend({ localTimeoutMs: 120000, cloudTimeoutMs: 450000 });
    assertEqual(ob.localTimeoutMs, 120000, 'local override honored');
    assertEqual(ob.cloudTimeoutMs, 450000, 'cloud override honored');
    assertEqual(ob._timeoutForModel('x-cloud'), 450000, 'cloud model uses overridden cloud timeout');
  });

  test('invalid override falls back to constant default', () => {
    const ob = new OllamaBackend({ cloudTimeoutMs: 0 });   // 0 = invalid
    assertEqual(ob.cloudTimeoutMs, TIMEOUTS.LLM_RESPONSE_CLOUD_OLLAMA,
      'zero override ignored, falls back to default');
    const ob2 = new OllamaBackend({ cloudTimeoutMs: -5 }); // negative = invalid
    assertEqual(ob2.cloudTimeoutMs, TIMEOUTS.LLM_RESPONSE_CLOUD_OLLAMA,
      'negative override ignored');
  });

  test('ModelBridge passes ollamaCloudTimeoutMs through to backend', () => {
    const mb = new ModelBridge({ bus: createBus(), ollamaCloudTimeoutMs: 360000 });
    assertEqual(mb.backends.ollama.cloudTimeoutMs, 360000,
      'cloud timeout reached the Ollama backend through ModelBridge');
  });

});

if (require.main === module) run();
