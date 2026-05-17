// ============================================================
// GENESIS — test/modules/v790-skill-forge.contract.test.js
// Contract tests for v7.9.0 final — iteration-loop robustness
// and skill awareness.
//   • SkillManager.createSkill iteration loop (max 3 attempts)
//   • PromptEngine create-skill retry template (lastError/lastCode)
//   • SkillManager.executeSkill format-tolerant invocation
//   • CommandHandlersCode.runSkill JSON-arg parsing
//   • PromptBuilderSectionsExtra._skillsContext output
// All test names carry `koennen-forge-v790 contract:` prefix.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');
const { SkillManager } = require(path.join(ROOT, 'src/agent/capabilities/SkillManager'));
const { PromptEngine } = require(path.join(ROOT, 'src/agent/foundation/PromptEngine'));
const { commandHandlersCode } = require(path.join(ROOT, 'src/agent/hexagonal/CommandHandlersCode'));
const { sectionsExtra } = require(path.join(ROOT, 'src/agent/intelligence/PromptBuilderSectionsExtra'));

// ── Shared helpers ──────────────────────────────────────

function makeBusStub() {
  const fired = [];
  return {
    fired,
    fire(evt, payload) { fired.push({ evt, payload }); },
    subscribe() {},
  };
}

function makeCodeSafetyStub({ block = false } = {}) {
  return {
    scanCode() {
      return block
        ? { safe: false, blocked: [{ description: 'blocked-pattern' }] }
        : { safe: true, blocked: [] };
    },
  };
}

function makeSandboxStub({ failFirst = 0, failReason = 'syntax error' } = {}) {
  let calls = 0;
  return {
    testPatch() {
      calls += 1;
      if (calls <= failFirst) {
        return Promise.resolve({ success: false, phase: 'load', error: failReason });
      }
      return Promise.resolve({ success: true });
    },
    execute() { return Promise.resolve({ output: '{}' }); },
    rootDir: ROOT,
    get _calls() { return calls; },
  };
}

function makeModelStub(responses) {
  let i = 0;
  const chatCalls = [];
  return {
    chatCalls,
    async chat(prompt /* , history, taskType, opts */) {
      chatCalls.push(prompt);
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return r;
    },
  };
}

function makePromptsStub() {
  const engine = new PromptEngine();
  const builds = [];
  return {
    builds,
    build(name, slots) {
      builds.push({ name, slots });
      return engine.build(name, slots);
    },
  };
}

function makeSkillManager({ model, sandbox, codeSafety, prompts, bus, skillsDir }) {
  const tmpDir = skillsDir || fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-'));
  // Positional constructor: (skillsDir, sandbox, model, prompts, guard)
  const mgr = new SkillManager(tmpDir, sandbox, model, prompts, null);
  mgr._codeSafety = codeSafety;
  mgr.bus = bus;
  return { mgr, tmpDir };
}

const validResponse = (name = 'good-skill') => `Here is the skill:

\`\`\`json
{
  "name": "${name}",
  "version": "1.0.0",
  "description": "A working skill",
  "entry": "index.js"
}
\`\`\`

\`\`\`javascript
class GoodSkill {
  async execute(input) { return { ok: true }; }
}
module.exports = { GoodSkill };
\`\`\``;

const brokenResponse = `\`\`\`json
{"name": "broken-skill", "version": "1.0.0", "description": "broken"}
\`\`\`

\`\`\`javascript
class BrokenSkill {
  async execute(input) { return broken syntax here; }
}
module.exports = { BrokenSkill };
\`\`\``;

// ── Tests ──────────────────────────────────────────────

