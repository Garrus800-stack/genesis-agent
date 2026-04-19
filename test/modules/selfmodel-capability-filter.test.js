// ============================================================
// Test: SelfModel capability detection — no parser artifacts
// v7.3.3: The class-name extractor was over-matching on strings
// and comments inside source files (especially vendor files like
// acorn.js that list reserved words as strings). This test pins
// down the fix so the regression doesn't come back.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const { SelfModel } = require('../../src/agent/foundation/SelfModel');

function makeModel() {
  return new SelfModel(process.cwd(), { isProtected: () => false });
}

describe('SelfModel: capability detection filters parser artifacts', () => {
  test('no JS reserved words leak as capabilities', async () => {
    const model = makeModel();
    await model.scan();
    const caps = model.manifest.capabilities;

    // These showed up as bogus "capabilities" before v7.3.3 because the
    // naive class-name regex matched strings like "class enum extends super"
    // inside acorn.js and similar vendor libraries.
    const reservedWords = [
      'enum', 'extends', 'static', 'method', 'field', 'getters',
      'identifiers', 'escape', 'declaration', 'definition',
      'as', 'is', 'of', 'to', 'for', 'into', 'from',
      'foo', 'bar', 'baz', 'may', 'name', 'names',
      'matching', 'rolling', 'found', 'size', 'double',
    ];
    const leaked = caps.filter((c) => reservedWords.includes(c));
    assertEqual(
      leaked.length,
      0,
      'reserved words leaked as capabilities: ' + JSON.stringify(leaked)
    );
  });

  test('vendor files are excluded from capability scanning', async () => {
    const model = makeModel();
    await model.scan();
    const files = Object.keys(model.manifest.files);
    const vendorFiles = files.filter((f) => f.includes('/vendor/') || f.includes('\\vendor\\'));
    assertEqual(
      vendorFiles.length,
      0,
      'vendor files still being scanned: ' + JSON.stringify(vendorFiles.slice(0, 5))
    );
  });

  test('real PascalCase classes are still detected', async () => {
    const model = makeModel();
    await model.scan();
    const caps = model.manifest.capabilities;

    // A handful of real Genesis classes that MUST appear as capabilities.
    const expectedReal = [
      'chat-orchestrator',
      'goal-stack',
      'event-bus',
      'intent-router',
      'prompt-builder',
      'self-model',
      'core-memories',
    ];
    for (const cap of expectedReal) {
      assert(
        caps.includes(cap),
        `expected real capability "${cap}" missing from detected list`
      );
    }
  });

  test('classes inside string literals are not mistaken for declarations', async () => {
    // Direct parser test: feed synthetic source with "class X" inside strings/comments
    const model = makeModel();
    const synthetic = `
      // This comment mentions "class FakeClass { }" but it's just docs.
      /* class AnotherFake extends Base */
      const example = 'class StringFake extends other';
      const other = "class QuotedFake";
      class RealClass {
        method() {}
      }
      class AlsoReal extends RealClass {}
    `;
    const result = model._parseModule(synthetic, 'test/fake.js');
    assert(result.classes.includes('RealClass'), 'real class should be detected');
    assert(result.classes.includes('AlsoReal'), 'second real class should be detected');
    assert(!result.classes.includes('FakeClass'), 'comment-only class should NOT be detected');
    assert(!result.classes.includes('AnotherFake'), 'block-comment class should NOT be detected');
    assert(!result.classes.includes('StringFake'), 'string-literal class should NOT be detected');
    assert(!result.classes.includes('QuotedFake'), 'double-quoted class should NOT be detected');
  });

  test('lowercase identifiers after class keyword are ignored', async () => {
    const model = makeModel();
    // Some source code has patterns like "class enum" in reserved-word lists
    const synthetic = `
      const reserved = "class enum extends super";
      const pattern = /class\\s+(\\w+)/;
      class RealOne {}
    `;
    const result = model._parseModule(synthetic, 'test/fake2.js');
    assertEqual(result.classes.length, 1, 'only RealOne should be detected');
    assertEqual(result.classes[0], 'RealOne');
  });
});

run();
