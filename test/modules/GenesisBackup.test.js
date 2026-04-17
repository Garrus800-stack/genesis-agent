#!/usr/bin/env node
// Test: GenesisBackup — standalone backup system for .genesis/ folder
// v7.2.3 — Identity continuity feature
const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');
const os = require('os');
const fs = require('fs');

const { GenesisBackup } = require('../../src/agent/foundation/GenesisBackup');

// ─── Setup helpers ───────────────────────────────────────────
function mktmp() {
  return path.join(os.tmpdir(), `genesis-backup-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

function setupFixture() {
  const rootDir = mktmp();
  const genesisDir = path.join(rootDir, '.genesis');
  fs.mkdirSync(genesisDir, { recursive: true });
  fs.writeFileSync(path.join(genesisDir, 'test-memory.json'), JSON.stringify({ foo: 'bar' }));
  fs.writeFileSync(path.join(genesisDir, 'test-journal.json'), JSON.stringify({ entries: [] }));
  const subDir = path.join(genesisDir, 'sub');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, 'nested.json'), JSON.stringify({ nested: true }));
  return { rootDir, genesisDir };
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* ok */ }
}

// ─── Tests ──────────────────────────────────────────────────
describe('GenesisBackup', () => {

  test('constructor requires genesisDir and rootDir', () => {
    try {
      new GenesisBackup({});
      assert(false, 'should have thrown');
    } catch (err) {
      assert(err.message.includes('genesisDir'), 'error mentions required params');
    }
  });

  test('constructor creates .genesis-backups/ folder', () => {
    const { rootDir } = setupFixture();
    try {
      const gb = new GenesisBackup({ genesisDir: path.join(rootDir, '.genesis'), rootDir });
      assert(fs.existsSync(path.join(rootDir, '.genesis-backups')), 'backups folder created');
    } finally { cleanup(rootDir); }
  });

  test('backup() creates a timestamped snapshot', async () => {
    const { rootDir, genesisDir } = setupFixture();
    try {
      const gb = new GenesisBackup({ genesisDir, rootDir });
      const result = await gb.backup('test');
      assert(result.ok, 'backup succeeded');
      assert(result.path, 'result has path');
      assert(fs.existsSync(result.path), 'backup directory exists');
      assert(fs.existsSync(path.join(result.path, 'test-memory.json')), 'file copied');
      assert(fs.existsSync(path.join(result.path, 'sub', 'nested.json')), 'nested file copied');
    } finally { cleanup(rootDir); }
  });

  test('backup() returns skipped when another is running (mutex)', async () => {
    const { rootDir, genesisDir } = setupFixture();
    try {
      const gb = new GenesisBackup({ genesisDir, rootDir });
      // Kick off first backup without awaiting
      const p1 = gb.backup('first');
      // Second call should hit the mutex
      const result2 = await gb.backup('second');
      assert(result2.skipped, 'second call was skipped');
      assertEqual(result2.reason, 'already running');
      // Let first one finish
      const result1 = await p1;
      assert(result1.ok, 'first backup succeeded');
    } finally { cleanup(rootDir); }
  });

  test('backupIfStale() skips when recent backup exists', async () => {
    const { rootDir, genesisDir } = setupFixture();
    try {
      const gb = new GenesisBackup({ genesisDir, rootDir });
      await gb.backup('initial');
      const result = await gb.backupIfStale('stale-check');
      assert(result.ok, 'returned ok');
      assert(result.skipped, 'was skipped');
      assertEqual(result.reason, 'not stale yet');
    } finally { cleanup(rootDir); }
  });

  test('backupIfStale() backs up when no backup exists', async () => {
    const { rootDir, genesisDir } = setupFixture();
    try {
      const gb = new GenesisBackup({ genesisDir, rootDir });
      const result = await gb.backupIfStale('first-ever');
      assert(result.ok, 'backup succeeded');
      assert(!result.skipped, 'not skipped');
    } finally { cleanup(rootDir); }
  });

  test('rotation keeps at most maxBackups', async () => {
    const { rootDir, genesisDir } = setupFixture();
    try {
      const gb = new GenesisBackup({ genesisDir, rootDir, maxBackups: 3 });
      // Create 5 backups sequentially with small delays for distinct timestamps
      for (let i = 0; i < 5; i++) {
        await gb.backup(`test-${i}`);
        await new Promise(r => setTimeout(r, 15));
      }
      const backups = gb.listBackups();
      assert(backups.length <= 3, `expected <= 3 backups, got ${backups.length}`);
      assert(backups.length >= 1, 'at least one backup present');
    } finally { cleanup(rootDir); }
  });

  test('listBackups() returns newest-first', async () => {
    const { rootDir, genesisDir } = setupFixture();
    try {
      const gb = new GenesisBackup({ genesisDir, rootDir });
      await gb.backup('first');
      await new Promise(r => setTimeout(r, 20));
      await gb.backup('second');
      const backups = gb.listBackups();
      assert(backups.length >= 2, 'at least 2 backups');
      assert(backups[0].timestamp >= backups[1].timestamp, 'newest first');
    } finally { cleanup(rootDir); }
  });

  test('backup fails loudly when source missing', async () => {
    const { rootDir } = setupFixture();
    try {
      // Use non-existent genesisDir
      const fakeDir = path.join(rootDir, 'does-not-exist');
      let emittedEvent = null;
      const mockBus = {
        emit: (name, payload) => { emittedEvent = { name, payload }; },
      };
      const gb = new GenesisBackup({ genesisDir: fakeDir, rootDir, bus: mockBus });
      const result = await gb.backup('missing-source');
      assert(!result.ok, 'backup failed');
      assert(emittedEvent, 'safety:degraded event emitted');
      assertEqual(emittedEvent.name, 'safety:degraded');
      assertEqual(emittedEvent.payload.service, 'genesisBackup');
    } finally { cleanup(rootDir); }
  });

  test('getStats() reports accurate counts', async () => {
    const { rootDir, genesisDir } = setupFixture();
    try {
      const gb = new GenesisBackup({ genesisDir, rootDir });
      await gb.backup('one');
      await gb.backup('two');
      const stats = gb.getStats();
      assertEqual(stats.created, 2);
      assertEqual(stats.failed, 0);
      assert(stats.lastBackupAt, 'lastBackupAt is set');
      assert(!stats.running, 'not running after await');
    } finally { cleanup(rootDir); }
  });

  test('backup failure cleans up incomplete directory', async () => {
    const { rootDir } = setupFixture();
    try {
      const fakeDir = path.join(rootDir, 'does-not-exist');
      const gb = new GenesisBackup({ genesisDir: fakeDir, rootDir });
      const beforeCount = fs.readdirSync(path.join(rootDir, '.genesis-backups')).length;
      await gb.backup('will-fail');
      const afterCount = fs.readdirSync(path.join(rootDir, '.genesis-backups')).length;
      assertEqual(beforeCount, afterCount, 'no dangling backup directory left behind');
    } finally { cleanup(rootDir); }
  });

});

run();
