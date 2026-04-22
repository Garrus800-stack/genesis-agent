#!/usr/bin/env node
// ============================================================
// GENESIS — scripts/migrate-episodes-to-layers.js (v7.3.7)
//
// Adds the v7.3.7 layer-system fields to existing episodes in
// .genesis/episodic-memory.json. Idempotent — episodes that
// already have a `layer` field are skipped.
//
// CRITICAL INVARIANT: layerHistory[0].since = episode.timestamp
// (the original recording timestamp), NEVER Date.now(). This is
// what makes partial migrations (e.g. interrupted by a crash)
// safe — the second pass continues with original data, not
// drifted timestamps.
//
// USAGE:
//   node scripts/migrate-episodes-to-layers.js [.genesis-dir]
//
// If no .genesis-dir is given, the default is $HOME/.genesis or
// the GENESIS_HOME env var.
//
// Note: Genesis also self-migrates on _load() — this script is a
// belt-and-suspenders option for explicit pre-boot migration.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

function resolveGenesisDir(argv) {
  if (argv[2]) return path.resolve(argv[2]);
  if (process.env.GENESIS_HOME) return path.resolve(process.env.GENESIS_HOME);
  return path.join(os.homedir(), '.genesis');
}

function migrateEpisodes(filePath) {
  if (!fs.existsSync(filePath)) {
    console.log(`[migrate] No file at ${filePath} — nothing to do.`);
    return { migrated: 0, skipped: 0, total: 0 };
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.error(`[migrate] Failed to parse ${filePath}: ${e.message}`);
    process.exit(2);
  }

  if (!data || !Array.isArray(data.episodes)) {
    console.log(`[migrate] No episodes array in ${filePath}.`);
    return { migrated: 0, skipped: 0, total: 0 };
  }

  let migrated = 0;
  let skipped = 0;

  for (const ep of data.episodes) {
    if (ep.layer !== undefined) {
      skipped++;
      continue;
    }
    ep.layer = 1;
    // Original timestamp — never Date.now()
    ep.layerHistory = [{ layer: 1, since: ep.timestamp }];
    ep.immuneAnchors = ep.immuneAnchors || [];
    ep.protected = ep.protected === true;
    ep.linkedCoreMemoryId = ep.linkedCoreMemoryId || null;
    ep.lastConsolidatedAt = null;
    ep.feelingEssence = null;
    ep.pinStatus = null;
    ep.pinnedAt = null;
    ep.pinReviewedAt = null;
    migrated++;
  }

  if (migrated > 0) {
    // Write back atomically: tmp + rename
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, filePath);
    console.log(`[migrate] Migrated ${migrated} episodes (skipped ${skipped} already-migrated, total ${data.episodes.length}).`);
  } else {
    console.log(`[migrate] No migration needed — ${skipped} episodes already at v7.3.7 schema (total ${data.episodes.length}).`);
  }

  return { migrated, skipped, total: data.episodes.length };
}

if (require.main === module) {
  const dir = resolveGenesisDir(process.argv);
  const file = path.join(dir, 'episodic-memory.json');
  console.log(`[migrate] Targeting ${file}`);
  const result = migrateEpisodes(file);
  process.exit(result.migrated >= 0 ? 0 : 1);
}

module.exports = { migrateEpisodes };
