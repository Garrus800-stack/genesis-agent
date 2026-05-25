// ============================================================
// GENESIS — v798-user-settings-preservation.contract.test.js
//
// Pins the v7.9.8 invariants protecting explicit user settings
// from being silently overwritten by boot, migration, or default-
// application paths.
//
//   User-Settings are sacred. What the user has set, stays set.
//   No version upgrade, no boot sequence, no migration path may
//   ever overwrite an explicit user value silently. Defaults
//   apply only to keys that don't exist yet — fresh installs,
//   or keys newly added to the schema.
//
// The tests below verify this for the trust-level subsystem
// (the one v7.9.8 directly addresses), and pin the SUPERVISED
// default for fresh-install scenarios.
// ============================================================

'use strict';

const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '../..');
const { describe, test, assert, assertEqual, run } = require('../harness');

const { TrustLevelSystem, TRUST_LEVELS } = require(
  path.join(ROOT, 'src/agent/foundation/TrustLevelSystem'));

// ── Mock helpers ────────────────────────────────────────────

function makeNoopBus() {
  return { on: () => () => {}, fire() {}, emit() {} };
}

function makeStorage(initial) {
  const data = initial || null;
  const writes = [];
  return {
    readJSON: async () => data,
    writeJSON: async (key, value) => { writes.push({ key, value }); },
    _writes: writes,
  };
}

function makeSettings(initial) {
  const data = initial || {};
  const writes = [];
  return {
    get: (path) => {
      const parts = path.split('.');
      let obj = data;
      for (const p of parts) {
        if (!obj || typeof obj !== 'object') return undefined;
        obj = obj[p];
      }
      return obj;
    },
    set: (path, value) => {
      writes.push({ path, value });
      const parts = path.split('.');
      let obj = data;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!obj[parts[i]] || typeof obj[parts[i]] !== 'object') obj[parts[i]] = {};
        obj = obj[parts[i]];
      }
      obj[parts[parts.length - 1]] = value;
    },
    _data: data,
    _writes: writes,
  };
}

describe('v7.9.8 User-Settings-Preservation', () => {

// ── Fresh-install defaults ─────────────────────────────────

test('SUP-01: fresh install (no storage, no settings) defaults to SUPERVISED', () => {
  const tls = new TrustLevelSystem({ bus: makeNoopBus(), storage: makeStorage(null) });
  assertEqual(tls.getLevel(), TRUST_LEVELS.SUPERVISED,
    'fresh install must default to SUPERVISED (safest opt-in)');
});

test('SUP-02: cfg.level undefined → SUPERVISED', () => {
  const tls = new TrustLevelSystem({ bus: makeNoopBus(), storage: makeStorage(null), config: {} });
  assertEqual(tls.getLevel(), TRUST_LEVELS.SUPERVISED);
});

test('SUP-03: _migrateLevel(corrupt) → SUPERVISED (not AUTONOMOUS)', () => {
  assertEqual(TrustLevelSystem._migrateLevel(NaN), TRUST_LEVELS.SUPERVISED);
  assertEqual(TrustLevelSystem._migrateLevel(undefined), TRUST_LEVELS.SUPERVISED);
  assertEqual(TrustLevelSystem._migrateLevel('not a number'), TRUST_LEVELS.SUPERVISED);
  assertEqual(TrustLevelSystem._migrateLevel(99), TRUST_LEVELS.SUPERVISED);
  assertEqual(TrustLevelSystem._migrateLevel(-1), TRUST_LEVELS.SUPERVISED);
});

test('SUP-04: settings-defaults.js set-trust-level default is 0 (SUPERVISED)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/ui/modules/settings-defaults.js'), 'utf8');
  const match = src.match(/'set-trust-level'[^}]*default:\s*(\d+)/);
  assert(match, 'set-trust-level entry must exist');
  assertEqual(match[1], '0',
    'set-trust-level default must be 0 (SUPERVISED) for fresh installs');
});

// ── Existing-user preservation ─────────────────────────────

test('PRES-01: existing stored trust.level=1 (no schemaVersion) migrates to SUPERVISED (v7.9.9 A)', async () => {
  // Pre-schemaVersion storage with level=1 represents either pre-v7.9.7 ASSISTED
  // or the brief v7.9.7-only AUTONOMOUS=1. v7.9.9 (A) re-buckets ASSISTED users
  // to SUPERVISED — the safer default direction since "ask for risky" no longer
  // exists as a level. Both interpretations land safely at "always ask".
  const storage = makeStorage({ level: 1, overrides: {}, pendingUpgrades: [] });
  const tls = new TrustLevelSystem({ bus: makeNoopBus(), storage });
  await tls.asyncLoad();
  assertEqual(tls.getLevel(), TRUST_LEVELS.SUPERVISED,
    'v7.9.9 (A): un-marked stored level=1 must migrate to SUPERVISED (not AUTONOMOUS)');
});

