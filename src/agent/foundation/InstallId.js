// @ts-check
'use strict';

// GENESIS — InstallId.js (v7.6.6 — installation identifier)
//
// Persistent, machine-independent installation UUID stored in
// `.genesis/.install-id`. Foundation for Settings encryption keying
// and HauptstandortMarker identity, replacing the v2-era pattern of
// deriving keys from `os.hostname():username` (which broke on hostname
// changes, username changes, or identity-folder copy across machines).
//
// Properties:
//   - Generated once on first boot, persisted forever.
//   - Race-safe: `fs.writeFileSync` with flag 'wx' (exclusive) — second
//     concurrent caller hits EEXIST and reads the winner's value.
//   - Format-validated on read: a corrupt or manually-tampered file is
//     logged and rotated.
//   - Permission-best-effort 0600 on POSIX, no-op on Windows.
//
// Used by:
//   - Settings.js (`_deriveKey` — installation-anchored encryption)
//   - HauptstandortMarker.js (identity stamp)
//   - AgentCoreBoot (boot-time bootstrap)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createLogger } = require('../core/Logger.js');

const _log = createLogger('InstallId');

const INSTALL_ID_FILE = '.install-id';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Get the installation UUID, creating it if absent or corrupt.
 *
 * @param {string} genesisDir  Path to `.genesis/` directory.
 * @returns {string}           Validated UUIDv4 string.
 */
function getOrCreate(genesisDir) {
  if (!genesisDir) throw new Error('InstallId.getOrCreate: genesisDir required');

  const idPath = path.join(genesisDir, INSTALL_ID_FILE);

  // Read path
  if (fs.existsSync(idPath)) {
    try {
      const content = fs.readFileSync(idPath, 'utf8').trim();
      if (UUID_RE.test(content)) return content;
      _log.warn(`[INSTALL-ID] corrupt content at ${idPath} — rotating`);
      try { fs.unlinkSync(idPath); } catch (_e) { /* best-effort */ }
    } catch (err) {
      _log.warn(`[INSTALL-ID] read failed: ${err.message} — attempting recreate`);
    }
  }

  // Create path — ensure dir exists
  try { fs.mkdirSync(genesisDir, { recursive: true }); } catch (_e) { /* exists */ }

  const uuid = crypto.randomUUID();
  try {
    fs.writeFileSync(idPath, uuid, { flag: 'wx', encoding: 'utf8' });
  } catch (err) {
    if (/** @type {any} */ (err).code === 'EEXIST') {
      // Race: another process won. Read theirs.
      try {
        const content = fs.readFileSync(idPath, 'utf8').trim();
        if (UUID_RE.test(content)) return content;
      } catch (_e) { /* fall through */ }
    }
    throw err;
  }

  // Best-effort restrictive perms (no-op on Windows)
  try { fs.chmodSync(idPath, 0o600); } catch (_e) { /* best-effort */ }

  _log.info(`[INSTALL-ID] created ${uuid.slice(0, 8)}...`);
  return uuid;
}

/**
 * Read existing install-id without creating one. Returns null if absent
 * or corrupt. Used by tools that should not implicitly bootstrap state.
 *
 * @param {string} genesisDir
 * @returns {string | null}
 */
function read(genesisDir) {
  if (!genesisDir) return null;
  const idPath = path.join(genesisDir, INSTALL_ID_FILE);
  if (!fs.existsSync(idPath)) return null;
  try {
    const content = fs.readFileSync(idPath, 'utf8').trim();
    return UUID_RE.test(content) ? content : null;
  } catch (_e) {
    return null;
  }
}

module.exports = { getOrCreate, read, UUID_RE, INSTALL_ID_FILE };
