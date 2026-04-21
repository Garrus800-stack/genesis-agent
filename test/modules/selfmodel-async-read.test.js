// ============================================================
// Test: v7.3.1 A4-F1 — SelfModel Async Read + describeModule + Cache
// ============================================================

'use strict';

const path = require('path');
const { describe, test, assert, assertEqual, run } = require('../harness');
const { SelfModel } = require('../../src/agent/foundation/SelfModel');
const { SafeGuard } = require('../../src/kernel/SafeGuard');

const ROOT = path.resolve(__dirname, '..', '..');

// v7.3.6 patch: scan() is expensive (~6-7s in CI, full filesystem walk + git)
// and was called 15× from the test suite, approaching the 90s test timeout
// under parallel load. Cache one scanned instance and reset its mutable
// state between tests. Each test still runs against a "fresh" semantic
// view — the underlying manifest is shared (read-only to the tests),
// only _readCache and _readSourceState are reset.
let _sharedScanned = null;
async function buildScanned() {
  if (!_sharedScanned) {
    const guard = new SafeGuard([path.join(ROOT, 'src', 'kernel')], ROOT);
    _sharedScanned = new SelfModel(ROOT, guard);
    await _sharedScanned.scan();
  }
  // Reset mutable state between tests so each gets a clean cache
  _sharedScanned._readCache.clear();
  _sharedScanned._readCacheMax = 50;
  _sharedScanned._hotReloadUnsub = null;
  _sharedScanned.resetReadSourceSession();
  return _sharedScanned;
}

describe('v7.3.1 — readModuleAsync', () => {
  test('reads an existing module by path (cache miss)', async () => {
    const sm = await buildScanned();
    const content = await sm.readModuleAsync('src/agent/autonomy/IdleMind.js');
    assert(typeof content === 'string', 'returns string content');
    assert(content.includes('class IdleMind'), 'content contains class declaration');
  });

  test('reads an existing module by class name', async () => {
    const sm = await buildScanned();
    const content = await sm.readModuleAsync('IdleMind');
    assert(typeof content === 'string', 'class-name lookup works');
    assert(content.includes('class IdleMind'));
  });

  test('returns null for missing file', async () => {
    const sm = await buildScanned();
    const content = await sm.readModuleAsync('src/does/not/exist.js');
    assertEqual(content, null, 'missing file → null');
  });

  test('returns null for unknown class name', async () => {
    const sm = await buildScanned();
    const content = await sm.readModuleAsync('NonExistentClassName');
    assertEqual(content, null, 'unknown class → null');
  });
});

describe('v7.3.1 — read cache', () => {
  test('second read of same file hits cache (faster)', async () => {
    const sm = await buildScanned();
    const filePath = 'src/agent/autonomy/IdleMind.js';

    const first = await sm.readModuleAsync(filePath);
    assert(first !== null);

    // Verify cache population
    assert(sm._readCache.has(filePath), 'cache populated after first read');

    const second = await sm.readModuleAsync(filePath);
    assertEqual(second, first, 'second read returns identical content');
  });

  test('TTL expiry invalidates cache', async () => {
    const sm = await buildScanned();
    const filePath = 'src/agent/autonomy/IdleMind.js';

    await sm.readModuleAsync(filePath);
    const cached = sm._readCache.get(filePath);
    assert(cached, 'cache entry exists');

    // Manually age the entry beyond TTL
    cached.loadedAt = Date.now() - (sm._readCacheTTL + 1000);

    await sm.readModuleAsync(filePath);
    const refreshed = sm._readCache.get(filePath);
    assert(refreshed.loadedAt > cached.loadedAt,
      'stale cache entry was refreshed from disk');
  });

  test('LRU eviction caps cache at max size', async () => {
    const sm = await buildScanned();
    sm._readCacheMax = 5; // shrink for test

    const files = [
      'src/agent/autonomy/IdleMind.js',
      'src/agent/autonomy/IdleMindActivities.js',
      'src/agent/autonomy/AutonomousDaemon.js',
      'src/agent/foundation/SelfModel.js',
      'src/agent/foundation/Sandbox.js',
      'src/agent/core/EventBus.js',
      'src/agent/core/Container.js',
    ];
    for (const f of files) await sm.readModuleAsync(f);
    assert(sm._readCache.size <= sm._readCacheMax,
      `cache size ${sm._readCache.size} must be <= ${sm._readCacheMax}`);
  });

  test('hot-reload:success invalidates specific file', async () => {
    const sm = await buildScanned();

    // Build minimal bus stub
    const listeners = new Map();
    const bus = {
      on: (ev, fn) => {
        listeners.set(ev, fn);
        return () => listeners.delete(ev);
      },
    };

    sm.wireHotReloadInvalidation(bus);

    const filePath = 'src/agent/autonomy/IdleMind.js';
    await sm.readModuleAsync(filePath);
    assert(sm._readCache.has(filePath), 'cached after read');

    // Fire hot-reload:success
    const handler = listeners.get('hot-reload:success');
    assert(handler, 'handler registered');
    handler({ file: filePath });

    assert(!sm._readCache.has(filePath), 'cache invalidated for specific file');
  });

  test('clearReadCache() wipes everything', async () => {
    const sm = await buildScanned();
    await sm.readModuleAsync('src/agent/autonomy/IdleMind.js');
    await sm.readModuleAsync('src/agent/foundation/SelfModel.js');
    assert(sm._readCache.size > 0);

    sm.clearReadCache();
    assertEqual(sm._readCache.size, 0, 'cache cleared');
  });
});

describe('v7.3.1 — describeModule', () => {
  test('returns structured metadata by class name', async () => {
    const sm = await buildScanned();
    const desc = sm.describeModule('Homeostasis');
    assert(desc, 'found Homeostasis');
    assert(desc.file.includes('Homeostasis.js'), 'file path correct');
    assert(Array.isArray(desc.classes), 'classes array');
    assert(desc.classes.includes('Homeostasis'), 'class in list');
    assert(Array.isArray(desc.functions), 'functions array');
    assert(typeof desc.description === 'string', 'has description');
    assertEqual(typeof desc.loc, 'number', 'loc is number');
    assertEqual(typeof desc.protected, 'boolean', 'protected is boolean');
    assertEqual(typeof desc.isCapability, 'boolean', 'isCapability is boolean');
  });

  test('returns null for unknown name', async () => {
    const sm = await buildScanned();
    assertEqual(sm.describeModule('NonExistent'), null);
  });

  test('isCapability is true for classes that became capabilities', async () => {
    const sm = await buildScanned();
    const desc = sm.describeModule('Homeostasis');
    assertEqual(desc.isCapability, true,
      'Homeostasis should be marked as capability (v7.3.0 detection)');
  });

  test('does not require re-reading source (uses manifest)', async () => {
    const sm = await buildScanned();
    // Clear cache to verify describeModule does NOT populate it
    sm.clearReadCache();
    sm.describeModule('Homeostasis');
    assertEqual(sm._readCache.size, 0,
      'describeModule must not read source — it uses manifest data only');
  });
});

describe('v7.3.1 — backward compatibility', () => {
  test('sync readModule() still works', async () => {
    const sm = await buildScanned();
    const content = sm.readModule('src/agent/autonomy/IdleMind.js');
    assert(typeof content === 'string');
    assert(content.includes('class IdleMind'));
  });

  test('sync readModule() does not touch async cache', async () => {
    const sm = await buildScanned();
    sm.clearReadCache();
    sm.readModule('src/agent/autonomy/IdleMind.js');
    assertEqual(sm._readCache.size, 0,
      'sync path must not pollute async cache');
  });
});

run();
