// ============================================================
// GENESIS — v7.6.7 SettingsEncryption split contract test
//
// Pins the mixin-pattern extraction of encryption-at-rest concerns
// from Settings.js to SettingsEncryption.js. Same shape as
// v765-modelbridge-split.contract.test.js — protects against
// silent re-merging or method-loss during refactors.
// ============================================================

'use strict';

const { describe, test, run } = require('../harness');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '../..');
const enc = require('../../src/agent/foundation/SettingsEncryption');
const { Settings } = require('../../src/agent/foundation/Settings');

describe('v7.6.7 SettingsEncryption split contract', () => {

  test('SettingsEncryption module exports expected shape', () => {
    // Constants
    assert(enc.SENSITIVE_KEYS instanceof Set, 'SENSITIVE_KEYS is a Set');
    assert(enc.SENSITIVE_KEYS.has('models.anthropicApiKey'),
      'SENSITIVE_KEYS contains anthropic key path');
    assert(enc.SENSITIVE_KEYS.has('models.openaiApiKey'),
      'SENSITIVE_KEYS contains openai key path');
    assert.strictEqual(enc.ENC_PREFIX, 'enc:');
    assert.strictEqual(enc.ENC_PREFIX_V2, 'enc2:');
    assert.strictEqual(enc.ENC_PREFIX_V3, 'enc3:');
    assert.strictEqual(enc.PBKDF2_ITERATIONS_V1, 10000);
    assert.strictEqual(enc.PBKDF2_ITERATIONS_V2, 600000);

    // Module-level helpers
    assert.strictEqual(typeof enc.legacyMachineId, 'function');
    assert.strictEqual(typeof enc.deriveKey, 'function');
    assert.strictEqual(typeof enc.encryptValue, 'function');
    assert.strictEqual(typeof enc.decryptValue, 'function');

    // Mixin object
    assert(enc.settingsEncryptionMixin && typeof enc.settingsEncryptionMixin === 'object',
      'settingsEncryptionMixin is an object');
  });

  test('settingsEncryptionMixin exports the five expected methods', () => {
    const mixin = enc.settingsEncryptionMixin;
    const expected = [
      '_migrateLegacyEncryption',
      '_checkUnreadableV3Keys',
      '_writePreMigrationBackup',
      '_migratePlaintextKeys',
      '_loadOrCreateSalt',
    ];
    for (const name of expected) {
      assert.strictEqual(typeof mixin[name], 'function',
        `mixin must export ${name} as function`);
    }
  });

  test('Object.assign mount: Settings.prototype has all mixin methods', () => {
    const expected = [
      '_migrateLegacyEncryption',
      '_checkUnreadableV3Keys',
      '_writePreMigrationBackup',
      '_migratePlaintextKeys',
      '_loadOrCreateSalt',
    ];
    for (const name of expected) {
      assert.strictEqual(typeof Settings.prototype[name], 'function',
        `Settings.prototype.${name} must be present after mount`);
    }
  });

  test('identity-equality: prototype methods === mixin methods', () => {
    // Pinned: nothing else has overwritten the mounted refs.
    assert.strictEqual(Settings.prototype._migrateLegacyEncryption,
      enc.settingsEncryptionMixin._migrateLegacyEncryption);
    assert.strictEqual(Settings.prototype._checkUnreadableV3Keys,
      enc.settingsEncryptionMixin._checkUnreadableV3Keys);
    assert.strictEqual(Settings.prototype._writePreMigrationBackup,
      enc.settingsEncryptionMixin._writePreMigrationBackup);
    assert.strictEqual(Settings.prototype._migratePlaintextKeys,
      enc.settingsEncryptionMixin._migratePlaintextKeys);
    assert.strictEqual(Settings.prototype._loadOrCreateSalt,
      enc.settingsEncryptionMixin._loadOrCreateSalt);
  });

  test('encryptValue/decryptValue round-trip with installId', () => {
    const salt = 'a'.repeat(64);
    const installId = 'ec40b421-fe85-4f1a-9f8c-2d2eb3c44b12';
    const plaintext = 'sk-test-secret-12345';

    const enc3 = enc.encryptValue(plaintext, salt, installId);
    assert(enc3.startsWith('enc3:'), 'enc3: prefix when installId provided');
    assert.strictEqual(enc.decryptValue(enc3, salt, installId), plaintext);
  });

  test('encryptValue with null installId falls back to enc2 (legacy)', () => {
    const salt = 'b'.repeat(64);
    const plaintext = 'sk-fallback-test';

    const enc2 = enc.encryptValue(plaintext, salt, null);
    assert(enc2.startsWith('enc2:'),
      'enc2: prefix when installId not provided (hostname fallback)');
    assert.strictEqual(enc.decryptValue(enc2, salt, null), plaintext);
  });

  test('decryptValue rejects enc3 ciphertext without installId', () => {
    const salt = 'c'.repeat(64);
    const installId = 'ec40b421-fe85-4f1a-9f8c-2d2eb3c44b12';
    const enc3 = enc.encryptValue('cannot-read-me', salt, installId);

    // enc3 ciphertext without installId returns '' (signal to caller to flag)
    const result = enc.decryptValue(enc3, salt, null);
    assert.strictEqual(result, '',
      'enc3 without installId returns empty string for caller to flag');
  });

  test('Settings.js no longer holds module-level encryption functions', () => {
    // Source-presence: ensure the extraction is structural, not duplicated.
    const settingsSrc = fs.readFileSync(
      path.join(ROOT, 'src/agent/foundation/Settings.js'), 'utf8');

    // Top-level `function deriveKey(` would be in Settings.js if extraction
    // was duplicated. After v7.6.7, only the require/destructure remains.
    const matches = settingsSrc.match(/^function (deriveKey|encryptValue|decryptValue|legacyMachineId)\(/gm);
    assert.strictEqual(matches, null,
      'Settings.js must not redefine extracted functions at module level');

    // Mount line is present
    assert(settingsSrc.includes('Object.assign(Settings.prototype, enc.settingsEncryptionMixin)'),
      'Settings.js must mount the mixin via Object.assign');
  });
});

if (require.main === module) run();
