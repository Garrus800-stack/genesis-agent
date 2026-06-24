// ============================================================
// v7.9.27 #14 — token-budget warning threshold is configurable.
//
// CognitiveMonitor warned at a hardcoded 0.85 while the neighbouring
// limits were read from config. The threshold now comes from
// config.tokenWarnThreshold, defaulting to 0.85.
// ============================================================

'use strict';

const path = require('path');
const { describe, test, run, assertEqual } = require('../harness');

const ROOT = path.join(__dirname, '../..');
const { CognitiveMonitor } = require(path.join(ROOT, 'src/agent/autonomy/CognitiveMonitor'));

describe('v7.9.27 #14 — configurable token-warn threshold', () => {
  test('defaults to 0.85 when not configured', () => {
    const cm = new CognitiveMonitor({});
    assertEqual(cm._tokenWarnThreshold, 0.85);
  });

  test('reads tokenWarnThreshold from config', () => {
    const cm = new CognitiveMonitor({ config: { tokenWarnThreshold: 0.6 } });
    assertEqual(cm._tokenWarnThreshold, 0.6);
  });

  test('a falsy zero falls back to the default (guards against silent always-on)', () => {
    const cm = new CognitiveMonitor({ config: { tokenWarnThreshold: 0 } });
    assertEqual(cm._tokenWarnThreshold, 0.85);
  });
});

if (require.main === module) run();
