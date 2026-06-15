'use strict';
// v7.9.23 (Point 3) — boot integrity heal building blocks. GenesisBackup.restoreFile restores a
// single file from the most recent backup; StorageService.recomputeChecksum refreshes the stored
// checksum from disk so a restored (older) file is not re-flagged. The first test deliberately backs
// up v1, advances the live file to v2, then corrupts it: after restoreFile (→ v1) the v2 checksum
// still mismatches, proving recomputeChecksum is required to settle integrity.
const { describe, test, run, assert } = require('../harness');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StorageService } = require('../../src/agent/foundation/StorageService');
const { GenesisBackup } = require('../../src/agent/foundation/GenesisBackup');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-heal-'));
  const genesisDir = path.join(root, '.genesis');
  fs.mkdirSync(genesisDir, { recursive: true });
  return { root, genesisDir, storage: new StorageService(genesisDir), gb: new GenesisBackup({ genesisDir, rootDir: root }) };
}

describe('v7923 integrity heal restore + recompute', () => {
  test('corrupt file restored from backup; recompute settles a checksum newer than the backup', async () => {
    const { root, genesisDir, storage, gb } = setup();

    storage.writeJSON('session-history.json', { v: 1 });          // checksum(v1)
    assert(storage.verifyIntegrity().ok, 'baseline integrity OK after v1 write');
    await gb.backup('test-backup');                                // backup holds v1
    storage.writeJSON('session-history.json', { v: 2 });          // checksum(v2); backup still v1
    assert(storage.verifyIntegrity().ok, 'integrity OK at v2');

    fs.writeFileSync(path.join(genesisDir, 'session-history.json'), 'NOT JSON — corrupt', 'utf-8');
    assert(!storage.verifyIntegrity().ok, 'mismatch detected after corruption');

    const r = gb.restoreFile('session-history.json');
    assert(r.restored, 'restoreFile reports restored — got: ' + JSON.stringify(r));
    assert(!storage.verifyIntegrity().ok, 'restored v1 still mismatches the v2 checksum (why recompute is needed)');

    assert(storage.recomputeChecksum('session-history.json'), 'recomputeChecksum returns true');
    assert(storage.verifyIntegrity().ok, 'integrity OK once the checksum matches the restored content');

    const restored = JSON.parse(fs.readFileSync(path.join(genesisDir, 'session-history.json'), 'utf-8'));
    assert(restored.v === 1, 'file restored to the backed-up v1 — got: ' + JSON.stringify(restored));

    fs.rmSync(root, { recursive: true, force: true });
  });

  test('restoreFile reports not-restored when no backup contains the file', async () => {
    const { root, gb, storage } = setup();
    storage.writeJSON('present.json', { a: 1 });
    await gb.backup('test-backup');
    const r = gb.restoreFile('never-backed-up.json');
    assert(!r.restored, 'not restored for an unknown file — got: ' + JSON.stringify(r));
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('recomputeChecksum returns false for a missing file', () => {
    const { root, storage } = setup();
    assert(storage.recomputeChecksum('does-not-exist.json') === false, 'recompute false for missing file');
    fs.rmSync(root, { recursive: true, force: true });
  });
});

if (require.main === module) run();
