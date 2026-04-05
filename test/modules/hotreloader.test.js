// ============================================================
// GENESIS — test/modules/hotreloader.test.js (v3.8.0)
// Tests for HotReloader: watch/unwatch, guard, reload, rollback
// ============================================================

const { describe, test, assert, assertEqual, run, createTestRoot } = require('../harness');
const path = require('path');
const fs = require('fs');
const { NullBus } = require('../../src/agent/core/EventBus');

// Minimal guard mock
function mockGuard(protectedPaths = []) {
  const resolved = protectedPaths.map(p => path.resolve(p));
  return {
    isProtected(filePath) {
      const r = path.resolve(filePath);
      return resolved.some(p => r === p || r.startsWith(p + path.sep));
    },
  };
}

// Spy bus that records emitted events
function spyBus() {
  const events = [];
  return {
    ...NullBus,
    emit(event, data, meta) { events.push({ event, data, meta }); return []; },
    fire(event, data, meta) { events.push({ event, data, meta }); },
    on(event, handler, opts) { return () => {}; },
    events,
  };
}

describe('HotReloader — Constructor & State', () => {
  test('initializes with empty maps', () => {
    const { HotReloader } = require('../../src/agent/capabilities/HotReloader');
    const hr = new HotReloader('/tmp/test', mockGuard());
    assertEqual(hr.moduleCache.size, 0);
    assertEqual(hr.watchers.size, 0);
    assertEqual(hr.reloadCallbacks.size, 0);
  });

  test('uses NullBus when no bus provided', () => {
    const { HotReloader } = require('../../src/agent/capabilities/HotReloader');
    const hr = new HotReloader('/tmp/test', mockGuard());
    assert(hr.bus !== null, 'bus should fallback to NullBus');
  });
});

describe('HotReloader — Guard Protection', () => {
  test('skips watching protected kernel files', () => {
    const { HotReloader } = require('../../src/agent/capabilities/HotReloader');
    const root = createTestRoot('hotreloader-guard');
    const kernelPath = path.join(root, 'kernel');
    fs.mkdirSync(kernelPath, { recursive: true });
    fs.writeFileSync(path.join(kernelPath, 'main.js'), 'module.exports = {}');

    const guard = mockGuard([kernelPath]);
    const hr = new HotReloader(root, guard);
    hr.watch('kernel/main.js', () => {});

    // Should NOT be registered
    assertEqual(hr.watchers.size, 0);
    assertEqual(hr.reloadCallbacks.size, 0);
  });

  test('allows watching non-protected files', () => {
    const { HotReloader } = require('../../src/agent/capabilities/HotReloader');
    const root = createTestRoot('hotreloader-allow');
    const agentDir = path.join(root, 'agent');
    fs.mkdirSync(agentDir, { recursive: true });
    const filePath = path.join(agentDir, 'test-mod.js');
    fs.writeFileSync(filePath, 'module.exports = { x: 1 };');

    const guard = mockGuard([path.join(root, 'kernel')]);
    const hr = new HotReloader(root, guard);
    hr.watch('agent/test-mod.js', () => {});

    assert(hr.reloadCallbacks.has('agent/test-mod.js'), 'callback should be registered');
    // Clean up watcher
    hr.unwatchAll();
  });
});

