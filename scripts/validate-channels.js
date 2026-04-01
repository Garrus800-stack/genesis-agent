#!/usr/bin/env node
// ============================================================
// GENESIS — scripts/validate-channels.js (v4.10.0)
//
// CI script: validates that preload.mjs IPC channel whitelists
// are in sync with the CHANNELS contract in main.js.
//
// Catches drift where a new IPC channel is added to main.js
// but forgotten in the preload whitelist (or vice versa).
//
// Usage:
//   node scripts/validate-channels.js          — report
//   node scripts/validate-channels.js --strict — exit 1 on mismatch
// ============================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const strict = process.argv.includes('--strict');

// ── Parse main.js CHANNELS ────────────────────────────────

function parseMainChannels(filePath) {
  const src = fs.readFileSync(filePath, 'utf-8');

  // Extract CHANNELS object block
  const channelsMatch = src.match(/const\s+CHANNELS\s*=\s*\{([\s\S]*?)\n\};/);
  if (!channelsMatch) {
    console.error('[CHANNELS] Could not find CHANNELS object in main.js');
    process.exit(1);
  }

  const block = channelsMatch[1];
  const channels = { invoke: [], send: [], receive: [] };

  // Match all channel keys — both handler channels and push-only
  const keyRegex = /'([^']+)':/g;
  let m;
  while ((m = keyRegex.exec(block)) !== null) {
    const channel = m[1];
    // Find the handler value for this key
    const afterKey = block.slice(m.index + m[0].length, m.index + m[0].length + 200);

    if (afterKey.match(/^\s*null/)) {
      // Push-only channel (Agent → UI)
      channels.receive.push(channel);
    } else if (afterKey.match(/^\s*async/)) {
      // Handler channel (UI → Agent via invoke)
      channels.invoke.push(channel);
    }
  }

  // Also find streaming/send channels registered via ipcMain.on
  const sendRegex = /ipcMain\.on\('([^']+)'/g;
  let sendMatch;
  while ((sendMatch = sendRegex.exec(src)) !== null) {
    channels.send.push(sendMatch[1]);
  }

  return channels;
}

// ── Parse preload.mjs whitelists ──────────────────────────

function parsePreloadChannels(filePath) {
  const src = fs.readFileSync(filePath, 'utf-8');

  const extract = (varName) => {
    const regex = new RegExp(`const\\s+${varName}\\s*=\\s*\\[([^\\]]+)\\]`, 's');
    const match = src.match(regex);
    if (!match) return [];
    return [...match[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  };

  return {
    invoke: extract('ALLOWED_INVOKE'),
    send: extract('ALLOWED_SEND'),
    receive: extract('ALLOWED_RECEIVE'),
  };
}

// ── Compare ───────────────────────────────────────────────

function compare(label, mainChannels, preloadChannels) {
  const mainSet = new Set(mainChannels);
  const preloadSet = new Set(preloadChannels);

  const missingInPreload = mainChannels.filter(c => !preloadSet.has(c));
  const extraInPreload = preloadChannels.filter(c => !mainSet.has(c));

  return { label, missingInPreload, extraInPreload, synced: missingInPreload.length === 0 && extraInPreload.length === 0 };
}

// ── Main ──────────────────────────────────────────────────

console.log('\n━━━ Channel Sync Validation ━━━\n');

const mainPath = path.join(ROOT, 'main.js');
// v4.10.0: Support both ESM (.mjs) and CJS (.js) preload
const preloadPathMjs = path.join(ROOT, 'preload.mjs');
const preloadPathCjs = path.join(ROOT, 'preload.js');
const preloadPath = fs.existsSync(preloadPathCjs) ? preloadPathCjs : preloadPathMjs;

if (!fs.existsSync(mainPath) || !fs.existsSync(preloadPath)) {
  console.error('[CHANNELS] main.js or preload not found');
  process.exit(1);
}

const mainChannels = parseMainChannels(mainPath);
const preloadChannels = parsePreloadChannels(preloadPath);

let hasErrors = false;

for (const type of ['invoke', 'send', 'receive']) {
  const result = compare(type.toUpperCase(), mainChannels[type], preloadChannels[type]);

  if (result.synced) {
    console.log(`  ✅ ${result.label}: ${preloadChannels[type].length} channels in sync`);
  } else {
    hasErrors = true;
    if (result.missingInPreload.length > 0) {
      console.log(`  ❌ ${result.label}: Missing in preload.mjs:`);
      for (const c of result.missingInPreload) {
        console.log(`     + '${c}'`);
      }
    }
    if (result.extraInPreload.length > 0) {
      console.log(`  ⚠️  ${result.label}: In preload.mjs but not in main.js:`);
      for (const c of result.extraInPreload) {
        console.log(`     - '${c}'`);
      }
    }
  }
}

const totalMain = mainChannels.invoke.length + mainChannels.send.length + mainChannels.receive.length;
const totalPreload = preloadChannels.invoke.length + preloadChannels.send.length + preloadChannels.receive.length;

console.log(`\n  Summary: main.js=${totalMain} channels, preload.mjs=${totalPreload} channels`);

if (hasErrors) {
  console.log('\n  ⚠️  Channel mismatch detected!');
  if (strict) {
    console.error('  Failing due to --strict mode.\n');
    process.exit(1);
  }
} else {
  console.log('\n  ✅ All channels in sync.\n');
}
