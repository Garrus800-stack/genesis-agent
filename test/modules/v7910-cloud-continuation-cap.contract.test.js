// ============================================================
// GENESIS — test/modules/v7910-cloud-continuation-cap.contract.test.js
// v7.9.10: Cloud (no-prefill) continuation cap lifted to ≥10.
// Local (verified-prefill) stays at caller's maxContinuations.
//
// Tests the pure function computeEffectiveMaxContinuations directly.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const {
  computeEffectiveMaxContinuations,
  CLOUD_NO_PREFILL_FLOOR,
  MAX_CONTINUATIONS_DEFAULT,
} = require(path.join(ROOT, 'src/agent/foundation/backends/ContinuationLoop'));

describe('v7.9.10 — Cloud no-prefill continuation cap', () => {

  test('CLOUD_NO_PREFILL_FLOOR is 10', () => {
    assertEqual(CLOUD_NO_PREFILL_FLOOR, 10, 'cloud floor must be 10');
  });

  test('MAX_CONTINUATIONS_DEFAULT stays 6 (local-prefill floor)', () => {
    assertEqual(MAX_CONTINUATIONS_DEFAULT, 6, 'default cap unchanged at 6');
  });

  test('verified-prefill respects caller value (6 stays 6)', () => {
    const eff = computeEffectiveMaxContinuations({ status: 'verified-prefill' }, 6);
    assertEqual(eff, 6, 'local-prefill must not be lifted');
  });

  test('verified-prefill respects caller value (3 stays 3)', () => {
    const eff = computeEffectiveMaxContinuations({ status: 'verified-prefill' }, 3);
    assertEqual(eff, 3, 'local-prefill caller-3 must stay 3');
  });

  test('verified-no-prefill lifts 6 → 10', () => {
    const eff = computeEffectiveMaxContinuations({ status: 'verified-no-prefill' }, 6);
    assertEqual(eff, 10, 'cloud no-prefill must lift to 10');
  });

  test('unverified-no-prefill also lifts 6 → 10', () => {
    const eff = computeEffectiveMaxContinuations({ status: 'unverified-no-prefill' }, 6);
    assertEqual(eff, 10, 'unverified no-prefill must lift to 10');
  });

  test('caller requesting >10 (e.g. 15) is not capped down', () => {
    const eff = computeEffectiveMaxContinuations({ status: 'verified-no-prefill' }, 15);
    assertEqual(eff, 15, 'caller-15 must stay 15 even with floor 10');
  });

  test('null capability defaults to no-prefill behaviour', () => {
    const eff = computeEffectiveMaxContinuations(null, 6);
    assertEqual(eff, 10, 'null capability treated conservatively → lift');
  });

  test('undefined capability defaults to no-prefill behaviour', () => {
    const eff = computeEffectiveMaxContinuations(undefined, 6);
    assertEqual(eff, 10, 'undefined capability treated conservatively → lift');
  });

  test('capability without status field defaults to no-prefill', () => {
    const eff = computeEffectiveMaxContinuations({}, 6);
    assertEqual(eff, 10, 'capability with no status → lift');
  });

  test('verification-failed capability lifts (no prefill possible)', () => {
    const eff = computeEffectiveMaxContinuations({ status: 'verification-failed' }, 6);
    assertEqual(eff, 10, 'verification-failed treated as no-prefill');
  });
});

if (require.main === module) run();
