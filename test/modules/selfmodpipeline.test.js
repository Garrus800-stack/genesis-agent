// ============================================================
// Test: SelfModificationPipeline.js — Handler wiring, patch
// extraction, modify safety, clone, repair
// ============================================================
let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  // v3.5.2: Fixed — try/catch around fn() for sync errors
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => {
        passed++; console.log(`    ✅ ${name}`);
      }).catch(err => {
        failed++; failures.push({ name, error: err.message });
        console.log(`    ❌ ${name}: ${err.message}`);
      });
    }
    passed++; console.log(`    ✅ ${name}`);
  } catch (err) {
    failed++; failures.push({ name, error: err.message });
    console.log(`    ❌ ${name}: ${err.message}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }

const { SelfModificationPipeline } = require('../../src/agent/hexagonal/SelfModificationPipeline');

function createMockPipeline() {
  const pipeline = new SelfModificationPipeline({
    selfModel: {
      getFullModel: () => ({ identity: 'Genesis', version: '2.5', modules: { a: 1 }, files: { a: 1 }, capabilities: ['chat'] }),
      getModuleSummary: () => [{ file: 'src/agent/Test.js', classes: ['Test'], functions: 3, protected: false }],
      readModule: (f) => f === 'src/agent/Test.js' ? 'const x = 1;' : null,
      moduleCount: () => 5,
      scan: async () => {},
      commitSnapshot: async () => {},
    },
    model: {
      chat: async (prompt) => 'LLM response',
      activeModel: 'gemma2:9b',
    },
    prompts: { build: () => 'prompt' },
    sandbox: {
      testPatch: async (file, code) => ({ success: true }),
      execute: async (code) => ({ success: true, output: '' }),
    },
    reflector: {
      diagnose: async () => ({ issues: [] }),
      repair: async (issues) => issues.map(i => ({ file: i.file, fixed: true, detail: 'ok' })),
    },
    skills: {
      listSkills: () => [{ name: 'test-skill', description: 'test' }],
      createSkill: async (msg) => '✅ Skill "test" erstellt',
      executeSkill: async (name, input) => 'skill result',
    },
    cloner: {
      createClone: async (cfg) => 'Clone created at /tmp/clone',
    },
    reasoning: {
      solve: async (task, ctx) => ({ answer: 'reasoning result' }),
    },
    hotReloader: { reload: async (file) => {} },
    guard: { validateWrite: (p) => true, verifyIntegrity: () => ({ ok: true }) },
    tools: {
      listTools: () => [{ name: 'test' }],
      hasTool: (name) => false,
      register: () => {},
    },
    eventStore: { append: () => {} },
    rootDir: require('path').join(require('os').tmpdir(), 'genesis-test'),
    astDiff: {
      buildDiffPrompt: () => 'diff prompt',
      parseDiffs: () => [],
      apply: (code, diffs) => ({ code, applied: 0, errors: [] }),
      describe: (diffs) => 'changes',
    },
  });
  // FIX v5.1.0 (DI-1): CodeSafety via port lateBinding
  const { MockCodeSafety } = require('../../src/agent/ports/CodeSafetyPort');
  pipeline._codeSafety = new MockCodeSafety();
  return pipeline;
}

console.log('\n  📦 SelfModificationPipeline');

// ── Handler Registration ────────────────────────────────────

test('registerHandlers registers all 9 intent types', () => {
  const pipeline = createMockPipeline();
  const registered = new Map();
  const mockOrchestrator = { registerHandler: (type, fn) => registered.set(type, fn) };
  pipeline.registerHandlers(mockOrchestrator);

  const expected = ['self-inspect', 'self-reflect', 'self-modify', 'self-repair', 'self-repair-reset', 'create-skill', 'clone', 'greeting', 'retry'];
  for (const intent of expected) {
    assert(registered.has(intent), `Missing handler for: ${intent}`);
    assert(typeof registered.get(intent) === 'function', `Handler for ${intent} should be function`);
  }
  assert(registered.size === 9, `Expected 9 handlers, got ${registered.size}`);
});

// ── Patch Extraction ────────────────────────────────────────

test('_extractPatches finds FILE: style patches', () => {
  const pipeline = createMockPipeline();
  const response = `Here's the fix:
// FILE: src/agent/Test.js
\`\`\`javascript
const x = 2;
\`\`\`
Done.`;
  const patches = pipeline._extractPatches(response);
  assert(patches.length === 1, `Expected 1 patch, got ${patches.length}`);
  assert(patches[0].file === 'src/agent/Test.js');
  assert(patches[0].code.includes('const x = 2'));
});

