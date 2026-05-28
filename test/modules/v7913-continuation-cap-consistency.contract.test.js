#!/usr/bin/env node
// ============================================================
// GENESIS — test/modules/v7913-continuation-cap-consistency.contract.test.js
//
// v7.9.13 (P6): ContinuationLoop max-attempts cap — comment drift fixed,
// value deliberately stays 6.
//
// The story: a v7.9.9 comment claimed "Fix 7: 6 -> 10" in three files,
// but the literal stayed 6 everywhere. Investigation found this was not
// a forgotten edit — v7.9.10 had addressed the cloud-truncation problem
// a better way: computeEffectiveMaxContinuations lifts no-prefill/cloud
// models to CLOUD_NO_PREFILL_FLOOR (10) at run time, while local
// verified-prefill models keep the 6 default where it suffices. So the
// global default of 6 is correct; the "6 -> 10" comments were stale,
// describing an intent that v7.9.10 implemented per-capability instead.
//
// This contract guards two things:
//   1. The value stays 6 in all three places (Settings default,
//      ContinuationLoop default, ModelBridgeContinuation fallback).
//      Any drift produces silently mismatched behaviour by call path.
//   2. The stale "6 -> 10" / "all three: 10" comment claims are gone,
//      so the next reader is not misled again.
//
// The cloud-lift to 10 lives in v7910-cloud-continuation-cap.contract;
// that test is the companion guarding CLOUD_NO_PREFILL_FLOOR === 10.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SETTINGS = path.join(ROOT, 'src/agent/foundation/Settings.js');
const CONTINUATION = path.join(ROOT, 'src/agent/foundation/backends/ContinuationLoop.js');
const BRIDGE_CONT = path.join(ROOT, 'src/agent/foundation/ModelBridgeContinuation.js');

describe('v7.9.13 (P6) — continuation-cap value + comment consistency', () => {

  test('Settings default maxAttempts is 6', () => {
    const src = fs.readFileSync(SETTINGS, 'utf8');
    assert(/continuation:\s*\{\s*maxAttempts:\s*6\s*\}/.test(src),
      'Settings.js must keep continuation.maxAttempts at 6 (local-prefill floor)');
  });

  test('ContinuationLoop default constant is 6', () => {
    const src = fs.readFileSync(CONTINUATION, 'utf8');
    assert(/MAX_CONTINUATIONS_DEFAULT\s*=\s*6\b/.test(src),
      'ContinuationLoop MAX_CONTINUATIONS_DEFAULT must stay 6');
  });

  test('ModelBridgeContinuation fallback is 6', () => {
    const src = fs.readFileSync(BRIDGE_CONT, 'utf8');
    assert(/maxAttempts'\)\s*\?\?\s*6\)/.test(src),
      'ModelBridgeContinuation maxContinuations fallback must stay 6');
  });

  test('runtime: Settings resolves maxAttempts to 6', () => {
    const os = require('os');
    const { Settings } = require(path.join(ROOT, 'src/agent/foundation/Settings'));
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v7913-p6-'));
    const s = new Settings(tmpDir);
    assertEqual(s.get('llm.continuation.maxAttempts'), 6,
      'live default must be 6');
  });

  test('stale "6 -> 10" comment claims are removed from all three files', () => {
    for (const f of [SETTINGS, CONTINUATION, BRIDGE_CONT]) {
      const src = fs.readFileSync(f, 'utf8');
      assert(!/6\s*(?:->|→)\s*10/.test(src),
        `${path.basename(f)} must not claim "6 -> 10" (stale v7.9.9 comment)`);
      assert(!/all three:\s*10/.test(src),
        `${path.basename(f)} must not claim "all three: 10"`);
    }
  });

  test('comments reference the v7.9.10 per-capability mechanism', () => {
    // The corrected comments should point the reader to where the 10
    // actually lives, so the drift is not reintroduced.
    const settingsSrc = fs.readFileSync(SETTINGS, 'utf8');
    assert(/computeEffectiveMaxContinuations|CLOUD_NO_PREFILL_FLOOR/.test(settingsSrc),
      'Settings.js comment should reference the v7.9.10 cloud-lift mechanism');
  });

});

if (require.main === module) run();
