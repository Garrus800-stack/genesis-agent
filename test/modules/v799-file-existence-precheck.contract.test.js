// ============================================================
// GENESIS — v799-file-existence-precheck.contract.test.js
//
// Pins the v7.9.9 Plan-activity invariant: goals that reference
// non-existent src/test/scripts paths (i.e. paths NOT in the
// realPaths catalogue AND NOT present on disk) are rejected
// before they reach the GoalStack. Pre-fix the LLM hallucinated
// paths like `src/agent/autonomy/activities/SensorDiagnostics.js`
// which produced 15-minute stall-watchdog waits per goal.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const { describe, test, assert, run } = require('../harness');

const PLAN_PATH = path.join(ROOT, 'src/agent/autonomy/activities/Plan.js');

describe('v7.9.9 Plan File-Existence Pre-Check', () => {

  test('SRC-01: _hasHallucinatedPaths helper exists in Plan.js', () => {
    const src = fs.readFileSync(PLAN_PATH, 'utf8');
    assert(/_hasHallucinatedPaths/.test(src),
      'Plan.js must export/define _hasHallucinatedPaths helper');
  });

  test('SRC-02: regex matches src/test/scripts paths with file extensions', () => {
    const src = fs.readFileSync(PLAN_PATH, 'utf8');
    const regexLine = src.match(/_PATH_REGEX\s*=\s*\/[^;]+/)?.[0] || '';
    assert(/src\|test\|scripts/.test(regexLine),
      '_PATH_REGEX must scan src|test|scripts paths');
    assert(/js\|ts\|json\|md/.test(regexLine),
      '_PATH_REGEX must cover .js/.ts/.json/.md extensions');
  });

  test('SRC-03: pre-check called before addGoal', () => {
    const src = fs.readFileSync(PLAN_PATH, 'utf8');
    const planRunIdx = src.indexOf('async run(');
    const helloHallucIdx = src.indexOf('_hasHallucinatedPaths(thought', planRunIdx);
    const addGoalIdx = src.indexOf('.addGoal(', planRunIdx);
    assert(helloHallucIdx > 0, '_hasHallucinatedPaths must be called from run()');
    assert(addGoalIdx > 0, 'addGoal call must exist');
    assert(helloHallucIdx < addGoalIdx,
      'pre-check must run BEFORE addGoal so hallucinated goals are rejected');
  });

  test('SRC-04: rejection uses _log.info with skip-marker', () => {
    const src = fs.readFileSync(PLAN_PATH, 'utf8');
    assert(/references non-existent path/.test(src),
      'rejection log message must reference the non-existent path');
  });

  test('LOGIC-01: real-file match short-circuits via realSet', () => {
    const src = fs.readFileSync(PLAN_PATH, 'utf8');
    assert(/realSet\.has\(normRef\)/.test(src),
      'paths in the realPaths catalogue must short-circuit (in-catalogue)');
  });

  test('LOGIC-02: fs.existsSync fallback for paths not in catalogue', () => {
    const src = fs.readFileSync(PLAN_PATH, 'utf8');
    assert(/fs\.existsSync\(abs\)/.test(src),
      'paths not in catalogue but present on disk must pass via fs.existsSync');
  });

  test('LOGIC-03: rootDir read from selfModel.rootDir with fallback', () => {
    const src = fs.readFileSync(PLAN_PATH, 'utf8');
    assert(/idleMind\.selfModel\?\.rootDir.*process\.cwd/.test(src),
      'rootDir must come from idleMind.selfModel.rootDir, fallback to process.cwd()');
  });

}); // describe

run().catch(err => { console.error(err); process.exit(1); });
