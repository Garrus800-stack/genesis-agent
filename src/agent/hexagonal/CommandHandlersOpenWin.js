// @ts-checked-v7.6.0
// ============================================================
// GENESIS — CommandHandlersOpenWin.js
// v7.6.0 Track A #3 — Windows resolver, extracted from
// CommandHandlersOpen.js.
//
// Pure async function — no `this`, no mixin. Caller passes a
// context bag with the shell adapter and helpers, gets back
// either a {path, via} object or null.
//
// Stages (in order):
//   1. KNOWN_WIN_APPS lookup → C:\Program Files\<dir>\<exe>
//   2. Registry HKLM Uninstall → InstallLocation + verified .exe
//   3. Start-Menu .lnk shortcut (winget/choco often only put a
//      .lnk into the Start Menu — Windows resolves it on launch)
//
// PATH probe (where.exe) is handled by the dispatcher because it
// is shared with Linux/macOS and lives one level up.
// ============================================================

'use strict';

const { _KNOWN_WIN_APPS } = require('./CommandHandlersInstallDB');

/**
 * @param {string} name           Lowercased app name
 * @param {object} ctx
 * @param {object} ctx.shell      Shell adapter
 * @param {Function} ctx.fileExists  async (path) → boolean
 * @param {Function} ctx.findMainExeInDir  async (dir, name) → path|null
 * @returns {Promise<{path: string, via: string} | null>}
 */
async function resolveWin(name, ctx) {
  const { shell, fileExists, findMainExeInDir } = ctx;

  // Stage 1: Standard install dirs from KNOWN_WIN_APPS.
  const known = _KNOWN_WIN_APPS[name.toLowerCase()];
  if (known) {
    const candidates = [
      `C:\\Program Files\\${known.dir}\\${known.exe}`,
      `C:\\Program Files (x86)\\${known.dir}\\${known.exe}`,
    ];
    for (const c of candidates) {
      if (await fileExists(c)) return { path: c, via: 'install-dir' };
    }
  }

  // Stage 2: Registry — VERIFY .exe actually exists inside the dir.
  // Earlier versions returned the registry's InstallLocation blindly,
  // which produced "Pfad: C:\Program Files\WinRAR" even when nothing
  // was actually there.
  try {
    const cmd = `reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall" /s /f "${name}" /d 2>nul | findstr /I "InstallLocation"`;
    const r = await shell.run(cmd, { tier: 'read', timeout: 8000 });
    if (r.stdout && r.stdout.trim()) {
      const m = r.stdout.match(/REG_SZ\s+(.+?)$/im);
      if (m && m[1]) {
        const dir = m[1].trim();
        const exe = await findMainExeInDir(dir, name);
        if (exe && await fileExists(exe)) {
          return { path: exe, via: 'registry+exe' };
        }
      }
    }
  } catch { /* skip */ }

  // Stage 3: Start-Menu .lnk lookup. winget installs into
  // %LOCALAPPDATA%\Microsoft\WinGet\Packages\... and only puts a .lnk
  // into the Start Menu. Windows resolves the .lnk to the real .exe
  // when launched via cmd /c start.
  // Exact name match — substring match found "GitHub Desktop.lnk" for
  // "git" requests.
  const lower = name.toLowerCase();
  const startMenuRoots = [
    `%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs`,
    `%PROGRAMDATA%\\Microsoft\\Windows\\Start Menu\\Programs`,
  ];
  for (const root of startMenuRoots) {
    try {
      const cmd = `dir /b /s /a-d "${root}\\${lower}.lnk" 2>nul`;
      const r = await shell.run(cmd, { tier: 'read' });
      if (r.stdout && r.stdout.trim()) {
        const first = r.stdout.trim().split('\n')[0].trim();
        if (first && /\.lnk$/i.test(first) && /[\\\/]/.test(first)) {
          return { path: first, via: 'startmenu-lnk' };
        }
      }
    } catch { /* skip */ }
  }

  return null;
}

module.exports = { resolveWin };
