// @ts-check
'use strict';

// GENESIS — HauptstandortMarker.js (v7.6.6 — identity foundation)
//
// Persistent marker file `.genesis/.hauptstandort.json` stamping this
// `.genesis/`-folder as the primary identity location ("Hauptstandort").
// Foundation for the v7.7+ Hauptstandort/Außenposten architecture: each
// Genesis instance is either a Hauptstandort (full identity, full
// autonomy) or an Außenposten (proxy, refers back to its Hauptstandort
// via `parentInstallUuid`).
//
// In v7.6.6 every install is a Hauptstandort; the schema reserves the
// `role` and `parentInstallUuid` fields so v7.7+ can flip new clones
// into Außenposten without a schema migration.
//
// Schema (v1):
//   {
//     "schemaVersion": 1,
//     "installUuid":   "<from .install-id>",
//     "createdAt":     "<ISO-8601>",
//     "role":          "hauptstandort",
//     "parentInstallUuid": null,        // v7.7+ Außenposten will set this
//     "hostnameHistory": [
//       { "hostname": "<host>", "username": "<user>", "since": "<ISO>" }
//     ]
//   }
//
// Lifecycle:
//   - loadOrCreate(): reads existing marker or creates a fresh one with
//     current install-id + hostname/username
//   - updateHostnameHistory(): appends a new (host,user)-tuple if it
//     differs from the most recent entry. Append-only.
//   - save(): atomic write with chmod 0600 (best-effort)
//
// Edge cases:
//   - Corrupt JSON → log warn, recreate fresh
//   - schemaVersion > 1 → log warn (forward-compat), treat as v1, do NOT
//     overwrite (avoid lossy downgrade)
//   - marker.installUuid != current install-id → log warn, leave marker
//     alone (user-investigable, no auto-recovery)

const fs = require('fs');
const path = require('path');
const os = require('os');
const { createLogger } = require('../core/Logger.js');

const _log = createLogger('HauptstandortMarker');

const MARKER_FILE = '.hauptstandort.json';
const SCHEMA_VERSION = 1;
const ROLE_HAUPTSTANDORT = 'hauptstandort';

/**
 * @typedef {Object} HostnameEntry
 * @property {string} hostname
 * @property {string} username
 * @property {string} since   ISO-8601 timestamp
 *
 * @typedef {Object} Marker
 * @property {number} schemaVersion
 * @property {string} installUuid
 * @property {string} createdAt
 * @property {string} role
 * @property {string | null} parentInstallUuid
 * @property {HostnameEntry[]} hostnameHistory
 */

/**
 * Build a fresh marker stamped with the current host/user/install-id.
 *
 * @param {string} installUuid
 * @returns {Marker}
 */
function createFresh(installUuid) {
  const nowIso = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    installUuid,
    createdAt: nowIso,
    role: ROLE_HAUPTSTANDORT,
    parentInstallUuid: null,
    hostnameHistory: [
      {
        hostname: os.hostname(),
        username: os.userInfo().username,
        since: nowIso,
      },
    ],
  };
}

/**
 * Load existing marker or create a new one. Validates schema and
 * detects install-id mismatch. On corrupt JSON or
 * schemaVersion < 1 / missing → recreate. On schemaVersion > 1 →
 * preserve as-is (forward-compat, log warn).
 *
 * @param {string} genesisDir
 * @param {string} installUuid  Current install-id from InstallId.getOrCreate
 * @returns {{ marker: Marker, isFresh: boolean }}
 */
