// ============================================================
// v7.9.27 #7 — generic verbs are affinity stopwords.
//
// SymbolicResolver._tokenise feeds the lesson goal-affinity match.
// Generic introspection/meta verbs ("inspect", "wiring", "review", ...)
// carried no subject yet counted toward the overlap, so an avoid-lesson
// lent its weight to almost any review or config step. Those tokens are
// now excluded; only subject tokens count.
// ============================================================

'use strict';

const path = require('path');
const { describe, test, run, assert } = require('../harness');

const ROOT = path.join(__dirname, '../..');
const { SymbolicResolver } = require(path.join(ROOT, 'src/agent/intelligence/SymbolicResolver'));

describe('v7.9.27 #7 — affinity stopwords', () => {
  const r = new SymbolicResolver({});
  const GENERIC = [
    'inspect', 'inspection', 'wiring', 'wire', 'config', 'configuration',
    'verify', 'review', 'analyze', 'examine', 'trace',
  ];

  test('generic verbs are excluded from tokenisation', () => {
    for (const w of GENERIC) {
      const toks = r._tokenise(`please ${w} the module`);
      assert(!toks.has(w), `"${w}" must not be an affinity token`);
    }
  });

  test('subject tokens still survive alongside generic verbs', () => {
    const toks = r._tokenise('inspect the telemetry sink wiring');
    assert(toks.has('telemetry'), 'subject token "telemetry" kept');
    assert(toks.has('sink'), 'subject token "sink" kept');
    assert(!toks.has('inspect'), 'generic verb "inspect" dropped');
    assert(!toks.has('wiring'), 'generic verb "wiring" dropped');
  });

  test('two unrelated goals no longer overlap on generic verbs alone', () => {
    const a = r._tokenise('inspect and verify the config');
    const b = r._tokenise('inspect and verify the payment flow');
    let overlap = 0;
    for (const t of a) if (b.has(t)) overlap++;
    assert(overlap === 0, `unrelated goals must not share generic-only tokens (overlap ${overlap})`);
  });
});

if (require.main === module) run();
