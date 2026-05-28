#!/usr/bin/env node
// ============================================================
// GENESIS — test/modules/v7912-failover-cluster.contract.test.js
//
// v7.9.12: failover-cluster detection. A burst of failovers sharing one
// reason carries a `cluster` marker on model:failover, and EmotionalState
// dampens the frustration bump for clustered failovers.
//
// Under test:
//   - _trackFailoverCluster: >=3 same-reason in 30s window → cluster
//   - <3 in window → no cluster
//   - per-reason isolation: a rate-limit burst doesn't trip a timeout cluster
//   - window pruning: old timestamps drop out
//   - EmotionalState bumps +0.06 for a lone failover, +0.02 for a clustered
//     one (the marker is the only difference in payload)
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const { ModelBridge } = require('../../src/agent/foundation/ModelBridge');
const { EmotionalState } = require('../../src/agent/organism/EmotionalState');
const { createBus } = require('../../src/agent/core/EventBus');

describe('v7.9.12 — failover-cluster detection', () => {

  test('3 same-reason failovers in window form a cluster', () => {
    const mb = new ModelBridge({ bus: createBus() });
    assertEqual(mb._trackFailoverCluster('rate-limit'), false, '1st not a cluster');
    assertEqual(mb._trackFailoverCluster('rate-limit'), false, '2nd not a cluster');
    assertEqual(mb._trackFailoverCluster('rate-limit'), true, '3rd completes the cluster');
    assertEqual(mb._trackFailoverCluster('rate-limit'), true, '4th still clustered');
  });

  test('per-reason isolation: rate-limit burst does not trip timeout', () => {
    const mb = new ModelBridge({ bus: createBus() });
    mb._trackFailoverCluster('rate-limit');
    mb._trackFailoverCluster('rate-limit');
    mb._trackFailoverCluster('rate-limit'); // rate-limit now clustered
    // A single timeout must NOT be considered clustered
    assertEqual(mb._trackFailoverCluster('timeout'), false,
      'timeout has its own independent window');
  });

  test('window pruning drops old timestamps', () => {
    const mb = new ModelBridge({ bus: createBus() });
    // Inject two timestamps older than the 30s window directly.
    const old = Date.now() - 31 * 1000;
    mb._failoverCluster.set('rate-limit', [old, old]);
    // A fresh failover should see the old ones pruned → count 1, no cluster
    assertEqual(mb._trackFailoverCluster('rate-limit'), false,
      'expired timestamps pruned, single fresh failover is not a cluster');
    assertEqual(mb._failoverCluster.get('rate-limit').length, 1,
      'only the fresh timestamp remains');
  });

  test('EmotionalState: lone failover bumps full, clustered bumps gentle', () => {
    // Two independent EmotionalState instances so the bumps don't interfere.
    const esLone = new EmotionalState({ bus: createBus(), storage: null, intervals: null, config: {} });
    const esCluster = new EmotionalState({ bus: createBus(), storage: null, intervals: null, config: {} });

    const f0 = esLone.dimensions.frustration.value;
    esLone.bus.fire('model:failover', { from: 'ollama', to: 'anthropic', error: 'x', reason: 'rate-limit' }, { source: 'test' });
    const loneDelta = esLone.dimensions.frustration.value - f0;

    const c0 = esCluster.dimensions.frustration.value;
    esCluster.bus.fire('model:failover', { from: 'ollama', to: 'anthropic', error: 'x', reason: 'rate-limit', cluster: { reason: 'rate-limit', windowMs: 30000 } }, { source: 'test' });
    const clusterDelta = esCluster.dimensions.frustration.value - c0;

    // Lone ≈ 0.06, clustered ≈ 0.02 (allow tiny float tolerance)
    assert(Math.abs(loneDelta - 0.06) < 1e-6, `lone failover bump ~0.06, got ${loneDelta}`);
    assert(Math.abs(clusterDelta - 0.02) < 1e-6, `clustered failover bump ~0.02, got ${clusterDelta}`);
    assert(clusterDelta < loneDelta, 'clustered bump must be smaller than lone bump');
  });

});

if (require.main === module) run();