test('PRES-02: existing stored trust.level=2 (FULL) is preserved on load', async () => {
  const storage = makeStorage({ level: 2, overrides: {}, pendingUpgrades: [] });
  const tls = new TrustLevelSystem({ bus: makeNoopBus(), storage });
  await tls.asyncLoad();
  // In the 3-level world, raw 2 stored by post-v7.9.7 means new-AUTONOMOUS
  // (migration: 2 → 1). User who set 2 in pre-v7.9.7 was alt-AUTONOMOUS,
  // which still maps to new-AUTONOMOUS — same behaviour either way.
  assertEqual(tls.getLevel(), TRUST_LEVELS.AUTONOMOUS,
    'stored 2 → AUTONOMOUS (semantic preservation of pre-v7.9.7 alt-AUTONOMOUS)');
});

test('PRES-03: existing settings.trust.level=1 migrates to SUPERVISED (v7.9.9 A)', async () => {
  const settings = makeSettings({ trust: { level: 1 } });
  const tls = new TrustLevelSystem({ bus: makeNoopBus(), storage: makeStorage(null), settings });
  await tls.asyncLoad();
  assertEqual(tls.getLevel(), TRUST_LEVELS.SUPERVISED,
    'v7.9.9 (A): settings level=1 without storage marker migrates to SUPERVISED');
});

test('PRES-04: settings level=1 triggers migration writeback (v7.9.9 A)', async () => {
  const settings = makeSettings({ trust: { level: 1 } });
  const tls = new TrustLevelSystem({ bus: makeNoopBus(), storage: makeStorage(null), settings });
  await tls.asyncLoad();
  // v7.9.9 (A): level=1 now migrates to 0 (SUPERVISED), so writeback DOES happen.
  // The invariant that "an explicit user value isn't silently overwritten" still
  // holds in spirit — the migration is announced and the new value is the safer one.
  const writes = settings._writes.filter(w => w.path === 'trust.level');
  assertEqual(writes.length, 1,
    'asyncLoad must write back the migrated value (1→0) exactly once');
  assertEqual(writes[0].value, TRUST_LEVELS.SUPERVISED,
    'writeback must record the migrated SUPERVISED value');
});

// ── Migration writeback (v7.9.8 Fix 1) ─────────────────────

test('MIG-01: storage migration writes back so next boot sees clean value', async () => {
  // Old 4-level stored value 3 = FULL → new 3-level FULL_AUTONOMY = 2.
  const storage = makeStorage({ level: 3, overrides: {}, pendingUpgrades: [] });
  const tls = new TrustLevelSystem({ bus: makeNoopBus(), storage });
  await tls.asyncLoad();
  assertEqual(tls.getLevel(), TRUST_LEVELS.FULL_AUTONOMY,
    'migration must map old 3 (FULL) to new 2 (FULL_AUTONOMY)');
  // v7.9.8 Fix 1: writeback must have happened.
  const writes = storage._writes;
  assert(writes.length >= 1,
    'asyncLoad must persist the migrated value (got no writes)');
  const last = writes[writes.length - 1];
  assertEqual(last.value.level, TRUST_LEVELS.FULL_AUTONOMY,
    'persisted value must be the migrated level, not the raw stored level');
});

test('MIG-02: settings migration writes back via settings.set', async () => {
  const settings = makeSettings({ trust: { level: 3 } });
  const tls = new TrustLevelSystem({ bus: makeNoopBus(), storage: makeStorage(null), settings });
  await tls.asyncLoad();
  assertEqual(tls.getLevel(), TRUST_LEVELS.FULL_AUTONOMY);
  // v7.9.8 Fix 1: settings.set must have been called with the migrated value.
  const trustWrites = settings._writes.filter(w => w.path === 'trust.level');
  assert(trustWrites.length >= 1,
    'asyncLoad must persist the migrated settings value');
  assertEqual(trustWrites[trustWrites.length - 1].value, TRUST_LEVELS.FULL_AUTONOMY,
    'persisted settings value must match the migrated level');
});

test('MIG-03: storage writeback survives storage.writeJSON failure (boot still succeeds)', async () => {
  const failingStorage = {
    readJSON: async () => ({ level: 3, overrides: {}, pendingUpgrades: [] }),
    writeJSON: async () => { throw new Error('disk full'); },
  };
  const tls = new TrustLevelSystem({ bus: makeNoopBus(), storage: failingStorage });
  // Must not throw — boot must complete even if writeback fails.
  await tls.asyncLoad();
  // The runtime level still migrated correctly even though persistence failed.
  assertEqual(tls.getLevel(), TRUST_LEVELS.FULL_AUTONOMY,
    'runtime migration must succeed even when storage.writeJSON throws');
});