test('_extractPatches finds --- style patches', () => {
  const pipeline = createMockPipeline();
  const response = `Fix:
--- src/agent/Foo.js ---
\`\`\`js
module.exports = {};
\`\`\``;
  const patches = pipeline._extractPatches(response);
  assert(patches.length === 1);
  assert(patches[0].file === 'src/agent/Foo.js');
});

test('_extractPatches returns empty for no patches', () => {
  const pipeline = createMockPipeline();
  const patches = pipeline._extractPatches('Just some text without code blocks in the right format.');
  assert(patches.length === 0);
});

test('_extractPatches handles multiple patches', () => {
  const pipeline = createMockPipeline();
  const response = `// FILE: a.js
\`\`\`js
const a = 1;
\`\`\`
// FILE: b.js
\`\`\`js
const b = 2;
\`\`\``;
  const patches = pipeline._extractPatches(response);
  assert(patches.length === 2, `Expected 2 patches, got ${patches.length}`);
});

// ── Async Pipeline Tests ────────────────────────────────────

async function runAsync() {
  await test('inspect returns formatted module summary', async () => {
    const pipeline = createMockPipeline();
    const result = await pipeline.inspect();
    assert(typeof result === 'string');
    assert(result.includes('Genesis'));
    assert(result.includes('test.js') || result.includes('Test'));
  });

  await test('repair with no issues returns all-intact message', async () => {
    const pipeline = createMockPipeline();
    const result = await pipeline.repair();
    assert(typeof result === 'string');
    // Should contain "intact" or German equivalent
  });

  await test('repair with issues delegates to reflector', async () => {
    const pipeline = createMockPipeline();
    let repairCalled = false;
    pipeline.reflector.diagnose = async () => ({
      issues: [{ type: 'syntax', file: 'test.js', detail: 'missing ;' }],
    });
    pipeline.reflector.repair = async (issues) => {
      repairCalled = true;
      return [{ file: 'test.js', fixed: true, detail: 'Added ;' }];
    };
    const result = await pipeline.repair();
    assert(repairCalled, 'Reflector.repair should be called');
    assert(result.includes('test.js'));
  });

  await test('createSkill delegates to skills manager', async () => {
    const pipeline = createMockPipeline();
    const result = await pipeline.createSkill('erstelle einen timer skill');
    assert(result.includes('✅'), 'Should return success indicator');
  });

  await test('createSkill registers new skill as tool', async () => {
    const pipeline = createMockPipeline();
    let registered = false;
    pipeline.tools.register = () => { registered = true; };
    await pipeline.createSkill('create a skill');
    assert(registered, 'New skill should be registered as tool');
  });

  await test('clone delegates to cloner', async () => {
    const pipeline = createMockPipeline();
    const result = await pipeline.clone('with improvements', []);
    assert(result.includes('Clone'), `Expected clone result, got: ${result}`);
  });

  await test('_greeting returns greeting string', async () => {
    const pipeline = createMockPipeline();
    const result = await pipeline._greeting();
    assert(typeof result === 'string');
  });

  await test('reflect sends self-context to LLM', async () => {
    const pipeline = createMockPipeline();
    let promptReceived = null;
    pipeline.model.chat = async (prompt) => { promptReceived = prompt; return 'reflection'; };
    const result = await pipeline.reflect('Was sind meine Schwächen?');
    assert(promptReceived !== null);
    assert(promptReceived.includes('Genesis'));
    assert(promptReceived.includes('Schwächen') || promptReceived.includes('Was sind'));
    assert(result === 'reflection');
  });

  await test('reflect handles LLM error gracefully', async () => {
    const pipeline = createMockPipeline();
    pipeline.model.chat = async () => { throw new Error('LLM down'); };
    const result = await pipeline.reflect('test');
    assert(result.includes('LLM down') || result.includes('Fehler'));
  });

  await test('modify with no target file falls back to full-file approach', async () => {
    const pipeline = createMockPipeline();
    const result = await pipeline.modify('verbessere die performance');
    assert(typeof result === 'string');
    // Should get reasoning result since no patches are extracted from 'reasoning result'
    assert(result.includes('reasoning result'));
  });
}

runAsync().then(() => {
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failures.length > 0) failures.forEach(f => console.log(`    FAIL: ${f.name} — ${f.error}`));
  process.exit(failed > 0 ? 1 : 0);
});
