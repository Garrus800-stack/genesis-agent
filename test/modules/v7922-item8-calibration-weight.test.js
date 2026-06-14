'use strict';
// v7.9.22 Item 8 — calibration error is weighted by the prediction's confidence, so a
// low-confidence cold-start guess drags the exposed score far less than a confident call.
const { describe, test, assert, run } = require('../harness');
const { ExpectationEngine } = require('../../src/agent/cognitive/ExpectationEngine');

const fresh = () => new ExpectationEngine({});
const seed = (e, n) => { e._calibration.booleanErrors = Array.from({ length: n }, () => ({ error: 0.1, weight: 0.9 })); };

describe('v7.9.22 Item 8 — confidence-weighted calibration score', () => {
  test('a confident correct prediction raises the score; a confident wrong one lowers it', () => {
    const up = fresh();
    up._updateCalibration({ successProb: 0.9, confidence: 0.9 }, { success: true });
    assert(up.getCalibration() > 0.5, `confident correct should raise above 0.5, got ${up.getCalibration()}`);

    const down = fresh();
    down._updateCalibration({ successProb: 0.9, confidence: 0.9 }, { success: false });
    assert(down.getCalibration() < 0.5, `confident wrong should drop below 0.5, got ${down.getCalibration()}`);
  });

  test('an equally-wrong low-confidence guess moves the score far less than a confident one', () => {
    const BASE = 0.9; // 20 seeded entries of error 0.1 → weighted mean error 0.1 → score 0.9
    const low = fresh();  seed(low, 20);
    low._updateCalibration({ successProb: 0.95, confidence: 0.05 }, { success: false });  // weight floors to 0.2
    const high = fresh(); seed(high, 20);
    high._updateCalibration({ successProb: 0.95, confidence: 0.95 }, { success: false }); // weight 0.95

    const sLow = low.getCalibration(), sHigh = high.getCalibration();
    assert(sLow > sHigh, `low-confidence wrong should leave the score higher (${sLow}) than confident wrong (${sHigh})`);
    assert((BASE - sLow) < 0.5 * (BASE - sHigh),
      `low-confidence drop ${(BASE - sLow).toFixed(4)} should be far less than confident drop ${(BASE - sHigh).toFixed(4)}`);
  });

  test('legacy plain-number window entries count at weight 1.0 (no migration)', () => {
    const e = fresh();
    e._calibration.booleanErrors = [0.0, 0.0, 0.0, 0.0]; // legacy format, four perfect predictions
    e._updateCalibration({ successProb: 0.5, confidence: 0.2 }, { success: false }); // adds error 0.5 weight 0.2
    // weighted mean = (4*1.0*0 + 0.2*0.5) / (4*1.0 + 0.2) = 0.1/4.2 ≈ 0.0238 → score ≈ 0.976
    const s = e.getCalibration();
    assert(s > 0.95 && s < 1.0, `legacy numbers at weight 1.0 dominate the single low-weight guess, got ${s}`);
  });
});

run();
