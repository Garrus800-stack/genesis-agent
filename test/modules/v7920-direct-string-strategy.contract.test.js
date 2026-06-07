'use strict';
// v7.9.20 (B1) — a STRING strategy is not DIRECT-eligible.
//
// Field trace (newer .genesis dump + boot-log): a manually-seeded lesson
// "step by step decomposition works best" (strategy: 'step-by-step
// decomposition' — a STRING, useCount 180, conf 0.99, source 'manual') passed
// every existing DIRECT gate and fired DIRECT on ANALYZE/SHELL/SEARCH steps.
// A string strategy has no `.command`, so DIRECT took the non-shell branch
// ("return the insight as the analysis") — emitting boilerplate in place of a
// real analysis and bypassing _stepAnalyze, so F2 wrote no agent-loop-analysis
// node. This contract pins: string strategy -> not DIRECT (falls to GUIDED);
// object strategies (the only thing DIRECT can apply) are unaffected.
const path = require('path');
const { SymbolicResolver } = require(path.join(__dirname, '..', '..', 'src/agent/intelligence/SymbolicResolver'));

let passed = 0, failed = 0;
function check(label, cond) { if (cond) { passed++; } else { console.log('    \u274c ' + label); failed++; } }

const r = new SymbolicResolver({});
// All gate preconditions satisfied (useCount >= 3, recent, conf >= directThreshold);
// only the strategy shape varies.
const base = { id: 'l1', insight: 'x', useCount: 180, lastUsed: Date.now(), confidence: 0.99 };

// (1) STRING strategy is the field-captured boilerplate — must NOT be DIRECT.
check('string strategy on ANALYZE is not DIRECT (null)',
  r._checkDirect('ANALYZE', { ...base, strategy: 'step-by-step decomposition' }) === null);
check('string strategy on SHELL is not DIRECT (null)',
  r._checkDirect('SHELL', { ...base, strategy: 'step-by-step decomposition' }) === null);
check('string strategy on SEARCH is not DIRECT (null)',
  r._checkDirect('SEARCH', { ...base, strategy: 'whatever text' }) === null);

// (2) OBJECT strategy with an actionable command — the only thing DIRECT can
// apply — MUST stay DIRECT-eligible (regression guard).
const cmd = r._checkDirect('SHELL', { ...base, strategy: { command: 'npm install' } });
check('object {command} on SHELL stays DIRECT (non-null)', cmd !== null);

// (3) OBJECT failure-classification strategy is still blocked by the existing
// v7.9.7 filter (unchanged by B1) — and is an object, so B1 itself wouldn't
// touch it; this guards we didn't accidentally re-open it.
check('object {classification} stays blocked (v7.9.7 filter)',
  r._checkDirect('ANALYZE', { ...base, strategy: { classification: 'structural' } }) === null);

console.log('\n    ' + passed + ' passed \u00b7 ' + failed + ' failed \u00b7 v7.9.20 B1 string-strategy DIRECT gate');
process.exit(failed > 0 ? 1 : 0);