describe('koennen-forge-v790 contract: SkillManager.createSkill iteration loop', () => {

  test('koennen-forge-v790 contract: succeeds in one attempt when LLM returns valid skill', async () => {
    const bus = makeBusStub();
    const { mgr } = makeSkillManager({
      model: makeModelStub([validResponse('first-try')]),
      sandbox: makeSandboxStub(),
      codeSafety: makeCodeSafetyStub(),
      prompts: makePromptsStub(),
      bus,
    });
    const result = await mgr.createSkill('A skill that does X');
    assert(result.includes('✅') && result.includes('first-try'), 'expected success message');
    const succeeded = bus.fired.filter(f => f.evt === 'skill:forge-succeeded');
    assertEqual(succeeded.length, 1, 'one skill:forge-succeeded event');
    assertEqual(succeeded[0].payload.attempts, 1, 'attempts=1');
  });

  test('koennen-forge-v790 contract: retries on sandbox failure with error feedback', async () => {
    const bus = makeBusStub();
    const sandbox = makeSandboxStub({ failFirst: 1, failReason: 'ReferenceError: foo' });
    const prompts = makePromptsStub();
    const { mgr } = makeSkillManager({
      model: makeModelStub([brokenResponse, validResponse('second-try')]),
      sandbox,
      codeSafety: makeCodeSafetyStub(),
      prompts,
      bus,
    });
    const result = await mgr.createSkill('A skill that fixes itself');
    assert(result.includes('✅'), 'expected success after retry');
    assertEqual(sandbox._calls, 2, 'sandbox called twice');
    // Second prompt-build should have included lastError + lastCode
    const secondBuild = prompts.builds[1];
    assert(secondBuild, 'second prompt build exists');
    assertEqual(secondBuild.slots.attempt, 2, 'attempt slot = 2');
    assert(typeof secondBuild.slots.lastError === 'string', 'lastError carried over');
    assert(secondBuild.slots.lastError.includes('ReferenceError') || secondBuild.slots.lastError.includes('sandbox'), 'lastError mentions sandbox failure');
  });

  test('koennen-forge-v790 contract: aborts cleanly after maxAttempts with last error', async () => {
    const bus = makeBusStub();
    const { mgr } = makeSkillManager({
      model: makeModelStub([brokenResponse, brokenResponse, brokenResponse]),
      sandbox: makeSandboxStub({ failFirst: 99, failReason: 'persistent failure' }),
      codeSafety: makeCodeSafetyStub(),
      prompts: makePromptsStub(),
      bus,
    });
    const result = await mgr.createSkill('Persistent failure');
    assert(result.includes('❌') && result.includes('3 attempts'), 'expected abort message with attempts');
    assert(result.includes('persistent failure') || result.includes('sandbox'), 'expected last error in message');
    assert(result.includes('configured model was not switched'), 'expected explicit no-switch note');
    const failed = bus.fired.filter(f => f.evt === 'skill:forge-failed');
    assertEqual(failed.length, 1, 'one skill:forge-failed event');
    assertEqual(failed[0].payload.attempts, 3, 'attempts=3');
  });

  test('koennen-forge-v790 contract: configured model is never auto-switched during iteration', async () => {
    const model = makeModelStub([brokenResponse, brokenResponse, validResponse('still-same-model')]);
    const sandbox = makeSandboxStub({ failFirst: 2 });
    const { mgr } = makeSkillManager({
      model,
      sandbox,
      codeSafety: makeCodeSafetyStub(),
      prompts: makePromptsStub(),
      bus: makeBusStub(),
    });
    await mgr.createSkill('Test no model switch');
    // All three chat calls should go to the SAME model stub (no router involved)
    assertEqual(model.chatCalls.length, 3, 'exactly three chat calls');
    // We never mutate model.activeModel from within createSkill — verify nothing on model changed
    assert(!model.activeModel, 'no activeModel mutation observed');
  });

  test('koennen-forge-v790 contract: emits forge-attempt event for every iteration', async () => {
    const bus = makeBusStub();
    const { mgr } = makeSkillManager({
      model: makeModelStub([brokenResponse, validResponse('two-attempts')]),
      sandbox: makeSandboxStub({ failFirst: 1 }),
      codeSafety: makeCodeSafetyStub(),
      prompts: makePromptsStub(),
      bus,
    });
    await mgr.createSkill('attempt event check');
    const attempts = bus.fired.filter(f => f.evt === 'skill:forge-attempt');
    assertEqual(attempts.length, 2, 'two forge-attempt events');
    assertEqual(attempts[0].payload.attempt, 1, 'first attempt=1');
    assertEqual(attempts[1].payload.attempt, 2, 'second attempt=2');
    assertEqual(attempts[0].payload.source, 'create-skill', 'source=create-skill');
  });

  test('koennen-forge-v790 contract: feeds back code safety violation as lastError', async () => {
    const bus = makeBusStub();
    const prompts = makePromptsStub();
    const { mgr } = makeSkillManager({
      model: makeModelStub([validResponse('unsafe'), validResponse('unsafe')]),
      sandbox: makeSandboxStub(),
      codeSafety: { scanCode: () => ({ safe: false, blocked: [{ description: 'eval is blocked' }] }) },
      prompts,
      bus,
    });
    await mgr.createSkill('triggers safety');
    const secondBuild = prompts.builds[1];
    assert(secondBuild?.slots?.lastError?.includes('safety'), 'lastError mentions safety block');
    assert(secondBuild?.slots?.lastError?.includes('eval is blocked'), 'lastError carries scanner detail');
  });

});

