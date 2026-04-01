#!/usr/bin/env node
// Test: SnapshotManager.js — Named source code snapshots
const { describe, test, assert, assertEqual, assertThrows, run, createTestRoot } = require('../harness');
const path = require('path');
const fs = require('fs');

const ROOT = createTestRoot('snapshot');
// Create mock source tree
const agentDir = path.join(ROOT, 'src', 'agent');
fs.mkdirSync(agentDir, { recursive: true });
fs.writeFileSync(path.join(agentDir, 'TestModule.js'), 'module.exports = { version: 1 };');
fs.writeFileSync(path.join(agentDir, 'Other.js'), '// other');
fs.mkdirSync(path.join(ROOT, '.genesis'), { recursive: true });

const { SnapshotManager } = require('../../src/agent/capabilities/SnapshotManager');

function createMgr() {
  return new SnapshotManager({
    rootDir: ROOT,
    storage: { baseDir: path.join(ROOT, '.genesis') },
    guard: {
      validateWrite: (p) => {
        if (p.includes('kernel')) throw new Error('protected');
        return true;
      },
    },
  });
}

describe('SnapshotManager — Create', () => {
  test('creates a snapshot with metadata', () => {
    const mgr = createMgr();
    const result = mgr.create('test-snap', 'test description');
    assert(result.name === 'test-snap');
    assert(result.fileCount > 0, 'should snapshot files');
    assert(result.timestamp > 0);
    assert(result.hash, 'should have hash');
  });

  test('sanitizes unsafe names', () => {
    const mgr = createMgr();
    const result = mgr.create('../../etc/passwd', 'bad name');
    assert(!result.name.includes('/'));
    assert(!result.name.includes('..'));
  });

  test('overwrites existing snapshot with same name', () => {
    const mgr = createMgr();
    mgr.create('dup');
    mgr.create('dup'); // should not throw
    const list = mgr.list();
    const dups = list.filter(s => s.name === 'dup');
    assertEqual(dups.length, 1, 'should have exactly one');
  });
});

describe('SnapshotManager — List', () => {
  test('lists created snapshots sorted by time desc', () => {
    const mgr = createMgr();
    mgr.create('snap-a');
    mgr.create('snap-b');
    const list = mgr.list();
    assert(list.length >= 2);
    assert(list[0].timestamp >= list[1].timestamp, 'newest first');
  });

  test('empty list when no snapshots', () => {
    const mgr = new SnapshotManager({
      rootDir: ROOT,
      storage: { baseDir: path.join(ROOT, '.genesis', 'empty-' + Date.now()) },
      guard: { validateWrite: () => true },
    });
    const list = mgr.list();
    assertEqual(list.length, 0);
  });
});

describe('SnapshotManager — Restore', () => {
  test('restores files from snapshot', () => {
    const mgr = createMgr();
    mgr.create('restore-test');
    // Modify source
    fs.writeFileSync(path.join(agentDir, 'TestModule.js'), 'module.exports = { version: 999 };');
    // Restore
    const result = mgr.restore('restore-test');
    assert(result.restored > 0);
    const content = fs.readFileSync(path.join(agentDir, 'TestModule.js'), 'utf-8');
    assert(content.includes('version: 1'), 'should restore original content');
  });

  test('restore throws for nonexistent snapshot', () => {
    const mgr = createMgr();
    assertThrows(() => mgr.restore('nonexistent'));
  });
});

describe('SnapshotManager — Delete', () => {
  test('deletes existing snapshot', () => {
    const mgr = createMgr();
    mgr.create('to-delete');
    assert(mgr.delete('to-delete'));
    const list = mgr.list();
    assert(!list.some(s => s.name === 'to-delete'));
  });

  test('returns false for nonexistent snapshot', () => {
    const mgr = createMgr();
    assertEqual(mgr.delete('nope'), false);
  });
});

run();