test('MIG-04: settings writeback survives settings.set failure (boot still succeeds)', async () => {
  const failingSettings = {
    get: () => 3,
    set: () => { throw new Error('settings locked'); },
  };
  const tls = new TrustLevelSystem({ bus: makeNoopBus(), storage: makeStorage(null), settings: failingSettings });
  await tls.asyncLoad();
  assertEqual(tls.getLevel(), TRUST_LEVELS.FULL_AUTONOMY,
    'runtime migration must succeed even when settings.set throws');
});

// ── No double-migration ────────────────────────────────────

test('NODOUBLE-01: second boot after migration leaves the value untouched', async () => {
  // First boot migrates 3 → 2.
  const storedData = { level: 3, overrides: {}, pendingUpgrades: [] };
  const storage = {
    readJSON: async () => storedData,
    writeJSON: async (_key, value) => { Object.assign(storedData, value); },
  };
  const tls1 = new TrustLevelSystem({ bus: makeNoopBus(), storage });
  await tls1.asyncLoad();
  assertEqual(tls1.getLevel(), TRUST_LEVELS.FULL_AUTONOMY);
  assertEqual(storedData.level, TRUST_LEVELS.FULL_AUTONOMY, 'storage now has 2, not 3');

  // Second boot: same storage, fresh TrustLevelSystem.
  const writesBeforeSecondBoot = [];
  const storage2 = {
    readJSON: async () => storedData,
    writeJSON: async (key, value) => { writesBeforeSecondBoot.push({ key, value }); },
  };
  const tls2 = new TrustLevelSystem({ bus: makeNoopBus(), storage: storage2 });
  await tls2.asyncLoad();
  assertEqual(tls2.getLevel(), TRUST_LEVELS.FULL_AUTONOMY, 'second boot still has level 2');
  // Critical: no re-migration writeback, because no migration happened.
  assertEqual(writesBeforeSecondBoot.length, 0,
    'second boot must NOT re-persist an already-migrated value');
});

// ── Settings clamp removed (v7.9.8 Fix 3) ──────────────────

test('CLAMP-01: Settings.js no longer clamps trust.level (TrustLevelSystem owns validation)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/Settings.js'), 'utf8');
  assert(!/clamp\('trust\.level',\s*0,\s*3\)/.test(src),
    'old clamp(0,3) for trust.level must be removed in v7.9.8');
  assert(!/clamp\('trust\.level',\s*0,\s*2\)/.test(src),
    'clamp(0,2) would still collapse pre-migration values; must be fully removed');
});

// ── v7.9.9 (A) Trust-system final corrections ─────────────

test('V799A-01: Settings.js trust default reads { level: 0 } not 1', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/Settings.js'), 'utf8');
  assert(/trust:\s*\{\s*level:\s*0\s*\}/.test(src),
    'v7.9.9 (A): Settings.js fresh-install default must be { level: 0 }');
  assert(!/trust:\s*\{\s*level:\s*1\s*\}/.test(src),
    'v7.9.9 (A): old { level: 1 } default must be removed');
});

test('V799A-02: Settings.js trust comment reads 0..2 not 0..3', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/Settings.js'), 'utf8');
  // Look for the trust-level documentation comment block.
  const idx = src.indexOf('trust: { level: 0 }');
  assert(idx > 0, 'must find trust default declaration');
  const before = src.slice(Math.max(0, idx - 400), idx);
  assert(/0\.\.2\s*=\s*SUPERVISED.*FULL_AUTONOMY/.test(before),
    'v7.9.9 (A): trust comment must document range as 0..2 = SUPERVISED..FULL_AUTONOMY');
  assert(!/0\.\.3\s*=\s*SUPERVISED.*FULL_AUTONOMY/.test(before),
    'v7.9.9 (A): stale 0..3 range comment must be removed');
});

test('V799A-03: _migrateLevel(1) returns SUPERVISED (not AUTONOMOUS)', () => {
  assertEqual(TrustLevelSystem._migrateLevel(1), TRUST_LEVELS.SUPERVISED,
    'v7.9.9 (A): old ASSISTED (1) must migrate to SUPERVISED (safer-default rebucket)');
  // Sanity: other entries unchanged
  assertEqual(TrustLevelSystem._migrateLevel(0), TRUST_LEVELS.SUPERVISED, 'level 0 → SUPERVISED unchanged');
  assertEqual(TrustLevelSystem._migrateLevel(2), TRUST_LEVELS.AUTONOMOUS, 'level 2 → AUTONOMOUS unchanged');
  assertEqual(TrustLevelSystem._migrateLevel(3), TRUST_LEVELS.FULL_AUTONOMY, 'level 3 → FULL_AUTONOMY unchanged');
});

}); // describe

run().catch(err => { console.error(err); process.exit(1); });
