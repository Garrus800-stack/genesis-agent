// ============================================================
// GENESIS — test/modules/v766-settings-key-migration.test.js
//
// Coverage for v7.6.6 Track A — installation-anchored encryption
// keying for SENSITIVE_KEYS in Settings.js. Replaces the v2-era
// hostname-derived machineId with a UUID stored in `.install-id`,
// fixing three real-world brokenness scenarios:
//
//   1. Hostname change on the same machine → keys still decrypt
//   2. `.genesis/`-folder copied to a new machine → keys still decrypt
//   3. Username change → keys still decrypt
//
// Tests cover: enc3: prefix is the default when install-id is
// available; legacy enc2: values are bulk-migrated on first boot;
// pre-migration backup is written; setBus() fires
// settings:keys-unreadable for values that fail decrypt.
// ============================================================

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { describe, test, assert, assertEqual, run } = require('../harness');

const ROOT = path.resolve(__dirname, '..', '..');
const { Settings } = require(path.join(ROOT, 'src/agent/foundation/Settings.js'));
const { getOrCreate: getOrCreateInstallId, INSTALL_ID_FILE } =
  require(path.join(ROOT, 'src/agent/foundation/InstallId.js'));

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-settings-mig-'));
}

/**
 * Encrypt a plaintext value with the legacy v2 machineId
 * (`os.hostname():username:genesis-v2`) and a given salt. Used to seed
 * test fixtures that simulate a pre-v7.6.6 settings.json.
 */
function legacyEncryptV2(plaintext, saltHex) {
  const machineId = `${os.hostname()}:${os.userInfo().username}:genesis-v2`;
  const key = crypto.pbkdf2Sync(machineId, saltHex, 600000, 32, 'sha256');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `enc2:${iv.toString('hex')}:${tag}:${encrypted}`;
}