function loadOrCreate(genesisDir, installUuid) {
  if (!genesisDir) throw new Error('HauptstandortMarker.loadOrCreate: genesisDir required');
  if (!installUuid) throw new Error('HauptstandortMarker.loadOrCreate: installUuid required');

  const markerPath = path.join(genesisDir, MARKER_FILE);

  if (fs.existsSync(markerPath)) {
    try {
      const raw = fs.readFileSync(markerPath, 'utf8');
      const parsed = JSON.parse(raw);

      // schemaVersion validation
      if (typeof parsed.schemaVersion !== 'number' || parsed.schemaVersion < 1) {
        _log.warn(`[MARKER] missing/invalid schemaVersion in ${markerPath} — recreating`);
        return { marker: createFresh(installUuid), isFresh: true };
      }
      if (parsed.schemaVersion > SCHEMA_VERSION) {
        _log.warn(`[MARKER] future schemaVersion ${parsed.schemaVersion} (this build supports ${SCHEMA_VERSION}) — preserving as-is`);
        // Return parsed as-is, do not modify
        return { marker: /** @type {Marker} */ (parsed), isFresh: false };
      }

      // installUuid mismatch — flag, leave alone (Edge-Case 6 from plan)
      if (parsed.installUuid !== installUuid) {
        _log.warn(`[MARKER] installUuid mismatch: marker has ${String(parsed.installUuid).slice(0, 8)}..., .install-id has ${installUuid.slice(0, 8)}... — investigate manually`);
        // Return parsed as-is; the operator must decide whether to keep
        // the existing marker (e.g. install-id was rotated) or delete it.
        return { marker: /** @type {Marker} */ (parsed), isFresh: false };
      }

      // Validate required fields
      if (typeof parsed.installUuid !== 'string'
          || typeof parsed.createdAt !== 'string'
          || typeof parsed.role !== 'string'
          || !Array.isArray(parsed.hostnameHistory)) {
        _log.warn(`[MARKER] required fields missing in ${markerPath} — recreating`);
        return { marker: createFresh(installUuid), isFresh: true };
      }

      return { marker: /** @type {Marker} */ (parsed), isFresh: false };
    } catch (err) {
      _log.warn(`[MARKER] could not parse ${markerPath}: ${err.message} — recreating`);
      return { marker: createFresh(installUuid), isFresh: true };
    }
  }

  return { marker: createFresh(installUuid), isFresh: true };
}

/**
 * Append the current (hostname, username) tuple to history if it
 * differs from the most recent entry. Mutates marker in place and
 * returns true if a change was made.
 *
 * @param {Marker} marker
 * @returns {boolean}  true if history was appended
 */
function updateHostnameHistory(marker) {
  if (!marker || !Array.isArray(marker.hostnameHistory)) return false;

  const currentHost = os.hostname();
  const currentUser = os.userInfo().username;
  const last = marker.hostnameHistory[marker.hostnameHistory.length - 1];

  if (last && last.hostname === currentHost && last.username === currentUser) {
    return false; // unchanged
  }

  marker.hostnameHistory.push({
    hostname: currentHost,
    username: currentUser,
    since: new Date().toISOString(),
  });
  return true;
}

/**
 * Atomically write the marker to disk. Best-effort chmod 0600.
 *
 * @param {string} genesisDir
 * @param {Marker} marker
 */
function save(genesisDir, marker) {
  if (!genesisDir) throw new Error('HauptstandortMarker.save: genesisDir required');
  if (!marker) throw new Error('HauptstandortMarker.save: marker required');

  try { fs.mkdirSync(genesisDir, { recursive: true }); } catch (_e) { /* exists */ }

  const markerPath = path.join(genesisDir, MARKER_FILE);
  const tmpPath = `${markerPath}.tmp.${process.pid}`;

  fs.writeFileSync(tmpPath, JSON.stringify(marker, null, 2), 'utf8');
  try { fs.renameSync(tmpPath, markerPath); }
  catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (_e) { /* ignore */ }
    throw err;
  }

  try { fs.chmodSync(markerPath, 0o600); } catch (_e) { /* best-effort */ }
}

module.exports = {
  loadOrCreate,
  updateHostnameHistory,
  save,
  createFresh,
  MARKER_FILE,
  SCHEMA_VERSION,
  ROLE_HAUPTSTANDORT,
};
