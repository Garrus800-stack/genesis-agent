#!/usr/bin/env node
// v7.7.9 Phase 3 — Bug 1 regression test
//
// Live-Befund (Garrus, 2026-05-10): the pursuit-failure log showed
//   "pursuit of goal_..._1 failed (1/6) — backing off 5s: <empty>"
// which means agent-loop:complete was fired with success=false but
// an empty summary. The downstream chain (GoalDriverFailurePolicy →
// reflectOnFailure → plan-failure-reflection → InnerSpeech → PSE)
// then had no useful content to reflect on, so even when the pipeline
// fires the reflection text is essentially empty.
//
// Fix: in AgentLoopPursuit._executeLoop, when verification.success ===
// false AND summary is empty, reconstruct a meaningful default from
// the available step errors. Downstream consumers always get a
// non-empty failure description.

'use strict';

const { describe, test, assert, run } = require('../harness');
const fs = require('fs');
const path = require('path');

describe('Bug 1 — _executeLoop guarantees non-empty failure summary', () => {
  test('AgentLoopPursuit source contains the non-empty summary fallback', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src/agent/revolution/AgentLoopPursuit.js'),
      'utf-8',
    );
    // The fix must (a) detect empty summary, (b) reconstruct from last
    // step error, (c) fall back to a generic message if nothing found.
    assert(/verification\.success.*\(!\s*_finalSummary/.test(src) ||
           /!verification\.success\s*&&\s*\(!\s*_finalSummary/.test(src),
      'fallback condition (success=false AND empty summary) must be present');
    assert(/Last error:/.test(src),
      'fallback must mention last error when available');
    assert(/no explicit error message captured/.test(src),
      'generic fallback message must be present for truly empty cases');
  });

  test('agent-loop:complete payload uses _finalSummary not verification.summary', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src/agent/revolution/AgentLoopPursuit.js'),
      'utf-8',
    );
    // The bus.fire('agent-loop:complete', ...) at end of _executeLoop
    // must use _finalSummary, not verification.summary directly.
    const fireBlock = src.match(/bus\.fire\('agent-loop:complete'[^}]*\}\)/s);
    if (fireBlock) {
      const lastFireBlockNearReturn = src.match(/bus\.fire\('agent-loop:complete',\s*\{[^}]*summary:\s*_finalSummary/s);
      assert(lastFireBlockNearReturn,
        'agent-loop:complete must emit _finalSummary, not raw verification.summary');
    }
  });

  test('return value also uses _finalSummary', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src/agent/revolution/AgentLoopPursuit.js'),
      'utf-8',
    );
    // The final return at end of _executeLoop should also use
    // _finalSummary so callers get the same enriched message.
    assert(/return\s*\{\s*success:\s*verification\.success,\s*summary:\s*_finalSummary/s.test(src),
      'final return must use _finalSummary');
  });
});

// ── End-to-end behaviour test ────────────────────────────
// Simulate the failure path by directly invoking the fallback logic
// inline. The actual _executeLoop integration is covered by AgentLoop
// tests; here we just verify the fallback shape.
describe('Bug 1 — fallback message shape', () => {
  test('with last error → includes "Last error:" prefix', () => {
    const allResults = [
      { output: 'ok' },
      { output: 'ok' },
      { error: 'Resource(s) unavailable: file:logs/self-statement.log' },
    ];
    const stepCount = 3;
    const errorCount = allResults.filter(r => r && r.error).length;
    const lastError = [...allResults].reverse().find(r => r && r.error);
    const lastErrorMsg = lastError && typeof lastError.error === 'string'
      ? lastError.error.slice(0, 120) : '';
    const summary = lastErrorMsg
      ? `Goal verification failed after ${stepCount} steps. Last error: ${lastErrorMsg}`
      : `Goal verification failed after ${stepCount} steps with ${errorCount} step error(s) (no explicit error message captured).`;

    assert(summary.includes('Last error: Resource(s) unavailable'),
      'expected last-error prefix');
    assert(summary.includes('after 3 steps'),
      'expected step count');
  });

  test('with no captured errors → generic fallback', () => {
    const allResults = [{ output: 'partial' }, { output: 'partial' }];
    const stepCount = 2;
    const errorCount = allResults.filter(r => r && r.error).length;
    const lastError = [...allResults].reverse().find(r => r && r.error);
    const lastErrorMsg = lastError && typeof lastError.error === 'string'
      ? lastError.error.slice(0, 120) : '';
    const summary = lastErrorMsg
      ? `Goal verification failed after ${stepCount} steps. Last error: ${lastErrorMsg}`
      : `Goal verification failed after ${stepCount} steps with ${errorCount} step error(s) (no explicit error message captured).`;

    assert(summary.includes('no explicit error message captured'),
      'expected generic fallback');
    assert(summary.includes('0 step error(s)'),
      'expected 0 error count');
  });

  test('summary is always non-empty when success=false', () => {
    // Even with completely empty results array, we get a non-empty message
    const allResults = [];
    const stepCount = 0;
    const lastError = [...allResults].reverse().find(r => r && r.error);
    const lastErrorMsg = lastError && typeof lastError.error === 'string'
      ? lastError.error.slice(0, 120) : '';
    const summary = lastErrorMsg
      ? `Goal verification failed after ${stepCount} steps. Last error: ${lastErrorMsg}`
      : `Goal verification failed after ${stepCount} steps with 0 step error(s) (no explicit error message captured).`;

    assert(summary.length > 0, 'summary must never be empty');
    assert(!summary.includes('<empty>'),
      'summary must not contain the literal "<empty>" placeholder');
  });
});

run();
