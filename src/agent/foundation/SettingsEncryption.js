// @ts-checked-v5.8
// ============================================================
// GENESIS — SettingsEncryption.js (v7.6.7 — extracted mixin)
//
// Encryption-at-rest concern for Settings.js, extracted under
// the existing Mixin-Pattern (analog ModelBridgeFailover.js,
// ModelBridgeAvailability.js, ModelBridgeDiscovery.js).
//
// Module-level helpers:
//   legacyMachineId()                  — pre-v7.6.6 hostname-derived id
//   deriveKey(salt, iters, machineId)  — PBKDF2-SHA256
//   encryptValue(plaintext, salt, installId?)
//   decryptValue(ciphertext, salt, installId?)
//
// Mixin (mounted onto Settings.prototype via Object.assign):
//   _migrateLegacyEncryption()         — v1/v2 → v3 bulk rekey
//   _checkUnreadableV3Keys()           — flag enc3: that decrypts to ''
//   _writePreMigrationBackup()         — settings.json.pre-v3-migration
//   _migratePlaintextKeys()            — first-write encryption + v1→v2 upgrade
//   _loadOrCreateSalt(storageDir)      — .genesis/enc-salt provisioning
//
// Constants exported for consumers in Settings.js (set/get/_setRaw):
//   SENSITIVE_KEYS, ENC_PREFIX, ENC_PREFIX_V2, ENC_PREFIX_V3
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { createLogger } = require('../core/Logger');
const _log = createLogger('Settings');

// ── Constants ──────────────────────────────────────────────
const SENSITIVE_KEYS = new Set(['models.anthropicApiKey', 'models.openaiApiKey']);

const ENC_PREFIX = 'enc:';
// FIX v4.10.0 (S-4): v2 prefix for 600k-iteration keys.
// Old 'enc:' prefix = 10,000 iterations (read-compatible, auto-upgraded on next write).
// New 'enc2:' prefix = 600,000 iterations (OWASP 2023 minimum for SHA-256).
const ENC_PREFIX_V2 = 'enc2:';
// v7.6.6 Track A: v3 prefix for installation-anchored keys.
// machineId now derives from `.genesis/.install-id` (UUIDv4) instead of
// `os.hostname():username`. Survives hostname changes, username changes,
// and `.genesis/`-folder copy across machines. Iteration count unchanged
// (600k OWASP 2023). Legacy v1/v2 values auto-migrate on first v7.6.6 boot.
const ENC_PREFIX_V3 = 'enc3:';

const PBKDF2_ITERATIONS_V1 = 10000;
const PBKDF2_ITERATIONS_V2 = 600000;

// ── Module-level helpers ───────────────────────────────────

// v7.6.6: Legacy machine-id used by enc:/enc2: ciphertexts. Kept for
// backward-compat decrypt path (read v1/v2 values written before v7.6.6).
function legacyMachineId() {
  return `${os.hostname()}:${os.userInfo().username}:genesis-v2`;
}

function deriveKey(salt, iterations, machineId) {
  return crypto.pbkdf2Sync(machineId, salt, iterations, 32, 'sha256');
}

function encryptValue(plaintext, salt, installId) {
  if (!plaintext
      || plaintext.startsWith(ENC_PREFIX_V3)
      || plaintext.startsWith(ENC_PREFIX_V2)
      || plaintext.startsWith(ENC_PREFIX)) {
    return plaintext;
  }
  let prefix, machineId;
  if (installId) {
    // v7.6.6 default — installation-anchored
    prefix = ENC_PREFIX_V3;
    machineId = installId;
  } else {
    // Fallback when install-id unavailable (e.g. fs error). Still secure
    // as long as caller is on the original machine; matches pre-v7.6.6
    // behavior.
    prefix = ENC_PREFIX_V2;
    machineId = legacyMachineId();
  }
  const key = deriveKey(salt, PBKDF2_ITERATIONS_V2, machineId);
  const iv = crypto.randomBytes(12);
  const cipher = /** @type {*} */ (crypto.createCipheriv('aes-256-gcm', key, iv));
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `${prefix}${iv.toString('hex')}:${tag}:${encrypted}`;
}

