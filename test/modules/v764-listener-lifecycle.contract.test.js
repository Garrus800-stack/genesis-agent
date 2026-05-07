// ============================================================
// GENESIS — test/modules/v764-listener-lifecycle.contract.test.js
//
// Regression contract for v7.6.4 L1 closeout: every multi-listener
// service under src/agent/ must have one of the documented teardown
// patterns. Without one, hot-reload or ServiceRecovery reinstantiation
// stacks listeners on the bus — a silent leak class that does not
// surface in unit tests because it only manifests across instance
// generations.
//
// The audit script (scripts/audit-listener-lifecycle.js) is the live
// gate; this contract pins three things it should not regress on:
//
//   (a) Six modules migrated in v7.6.4 must keep their teardown
//       pattern (applySubscriptionHelper for standard classes, host
//       _unsubAll() for prototype-mixins). If anyone removes the
//       cleanup path, the audit catches it AND this test breaks.
//
//   (b) Four modules cleared as audit false-positives in v7.6.4
//       (digit-suffixed _unsub fields, array-push pattern) must keep
//       their existing teardown shape so the audit-script extensions
//       added in v7.6.4 stay justified.
//
//   (c) The TO_STOP list in AgentCoreHealth.js must contain every
//       service-name whose service has a stop() that does listener
//       teardown. Architectural-fitness Check #3 covers the general
//       case; this test pins the v7.6.4 additions specifically.
//
// SECURITY CONTRACT: gate contract: listener-lifecycle teardown is
// the only thing standing between hot-reload and an unbounded
// listener pile — once the bus accumulates dozens of stale closures,
// fired events fan out to dead instances and the resulting double-
// processing class is unbounded in scope.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');

const { describe, test, assert, assertEqual, run } = require('../harness');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src', 'agent');

const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf-8');

// ── (a) Migrated modules — applySubscriptionHelper or host pattern ──

const MIGRATED_STANDARD = [
  // file rel-path                          // service-name in TO_STOP
  ['planning/SelfOptimizer.js',             'selfOptimizer'],
  ['planning/Anticipator.js',               'anticipator'],
  ['revolution/VectorMemory.js',            'vectorMemory'],
];

const MIGRATED_FRONTIER = [
  // FrontierWriter is one class with three registered instances.
  ['unfinishedWorkFrontier'],
  ['suspicionFrontier'],
  ['lessonFrontier'],
];

const MIGRATED_MIXIN_HOSTS = [
  // host file                              mixin file                              host class
  ['autonomy/CognitiveMonitor.js',          'autonomy/CognitiveMonitorAnalysis.js', 'CognitiveMonitor'],
  ['organism/Homeostasis.js',               'organism/HomeostasisVitals.js',        'Homeostasis'],
];

// ── (b) False-positives — pre-existing patterns now recognised ──

const FALSE_POSITIVES = [
  // file                                pattern type
  ['agency/GoalDriver.js',               'array-push'],   // _unsubs.push + for-of
  ['foundation/ResourceRegistry.js',     'array-push'],   // _unsubs.push + for-of
  ['cognitive/OnlineLearner.js',         'digit-unsub'],  // _unsub1 / _unsub2 + ?.()
  ['cognitive/LessonsStore.js',          'digit-unsub'],  // _unsub1...7 + ?.()
];

