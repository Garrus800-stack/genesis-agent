// ============================================================
// Test: PluginRegistry.js — install, uninstall, execute,
// manifest validation, dependencies, recipes
// ============================================================

const { describe, test, assert, assertEqual, run, createTestRoot } = require('../harness');
const path = require('path');
const fs = require('fs');
const { PluginRegistry } = require('../../src/agent/capabilities/PluginRegistry');

function createRegistry(overrides = {}) {
  const tmpRoot = createTestRoot('plugins');
  const pluginsDir = path.join(tmpRoot, 'plugins');
  const events = [];
  const tools = {
    _tools: new Map(),
    hasTool: (n) => tools._tools.has(n),
    register: (n, s, h, src) => tools._tools.set(n, { schema: s, handler: h }),
    unregister: (n) => tools._tools.delete(n),
    execute: async (n, input) => {
      const t = tools._tools.get(n);
      return t ? t.handler(input) : { error: 'not found' };
    },
  };

  return {
    registry: new PluginRegistry({
      bus: { fire: (e, d) => events.push({ e, d }), emit: (e, d) => events.push({ e, d }) },
      sandbox: overrides.sandbox || {
        testPatch: async () => ({ success: true }),
        execute: async (code) => ({ success: true, output: '{"result":"ok"}' }),
      },
      toolRegistry: tools,
      storage: null,
      pluginsDir,
      codeSafety: overrides.codeSafety || {
        scanCode: () => ({ safe: true, blocked: [], warnings: [], scanMethod: 'mock' }),
        available: true,
      },
      ...overrides,
    }),
    pluginsDir,
    tmpRoot,
    events,
    tools,
  };
}

const VALID_MANIFEST = {
  name: 'test-plugin',
  version: '1.0.0',
  type: 'skill',
  description: 'A test plugin',
  entry: 'index.js',
  interface: { input: { text: 'string' }, output: { result: 'string' } },
};

const VALID_CODE = `
class TestPlugin {
  async execute(input) { return { result: 'processed: ' + input.text }; }
}
module.exports = { TestPlugin };
`;

describe('PluginRegistry: Manifest Validation', () => {

  test('valid manifest passes', () => {
    const { registry } = createRegistry();
    const result = registry._validateManifest(VALID_MANIFEST);
    assert(result.ok, `Should pass: ${result.errors}`);
  });

  test('missing name fails', () => {
    const { registry } = createRegistry();
    const result = registry._validateManifest({ ...VALID_MANIFEST, name: '' });
    assert(!result.ok);
    assert(result.errors.some(e => e.includes('name')));
  });

  test('invalid type fails', () => {
    const { registry } = createRegistry();
    const result = registry._validateManifest({ ...VALID_MANIFEST, type: 'widget' });
    assert(!result.ok);
  });

  test('uppercase name fails', () => {
    const { registry } = createRegistry();
    const result = registry._validateManifest({ ...VALID_MANIFEST, name: 'MyPlugin' });
    assert(!result.ok);
  });

  test('unknown permission fails', () => {
    const { registry } = createRegistry();
    const result = registry._validateManifest({ ...VALID_MANIFEST, permissions: ['root-access'] });
    assert(!result.ok);
  });

  test('valid permissions pass', () => {
    const { registry } = createRegistry();
    const result = registry._validateManifest({ ...VALID_MANIFEST, permissions: ['sandbox', 'filesystem'] });
    assert(result.ok);
  });
});

describe('PluginRegistry: Install', () => {

  test('install creates directory and files', async () => {
    const { registry, pluginsDir } = createRegistry();
    const result = await registry.install(VALID_MANIFEST, VALID_CODE);
    assert(result.ok, `Install should succeed: ${result.error}`);

    const dir = path.join(pluginsDir, 'test-plugin');
    assert(fs.existsSync(dir), 'Plugin dir should exist');
    assert(fs.existsSync(path.join(dir, 'plugin-manifest.json')), 'Manifest should exist');
    assert(fs.existsSync(path.join(dir, 'index.js')), 'Code should exist');
  });

  test('install registers as tool', async () => {
    const { registry, tools } = createRegistry();
    await registry.install(VALID_MANIFEST, VALID_CODE);
    assert(tools.hasTool('plugin:test-plugin'), 'Should register as tool');
  });

  test('install emits plugin:installed event', async () => {
    const { registry, events } = createRegistry();
    await registry.install(VALID_MANIFEST, VALID_CODE);
    assert(events.some(e => e.e === 'plugin:installed'), 'Should emit install event');
  });

  test('install rejects invalid manifest', async () => {
    const { registry } = createRegistry();
    const result = await registry.install({ name: '', type: 'bad' }, 'code');
    assert(!result.ok);
    assert(result.error.includes('Invalid manifest'));
  });

  test('install rejects when sandbox test fails', async () => {
    const { registry } = createRegistry({
      sandbox: { testPatch: async () => ({ success: false, error: 'SyntaxError' }) },
    });
    const result = await registry.install(VALID_MANIFEST, 'broken(');
    assert(!result.ok);
    assert(result.error.includes('Sandbox'));
  });

  test('install checks dependencies', async () => {
    const { registry } = createRegistry();
    const manifest = { ...VALID_MANIFEST, name: 'dependent', dependencies: ['missing-dep'] };
    const result = await registry.install(manifest, VALID_CODE);
    assert(!result.ok);
    assert(result.error.includes('missing-dep'));
  });
});

