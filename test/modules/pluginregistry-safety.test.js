// ============================================================
// TEST: PluginRegistry — CodeSafetyScanner Integration (F-03)
// ============================================================

const path = require('path');
const fs = require('fs');
const { describe, test, assert, run, createTestRoot } = require('../harness');

describe('PluginRegistry — Code Safety (v4.0.0)', () => {
  const rootDir = createTestRoot('pluginreg');
  const pluginsDir = path.join(rootDir, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });

  const mockBus = { emit: () => [], fire: () => {}, on: () => () => {} };
  const mockSandbox = {
    testPatch: async () => ({ success: true, error: null, phase: 'complete' }),
  };
  const mockToolRegistry = {
    register: () => {}, hasTool: () => false, listTools: () => [],
  };
  const mockStorage = {
    readJSON: () => null, writeJSON: () => {}, writeJSONDebounced: () => {},
  };

  const { PluginRegistry } = require('../../src/agent/capabilities/PluginRegistry');

  function createRegistry() {
    return new PluginRegistry({
      bus: mockBus, sandbox: mockSandbox,
      toolRegistry: mockToolRegistry, storage: mockStorage,
      pluginsDir,
    });
  }

  test('blocks plugin with eval()', async () => {
    const reg = createRegistry();
    const manifest = { name: 'evil-plugin', version: '1.0.0', type: 'skill', description: 'test', entry: 'index.js' };
    const code = `module.exports = { run: () => eval("1+1") };`;
    const result = await reg.install(manifest, code);
    assert(!result.ok, 'Should block plugin with eval()');
    assert(result.error.includes('safety') || result.error.includes('block'), `Error should mention safety/block: ${result.error}`);
  });

  test('blocks plugin with process.exit()', async () => {
    const reg = createRegistry();
    const manifest = { name: 'exit-plugin', version: '1.0.0', type: 'skill', description: 'test', entry: 'index.js' };
    const code = `module.exports = { run: () => process.exit(0) };`;
    const result = await reg.install(manifest, code);
    assert(!result.ok, 'Should block plugin with process.exit()');
  });

  test('blocks plugin with kernel import', async () => {
    const reg = createRegistry();
    const manifest = { name: 'kernel-plugin', version: '1.0.0', type: 'skill', description: 'test', entry: 'index.js' };
    const code = `const sg = require('../kernel/SafeGuard'); module.exports = {};`;
    const result = await reg.install(manifest, code);
    assert(!result.ok, 'Should block plugin importing kernel');
  });

  test('allows safe plugin code (requires acorn)', async () => {
    let hasAcorn = false;
    try { require('acorn'); hasAcorn = true; } catch { /* acorn not installed */ }
    if (!hasAcorn) {
      // Without acorn, scanner correctly blocks ALL code — this is safe-by-default
      console.log('    ⏭  skipped (acorn not installed — scanner blocks all code, which is correct)');
      return;
    }
    const reg = createRegistry();
    const manifest = { name: 'safe-plugin', version: '1.0.0', type: 'skill', description: 'safe test', entry: 'index.js' };
    const code = `module.exports = { run: (input) => ({ result: String(input).toUpperCase() }) };`;
    const result = await reg.install(manifest, code);
    assert(result.ok, `Should allow safe code, got: ${result.error}`);
  });

  test('skips safety scan for recipe type (declarative)', async () => {
    const reg = createRegistry();
    const manifest = { name: 'recipe-test', version: '1.0.0', type: 'recipe', description: 'test recipe' };
    const code = `{ "steps": [{"tool": "search", "input": "hello"}] }`;
    const result = await reg.install(manifest, code);
    assert(result.ok, `Recipe should skip code safety scan, got: ${result.error}`);
  });
});

run();
