// ============================================================
// v7.4.2 Baustein E Hotfix — Circuit-Breaker / LLM-Timeout alignment
//
// Problem: CIRCUIT.TIMEOUT_MS (60s) was shorter than
// LLM_RESPONSE_LOCAL (180s). Large local models like qwen3:32b-q4
// cold-start in 90-150s — within the HTTP budget, but past the
// circuit-breaker timeout. The wrapper killed the in-flight call,
// counted a failure, retried, failed again, opened the circuit
// after 3 counts, blocked all subsequent chat for the 30s cooldown.
//
// Fix: raise CIRCUIT.TIMEOUT_MS to 180000 so the circuit-breaker
// only fires when the underlying HTTP timeout would also fire.
// This test pins the invariant so a future reviewer can't silently
// lower one of the two and reintroduce the regression.
// ============================================================

'use strict';

const { describe, it } = require('node:test');
const assert = require('assert');

const { CIRCUIT, TIMEOUTS } = require('../../src/agent/core/Constants');

describe('v7.4.2 Baustein E — Circuit timeout must match HTTP LLM timeout', () => {

  it('CIRCUIT.TIMEOUT_MS is ≥ LLM_RESPONSE_LOCAL', () => {
    assert.ok(
      CIRCUIT.TIMEOUT_MS >= TIMEOUTS.LLM_RESPONSE_LOCAL,
      `CIRCUIT.TIMEOUT_MS (${CIRCUIT.TIMEOUT_MS}) must be >= ` +
      `LLM_RESPONSE_LOCAL (${TIMEOUTS.LLM_RESPONSE_LOCAL}). ` +
      `If the wrapper is shorter than the HTTP budget, legitimate ` +
      `long-running local-model calls get killed and the breaker ` +
      `spuriously opens. See v7.4.2 Baustein E CHANGELOG.`
    );
  });

  it('CIRCUIT.TIMEOUT_MS is at least 180000 ms (documented floor)', () => {
    assert.ok(
      CIRCUIT.TIMEOUT_MS >= 180000,
      `CIRCUIT.TIMEOUT_MS must be >= 180000. Current: ${CIRCUIT.TIMEOUT_MS}`
    );
  });

  it('CIRCUIT.FAILURE_THRESHOLD stays at 3 (reference value)', () => {
    // Locked for regression detection; not a hard constraint.
    assert.strictEqual(CIRCUIT.FAILURE_THRESHOLD, 3);
  });

  it('CIRCUIT.COOLDOWN_MS is 30000 (reference value)', () => {
    assert.strictEqual(CIRCUIT.COOLDOWN_MS, 30000);
  });

  it('CIRCUIT.MAX_RETRIES is 1 (reference value)', () => {
    assert.strictEqual(CIRCUIT.MAX_RETRIES, 1);
  });
});