describe('PluginRegistry: List & Query', () => {

  test('list returns installed plugins', async () => {
    const { registry } = createRegistry();
    await registry.install(VALID_MANIFEST, VALID_CODE);
    const list = registry.list();
    assertEqual(list.length, 1);
    assertEqual(list[0].name, 'test-plugin');
  });

  test('has returns true for installed', async () => {
    const { registry } = createRegistry();
    await registry.install(VALID_MANIFEST, VALID_CODE);
    assert(registry.has('test-plugin'));
    assert(!registry.has('nonexistent'));
  });

  test('getStats returns per-plugin stats', async () => {
    const { registry } = createRegistry();
    await registry.install(VALID_MANIFEST, VALID_CODE);
    const stats = registry.getStats();
    assert(stats['test-plugin']);
    assertEqual(stats['test-plugin'].calls, 0);
  });
});

describe('PluginRegistry: Uninstall', () => {

  test('uninstall removes plugin', async () => {
    const { registry, pluginsDir } = createRegistry();
    await registry.install(VALID_MANIFEST, VALID_CODE);
    const removed = registry.uninstall('test-plugin');
    assert(removed);
    assert(!registry.has('test-plugin'));
    assert(!fs.existsSync(path.join(pluginsDir, 'test-plugin')));
  });

  test('uninstall removes tool registration', async () => {
    const { registry, tools } = createRegistry();
    await registry.install(VALID_MANIFEST, VALID_CODE);
    registry.uninstall('test-plugin');
    assert(!tools.hasTool('plugin:test-plugin'));
  });

  test('uninstall returns false for unknown plugin', () => {
    const { registry } = createRegistry();
    assertEqual(registry.uninstall('ghost'), false);
  });

  test('uninstall blocks if other plugins depend on it', async () => {
    const { registry } = createRegistry();
    await registry.install(VALID_MANIFEST, VALID_CODE);
    await registry.install({ ...VALID_MANIFEST, name: 'child', dependencies: ['test-plugin'] }, VALID_CODE);
    const removed = registry.uninstall('test-plugin');
    assert(!removed, 'Should not uninstall when dependents exist');
    assert(registry.has('test-plugin'), 'Plugin should still exist');
  });
});

describe('PluginRegistry: Execute', () => {

  test('execute calls sandbox for skill plugins', async () => {
    const { registry } = createRegistry();
    await registry.install(VALID_MANIFEST, VALID_CODE);
    const result = await registry.execute('test-plugin', { text: 'hello' });
    assert(result, 'Should return result');
  });

  test('execute increments call stats', async () => {
    const { registry } = createRegistry();
    await registry.install(VALID_MANIFEST, VALID_CODE);
    await registry.execute('test-plugin', {});
    await registry.execute('test-plugin', {});
    assertEqual(registry.getStats()['test-plugin'].calls, 2);
  });

  test('execute throws for unknown plugin', async () => {
    const { registry } = createRegistry();
    let threw = false;
    try { await registry.execute('nope', {}); } catch { threw = true; }
    assert(threw);
  });

  test('execute tracks errors', async () => {
    const { registry } = createRegistry({
      sandbox: {
        testPatch: async () => ({ success: true }),
        execute: async () => { throw new Error('runtime boom'); },
      },
    });
    await registry.install(VALID_MANIFEST, VALID_CODE);
    try { await registry.execute('test-plugin', {}); } catch { /* expected */ }
    assertEqual(registry.getStats()['test-plugin'].errors, 1);
  });
});

describe('PluginRegistry: asyncLoad', () => {

  test('asyncLoad loads plugins from disk', async () => {
    const { registry, pluginsDir } = createRegistry();
    // Pre-populate disk
    const dir = path.join(pluginsDir, 'preinstalled');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugin-manifest.json'), JSON.stringify({
      name: 'preinstalled', version: '1.0.0', type: 'skill',
      description: 'Pre-installed', entry: 'index.js',
    }));
    fs.writeFileSync(path.join(dir, 'index.js'), VALID_CODE);

    await registry.asyncLoad();
    assert(registry.has('preinstalled'));
  });
});

run();
