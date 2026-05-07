// ============================================================
// GENESIS — test/modules/v766-hauptstandort-marker.test.js
//
// Coverage for src/agent/foundation/HauptstandortMarker.js — the v7.6.6
// Track B identity foundation. Verifies:
//   - fresh creation with current host/user
//   - load existing marker
//   - corrupt JSON triggers recreate
//   - schemaVersion < 1 / missing triggers recreate
//   - schemaVersion > 1 is preserved as-is (forward-compat)
//   - installUuid mismatch is logged but marker preserved
//   - hostnameHistory append-only semantics
//   - atomic save with tmp+rename
// ============================================================

const fs = require('fs');
const path = require('path');
const os = require('os');

const { describe, test, assert, assertEqual, run } = require('../harness');

const ROOT = path.resolve(__dirname, '..', '..');
const Marker = require(path.join(ROOT, 'src/agent/foundation/HauptstandortMarker.js'));
const { getOrCreate: getOrCreateInstallId } =
  require(path.join(ROOT, 'src/agent/foundation/InstallId.js'));

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-marker-test-'));
}

describe('v7.6.6 — HauptstandortMarker', () => {

  test('loadOrCreate: fresh dir creates marker with required fields', () => {
    const dir = freshDir();
    const installId = getOrCreateInstallId(dir);
    const { marker, isFresh } = Marker.loadOrCreate(dir, installId);

    assert(isFresh === true, 'should report isFresh=true on first call');
    assertEqual(marker.schemaVersion, Marker.SCHEMA_VERSION, 'schemaVersion=1');
    assertEqual(marker.installUuid, installId, 'installUuid matches');
    assertEqual(marker.role, Marker.ROLE_HAUPTSTANDORT, 'role=hauptstandort');
    assertEqual(marker.parentInstallUuid, null, 'parentInstallUuid=null in v7.6.6');
    assert(typeof marker.createdAt === 'string', 'createdAt is iso string');
    assert(Array.isArray(marker.hostnameHistory), 'hostnameHistory is array');
    assert(marker.hostnameHistory.length === 1, 'hostnameHistory has one entry');
    assertEqual(marker.hostnameHistory[0].hostname, os.hostname(), 'host matches');
    assertEqual(marker.hostnameHistory[0].username, os.userInfo().username, 'user matches');
  });

  test('loadOrCreate: second call after save returns persisted marker', () => {
    const dir = freshDir();
    const installId = getOrCreateInstallId(dir);
    const { marker: m1 } = Marker.loadOrCreate(dir, installId);
    Marker.save(dir, m1);

    const { marker: m2, isFresh } = Marker.loadOrCreate(dir, installId);
    assert(isFresh === false, 'second call is not fresh');
    assertEqual(m2.installUuid, m1.installUuid, 'persisted installUuid');
    assertEqual(m2.createdAt, m1.createdAt, 'createdAt preserved');
  });

  test('loadOrCreate: corrupt JSON triggers recreate', () => {
    const dir = freshDir();
    const installId = getOrCreateInstallId(dir);
    fs.writeFileSync(path.join(dir, Marker.MARKER_FILE), 'not json at all', 'utf8');

    const { marker, isFresh } = Marker.loadOrCreate(dir, installId);
    assert(isFresh === true, 'corrupt → recreate flag');
    assertEqual(marker.schemaVersion, Marker.SCHEMA_VERSION, 'fresh schema');
  });

  test('loadOrCreate: schemaVersion=0 triggers recreate', () => {
    const dir = freshDir();
    const installId = getOrCreateInstallId(dir);
    fs.writeFileSync(path.join(dir, Marker.MARKER_FILE),
      JSON.stringify({ schemaVersion: 0, installUuid: installId, role: 'hauptstandort' }),
      'utf8');

    const { marker, isFresh } = Marker.loadOrCreate(dir, installId);
    assert(isFresh === true, 'invalid schemaVersion → recreate');
    assertEqual(marker.schemaVersion, Marker.SCHEMA_VERSION, 'fresh marker');
  });

  test('loadOrCreate: schemaVersion=99 (future) is preserved as-is', () => {
    const dir = freshDir();
    const installId = getOrCreateInstallId(dir);
    const futureMarker = {
      schemaVersion: 99,
      installUuid: installId,
      createdAt: '2099-01-01T00:00:00.000Z',
      role: 'hauptstandort',
      parentInstallUuid: null,
      hostnameHistory: [],
      futureField: 'something-from-v99',
    };
    fs.writeFileSync(path.join(dir, Marker.MARKER_FILE),
      JSON.stringify(futureMarker), 'utf8');

    const { marker, isFresh } = Marker.loadOrCreate(dir, installId);
    assert(isFresh === false, 'future version preserved, not fresh');
    assertEqual(marker.schemaVersion, 99, 'schemaVersion preserved');
    assertEqual(/** @type {*} */ (marker).futureField, 'something-from-v99',
      'unknown future field preserved');
  });

  test('loadOrCreate: installUuid mismatch is preserved (operator-investigable)', () => {
    const dir = freshDir();
    const oldInstallId = getOrCreateInstallId(dir);
    const { marker: m1 } = Marker.loadOrCreate(dir, oldInstallId);
    Marker.save(dir, m1);

    // Simulate install-id rotation: new install-id, same marker
    const newInstallId = '11111111-2222-3333-4444-555555555555';
    const { marker, isFresh } = Marker.loadOrCreate(dir, newInstallId);
    assert(isFresh === false, 'mismatch is not fresh — preserved');
    assertEqual(marker.installUuid, oldInstallId,
      'old installUuid preserved, NOT silently rewritten');
  });

  test('updateHostnameHistory: same host/user is no-op', () => {
    const dir = freshDir();
    const installId = getOrCreateInstallId(dir);
    const { marker } = Marker.loadOrCreate(dir, installId);
    const lenBefore = marker.hostnameHistory.length;

    const changed = Marker.updateHostnameHistory(marker);
    assert(changed === false, 'same host → no change');
    assertEqual(marker.hostnameHistory.length, lenBefore, 'length unchanged');
  });

  test('updateHostnameHistory: different host appends entry', () => {
    const dir = freshDir();
    const installId = getOrCreateInstallId(dir);
    const { marker } = Marker.loadOrCreate(dir, installId);
    // Tamper: pretend last entry was a different host
    marker.hostnameHistory[marker.hostnameHistory.length - 1] = {
      hostname: 'OLD-HOSTNAME-XYZ',
      username: 'olduser',
      since: '2020-01-01T00:00:00.000Z',
    };

    const changed = Marker.updateHostnameHistory(marker);
    assert(changed === true, 'different host → appended');
    assertEqual(marker.hostnameHistory.length, 2, 'two entries now');
    assertEqual(marker.hostnameHistory[1].hostname, os.hostname(), 'new entry has current host');
  });

  test('save: writes valid JSON to disk', () => {
    const dir = freshDir();
    const installId = getOrCreateInstallId(dir);
    const { marker } = Marker.loadOrCreate(dir, installId);
    Marker.save(dir, marker);

    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, Marker.MARKER_FILE), 'utf8'));
    assertEqual(onDisk.installUuid, installId, 'on-disk matches in-memory');
    assertEqual(onDisk.schemaVersion, Marker.SCHEMA_VERSION, 'schemaVersion persisted');
  });

  test('save: cleans up tmp file on success', () => {
    const dir = freshDir();
    const installId = getOrCreateInstallId(dir);
    const { marker } = Marker.loadOrCreate(dir, installId);
    Marker.save(dir, marker);

    // No leftover .tmp files
    const dirContents = fs.readdirSync(dir);
    const tmpFiles = dirContents.filter(f => f.includes('.tmp.'));
    assertEqual(tmpFiles.length, 0, 'no .tmp leftover after successful save');
  });

  test('createFresh: produces a usable marker with current process identity', () => {
    const fakeUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const m = Marker.createFresh(fakeUuid);
    assertEqual(m.installUuid, fakeUuid, 'installUuid set');
    assertEqual(m.role, 'hauptstandort', 'role default');
    assertEqual(m.parentInstallUuid, null, 'parentInstallUuid null');
    assertEqual(m.hostnameHistory.length, 1, 'one initial host entry');
    assertEqual(m.hostnameHistory[0].hostname, os.hostname(), 'current host');
  });

});

run();
