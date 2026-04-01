// ============================================================
// TEST — DynamicToolSynthesis.js (SA-P8)
// ============================================================

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { DynamicToolSynthesis } = require('../../src/agent/cognitive/DynamicToolSynthesis');
const { EventBus } = require('../../src/agent/core/EventBus');

// ── Mock LLM ────────────────────────────────────────────────
function mockLLM(response) {
  return {
    chat: async () => JSON.stringify(response),
  };
}

// ── Mock Sandbox ────────────────────────────────────────────
function mockSandbox(execResult = { output: '{"result": "ok"}', error: null }) {
  return {
    syntaxCheck: async () => ({ valid: true }),
    execute: async () => execResult,
  };
}

// ── Mock ToolRegistry ───────────────────────────────────────
function mockToolRegistry() {
  const tools = new Map();
  return {
    register: (name, schema, handler, source) => { tools.set(name, { schema, handler, source }); },
    unregister: (name) => tools.delete(name),
    hasTool: (name) => tools.has(name),
    _tools: tools,
  };
}

// ── Mock Storage ────────────────────────────────────────────
function mockStorage() {
  const data = {};
  return {
    readJSON: (file, fallback) => data[file] || fallback,
    writeJSON: (file, value) => { data[file] = value; },
    _data: data,
  };
}

// Valid LLM response
const VALID_SPEC = {
  name: 'text-reverse',
  description: 'Reverses a text string',
  schema: {
    input: { text: 'string' },
    output: { reversed: 'string' },
  },
  code: 'const result = { reversed: input.text.split("").reverse().join("") };\nresult;',
  testCases: [
    { input: { text: 'hello' }, expectField: 'reversed', expectType: 'string' },
  ],
};