describe('HotReloader — Unwatch', () => {
  test('unwatch removes callback and cache', () => {
    const { HotReloader } = require('../../src/agent/capabilities/HotReloader');
    const root = createTestRoot('hotreloader-unwatch');
    const filePath = path.join(root, 'mod.js');
    fs.writeFileSync(filePath, 'module.exports = { v: 1 };');

    const guard = mockGuard([]);
    const hr = new HotReloader(root, guard);
    hr.watch('mod.js', () => {});
    assert(hr.reloadCallbacks.has('mod.js'));

    hr.unwatch('mod.js');
    assertEqual(hr.reloadCallbacks.has('mod.js'), false);
    assertEqual(hr.watchers.has('mod.js'), false);
    assertEqual(hr.moduleCache.has('mod.js'), false);
  });

  test('unwatchAll clears everything', () => {
    const { HotReloader } = require('../../src/agent/capabilities/HotReloader');
    const root = createTestRoot('hotreloader-unwatchall');
    fs.writeFileSync(path.join(root, 'a.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(root, 'b.js'), 'module.exports = {};');

    const guard = mockGuard([]);
    const hr = new HotReloader(root, guard);
    hr.watch('a.js', () => {});
    hr.watch('b.js', () => {});

    hr.unwatchAll();
    assertEqual(hr.watchers.size, 0);
    assertEqual(hr.reloadCallbacks.size, 0);
  });
});

describe('HotReloader — Reload', () => {
  test('reload detects file not found', async () => {
    const { HotReloader } = require('../../src/agent/capabilities/HotReloader');
    const root = createTestRoot('hotreloader-notfound');
    const hr = new HotReloader(root, mockGuard());
    const result = await hr.reload('nonexistent.js');
    assertEqual(result.success, false);
    assert(result.error.includes('not found') || result.error.includes('no such'), result.error);
  });

  test('reload detects syntax errors', async () => {
    const { HotReloader } = require('../../src/agent/capabilities/HotReloader');
    const root = createTestRoot('hotreloader-syntax');
    const filePath = path.join(root, 'bad.js');
    fs.writeFileSync(filePath, 'module.exports = {;'); // syntax error

    const bus = spyBus();
    const hr = new HotReloader(root, mockGuard(), bus);
    const result = await hr.reload('bad.js');

    assertEqual(result.success, false);
    assert(result.error.includes('Syntax'), result.error);
    assert(bus.events.some(e => e.event === 'hot-reload:syntax-error'), 'should emit syntax-error event');
  });

  test('reload succeeds for valid module', async () => {
    const { HotReloader } = require('../../src/agent/capabilities/HotReloader');
    const root = createTestRoot('hotreloader-reload');
    const filePath = path.join(root, 'good.js');
    fs.writeFileSync(filePath, 'module.exports = { version: 1 };');

    const bus = spyBus();
    const hr = new HotReloader(root, mockGuard(), bus);

    // Pre-cache so _handleChange detects a difference
    hr.moduleCache.set('good.js', { hash: 'oldhash', loadedAt: '' });

    const result = await hr.reload('good.js');
    assertEqual(result.success, true);
    assertEqual(result.changed, true);

    // Clean up require cache
    delete require.cache[require.resolve(filePath)];
  });

  test('reload reports unchanged when hash matches', async () => {
    const { HotReloader } = require('../../src/agent/capabilities/HotReloader');
    const root = createTestRoot('hotreloader-unchanged');
    const filePath = path.join(root, 'same.js');
    fs.writeFileSync(filePath, 'module.exports = { x: 1 };');

    const hr = new HotReloader(root, mockGuard());
    // Pre-cache with the correct hash
    const crypto = require('crypto');
    const content = fs.readFileSync(filePath, 'utf-8');
    const hash = crypto.createHash('md5').update(content).digest('hex').slice(0, 10);
    hr.moduleCache.set('same.js', { hash, loadedAt: '' });

    const result = await hr.reload('same.js');
    assertEqual(result.success, true);
    assertEqual(result.changed, false);
  });
});

describe('HotReloader — getStatus', () => {
  test('returns status for cached modules', () => {
    const { HotReloader } = require('../../src/agent/capabilities/HotReloader');
    const root = createTestRoot('hotreloader-status');
    const hr = new HotReloader(root, mockGuard());

    hr.moduleCache.set('test.js', { hash: 'abc123', loadedAt: '2025-01-01', module: {} });
    const status = hr.getStatus();

    assert('test.js' in status);
    assertEqual(status['test.js'].hash, 'abc123');
    assertEqual(status['test.js'].watching, false);
  });
});

run();