describe('koennen-forge-v790 contract: PromptEngine create-skill template', () => {

  const engine = new PromptEngine();

  test('koennen-forge-v790 contract: initial attempt template includes format skeleton', () => {
    const p = engine.build('create-skill', { description: 'test skill', attempt: 1 });
    assert(p.includes('class SkillName'), 'has class skeleton');
    assert(p.includes('module.exports'), 'has module.exports');
    assert(!p.includes('PREVIOUS ERROR'), 'no retry section on first attempt');
  });

  test('koennen-forge-v790 contract: retry template includes lastError and lastCode', () => {
    const p = engine.build('create-skill', {
      description: 'test',
      attempt: 2,
      lastError: 'sandbox test failed: foo is not defined',
      lastCode: 'class Foo { execute() { return foo; } }',
    });
    assert(p.includes('PREVIOUS ERROR'), 'has previous error section');
    assert(p.includes('foo is not defined'), 'includes lastError text');
    assert(p.includes('PREVIOUS CODE'), 'has previous code section');
    assert(p.includes('class Foo'), 'includes lastCode text');
    assert(p.includes('Fix the specific error') || p.includes('do not rewrite'), 'instructs to fix not rewrite');
  });

  test('koennen-forge-v790 contract: template mentions all accepted export forms', () => {
    const p = engine.build('create-skill', { description: 'multi-form' });
    assert(p.includes('module.exports = async function') || p.includes('module.exports = {'),
      'mentions alternative export forms');
  });

});