describe('DynamicToolSynthesis', () => {
  let bus;

  beforeEach(() => {
    bus = new EventBus();
  });

  describe('synthesize', () => {
    it('synthesizes a tool from description', async () => {
      const dts = new DynamicToolSynthesis({
        bus,
        storage: mockStorage(),
        config: { autoSynthesize: false },
      });
      dts.llm = mockLLM(VALID_SPEC);
      dts.sandbox = mockSandbox();
      dts.toolRegistry = mockToolRegistry();
      dts.start();

      const result = await dts.synthesize('Reverse a text string');
      assert.ok(result.success, `Expected success, got: ${result.error}`);
      assert.equal(result.name, 'text-reverse');
      assert.ok(dts.toolRegistry._tools.has('text-reverse'));
    });

    it('returns error when LLM unavailable', async () => {
      const dts = new DynamicToolSynthesis({ bus, storage: mockStorage() });
      dts.sandbox = mockSandbox();
      dts.toolRegistry = mockToolRegistry();
      dts.start();

      const result = await dts.synthesize('Do something');
      assert.equal(result.success, false);
      assert.ok(result.error.includes('LLM'));
    });

    it('returns error when sandbox unavailable', async () => {
      const dts = new DynamicToolSynthesis({ bus, storage: mockStorage() });
      dts.llm = mockLLM(VALID_SPEC);
      dts.toolRegistry = mockToolRegistry();
      dts.start();

      const result = await dts.synthesize('Do something');
      assert.equal(result.success, false);
      assert.ok(result.error.includes('Sandbox'));
    });

    it('returns existing tool without re-synthesis', async () => {
      const dts = new DynamicToolSynthesis({ bus, storage: mockStorage(), config: { autoSynthesize: false } });
      dts.llm = mockLLM(VALID_SPEC);
      dts.sandbox = mockSandbox();
      dts.toolRegistry = mockToolRegistry();
      dts.start();

      await dts.synthesize('Reverse text');
      const result = await dts.synthesize('Reverse text again', { name: 'text-reverse' });
      assert.ok(result.success);
      assert.ok(result.note?.includes('Already'));
    });

    it('fails on invalid JSON from LLM', async () => {
      const dts = new DynamicToolSynthesis({ bus, storage: mockStorage(), config: { autoSynthesize: false } });
      dts.llm = { chat: async () => 'not json at all' };
      dts.sandbox = mockSandbox();
      dts.toolRegistry = mockToolRegistry();
      dts.start();

      const result = await dts.synthesize('Something');
      assert.equal(result.success, false);
    });

    it('fails on safety violation', async () => {
      const unsafeSpec = {
        ...VALID_SPEC,
        code: 'const fs = require("fs"); return fs.readFileSync("/etc/passwd");',
      };
      const dts = new DynamicToolSynthesis({ bus, storage: mockStorage(), config: { autoSynthesize: false } });
      dts.llm = mockLLM(unsafeSpec);
      dts.sandbox = mockSandbox();
      dts.toolRegistry = mockToolRegistry();
      dts.start();

      const result = await dts.synthesize('Read a file');
      assert.equal(result.success, false);
      assert.ok(result.error.includes('require'));
    });

    it('fails on syntax error', async () => {
      const dts = new DynamicToolSynthesis({ bus, storage: mockStorage(), config: { autoSynthesize: false } });
      dts.llm = mockLLM(VALID_SPEC);
      dts.sandbox = {
        syntaxCheck: async () => ({ valid: false, error: 'Unexpected token' }),
        execute: async () => ({ output: '', error: null }),
      };
      dts.toolRegistry = mockToolRegistry();
      dts.start();

      const result = await dts.synthesize('Something');
      assert.equal(result.success, false);
      assert.ok(result.error.includes('Syntax'));
    });

    it('fails on test failure', async () => {
      const dts = new DynamicToolSynthesis({ bus, storage: mockStorage(), config: { autoSynthesize: false } });
      dts.llm = mockLLM(VALID_SPEC);
      dts.sandbox = {
        syntaxCheck: async () => ({ valid: true }),
        execute: async () => ({ output: '', error: 'ReferenceError: x is not defined' }),
      };
      dts.toolRegistry = mockToolRegistry();
      dts.start();

      const result = await dts.synthesize('Something');
      assert.equal(result.success, false);
    });
  });

  describe('removeTool', () => {
    it('removes a synthesized tool', async () => {
      const dts = new DynamicToolSynthesis({ bus, storage: mockStorage(), config: { autoSynthesize: false } });
      dts.llm = mockLLM(VALID_SPEC);
      dts.sandbox = mockSandbox();
      dts.toolRegistry = mockToolRegistry();
      dts.start();

      await dts.synthesize('Reverse text');
      assert.ok(dts.removeTool('text-reverse'));
      assert.equal(dts._tools.size, 0);
    });

    it('returns false for unknown tool', () => {
      const dts = new DynamicToolSynthesis({ bus, storage: mockStorage() });
      dts.start();
      assert.equal(dts.removeTool('nope'), false);
    });
  });

  describe('listTools', () => {
    it('lists synthesized tools', async () => {
      const dts = new DynamicToolSynthesis({ bus, storage: mockStorage(), config: { autoSynthesize: false } });
      dts.llm = mockLLM(VALID_SPEC);
      dts.sandbox = mockSandbox();
      dts.toolRegistry = mockToolRegistry();
      dts.start();

      await dts.synthesize('Reverse text');
      const list = dts.listTools();
      assert.equal(list.length, 1);
      assert.equal(list[0].name, 'text-reverse');
    });
  });

  describe('getStats', () => {
    it('tracks synthesis stats', async () => {
      const dts = new DynamicToolSynthesis({ bus, storage: mockStorage(), config: { autoSynthesize: false } });
      dts.llm = mockLLM(VALID_SPEC);
      dts.sandbox = mockSandbox();
      dts.toolRegistry = mockToolRegistry();
      dts.start();

      await dts.synthesize('Reverse text');
      const stats = dts.getStats();
      assert.equal(stats.synthesized, 1);
      assert.equal(stats.active, 1);
    });
  });

  describe('persistence', () => {
    it('saves and reloads tools', async () => {
      const storage = mockStorage();
      const registry = mockToolRegistry();

      // First instance: synthesize
      const dts1 = new DynamicToolSynthesis({ bus, storage, config: { autoSynthesize: false } });
      dts1.llm = mockLLM(VALID_SPEC);
      dts1.sandbox = mockSandbox();
      dts1.toolRegistry = registry;
      dts1.start();
      await dts1.synthesize('Reverse text');
      dts1.stop();

      // Second instance: load from storage
      const dts2 = new DynamicToolSynthesis({ bus: new EventBus(), storage, config: { autoSynthesize: false } });
      dts2.sandbox = mockSandbox();
      dts2.toolRegistry = mockToolRegistry();
      dts2.start();

      assert.equal(dts2._tools.size, 1);
      assert.equal(dts2.getStats().loaded, 1);
    });
  });

  describe('eviction', () => {
    it('evicts LRU when at max capacity', async () => {
      const dts = new DynamicToolSynthesis({ bus, storage: mockStorage(), config: { maxTools: 2, autoSynthesize: false } });
      dts.sandbox = mockSandbox();
      dts.toolRegistry = mockToolRegistry();

      // Manually insert 2 tools
      dts._tools.set('old-tool', { createdAt: 1000, lastUsed: null, code: 'x', schema: {} });
      dts._tools.set('new-tool', { createdAt: 2000, lastUsed: null, code: 'x', schema: {} });

      dts.llm = mockLLM({ ...VALID_SPEC, name: 'third-tool' });
      dts.start();

      await dts.synthesize('A third tool');
      // old-tool should have been evicted
      assert.equal(dts._tools.has('old-tool'), false);
      assert.ok(dts._tools.has('third-tool'));
    });
  });

  describe('safety checks', () => {
    it('blocks process access', async () => {
      const unsafeSpec = { ...VALID_SPEC, code: 'return process.env.SECRET' };
      const dts = new DynamicToolSynthesis({ bus, storage: mockStorage(), config: { autoSynthesize: false } });
      dts.llm = mockLLM(unsafeSpec);
      dts.sandbox = mockSandbox();
      dts.toolRegistry = mockToolRegistry();
      dts.start();

      const result = await dts.synthesize('Get secret');
      assert.equal(result.success, false);
      assert.ok(result.error.includes('process'));
    });

    it('blocks eval', async () => {
      const unsafeSpec = { ...VALID_SPEC, code: 'return eval("1+1")' };
      const dts = new DynamicToolSynthesis({ bus, storage: mockStorage(), config: { autoSynthesize: false } });
      dts.llm = mockLLM(unsafeSpec);
      dts.sandbox = mockSandbox();
      dts.toolRegistry = mockToolRegistry();
      dts.start();

      const result = await dts.synthesize('Eval something');
      assert.equal(result.success, false);
      assert.ok(result.error.includes('eval'));
    });
  });

  describe('containerConfig', () => {
    it('has correct static config', () => {
      assert.equal(DynamicToolSynthesis.containerConfig.name, 'dynamicToolSynthesis');
      assert.equal(DynamicToolSynthesis.containerConfig.phase, 9);
      assert.ok(DynamicToolSynthesis.containerConfig.deps.includes('storage'));
    });
  });

  describe('event emission', () => {
    it('emits tool:synthesized on success', async () => {
      let emitted = false;
      bus.on('tool:synthesized', () => { emitted = true; });

      const dts = new DynamicToolSynthesis({ bus, storage: mockStorage(), config: { autoSynthesize: false } });
      dts.llm = mockLLM(VALID_SPEC);
      dts.sandbox = mockSandbox();
      dts.toolRegistry = mockToolRegistry();
      dts.start();

      await dts.synthesize('Reverse text');
      assert.ok(emitted);
    });

    it('emits tool:synthesis-failed on failure', async () => {
      let emitted = false;
      bus.on('tool:synthesis-failed', () => { emitted = true; });

      const dts = new DynamicToolSynthesis({ bus, storage: mockStorage(), config: { autoSynthesize: false, maxAttempts: 1 } });
      dts.llm = { chat: async () => 'not json' };
      dts.sandbox = mockSandbox();
      dts.toolRegistry = mockToolRegistry();
      dts.start();

      await dts.synthesize('Something');
      assert.ok(emitted);
    });
  });
});
