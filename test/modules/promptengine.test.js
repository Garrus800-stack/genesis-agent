// ============================================================
// GENESIS — test/modules/promptengine.test.js (v3.8.0)
// Tests for PromptEngine: template registry, rendering, builtins
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const { PromptEngine } = require('../../src/agent/foundation/PromptEngine');

describe('PromptEngine — Constructor', () => {
  test('initializes with builtin templates', () => {
    const engine = new PromptEngine();
    assert(engine.templates !== null, 'templates should exist');
    assert(typeof engine.templates === 'object', 'templates should be an object');
    const keys = Object.keys(engine.templates);
    assert(keys.length > 0, `should have templates, found ${keys.length}`);
  });

  test('has general template', () => {
    const engine = new PromptEngine();
    assert('general' in engine.templates, 'should have general');
    assert(typeof engine.templates['general'] === 'function', 'general should be a function');
  });

  test('has self-inspect template', () => {
    const engine = new PromptEngine();
    assert('self-inspect' in engine.templates, 'should have self-inspect');
  });

  test('has classify-intent template', () => {
    const engine = new PromptEngine();
    assert('classify-intent' in engine.templates, 'should have classify-intent');
  });
});

describe('PromptEngine — Template Rendering', () => {
  test('general template renders with module data', () => {
    const engine = new PromptEngine();
    const result = engine.templates['general']({
      identity: 'genesis',
      version: '3.8.0',
      modules: ['ModuleA', 'ModuleB'],
      capabilities: ['chat', 'code-execution'],
      tools: ['tool1', 'tool2'],
    });
    assert(typeof result === 'string', 'should return string');
    assert(result.includes('genesis') || result.includes('Genesis'), 'should include identity');
    assert(result.length > 50, 'general prompt should be substantial');
  });

  test('self-inspect template renders', () => {
    const engine = new PromptEngine();
    const result = engine.templates['self-inspect']({
      model: { identity: 'genesis', version: '1.0', modules: {}, capabilities: [] },
    });
    assert(typeof result === 'string');
    assert(result.length > 20);
  });

  test('classify-intent renders with message', () => {
    const engine = new PromptEngine();
    const result = engine.templates['classify-intent']({
      message: 'inspect yourself',
      capabilities: ['chat', 'self-awareness'],
    });
    assert(typeof result === 'string');
    assert(result.includes('inspect yourself'), 'should include the message');
  });

  test('modification-plan template renders', () => {
    const engine = new PromptEngine();
    const result = engine.templates['modification-plan']({
      request: 'add logging',
      model: { modules: {}, capabilities: [] },
    });
    assert(typeof result === 'string');
    assert(result.length > 20);
  });

  test('diagnose-error template renders', () => {
    const engine = new PromptEngine();
    const result = engine.templates['diagnose-error']({
      error: 'TypeError: x is not a function',
      context: 'AgentCore.boot()',
    });
    assert(typeof result === 'string');
    assert(result.includes('TypeError') || result.length > 20);
  });
});

describe('PromptEngine — Template Keys', () => {
  test('all templates are functions', () => {
    const engine = new PromptEngine();
    for (const [key, tpl] of Object.entries(engine.templates)) {
      assert(typeof tpl === 'function', `Template "${key}" should be a function, got ${typeof tpl}`);
    }
  });

  test('known template list', () => {
    const engine = new PromptEngine();
    const expected = [
      'general', 'self-inspect', 'self-inspect-report', 'modification-plan',
      'generate-modification', 'diagnose-error', 'repair-code', 'create-skill',
      'clone-plan', 'analyze-code', 'classify-intent',
    ];
    for (const name of expected) {
      assert(name in engine.templates, `Missing template: "${name}"`);
    }
  });

  test('has at least 10 templates', () => {
    const engine = new PromptEngine();
    const count = Object.keys(engine.templates).length;
    assert(count >= 10, `Expected >=10 templates, got ${count}`);
  });
});

describe('PromptEngine — Edge Cases', () => {
  test('general template handles empty data', () => {
    const engine = new PromptEngine();
    const result = engine.templates['general']({
      identity: 'genesis',
      version: '1.0',
      modules: [],
      capabilities: [],
      tools: [],
    });
    assert(typeof result === 'string');
    assert(result.length > 20);
  });

  test('classify-intent handles empty capabilities', () => {
    const engine = new PromptEngine();
    const result = engine.templates['classify-intent']({
      message: 'hello',
      capabilities: [],
    });
    assert(typeof result === 'string');
  });

  test('create-skill template renders', () => {
    const engine = new PromptEngine();
    const result = engine.templates['create-skill']({
      name: 'test-skill',
      description: 'A test skill',
    });
    assert(typeof result === 'string');
    assert(result.length > 20);
  });
});

run();
