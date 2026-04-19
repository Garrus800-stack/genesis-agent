// ============================================================
// Test: PromptBuilder source-access section (v7.3.3)
//
// When the user asks about a specific module, class, or service,
// Genesis injects the actual source file (or at least metadata)
// into the prompt instead of guessing. This is the chat-time
// counterpart to the IdleMind ReadSource activity.
//
// Selection heuristic:
//  1. Explicit file path (src/agent/...)  → exact file
//  2. Class name (PascalCase)              → file that exports it
//  3. Service name (camelCase +Suffix)     → file of that service
//  4. No match                              → empty section
// ============================================================

'use strict';

const { describe, test, assert, assertIncludes, run } = require('../harness');
const { PromptBuilder } = require('../../src/agent/intelligence/PromptBuilder');

// Build a minimal selfModel with getModuleSummary + readModule sync fallback.
// We use a stub because the real SelfModel requires full container context.
function makeSelfModel(extras = {}) {
  const modules = [
    {
      file: 'src/agent/intelligence/PromptBuilder.js',
      classes: ['PromptBuilder'],
      functions: 3,
      description: 'Builds system prompts from context sections.',
    },
    {
      file: 'src/agent/planning/GoalStack.js',
      classes: ['GoalStack'],
      functions: 15,
      description: 'Manages goal lifecycle and persistence.',
    },
    {
      file: 'src/agent/hexagonal/ChatOrchestrator.js',
      classes: ['ChatOrchestrator'],
      functions: 8,
      description: 'Main chat flow orchestration.',
    },
    {
      file: 'src/agent/intelligence/IntentRouter.js',
      classes: ['IntentRouter'],
      functions: 12,
      description: 'Classifies user messages into intents.',
    },
  ];
  return {
    getModuleSummary: () => modules,
    readModule: (file) => extras.readModule ? extras.readModule(file)
      : `// SOURCE OF ${file}\nclass Example { /* body */ }\n`,
    describeModule: (file) => {
      const m = modules.find(x => x.file === file);
      return m ? { classes: m.classes, description: m.description } : {};
    },
    ...extras,
  };
}

function makeBuilder(selfModel) {
  return new PromptBuilder({
    model: { activeModel: 'mock' },
    lang: { get: () => 'en', t: (k) => k },
    selfModel,
  });
}

// ── basic gating ───────────────────────────────────
describe('v7.3.3 — source-access: activation rules', () => {
  test('empty query → empty section', () => {
    const pb = makeBuilder(makeSelfModel());
    const out = pb._sourceAccessContext();
    assert(out === '', 'with no query set, section should be empty');
  });

  test('query without any file/class/service reference → empty', () => {
    const pb = makeBuilder(makeSelfModel());
    pb.setQuery('how are you today?');
    const out = pb._sourceAccessContext();
    assert(out === '', 'chit-chat should not trigger source injection');
  });

  test('no selfModel → empty (graceful)', () => {
    const pb = makeBuilder(null);
    pb.setQuery('show me GoalStack');
    const out = pb._sourceAccessContext();
    assert(out === '', 'missing selfModel → quiet skip');
  });
});

// ── file-path path ──────────────────────────────────
describe('v7.3.3 — source-access: explicit file path', () => {
  test('exact src/... path in query → that file is loaded', () => {
    const pb = makeBuilder(makeSelfModel());
    pb.setQuery('explain what src/agent/planning/GoalStack.js does');
    const out = pb._sourceAccessContext();
    assertIncludes(out, 'GoalStack.js', 'path should appear in header');
    assertIncludes(out, 'SOURCE REFERENCE', 'section has standard header');
    assertIncludes(out, 'SOURCE OF src/agent/planning/GoalStack.js', 'body of file present');
  });

  test('path match is case-sensitive, no false hits on partial names', () => {
    const pb = makeBuilder(makeSelfModel());
    pb.setQuery('in my file goalstack.js I see a bug');  // lowercase, no src/ prefix
    const out = pb._sourceAccessContext();
    // lowercase without src/ prefix shouldn't match our paths strictly
    // but class name "goalstack" lowercase also won't match our class regex
    assert(!out.includes('SOURCE OF'), 'loose path match should not trigger source load');
  });
});