function decryptValue(ciphertext, salt, installId) {
  if (!ciphertext) return ciphertext;
  let prefix, iterations, machineId;
  if (ciphertext.startsWith(ENC_PREFIX_V3)) {
    if (!installId) {
      // enc3 value present but no install-id available — caller (Settings
      // instance) tracks this in _unreadableKeys so setBus() can fire
      // settings:keys-unreadable. Return empty string for compat with
      // pre-v7.6.6 callers that expect string return.
      _log.warn('[SETTINGS] enc3 value present but install-id unavailable');
      return '';
    }
    prefix = ENC_PREFIX_V3;
    iterations = PBKDF2_ITERATIONS_V2;
    machineId = installId;
  } else if (ciphertext.startsWith(ENC_PREFIX_V2)) {
    prefix = ENC_PREFIX_V2;
    iterations = PBKDF2_ITERATIONS_V2;
    machineId = legacyMachineId();
  } else if (ciphertext.startsWith(ENC_PREFIX)) {
    prefix = ENC_PREFIX;
    iterations = PBKDF2_ITERATIONS_V1;
    machineId = legacyMachineId();
  } else {
    return ciphertext; // Not encrypted
  }
  try {
    const parts = ciphertext.slice(prefix.length).split(':');
    if (parts.length !== 3) return ciphertext;
    const [ivHex, tagHex, encHex] = parts;
    const key = deriveKey(salt, iterations, machineId);
    const decipher = /** @type {*} */ (crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex')));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    let decrypted = decipher.update(encHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    _log.warn('[SETTINGS] API key decryption failed — key may need re-entry');
    return '';
  }
}

// ── Mixin (mounted onto Settings.prototype) ─────────────────

const settingsEncryptionMixin = {
  /**
   * v7.6.6 Track A: Bulk-migrate v1/v2 ciphertexts to v3 (install-id-anchored).
   * Idempotent — safe to call repeatedly. Writes pre-v3-migration backup
   * once before mutating settings.json. Failed legacy decrypts are tracked
   * in _unreadableKeys (not aborted).
   */
  _migrateLegacyEncryption() {
    const installId = this._getInstallId();
    if (!installId) return; // can't write v3, leave legacy as-is

    // Detect any legacy-prefix value
    let needsMigration = false;
    for (const dotPath of SENSITIVE_KEYS) {
      const parts = dotPath.split('.');
      /** @type {*} */ let val = this.data;
      for (const p of parts) { if (val) val = val[p]; }
      if (typeof val === 'string'
          && (val.startsWith(ENC_PREFIX_V2) || val.startsWith(ENC_PREFIX))
          && !val.startsWith(ENC_PREFIX_V3)) {
        needsMigration = true;
        break;
      }
    }
    if (!needsMigration) return;

    this._writePreMigrationBackup();

    let migratedCount = 0;
    for (const dotPath of SENSITIVE_KEYS) {
      const parts = dotPath.split('.');
      /** @type {*} */ let obj = this.data;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!obj || !obj[parts[i]]) { obj = null; break; }
        obj = obj[parts[i]];
      }
      if (!obj) continue;
      const lastKey = parts[parts.length - 1];
      const val = obj[lastKey];
      if (typeof val !== 'string') continue;
      if (val.startsWith(ENC_PREFIX_V3)) continue; // already v3
      if (!val.startsWith(ENC_PREFIX_V2) && !val.startsWith(ENC_PREFIX)) continue;

      // Decrypt with legacy key (installId=null forces hostname-derived)
      const plaintext = decryptValue(val, this._encSalt, null);
      if (plaintext && plaintext.length > 0) {
        // Re-encrypt with v3 (installId-anchored)
        obj[lastKey] = encryptValue(plaintext, this._encSalt, installId);
        migratedCount++;
      } else {
        // Legacy-decrypt failed — leave value untouched, track for warning
        if (!this._unreadableKeys.includes(dotPath)) {
          this._unreadableKeys.push(dotPath);
        }
      }
    }

    if (migratedCount > 0) {
      this._save();
      _log.info(`[SETTINGS] Migrated ${migratedCount} value(s) to v3 keying (installation-anchored)`);
    }
  },

  /**
   * v7.6.6 Track A.4: After migration completes, check whether any
   * existing `enc3:` values fail to decrypt with the current install-id.
   * This catches the case where `.install-id` was rotated/restored from
   * an unrelated source — the values are present but cryptographically
   * unreadable and the user must re-enter them via /setkey or settings.
   */
  _checkUnreadableV3Keys() {
    const installId = this._getInstallId();
    if (!installId) return;
    for (const dotPath of SENSITIVE_KEYS) {
      if (this._unreadableKeys.includes(dotPath)) continue;
      const parts = dotPath.split('.');
      /** @type {*} */ let val = this.data;
      for (const p of parts) { if (val) val = val[p]; }
      if (typeof val !== 'string') continue;
      if (!val.startsWith(ENC_PREFIX_V3)) continue;
      const plaintext = decryptValue(val, this._encSalt, installId);
      if (!plaintext || plaintext.length === 0) {
        this._unreadableKeys.push(dotPath);
      }
    }
  },

  /**
   * v7.6.6 Track A.3: Snapshot settings.json before re-keying. Created
   * once on first migration; subsequent migrations skip if backup
   * already exists (preserves the original pre-v7.6.6 state).
   */
  _writePreMigrationBackup() {
    try {
      const backupPath = path.join(this._storageDir, 'settings.json.pre-v3-migration');
      if (fs.existsSync(backupPath)) return;
      if (!fs.existsSync(this.filePath)) return;
      fs.copyFileSync(this.filePath, backupPath);
      _log.info(`[SETTINGS] Pre-v3-migration backup written: ${backupPath}`);
    } catch (err) {
      _log.warn(`[SETTINGS] Pre-migration backup failed (non-fatal): ${err.message}`);
    }
  },

  /**
   * Encrypt plaintext SENSITIVE_KEYS values on first write; auto-upgrade
   * v1 (10k iterations) → v2 (600k) → v3 (install-id-anchored) on read.
   */
  _migratePlaintextKeys() {
    let migrated = false;
    for (const dotPath of SENSITIVE_KEYS) {
      const parts = dotPath.split('.');
      /** @type {*} */ let val = this.data;
      for (const p of parts) { if (val) val = val[p]; }
      if (val && typeof val === 'string' && val.length > 10) {
        if (!val.startsWith(ENC_PREFIX) && !val.startsWith(ENC_PREFIX_V2) && !val.startsWith(ENC_PREFIX_V3)) {
          // Plaintext → encrypt with v3 (or v2 fallback if no install-id)
          this.set(dotPath, val);
          migrated = true;
        } else if (val.startsWith(ENC_PREFIX) && !val.startsWith(ENC_PREFIX_V2) && !val.startsWith(ENC_PREFIX_V3)) {
          // FIX v4.10.0 (S-4): Auto-upgrade v1 (10k iterations) → v2 (600k iterations).
          // v7.6.6: now upgrades to v3 if install-id available, else v2.
          const plaintext = decryptValue(val, this._encSalt, this._getInstallId());
          if (plaintext && plaintext.length > 0) {
            this.set(dotPath, plaintext); // set() will encrypt with v3 (or v2)
            migrated = true;
          }
        }
      }
    }
    if (migrated) _log.info('[SETTINGS] Migrated API keys to PBKDF2 v2 (600k iterations)');
  },

  /**
   * FIX v4.10.0 (M-4): Load or create a random encryption salt.
   * Stored in .genesis/enc-salt (plain hex string, not sensitive itself —
   * security depends on the machine-derived key material in deriveKey()).
   * Falls back to deterministic salt for backward compatibility if the
   * salt file cannot be written.
   */
  _loadOrCreateSalt(storageDir) {
    const saltPath = path.join(storageDir, 'enc-salt');
    try {
      if (fs.existsSync(saltPath)) {
        return fs.readFileSync(saltPath, 'utf-8').trim();
      }
      const salt = crypto.randomBytes(32).toString('hex');
      if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true });
      fs.writeFileSync(saltPath, salt, 'utf-8');
      return salt;
    } catch (err) {
      _log.warn('[SETTINGS] Random salt creation failed, using deterministic fallback:', err.message);
      return 'genesis-' + storageDir.replace(/[^a-zA-Z0-9]/g, '').slice(-16);
    }
  },
};

module.exports = {
  // Constants
  SENSITIVE_KEYS,
  ENC_PREFIX,
  ENC_PREFIX_V2,
  ENC_PREFIX_V3,
  PBKDF2_ITERATIONS_V1,
  PBKDF2_ITERATIONS_V2,
  // Module-level helpers
  legacyMachineId,
  deriveKey,
  encryptValue,
  decryptValue,
  // Mixin for Settings.prototype
  settingsEncryptionMixin,
};
