// ============================================================
// TEST — BackupManager.js (v6.0.1)
// ============================================================

const { describe, test, run } = require('../harness');
const { BackupManager } = require('../../src/agent/capabilities/BackupManager');
const fs = require('fs');
const path = require('path');
const os = require('os');

let _tmpId = 0;
function tmpDir() {
  const dir = path.join(os.tmpdir(), `genesis-backup-test-${Date.now()}-${_tmpId++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true }); } catch (_e) { /* best effort */ }
}

describe('BackupManager', () => {
  test('export creates tar.gz with manifest', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ test: true }));
    fs.writeFileSync(path.join(dir, 'knowledge-graph.json'), JSON.stringify({ nodes: [] }));

    const bm = new BackupManager(dir);
    const outPath = path.join(dir, 'test-backup.tar.gz');
    const result = await bm.export(outPath);

    if (!result.success) throw new Error(`Export failed: ${result.error}`);
    if (!fs.existsSync(outPath)) throw new Error('Archive not created');
    if (result.stats.files < 2) throw new Error(`Expected >= 2 files, got ${result.stats.files}`);
    if (result.stats.archiveSize < 50) throw new Error('Archive too small');
    cleanup(dir);
  });

  test('export handles empty genesis dir', async () => {
    const dir = tmpDir();
    const bm = new BackupManager(dir);
    const outPath = path.join(dir, 'empty-backup.tar.gz');
    const result = await bm.export(outPath);

    if (!result.success) throw new Error(`Export should succeed even if empty: ${result.error}`);
    if (result.stats.files !== 0) throw new Error(`Expected 0 files, got ${result.stats.files}`);
    cleanup(dir);
  });

  test('import restores data from archive', async () => {
    const srcDir = tmpDir();
    const dstDir = tmpDir();
    fs.writeFileSync(path.join(srcDir, 'knowledge-graph.json'), JSON.stringify({ nodes: ['test'] }));
    fs.writeFileSync(path.join(srcDir, 'lessons.json'), JSON.stringify({ items: [1, 2, 3] }));

    const bm1 = new BackupManager(srcDir);
    const archivePath = path.join(srcDir, 'export.tar.gz');
    await bm1.export(archivePath);

    const bm2 = new BackupManager(dstDir);
    const result = await bm2.import(archivePath);

    if (!result.success) throw new Error(`Import failed: ${result.error}`);
    if (result.stats.imported < 2) throw new Error(`Expected >= 2 imported, got ${result.stats.imported}`);

    const kg = JSON.parse(fs.readFileSync(path.join(dstDir, 'knowledge-graph.json'), 'utf8'));
    if (!kg.nodes || kg.nodes[0] !== 'test') throw new Error('KG data not restored');
    cleanup(srcDir);
    cleanup(dstDir);
  });

  test('import preserves existing settings by default', async () => {
    const srcDir = tmpDir();
    const dstDir = tmpDir();
    fs.writeFileSync(path.join(srcDir, 'settings.json'), JSON.stringify({ from: 'backup' }));
    fs.writeFileSync(path.join(dstDir, 'settings.json'), JSON.stringify({ from: 'existing' }));

    const bm1 = new BackupManager(srcDir);
    const archivePath = path.join(srcDir, 'export.tar.gz');
    await bm1.export(archivePath);

    const bm2 = new BackupManager(dstDir);
    const result = await bm2.import(archivePath);

    if (!result.success) throw new Error(`Import failed: ${result.error}`);
    if (result.stats.skipped !== 1) throw new Error(`Expected 1 skipped, got ${result.stats.skipped}`);

    const settings = JSON.parse(fs.readFileSync(path.join(dstDir, 'settings.json'), 'utf8'));
    if (settings.from !== 'existing') throw new Error('Settings should be preserved');
    cleanup(srcDir);
    cleanup(dstDir);
  });

  test('import with overwrite replaces settings', async () => {
    const srcDir = tmpDir();
    const dstDir = tmpDir();
    fs.writeFileSync(path.join(srcDir, 'settings.json'), JSON.stringify({ from: 'backup' }));
    fs.writeFileSync(path.join(dstDir, 'settings.json'), JSON.stringify({ from: 'existing' }));

    const bm1 = new BackupManager(srcDir);
    const archivePath = path.join(srcDir, 'export.tar.gz');
    await bm1.export(archivePath);

    const bm2 = new BackupManager(dstDir);
    await bm2.import(archivePath, { overwrite: true });

    const settings = JSON.parse(fs.readFileSync(path.join(dstDir, 'settings.json'), 'utf8'));
    if (settings.from !== 'backup') throw new Error('Settings should be overwritten');
    cleanup(srcDir);
    cleanup(dstDir);
  });

  test('import rejects missing archive', async () => {
    const dir = tmpDir();
    const bm = new BackupManager(dir);
    const result = await bm.import('/nonexistent/path.tar.gz');
    if (result.success) throw new Error('Should fail for missing archive');
    if (!result.error.includes('not found')) throw new Error('Error should mention not found');
    cleanup(dir);
  });

  test('import rejects archive without manifest', async () => {
    const dir = tmpDir();
    const archivePath = path.join(dir, 'bad.tar.gz');
    // Create a tar.gz without manifest
    fs.writeFileSync(path.join(dir, 'dummy.txt'), 'hello');
    require('child_process').execFileSync('tar', ['-czf', archivePath, '-C', dir, 'dummy.txt']);

    const bm = new BackupManager(dir);
    const result = await bm.import(archivePath);
    if (result.success) throw new Error('Should fail without manifest');
    if (!result.error.includes('manifest')) throw new Error('Error should mention manifest');
    cleanup(dir);
  });

  test('export emits backup:exported event', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'settings.json'), '{}');
    const events = [];
    const bus = { emit: (n, d) => events.push({ n, d }), fire() {} };

    const bm = new BackupManager(dir, { bus });
    await bm.export(path.join(dir, 'ev-test.tar.gz'));

    const exp = events.find(e => e.n === 'backup:exported');
    if (!exp) throw new Error('Should emit backup:exported');
    if (!exp.d.path) throw new Error('Event should include path');
    cleanup(dir);
  });

  test('export includes subdirectories', async () => {
    const dir = tmpDir();
    const replayDir = path.join(dir, '.genesis-replay');
    fs.mkdirSync(replayDir, { recursive: true });
    fs.writeFileSync(path.join(replayDir, 'replay-001.json'), '{"steps":[]}');
    fs.writeFileSync(path.join(dir, 'settings.json'), '{}');

    const bm = new BackupManager(dir);
    const outPath = path.join(dir, 'dir-test.tar.gz');
    const result = await bm.export(outPath);

    if (!result.success) throw new Error(`Export failed: ${result.error}`);
    if (result.stats.files < 2) throw new Error(`Expected >= 2 files, got ${result.stats.files}`);
    cleanup(dir);
  });
});

if (require.main === module) run();
