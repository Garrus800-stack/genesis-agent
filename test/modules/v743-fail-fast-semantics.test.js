// ============================================================
// v7.4.3 Baustein A — O-11 fail-fast semantics
//
// v7.4.2 Baustein E synchronized CIRCUIT.TIMEOUT_MS (60s → 180s)
// to match LLM_RESPONSE_LOCAL. That stopped the symptom but kept
// the root cause: the LLM circuit was running a duplicate
// Promise.race over a fn whose own HTTP-level timeout did the
// same job. Two timers, same value, same error path. At identical
// values the wrapper is harmless; at any drift apart the shorter
// one orphans in-flight requests at the other one's boundary.
//
// v7.4.3 fix: rename CB.timeoutMs → CB.failFastMs (with deprecation
// alias), give it null/0 opt-out semantics, and configure the LLM
// breaker with failFastMs: null. OllamaBackend's req.setTimeout()
// is then the single ceiling. MCP keeps its 15s fail-fast because
// there it is real fail-fast (HTTP is 30s).
//
// This file pins the new invariants so a future reviewer can't
// silently re-enable the duplicate wrapper on the LLM circuit.
// The v7.4.2 test stays in place as a historical pin on the
// deprecation alias.
// ============================================================

'use strict';

const { describe, it } = require('node:test');
const assert = require('assert');

const { CircuitBreaker } = require('../../src/agent/core/CircuitBreaker');
const { CIRCUIT } = require('../../src/agent/core/Constants');

describe('v7.4.3 Baustein A — failFastMs canonical name + opt-out', () => {

  it('failFastMs is the canonical config name (replaces timeoutMs)', () => {
    const cb = new CircuitBreaker({ name: 't1', failFastMs: 5000 });
    assert.strictEqual(cb.failFastMs, 5000);
  });

  it('timeoutMs still works as deprecation alias', () => {
    const cb = new CircuitBreaker({ name: 't2', timeoutMs: 7000 });
    assert.strictEqual(cb.failFastMs, 7000);
    // Mirror property kept for HealthMonitor / getStatus consumers.
    assert.strictEqual(cb.timeoutMs, 7000);
  });

  it('failFastMs takes precedence over timeoutMs when both set', () => {
    const cb = new CircuitBreaker({ name: 't3', failFastMs: 1000, timeoutMs: 9000 });
    assert.strictEqual(cb.failFastMs, 1000);
  });

  it('failFastMs: null opts out of the wrapper — long calls finish', async () => {
    const cb = new CircuitBreaker({ name: 't4', failFastMs: null, maxRetries: 0 });
    let called = false;
    const slowFn = () => new Promise(resolve => {
      // 50ms is "long" relative to the wrapper's default 15000ms but
      // also fast enough that the test isn't slow. The point: with
      // failFastMs: null there is no Promise.race wrapper at all,
      // so even a fn that took hours would not be aborted by the CB.
      setTimeout(() => { called = true; resolve('done'); }, 50);
    });
    const result = await cb.execute(slowFn);
    assert.strictEqual(result, 'done');
    assert.strictEqual(called, true);
  });

  it('failFastMs: 0 also opts out (falsy → no wrapper)', async () => {
    const cb = new CircuitBreaker({ name: 't5', failFastMs: 0, maxRetries: 0 });
    const fn = () => Promise.resolve('ok');
    const result = await cb.execute(fn);
    assert.strictEqual(result, 'ok');
  });

  it('failFastMs > 0 still aborts long calls (MCP semantics preserved)', async () => {
    const cb = new CircuitBreaker({ name: 't6', failFastMs: 30, maxRetries: 0 });
    const slowFn = () => new Promise(resolve => setTimeout(() => resolve('late'), 200));
    let err;
    try {
      await cb.execute(slowFn);
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'fail-fast wrapper must reject the slow call');
    assert.match(err.message, /Timeout \(fail-fast\) nach 30ms/);
  });

  it('default failFastMs is 15000 (MCP and other opt-in callers rely on this)', () => {
    const cb = new CircuitBreaker({ name: 't7' });
    assert.strictEqual(cb.failFastMs, 15000);
  });

  it('getStatus surfaces failFastMs for diagnostics', () => {
    const cb = new CircuitBreaker({ name: 't8', failFastMs: null });
    const status = cb.getStatus();
    assert.strictEqual(status.failFastMs, null);
  });
});

describe('v7.4.3 Baustein A — LLM circuit is configured with failFastMs: null', () => {

  it('phase2-intelligence registers the llm CB with failFastMs: null', () => {
    // We don't boot the full container in a unit test — instead, parse
    // the manifest source to confirm the configuration. This catches
    // regressions where someone re-enables a fail-fast value on the
    // LLM circuit without going through this invariant.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '../../src/agent/manifest/phase2-intelligence.js'),
      'utf-8'
    );
    // The 'circuitBreaker' factory block must contain failFastMs: null
    // and must NOT contain a non-null fail-fast or timeout value.
    const cbBlock = src.match(/\['circuitBreaker',[\s\S]+?\}\),\s*\}\],/);
    assert.ok(cbBlock, 'circuitBreaker registration must exist in phase2-intelligence.js');
    assert.match(cbBlock[0], /failFastMs:\s*null/,
      'LLM circuit must opt out of fail-fast via failFastMs: null. ' +
      'OllamaBackend.req.setTimeout(LLM_RESPONSE_LOCAL) is the only ceiling.');
    assert.doesNotMatch(cbBlock[0], /timeoutMs:\s*CIRCUIT\.TIMEOUT_MS/,
      'LLM circuit must not use the deprecated timeoutMs config. ' +
      'See v7.4.3 Baustein A CHANGELOG.');
  });
});

describe('v7.4.3 Baustein A — CIRCUIT.FAIL_FAST_MS canonical constant', () => {

  it('CIRCUIT.FAIL_FAST_MS exists', () => {
    assert.strictEqual(typeof CIRCUIT.FAIL_FAST_MS, 'number');
  });

  it('CIRCUIT.TIMEOUT_MS retained as deprecated alias for any out-of-tree readers', () => {
    assert.strictEqual(CIRCUIT.TIMEOUT_MS, CIRCUIT.FAIL_FAST_MS);
  });
});
