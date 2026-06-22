#!/usr/bin/env node
// Test: StorageService checksum lifecycle — P4 (v7.9.25)
// - delete() clears the checksum so verifyIntegrity stops reporting a phantom 'missing'
// - writes persist checksums in the { schema, checksums } envelope
// - one-time migration drops ephemeral goals/steps orphans whose file is gone,
//   while keeping a genuinely missing critical file flagged
const { describe, test, assert, assertEqual, run } = require('../harness');
const { StorageService } = require('../../src/agent/foundation/StorageService');
const fs = require('fs');
const os = require('os');
const path = require('path');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-storage-'));
}

describe('StorageService P4 — checksum lifecycle', () => {

  test('delete() clears the checksum so verifyIntegrity stops reporting it', () => {
    const dir = tmpDir();
    const s = new StorageService(dir);
    s.writeJSON('goals/steps/goal_1.json', { step: 1 });
    let res = s.verifyIntegrity();
    assertEqual(res.missing.length, 0, 'no missing while file present');

    s.delete('goals/steps/goal_1.json');
    res = s.verifyIntegrity();
    assertEqual(res.missing.length, 0, 'no orphan checksum after delete');
    assert(!s._checksums.has('goals/steps/goal_1.json'), 'checksum entry removed');
  });

  test('writes persist checksums in the {schema,checksums} envelope', () => {
    const dir = tmpDir();
    const s = new StorageService(dir);
    s.writeJSON('genome.json', { traits: {} });
    const raw = JSON.parse(fs.readFileSync(path.join(dir, '_checksums.json'), 'utf8'));
    assertEqual(raw.schema, 1, 'envelope carries schema');
    assert(raw.checksums && typeof raw.checksums === 'object', 'envelope carries checksums map');
    assert(raw.checksums['genome.json'], 'genome checksum stored inside envelope');
  });

  test('migration drops ephemeral goals/steps orphans, keeps missing critical', () => {
    const dir = tmpDir();
    // a goals/steps file that DOES exist (its checksum must survive)
    fs.mkdirSync(path.join(dir, 'goals', 'steps'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'goals', 'steps', 'goal_exists.json'), '{}', 'utf8');
    // seed an OLD-format (bare map) checksums file
    fs.writeFileSync(path.join(dir, '_checksums.json'), JSON.stringify({
      'goals/steps/goal_gone.json': 'deadbeef',   // ephemeral + file gone → drop
      'goals/steps/goal_exists.json': 'cafef00d',  // ephemeral + file present → keep
      'genome.json': 'abc123',                      // critical + file gone → keep (stays flagged)
    }, null, 2), 'utf8');

    const s = new StorageService(dir); // constructor → _loadChecksums → migration

    assert(!s._checksums.has('goals/steps/goal_gone.json'), 'ephemeral orphan dropped');
    assert(s._checksums.has('goals/steps/goal_exists.json'), 'present ephemeral kept');
    assert(s._checksums.has('genome.json'), 'missing critical kept');

    // file rewritten in envelope format
    const raw = JSON.parse(fs.readFileSync(path.join(dir, '_checksums.json'), 'utf8'));
    assertEqual(raw.schema, 1, 'migrated file is now an envelope');
    assert(!raw.checksums['goals/steps/goal_gone.json'], 'orphan not in migrated file');

    // verifyIntegrity now flags only the genuinely missing critical file
    const res = s.verifyIntegrity();
    assert(res.missing.includes('genome.json'), 'critical missing still reported');
    assert(!res.missing.includes('goals/steps/goal_gone.json'), 'ephemeral orphan not reported');
  });

  test('a second load sees the envelope and does not re-migrate', () => {
    const dir = tmpDir();
    const s1 = new StorageService(dir);
    s1.writeJSON('genome.json', { traits: {} });
    s1.delete('genome.json'); // removes the file + checksum, envelope persists
    // re-open: envelope path, no throw, no spurious entries
    const s2 = new StorageService(dir);
    assert(!s2._checksums.has('genome.json'), 'no resurrected checksum on reload');
    const raw = JSON.parse(fs.readFileSync(path.join(dir, '_checksums.json'), 'utf8'));
    assertEqual(raw.schema, 1, 'still an envelope after reload');
  });
});

run();
