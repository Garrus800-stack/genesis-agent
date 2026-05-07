// ============================================================
// GENESIS — test/modules/v765-modelbridge-split.contract.test.js
//
// Contract test for the v7.6.5 ModelBridge A2 split: the three
// failover-helper methods (_findFallbackBackend, _classifyFailoverReason,
// _emitFailoverUnavailable) were extracted from ModelBridge.js to
// ModelBridgeFailover.js as a prototype-mixin, identical pattern to
// ModelBridgeAvailability.js (v7.5.6) and ModelBridgeDiscovery.js.
//
// This test pins:
//   1. The mixin module exists and exports `failoverMixin`
//   2. The mixin has exactly the three expected methods
//   3. ModelBridge.prototype carries them after Object.assign
//   4. _classifyFailoverReason returns the documented categories
//      (smoke check that runtime semantics survived the move)
//
// Failure-mode caught: somebody renames/removes one of the three
// methods, or drops the Object.assign at ModelBridge.js bottom, or
// extracts further methods without updating the mixin name.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

describe('v765-modelbridge-split contract: ModelBridgeFailover mixin', () => {

  test('module exports failoverMixin', () => {
    const mod = require(path.join(ROOT, 'src/agent/foundation/ModelBridgeFailover'));
    assert(mod.failoverMixin, 'missing failoverMixin export');
    assert(typeof mod.failoverMixin === 'object', 'failoverMixin must be an object');
  });

  test('failoverMixin has exactly three methods', () => {
    const { failoverMixin } = require(path.join(ROOT, 'src/agent/foundation/ModelBridgeFailover'));
    const keys = Object.keys(failoverMixin).sort();
    assertEqual(keys.length, 3, `expected 3 methods, got ${keys.length}: ${keys.join(',')}`);
    assert(keys.includes('_findFallbackBackend'), 'missing _findFallbackBackend');
    assert(keys.includes('_classifyFailoverReason'), 'missing _classifyFailoverReason');
    assert(keys.includes('_emitFailoverUnavailable'), 'missing _emitFailoverUnavailable');
  });

  test('all three methods are functions', () => {
    const { failoverMixin } = require(path.join(ROOT, 'src/agent/foundation/ModelBridgeFailover'));
    assert(typeof failoverMixin._findFallbackBackend === 'function', '_findFallbackBackend not a function');
    assert(typeof failoverMixin._classifyFailoverReason === 'function', '_classifyFailoverReason not a function');
    assert(typeof failoverMixin._emitFailoverUnavailable === 'function', '_emitFailoverUnavailable not a function');
  });

});

describe('v765-modelbridge-split contract: ModelBridge.prototype mount', () => {

  test('ModelBridge.prototype has all three failover methods after Object.assign', () => {
    const { ModelBridge } = require(path.join(ROOT, 'src/agent/foundation/ModelBridge'));
    assert(typeof ModelBridge.prototype._findFallbackBackend === 'function',
      'ModelBridge.prototype._findFallbackBackend missing — Object.assign not wired');
    assert(typeof ModelBridge.prototype._classifyFailoverReason === 'function',
      'ModelBridge.prototype._classifyFailoverReason missing');
    assert(typeof ModelBridge.prototype._emitFailoverUnavailable === 'function',
      'ModelBridge.prototype._emitFailoverUnavailable missing');
  });

  test('mounted methods are identical references to mixin methods', () => {
    const { ModelBridge } = require(path.join(ROOT, 'src/agent/foundation/ModelBridge'));
    const { failoverMixin } = require(path.join(ROOT, 'src/agent/foundation/ModelBridgeFailover'));
    assertEqual(ModelBridge.prototype._findFallbackBackend, failoverMixin._findFallbackBackend,
      'prototype method diverged from mixin source');
    assertEqual(ModelBridge.prototype._classifyFailoverReason, failoverMixin._classifyFailoverReason,
      'prototype method diverged from mixin source');
    assertEqual(ModelBridge.prototype._emitFailoverUnavailable, failoverMixin._emitFailoverUnavailable,
      'prototype method diverged from mixin source');
  });

});

describe('v765-modelbridge-split contract: _classifyFailoverReason semantics', () => {

  test('returns documented categories for known error patterns', () => {
    const { failoverMixin } = require(path.join(ROOT, 'src/agent/foundation/ModelBridgeFailover'));
    const classify = failoverMixin._classifyFailoverReason;

    // Subscription must be checked before auth (v7.5.7-fix)
    assertEqual(classify({ message: 'requires upgrade for access' }), 'subscription-required');
    assertEqual(classify({ message: 'visit ollama.com/upgrade' }), 'subscription-required');

    assertEqual(classify({ message: 'rate limit exceeded' }), 'rate-limit');
    assertEqual(classify({ message: 'HTTP 429 Too Many Requests' }), 'rate-limit');

    assertEqual(classify({ message: 'request timed out' }), 'timeout');
    assertEqual(classify({ message: 'ETIMEDOUT' }), 'timeout');

    assertEqual(classify({ message: 'ECONNREFUSED' }), 'connection-error');
    assertEqual(classify({ message: 'fetch failed' }), 'connection-error');

    assertEqual(classify({ message: '401 unauthorized' }), 'auth');
    assertEqual(classify({ message: 'invalid api key' }), 'auth');

    assertEqual(classify({ message: 'something weird' }), 'other');
    assertEqual(classify({ message: '' }), 'other');
    assertEqual(classify(null), 'other');
    assertEqual(classify(undefined), 'other');
  });

  test('subscription pattern wins over auth — Ollama Cloud Pro-gates carry both', () => {
    const { failoverMixin } = require(path.join(ROOT, 'src/agent/foundation/ModelBridgeFailover'));
    // 401 + subscription in same message — must classify as subscription, not auth
    assertEqual(
      failoverMixin._classifyFailoverReason({ message: '401 — requires subscription upgrade' }),
      'subscription-required'
    );
  });

});

run();
