'use strict';
// v7.9.23 (Point 2) — _parseModule extracts requires via the acorn AST so a require() that only
// appears as *text* inside a multi-line template literal is not miscounted as a dependency (the
// false positive that flagged a daemon-health issue every cycle), while a require inside a ${...}
// interpolation (real code) is kept. Comments and template text are dropped; on a parse failure the
// previous regex scan is used as a fallback.
const { describe, test, run, assert } = require('../harness');
const { selfModelParsing } = require('../../src/agent/foundation/SelfModelParsing');

function parse(code) {
  const obj = Object.assign({ manifest: { files: {}, modules: {} }, guard: null }, selfModelParsing);
  return obj._parseModule(code, 'fixture.js').requires;
}

describe('v7923 facade AST require extraction', () => {
  test('four require cases: top-level kept, comment dropped, template text dropped, interpolation kept', () => {
    const code = [
      "const top = require('./top-level');",
      "// const c = require('./commented');",
      "const tmpl = `a require('./template-text') b`;",
      "const x = `val=${require('./interpolated').FIELD}`;",
    ].join('\n');
    const reqs = parse(code);
    assert(reqs.includes('./top-level'), 'top-level require kept — got: ' + reqs.join(','));
    assert(reqs.includes('./interpolated'), 'require in ${} interpolation kept — got: ' + reqs.join(','));
    assert(!reqs.includes('./commented'), 'commented require dropped — got: ' + reqs.join(','));
    assert(!reqs.includes('./template-text'), 'require as template text dropped — got: ' + reqs.join(','));
  });

  test('real ASTDiff template-text require not captured; real CoreMemories requires are', () => {
    const fs = require('fs');
    const path = require('path');
    const astdiff = fs.readFileSync(path.resolve(__dirname, '../../src/agent/foundation/ASTDiff.js'), 'utf-8');
    const astdiffReqs = parse(astdiff);
    assert(!astdiffReqs.includes('./Foo'), "ASTDiff's fenced require('./Foo') is template text, must not be captured — got: " + astdiffReqs.join(','));

    const coremem = fs.readFileSync(path.resolve(__dirname, '../../src/agent/cognitive/CoreMemories.js'), 'utf-8');
    const corememReqs = parse(coremem);
    assert(corememReqs.includes('./SignificanceDetector'), "CoreMemories' real require('./SignificanceDetector') must be captured — got: " + corememReqs.join(','));
  });

  test('falls back to regex when source does not parse, still capturing valid requires', () => {
    const code = "const ok = require('./valid'); )(}{ not valid js ${";
    const reqs = parse(code);
    assert(reqs.includes('./valid'), 'fallback regex captures the valid require when AST parse fails — got: ' + reqs.join(','));
  });
});

if (require.main === module) run();