describe('koennen-forge-v790 contract: format-tolerant executeSkill', () => {

  function buildTestSkill(skillDir, name, code) {
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'skill-manifest.json'), JSON.stringify({
      name, version: '1.0.0', description: 'test', entry: 'index.js',
    }));
    fs.writeFileSync(path.join(skillDir, 'index.js'), code);
  }

  function makeRealSandbox() {
    const { Sandbox } = require(path.join(ROOT, 'src/agent/foundation/Sandbox'));
    return new Sandbox(ROOT);
  }

  test('koennen-forge-v790 contract: executeSkill accepts class with execute method', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmt-class-'));
    buildTestSkill(path.join(dir, 'cls'), 'cls', `
      class Cls { async execute(input) { return { form: 'class', input }; } }
      module.exports = { Cls };
    `);
    const mgr = new SkillManager(dir, makeRealSandbox(), null, new PromptEngine(), null);
    await mgr.loadSkills();
    const result = await mgr.executeSkill('cls', { v: 1 });
    const out = JSON.parse(result.output);
    assertEqual(out.form, 'class');
    assertEqual(out.input.v, 1);
  });

  test('koennen-forge-v790 contract: executeSkill accepts module.exports = function', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmt-fn-'));
    buildTestSkill(path.join(dir, 'fn'), 'fn', `
      module.exports = async function(input) { return { form: 'function', input }; };
    `);
    const mgr = new SkillManager(dir, makeRealSandbox(), null, new PromptEngine(), null);
    await mgr.loadSkills();
    const result = await mgr.executeSkill('fn', { v: 2 });
    const out = JSON.parse(result.output);
    assertEqual(out.form, 'function');
    assertEqual(out.input.v, 2);
  });

  test('koennen-forge-v790 contract: executeSkill accepts module.exports = arrow', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmt-arrow-'));
    buildTestSkill(path.join(dir, 'arrow'), 'arrow', `
      module.exports = async (input) => ({ form: 'arrow', input });
    `);
    const mgr = new SkillManager(dir, makeRealSandbox(), null, new PromptEngine(), null);
    await mgr.loadSkills();
    const result = await mgr.executeSkill('arrow', { v: 3 });
    const out = JSON.parse(result.output);
    assertEqual(out.form, 'arrow');
    assertEqual(out.input.v, 3);
  });

  test('koennen-forge-v790 contract: executeSkill accepts object with execute method', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmt-obj-'));
    buildTestSkill(path.join(dir, 'obj'), 'obj', `
      module.exports = { execute: async (input) => ({ form: 'object', input }) };
    `);
    const mgr = new SkillManager(dir, makeRealSandbox(), null, new PromptEngine(), null);
    await mgr.loadSkills();
    const result = await mgr.executeSkill('obj', { v: 4 });
    const out = JSON.parse(result.output);
    assertEqual(out.form, 'object');
    assertEqual(out.input.v, 4);
  });

});

describe('koennen-forge-v790 contract: /run-skill JSON argument parsing', () => {

  function makeHandler({ skills = [] } = {}) {
    return {
      ...commandHandlersCode,
      skillManager: {
        listSkills: () => skills,
        async executeSkill(name, input) {
          if (!skills.find(s => s.name === name)) {
            throw new Error(`Skill not found: ${name}`);
          }
          return { output: JSON.stringify({ name, input }) };
        },
      },
      shell: null,
      lang: { t: (k) => k },
    };
  }

  test('koennen-forge-v790 contract: /run-skill <name> (no arg) sends empty object', async () => {
    const h = makeHandler({ skills: [{ name: 'foo', description: 'd' }] });
    const result = await h.runSkill('/run-skill foo');
    assert(result.includes('✅'), 'expected success');
    // runSkill double-encodes through JSON.stringify(output, null, 2), so
    // an empty {} inside the inner JSON-stringified payload appears as
    // \"input\":{} in the escaped form. Match both raw and escaped.
    assert(result.includes('"input":{}') || result.includes('\\"input\\":{}') || result.includes('"input": {}'),
      'expected empty input object somewhere in the formatted result');
  });

  test('koennen-forge-v790 contract: /run-skill <name> {json} parses and passes the object', async () => {
    const h = makeHandler({ skills: [{ name: 'slugify', description: 'd' }] });
    const result = await h.runSkill('/run-skill slugify {"text":"Hello World"}');
    assert(result.includes('✅'), 'expected success');
    assert(result.includes('Hello World'), 'expected text passed through');
  });

  test('koennen-forge-v790 contract: /run-skill <name> {invalid json} returns clear error', async () => {
    const h = makeHandler({ skills: [{ name: 'foo', description: 'd' }] });
    const result = await h.runSkill('/run-skill foo {not-valid-json}');
    assert(result.includes('JSON argument could not be parsed') || result.includes('JSON'),
      'expected JSON parse error message');
    assert(result.includes('Usage:'), 'expected usage hint');
  });

  test('koennen-forge-v790 contract: /run-skill <name> [array] rejected (must be object)', async () => {
    const h = makeHandler({ skills: [{ name: 'foo', description: 'd' }] });
    const result = await h.runSkill('/run-skill foo [1,2,3]');
    assert(result.includes('must be a JSON object'), 'expected object-only error');
  });

});

