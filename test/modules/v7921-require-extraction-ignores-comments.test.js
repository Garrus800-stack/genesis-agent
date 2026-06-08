'use strict';
// v7.9.21 (Point B) — _parseModule's require extraction must ignore require(...)
// occurrences inside comments (line + block) and string/template literals, and
// must be string-safe (a "//" inside 'http://x' must not truncate the line).
const { describe, test, run, assert } = require('../harness');
const { selfModelParsing } = require('../../src/agent/foundation/SelfModelParsing');

function parse(code) {
  const obj = Object.assign({ manifest: { files: {}, modules: {} }, guard: null }, selfModelParsing);
  return obj._parseModule(code, 'fixture.js').requires;
}

describe('v7921 require extraction ignores comments', () => {
  test('real requires captured; commented and string-embedded ignored', () => {
    const code = [
      "const a = require('./real');",
      "// const b = require('./commented');",
      "/* const c = require('./block'); */",
      "const u = 'http://example.com'; const z = require('./z');",
      "const t = `tmpl require('./tmpl')`;",
      "const r = require('./mix'); // require('./trailing')",
    ].join('\n');
    const reqs = parse(code);

    assert(reqs.includes('./real'), 'real top require captured — got: ' + reqs.join(','));
    assert(reqs.includes('./z'), 'require after a URL string captured — got: ' + reqs.join(','));
    assert(reqs.includes('./mix'), 'real require before a trailing comment captured — got: ' + reqs.join(','));

    assert(!reqs.includes('./commented'), 'line-commented require must be ignored');
    assert(!reqs.includes('./block'), 'block-commented require must be ignored');
    assert(!reqs.includes('./tmpl'), 'require inside a template literal must be ignored');
    assert(!reqs.includes('./trailing'), 'require in a trailing line-comment must be ignored');
    assert(!reqs.some(r => /^https?:/.test(r)), 'a URL must not be captured as a require — got: ' + reqs.join(','));
  });

  test('multi-line block comment containing a require is ignored', () => {
    const code = [
      'const real = require("./keep");',
      '/*',
      "  const gone = require('./gone');",
      '*/',
      'const real2 = require("./keep2");',
    ].join('\n');
    const reqs = parse(code);
    assert(reqs.includes('./keep') && reqs.includes('./keep2'), 'real requires around the block kept — got: ' + reqs.join(','));
    assert(!reqs.includes('./gone'), 'require inside the multi-line block comment ignored — got: ' + reqs.join(','));
  });
});

if (require.main === module) run();
