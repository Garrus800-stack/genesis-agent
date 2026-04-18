#!/usr/bin/env node
// ============================================================
// GENESIS — scripts/start.js (v7.2.9)
//
// Entry point for `npm start`. Sets the Windows console codepage
// to UTF-8 (65001) BEFORE spawning Electron, so boot logs render
// em-dashes, arrows, and non-ASCII correctly instead of as CP850
// garbage ("ÔÇö" / "ÔåÆ").
//
// chcp must run in the parent process BEFORE the child is spawned
// because chcp modifies the Console's codepage (a Console-level
// setting), which is then inherited by the child. Running chcp
// INSIDE the child (e.g. from main.js) is too late — Electron's
// stdout is already bound.
//
// On non-Windows platforms this is a pure passthrough to electron.
// ============================================================

'use strict';

const { spawn, spawnSync } = require('child_process');
const path = require('path');

// ── Step 1: Set console codepage to UTF-8 on Windows ────────
if (process.platform === 'win32') {
  try {
    // `chcp` is a cmd.exe internal — invoke via `cmd /c` explicitly.
    // Avoids DEP0190 ("shell: true + args array" deprecation in Node 22+).
    spawnSync('cmd', ['/c', 'chcp', '65001'], { stdio: 'ignore' });
  } catch { /* non-fatal: some terminals don't support chcp */ }
}

// ── Step 2: Locate Electron binary and spawn ────────────────
// `require('electron')` returns the absolute path to the Electron binary
let electronPath;
try {
  electronPath = require('electron');
} catch (err) {
  console.error('[START] Failed to locate Electron. Did `npm install` run?');
  console.error(err.message);
  process.exit(1);
}

const appRoot = path.resolve(__dirname, '..');

const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  cwd: appRoot,
  windowsHide: false,
});

// ── Step 3: Forward exit code ───────────────────────────────
child.on('exit', (code, signal) => {
  if (signal) {
    // Re-raise signal on the parent process (Unix convention)
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on('error', (err) => {
  console.error('[START] Failed to launch Electron:', err.message);
  process.exit(1);
});