describe('koennen-forge-v790 contract: PromptBuilder _skillsContext', () => {

  test('koennen-forge-v790 contract: returns empty when no SkillManager wired', () => {
    const ctx = { skills: null };
    const result = sectionsExtra._skillsContext.call(ctx);
    assertEqual(result, '', 'empty when skills not wired');
  });

  test('koennen-forge-v790 contract: returns empty when no skills installed', () => {
    const ctx = { skills: { listSkills: () => [] } };
    const result = sectionsExtra._skillsContext.call(ctx);
    assertEqual(result, '', 'empty when zero skills');
  });

  test('koennen-forge-v790 contract: lists installed skills with name and description', () => {
    const ctx = {
      skills: {
        listSkills: () => [
          { name: 'slugify', description: 'Convert text to URL-safe slug' },
          { name: 'uuid-gen', description: 'Generate UUID v4' },
        ],
      },
    };
    const result = sectionsExtra._skillsContext.call(ctx);
    assert(result.includes('Installed Skills'), 'has header');
    assert(result.includes('slugify'), 'lists slugify');
    assert(result.includes('Convert text'), 'lists description');
    assert(result.includes('uuid-gen'), 'lists uuid-gen');
    assert(result.includes('/run-skill'), 'mentions /run-skill usage');
  });

  test('koennen-forge-v790 contract: caps output at 30 skills', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ name: `s${i}`, description: `d${i}` }));
    const ctx = { skills: { listSkills: () => many } };
    const result = sectionsExtra._skillsContext.call(ctx);
    const lines = result.split('\n').filter(l => l.includes('•'));
    assert(lines.length <= 30, `expected ≤30 skill lines, got ${lines.length}`);
  });

  test('koennen-forge-v790 contract: installed skills appear in final PromptBuilder.build() output', () => {
    // End-to-end: prove that an installed skill actually reaches the
    // assembled system prompt that Genesis sees during chat. This is
    // the test that catches a real wiring break — section method exists
    // but never gets called, or section gets dropped by priority/budget.
    const { PromptBuilder } = require(path.join(ROOT, 'src/agent/intelligence/PromptBuilder'));
    const pb = new PromptBuilder({
      selfModel: {
        getFullModel: () => ({ identity: 'Genesis', version: '7.9.0', capabilities: [] }),
        getModuleSummary: () => [],
        getCapabilities: () => [],
        moduleCount: () => 5,
      },
      model: { activeModel: 'qwen3-coder:480b-cloud' },
      skills: {
        listSkills: () => [
          { name: 'random-hex-color', description: 'Generate a random hex color' },
          { name: 'uuid-v4', description: 'Generate a UUID v4' },
        ],
      },
      knowledgeGraph: { search: () => [], getStats: () => ({ nodeCount: 0 }) },
      memory: {
        recallEpisodes: () => [],
        searchFacts: () => [],
        getStats: () => ({ episodes: 0, facts: 0 }),
        getUserName: () => null,
      },
    });

    const prompt = pb.build();
    assert(typeof prompt === 'string' && prompt.length > 0, 'prompt non-empty');
    assert(prompt.includes('Installed Skills'), 'final prompt contains Installed Skills header');
    assert(prompt.includes('random-hex-color'), 'final prompt mentions random-hex-color');
    assert(prompt.includes('uuid-v4'), 'final prompt mentions uuid-v4');
    assert(prompt.includes('/run-skill'), 'final prompt mentions /run-skill usage hint');
  });

});

run();