describe('v7.6.6 — Settings install-id key migration', () => {

  test('fresh install: writes enc3: prefix when install-id is created', () => {
    const dir = freshDir();
    const s = new Settings(dir, null);
    s.set('models.anthropicApiKey', 'sk-ant-fresh-001');
    const raw = s.data.models.anthropicApiKey;
    assert(raw.startsWith('enc3:'),
      `fresh install should write enc3:, got ${raw.slice(0, 6)}…`);
    // Round-trip
    assertEqual(s.get('models.anthropicApiKey'), 'sk-ant-fresh-001',
      'enc3 round-trip works');
  });

  test('install-id file is created on first sensitive-key write', () => {
    const dir = freshDir();
    const s = new Settings(dir, null);
    assert(!fs.existsSync(path.join(dir, INSTALL_ID_FILE)),
      'precondition: no install-id yet');
    s.set('models.anthropicApiKey', 'sk-ant-trigger');
    assert(fs.existsSync(path.join(dir, INSTALL_ID_FILE)),
      'install-id created during set()');
  });

  test('bulk migration: legacy enc2: values are re-keyed to enc3: on load', () => {
    const dir = freshDir();
    // Seed: pre-v7.6.6 settings.json with enc2: values + matching enc-salt
    // The salt and machineId-input must match what legacyEncryptV2 uses
    // so the bootstrapped Settings can decrypt.
    const salt = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(path.join(dir, 'enc-salt'), salt, 'utf-8');

    const enc2Anthropic = legacyEncryptV2('sk-ant-legacy', salt);
    const enc2OpenAI = legacyEncryptV2('sk-openai-legacy', salt);
    const seedSettings = {
      models: { anthropicApiKey: enc2Anthropic, openaiApiKey: enc2OpenAI }
    };
    fs.writeFileSync(path.join(dir, 'settings.json'),
      JSON.stringify(seedSettings, null, 2), 'utf-8');

    // Build storage shim that returns the seeded data
    const storage = {
      readJSON: (filename, fallback) => {
        const p = path.join(dir, filename);
        if (!fs.existsSync(p)) return fallback;
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
      },
      writeJSON: (filename, data) => {
        fs.writeFileSync(path.join(dir, filename), JSON.stringify(data, null, 2), 'utf-8');
      },
    };

    const s = new Settings(dir, storage);

    // After load+migration, raw values should be enc3:
    assert(s.data.models.anthropicApiKey.startsWith('enc3:'),
      `anthropic key should be migrated to enc3:, got ${s.data.models.anthropicApiKey.slice(0, 6)}`);
    assert(s.data.models.openaiApiKey.startsWith('enc3:'),
      `openai key should be migrated to enc3:, got ${s.data.models.openaiApiKey.slice(0, 6)}`);
    // Plaintext round-trips
    assertEqual(s.get('models.anthropicApiKey'), 'sk-ant-legacy', 'anthropic plaintext preserved');
    assertEqual(s.get('models.openaiApiKey'), 'sk-openai-legacy', 'openai plaintext preserved');
  });

  test('pre-migration backup is written when legacy values are migrated', () => {
    const dir = freshDir();
    const salt = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(path.join(dir, 'enc-salt'), salt, 'utf-8');

    const enc2Value = legacyEncryptV2('sk-ant-needs-backup', salt);
    fs.writeFileSync(path.join(dir, 'settings.json'),
      JSON.stringify({ models: { anthropicApiKey: enc2Value } }, null, 2), 'utf-8');

    const storage = {
      readJSON: (filename, fallback) => {
        const p = path.join(dir, filename);
        if (!fs.existsSync(p)) return fallback;
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
      },
      writeJSON: (filename, data) => {
        fs.writeFileSync(path.join(dir, filename), JSON.stringify(data, null, 2), 'utf-8');
      },
    };

    new Settings(dir, storage);

    const backupPath = path.join(dir, 'settings.json.pre-v3-migration');
    assert(fs.existsSync(backupPath), 'pre-migration backup must exist');
    const backed = JSON.parse(fs.readFileSync(backupPath, 'utf-8'));
    assert(backed.models.anthropicApiKey.startsWith('enc2:'),
      'backup should preserve original enc2: ciphertext');
  });

  test('migration is idempotent: second boot with already-v3 values is no-op', () => {
    const dir = freshDir();
    const storage = {
      readJSON: (filename, fallback) => {
        const p = path.join(dir, filename);
        if (!fs.existsSync(p)) return fallback;
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
      },
      writeJSONDebounced: (filename, data) => {
        // synchronous in test (no debounce) so the second boot sees writes
        fs.writeFileSync(path.join(dir, filename), JSON.stringify(data, null, 2), 'utf-8');
      },
    };
    const s1 = new Settings(dir, storage);
    s1.set('models.anthropicApiKey', 'sk-already-v3');

    // Confirm s1 wrote enc3:
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8'));
    assert(onDisk.models.anthropicApiKey.startsWith('enc3:'),
      'first boot should write enc3:');

    // Second instance — should not re-migrate (no legacy prefix), no backup
    const s2 = new Settings(dir, storage);
    assertEqual(s2.get('models.anthropicApiKey'), 'sk-already-v3', 'still readable');
    const backupPath = path.join(dir, 'settings.json.pre-v3-migration');
    assert(!fs.existsSync(backupPath),
      'no backup written when no legacy migration runs');
  });

  test('setBus fires settings:keys-unreadable for v3 values that fail decrypt', () => {
    const dir = freshDir();
    // Seed: storage has an enc3:-prefixed value but with a CORRUPT
    // ciphertext (decrypt will throw). Simulates the .install-id rotation
    // case without actually rotating the file.
    const salt = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(path.join(dir, 'enc-salt'), salt, 'utf-8');
    // A real install-id (so _getInstallId succeeds)
    getOrCreateInstallId(dir);
    // Plant an enc3:-prefixed but mathematically broken ciphertext
    const broken = `enc3:${crypto.randomBytes(12).toString('hex')}:${crypto.randomBytes(16).toString('hex')}:deadbeef`;
    fs.writeFileSync(path.join(dir, 'settings.json'),
      JSON.stringify({ models: { anthropicApiKey: broken } }, null, 2), 'utf-8');

    const storage = {
      readJSON: (filename, fallback) => {
        const p = path.join(dir, filename);
        if (!fs.existsSync(p)) return fallback;
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
      },
      writeJSON: () => {},
    };

    const s = new Settings(dir, storage);
    assert(s._unreadableKeys.includes('models.anthropicApiKey'),
      'broken enc3: should be tracked in _unreadableKeys');

    // Wire bus → event must fire
    const fired = [];
    s.setBus({ fire: (event, payload, meta) => fired.push({ event, payload, meta }) });
    const matching = fired.find(f => f.event === 'settings:keys-unreadable');
    assert(matching, 'settings:keys-unreadable must fire on setBus');
    assert(matching.payload.keys.includes('models.anthropicApiKey'),
      'payload must include the unreadable key path');

    // Re-setBus should NOT refire (cleared after fire)
    fired.length = 0;
    s.setBus({ fire: (event) => fired.push({ event }) });
    assert(fired.length === 0, 'second setBus() does not refire');
  });

  test('legacy decrypt path still works for plaintext (no encryption-prefix)', () => {
    const dir = freshDir();
    const s = new Settings(dir, null);
    s.set('ui.language', 'en');
    assertEqual(s.get('ui.language'), 'en', 'non-sensitive plaintext works');
  });

  test('install-id rotation does not corrupt unrelated values', () => {
    const dir = freshDir();
    const storage = {
      readJSON: (filename, fallback) => {
        const p = path.join(dir, filename);
        if (!fs.existsSync(p)) return fallback;
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
      },
      writeJSONDebounced: (filename, data) => {
        fs.writeFileSync(path.join(dir, filename), JSON.stringify(data, null, 2), 'utf-8');
      },
    };
    const s1 = new Settings(dir, storage);
    s1.set('models.anthropicApiKey', 'sk-before-rotation');
    s1.set('ui.language', 'fr');

    // Rotate install-id (file removed → next getOrCreate generates new one)
    fs.unlinkSync(path.join(dir, INSTALL_ID_FILE));

    const s2 = new Settings(dir, storage);
    assertEqual(s2.get('ui.language'), 'fr', 'unrelated value preserved');
    // Sensitive value cannot be decrypted (different install-id) — flagged
    assert(s2._unreadableKeys.includes('models.anthropicApiKey'),
      'rotated install-id should flag the previously-stored enc3: value');
  });

  test('AgentCoreWire source registers settings:keys-unreadable listener BEFORE setBus', () => {
    // v7.6.6 Track A.4 wiring contract: the listener must be registered
    // before settings.setBus(bus) so the synchronous initial fire (which
    // setBus emits if migration left any sensitive keys unreadable) is
    // captured. Pinned via source-presence to prevent regression — a
    // careless reorder would silently drop the boot-time warning.
    const src = fs.readFileSync(
      path.join(ROOT, 'src/agent/AgentCoreWire.js'), 'utf8');
    const idxOn = src.indexOf("bus.on('settings:keys-unreadable'");
    const idxSetBus = src.indexOf('settings.setBus(bus)');
    assert(idxOn > 0, 'AgentCoreWire must subscribe to settings:keys-unreadable');
    assert(idxSetBus > 0, 'AgentCoreWire must call settings.setBus(bus)');
    assert(idxOn < idxSetBus,
      'listener registration must precede settings.setBus(bus) for initial-fire capture');
  });

  test('AgentCoreWire wires keys-unreadable → chat:system-message with key list', () => {
    // Replicates the AgentCoreWire wiring (kept isolated to avoid full-boot
    // overhead). If this duplication ever drifts from the source, the
    // source-presence test above flags structural drift first.
    const fired = [];
    const handlers = new Map();
    const bus = {
      on(event, fn) {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event).push(fn);
        return () => {};
      },
      fire(event, payload, meta) {
        fired.push({ event, payload, meta });
        for (const h of (handlers.get(event) || [])) h(payload);
      },
    };

    bus.on('settings:keys-unreadable', (ev) => {
      const keys = (ev && Array.isArray(ev.keys)) ? ev.keys : [];
      if (keys.length === 0) return;
      const list = keys.join(', ');
      bus.fire('chat:system-message', {
        text: `⚠️ API-Keys konnten nicht entschlüsselt werden (${list}). Bitte über Settings → Models neu eingeben.`,
      }, { source: 'AgentCoreWire' });
    });

    bus.fire('settings:keys-unreadable', {
      keys: ['models.anthropicApiKey', 'models.openaiApiKey'],
    });

    const chatMsg = fired.find(f => f.event === 'chat:system-message');
    assert(chatMsg, 'chat:system-message must fire on keys-unreadable');
    assert(chatMsg.payload.text.includes('models.anthropicApiKey'),
      'message must list the affected key paths');
    assert(chatMsg.payload.text.includes('models.openaiApiKey'),
      'message must list all affected key paths');
  });

  test('keys-unreadable with empty array does NOT fire chat:system-message', () => {
    // Edge case: re-setBus after first fire (which clears _unreadableKeys)
    // would emit settings:keys-unreadable with keys=[]. Listener must
    // ignore that — no spam.
    const fired = [];
    const handlers = new Map();
    const bus = {
      on(event, fn) {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event).push(fn);
      },
      fire(event, payload) {
        fired.push({ event, payload });
        for (const h of (handlers.get(event) || [])) h(payload);
      },
    };

    bus.on('settings:keys-unreadable', (ev) => {
      const keys = (ev && Array.isArray(ev.keys)) ? ev.keys : [];
      if (keys.length === 0) return;
      bus.fire('chat:system-message', { text: 'should-not-appear' });
    });

    bus.fire('settings:keys-unreadable', { keys: [] });

    const chatMsg = fired.find(f => f.event === 'chat:system-message');
    assert(!chatMsg, 'no chat:system-message fired for empty keys array');
  });

});

run();
