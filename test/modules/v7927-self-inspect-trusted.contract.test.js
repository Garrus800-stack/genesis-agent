// ============================================================
// v7.9.27 #1 — self-inspection tools are trusted (internal).
//
// classifyToolSource did not recognise self-inspect / introspect /
// self-model / self-state, so their output fell to 'unknown' and was
// run through the injection scan. The word "routine" in a self-report
// matched the urgency heuristic, so Genesis flagged its own
// introspection as a prompt-injection attempt. These tools now classify
// as 'file:internal', like a read of its own source.
// ============================================================

'use strict';

const path = require('path');
const { describe, test, run, assertEqual } = require('../harness');

const ROOT = path.join(__dirname, '../..');
const { classifyToolSource } = require(path.join(ROOT, 'src/agent/core/injection-gate'));

describe('v7.9.27 #1 — self-inspection is internal', () => {
  test('self-inspect → file:internal', () => {
    assertEqual(classifyToolSource('self-inspect', {}), 'file:internal');
  });

  test('introspect → file:internal', () => {
    assertEqual(classifyToolSource('introspect', {}), 'file:internal');
  });

  test('self_model → file:internal', () => {
    assertEqual(classifyToolSource('self_model', {}), 'file:internal');
  });

  test('self-state → file:internal', () => {
    assertEqual(classifyToolSource('self-state', {}), 'file:internal');
  });

  // The new branch must not perturb the existing classifications.
  test('web tools still classify as web', () => {
    assertEqual(classifyToolSource('web-search', { query: 'x' }), 'web');
  });

  test('mcp tools still classify as mcp', () => {
    assertEqual(classifyToolSource('mcp__server__tool', {}), 'mcp');
  });

  test('an unrelated tool is still unknown', () => {
    assertEqual(classifyToolSource('frobnicate', {}), 'unknown');
  });
});

if (require.main === module) run();
