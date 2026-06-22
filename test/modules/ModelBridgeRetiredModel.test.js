#!/usr/bin/env node
// Test: retired-model classification + TTL wiring — C (v7.9.25)
// A 410/retired model is now classified 'model-retired' (before auth) and carries
// an effectively-permanent TTL, so markUnavailable fires and failover stops
// retrying the dead model first on every call. The 410 match is status-scoped so
// an unrelated "410 tokens" does not trip it.
const { describe, test, assert, assertEqual, run } = require('../harness');
const { failoverMixin } = require('../../src/agent/foundation/ModelBridgeFailover');
const { UNAVAILABLE_TTL_MAP } = require('../../src/agent/foundation/ModelBridge');

const classify = (message) => failoverMixin._classifyFailoverReason({ message });

describe('ModelBridge C — retired-model classification', () => {

  test('a retired-model 410 is classified model-retired', () => {
    assertEqual(classify('Model kimi-k2.7-code:cloud was retired (status code 410).'),
      'model-retired', 'retired wording → model-retired');
  });

  test('a bare "status code 410" (no wording) is model-retired', () => {
    assertEqual(classify('Request failed with status code 410'),
      'model-retired', '410 in a status context → model-retired');
  });

  test('a decommissioned model is model-retired', () => {
    assertEqual(classify('This model has been decommissioned.'),
      'model-retired', 'decommissioned → model-retired');
  });

  test('retired wins over co-occurring auth text (sticky long TTL, not 1h auth)', () => {
    assertEqual(classify('Model retired (410). Your API key is no longer valid for it.'),
      'model-retired', 'retired classified before auth');
  });

  test('a genuine auth error is still auth (retired pattern does not catch it)', () => {
    assertEqual(classify('401 Unauthorized: invalid api key'),
      'auth', 'real auth error unaffected');
  });

  test('"410 tokens" does NOT trip the retired classifier (false-positive guard)', () => {
    assert(classify('Context window exceeded: 410 tokens over the limit') !== 'model-retired',
      'non-status 410 is not model-retired');
  });

  test('model-retired carries an effectively-permanent TTL so markUnavailable fires', () => {
    const ttl = UNAVAILABLE_TTL_MAP['model-retired'];
    assert(typeof ttl === 'number' && ttl > 0, 'model-retired has a TTL entry');
    assert(ttl >= 24 * 60 * 60 * 1000, 'TTL is at least as long as the longest transient reason (24h)');
  });
});

run();