// ── class-name path ────────────────────────────────
describe('v7.3.3 — source-access: class name reference', () => {
  test('PascalCase class name → matching file loaded', () => {
    const pb = makeBuilder(makeSelfModel());
    pb.setQuery('how does GoalStack work?');
    const out = pb._sourceAccessContext();
    assertIncludes(out, 'GoalStack.js', 'should find file by class name');
    assertIncludes(out, '"GoalStack"', 'header shows matched class name');
  });

  test('question words (What/How/Why) are not treated as class names', () => {
    const pb = makeBuilder(makeSelfModel());
    pb.setQuery('What about you?');  // "What" is PascalCase but is a stop word
    const out = pb._sourceAccessContext();
    assert(out === '', 'question words should not trigger source loading');
  });

  test('multiple class names → first match wins', () => {
    const pb = makeBuilder(makeSelfModel());
    pb.setQuery('compare GoalStack and IntentRouter');
    const out = pb._sourceAccessContext();
    // Either one would be valid; first hit is loaded
    assert(
      out.includes('GoalStack.js') || out.includes('IntentRouter.js'),
      'at least one should match'
    );
    // But not both in the same injection
    const hitCount = (out.match(/SOURCE REFERENCE/g) || []).length;
    assert(hitCount === 1, `should inject exactly one file, got ${hitCount}`);
  });

  test('unknown PascalCase name → no match (empty)', () => {
    const pb = makeBuilder(makeSelfModel());
    pb.setQuery('tell me about FooBar');
    const out = pb._sourceAccessContext();
    assert(out === '', 'unknown class name should not load anything');
  });
});

// ── service-name path ─────────────────────────────
describe('v7.3.3 — source-access: service name reference', () => {
  test('camelCase service name → matching file loaded', () => {
    const pb = makeBuilder(makeSelfModel());
    pb.setQuery('how does chatOrchestrator handle streaming?');
    const out = pb._sourceAccessContext();
    assertIncludes(out, 'ChatOrchestrator.js', 'PascalCase file name resolved');
  });

  test('goalStack (lowercase) resolves to GoalStack.js', () => {
    const pb = makeBuilder(makeSelfModel());
    pb.setQuery('what does goalStack do when attempts are exhausted?');
    const out = pb._sourceAccessContext();
    assertIncludes(out, 'GoalStack.js', 'service name → file');
  });

  test('random camelCase without known suffix → no match', () => {
    const pb = makeBuilder(makeSelfModel());
    pb.setQuery('what about myVariable?');
    const out = pb._sourceAccessContext();
    assert(out === '', 'unknown camelCase name should not match');
  });
});

// ── content sanity ────────────────────────────────
describe('v7.3.3 — source-access: content safety', () => {
  test('very long source is truncated', () => {
    const long = 'x'.repeat(5000);
    const sm = makeSelfModel({ readModule: () => long });
    const pb = makeBuilder(sm);
    pb.setQuery('show me GoalStack');
    const out = pb._sourceAccessContext();
    assertIncludes(out, 'truncated', 'long source should be truncated');
    assert(out.length < 3000, `section should stay under 3000 chars, got ${out.length}`);
  });

  test('readModule returning null → empty section (no crash)', () => {
    const sm = makeSelfModel({ readModule: () => null });
    const pb = makeBuilder(sm);
    pb.setQuery('show me GoalStack');
    const out = pb._sourceAccessContext();
    assert(out === '', 'null content → empty, not crash');
  });

  test('readModule throwing → empty section (no crash)', () => {
    const sm = makeSelfModel({ readModule: () => { throw new Error('io fail'); } });
    const pb = makeBuilder(sm);
    pb.setQuery('show me GoalStack');
    const out = pb._sourceAccessContext();
    assert(out === '', 'throwing readModule → empty, not crash');
  });
});

// ── integration with full build ────────────────────
describe('v7.3.3 — source-access: integration with prompt build', () => {
  test('source section appears in full prompt when query matches', () => {
    const pb = makeBuilder(makeSelfModel());
    pb.setQuery('explain GoalStack');
    pb.setIntent('general');
    const prompt = pb.build();
    assertIncludes(prompt, 'SOURCE REFERENCE', 'source block included in full build');
  });

  test('source section absent when query does not match', () => {
    const pb = makeBuilder(makeSelfModel());
    pb.setQuery('hi, how are you?');
    pb.setIntent('general');
    const prompt = pb.build();
    assert(
      !prompt.includes('SOURCE REFERENCE'),
      'no source block when query has nothing to reference'
    );
  });
});

run();