describe('v7.6.4 listener-lifecycle contract: standard-class migrations', () => {
  for (const [rel] of MIGRATED_STANDARD) {
    test(`gate contract: ${path.basename(rel, '.js')} keeps applySubscriptionHelper teardown`, () => {
      const src = read(rel);
      assert(/require\(['"][^'"]+subscription-helper['"]\)/.test(src),
        `${rel} should import subscription-helper`);
      assert(/applySubscriptionHelper\s*\(\s*\w+/.test(src),
        `${rel} should call applySubscriptionHelper(ClassName, ...)`);
      assert(/this\._unsubs\s*=\s*\[\]/.test(src),
        `${rel} should initialise this._unsubs = [] in constructor`);
      assert(/this\._sub\(/.test(src),
        `${rel} should subscribe via this._sub() (helper-grafted)`);
      assert(/this\._unsubAll\(\)/.test(src),
        `${rel} should call this._unsubAll() in stop()`);
    });
  }
});

describe('v7.6.4 listener-lifecycle contract: FrontierWriter migration', () => {
  test('gate contract: FrontierWriter teardown via applySubscriptionHelper', () => {
    const src = read('organism/FrontierWriter.js');
    assert(/require\(['"][^'"]+subscription-helper['"]\)/.test(src),
      'FrontierWriter should import subscription-helper');
    assert(/applySubscriptionHelper\s*\(\s*FrontierWriter/.test(src),
      'FrontierWriter should call applySubscriptionHelper(FrontierWriter)');
    assert(/this\._unsubs\s*=\s*\[\]/.test(src),
      'FrontierWriter should initialise this._unsubs = []');
    // listeners live in enableEventBuffer(), not constructor
    assert(/this\._sub\(collectEvent/.test(src),
      'FrontierWriter.enableEventBuffer should use this._sub for collectEvent');
    assert(/this\._sub\(triggerEvent/.test(src),
      'FrontierWriter.enableEventBuffer should use this._sub for triggerEvent');
    assert(/this\._unsubAll\(\)/.test(src),
      'FrontierWriter should call this._unsubAll() in stop()');
  });
});

describe('v7.6.4 listener-lifecycle contract: prototype-mixin host migrations', () => {
  for (const [hostRel, mixinRel, hostClass] of MIGRATED_MIXIN_HOSTS) {
    test(`gate contract: ${hostClass} host applies helper before Object.assign`, () => {
      const hostSrc = read(hostRel);
      assert(/require\(['"][^'"]+subscription-helper['"]\)/.test(hostSrc),
        `${hostRel} should import subscription-helper`);
      assert(new RegExp(`applySubscriptionHelper\\s*\\(\\s*${hostClass}`).test(hostSrc),
        `${hostRel} should call applySubscriptionHelper(${hostClass}, ...)`);
      assert(/this\._unsubs\s*=\s*\[\]/.test(hostSrc),
        `${hostRel} should initialise this._unsubs = [] in constructor`);
      assert(/this\._unsubAll\(\)/.test(hostSrc),
        `${hostRel} should call this._unsubAll() in stop()`);

      // Order matters — helper must come BEFORE the Object.assign so the
      // mixin sees _sub on the prototype chain when its methods run.
      const helperIdx = hostSrc.search(/applySubscriptionHelper\s*\(\s*\w+/);
      const assignIdx = hostSrc.search(/Object\.assign\(\s*\w+\.prototype/);
      assert(helperIdx > 0, `${hostRel}: helper call not found`);
      assert(assignIdx > 0, `${hostRel}: Object.assign not found`);
      assert(helperIdx < assignIdx,
        `${hostRel}: applySubscriptionHelper must run before Object.assign(${hostClass}.prototype, mixin)`);
    });

    test(`gate contract: ${path.basename(mixinRel, '.js')} mixin uses this._sub (no raw bus.on)`, () => {
      const mixinSrc = read(mixinRel);
      // Mixin must wire via this._sub, not this.bus.on.
      assertEqual((mixinSrc.match(/this\.bus\.on\(/g) || []).length, 0,
        `${mixinRel} should not call this.bus.on() directly — use this._sub() instead`);
      assert((mixinSrc.match(/this\._sub\(/g) || []).length >= 2,
        `${mixinRel} should subscribe via this._sub()`);
    });
  }
});

describe('v7.6.4 listener-lifecycle contract: false-positives stay clean', () => {
  for (const [rel, kind] of FALSE_POSITIVES) {
    test(`gate contract: ${path.basename(rel, '.js')} keeps ${kind} teardown pattern`, () => {
      const src = read(rel);
      if (kind === 'array-push') {
        assert(/this\._unsubs\s*=\s*\[\]/.test(src),
          `${rel} should keep this._unsubs = [] init`);
        assert(/this\._unsubs\.push\(/.test(src),
          `${rel} should keep this._unsubs.push(bus.on(...)) pattern`);
        assert(/for\s*\(\s*const\s+\w+\s+of\s+this\._unsubs|this\._unsubs\.forEach|this\._unsubs\.length\s*=\s*0/.test(src),
          `${rel} should keep iterate-or-clear teardown`);
      } else if (kind === 'digit-unsub') {
        // assignment with digit suffix
        assert(/this\._unsub\d+\s*=\s*(?:this\.)?bus\.on\(/.test(src),
          `${rel} should keep this._unsub<N> = bus.on(...) pattern`);
        // teardown call
        assert(/this\._unsub\d+\??\.?\(\)/.test(src),
          `${rel} should keep this._unsub<N>?.() teardown calls`);
      }
    });
  }
});

describe('v7.6.4 listener-lifecycle contract: TO_STOP list contains v7.6.4 additions', () => {
  const HEALTH_FILE = path.join(SRC, 'AgentCoreHealth.js');
  const healthSrc = fs.readFileSync(HEALTH_FILE, 'utf-8');
  const toStopMatch = healthSrc.match(/const TO_STOP\s*=\s*\[([\s\S]*?)\];/);
  assert(toStopMatch, 'AgentCoreHealth.js must contain a const TO_STOP = [...] array');
  const toStop = (toStopMatch[1].match(/'([^']+)'/g) || []).map(s => s.replace(/'/g, ''));

  const v764Additions = [
    ...MIGRATED_STANDARD.map(([, name]) => name),
    ...MIGRATED_FRONTIER.flat(),
  ];

  for (const name of v764Additions) {
    test(`gate contract: '${name}' is in AgentCoreHealth TO_STOP`, () => {
      assert(toStop.includes(name),
        `Service '${name}' has a stop() that does listener teardown but is missing from TO_STOP — Architectural-fitness Check #3 also catches this in general; this test pins the v7.6.4 additions specifically.`);
    });
  }
});

describe('v7.6.4 listener-lifecycle contract: audit baseline is zero', () => {
  test('gate contract: audit-listener-lifecycle reports no findings', () => {
    const auditPath = path.join(ROOT, 'scripts', 'audit-listener-lifecycle.js');
    const { execSync } = require('child_process');
    const output = execSync(`node "${auditPath}" --json`, { encoding: 'utf-8' });
    const result = JSON.parse(output);
    assertEqual(result.findings.length, 0,
      `audit-listener-lifecycle baseline must stay at zero. New findings: ${result.findings.map(f => f.rel).join(', ')}`);
  });
});

run();
