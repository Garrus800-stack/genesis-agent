// @ts-checked-v7.6.0
// ============================================================
// GENESIS — CommandHandlersOpenLinux.js
// v7.6.0 Track A #3 — Linux resolver, extracted from
// CommandHandlersOpen.js.
//
// Pure async function — no `this`, no mixin.
//
// Stages (in order):
//   1. Common install dirs (/usr/bin, /usr/local/bin, /snap/bin,
//      ~/.local/bin, /opt/<name>/<name>)
//   2. .desktop file lookup in standard application roots
//      (/usr/share/applications, ~/.local/share/applications,
//      flatpak exports). Read the Exec= line, resolve to a binary
//      path, verify on disk.
//
// PATH probe (command -v / which) is handled by the dispatcher
// because it is shared with macOS/Windows and lives one level up.
//
// Future Linux polish (snap-as-Tier-1, transitional snap detection,
// Trust 1 own-user-folders) lands here without touching the
// dispatcher or the other platform resolvers.
// ============================================================

'use strict';

const os = require('os');
const path = require('path');

/**
 * @param {string} name           App name
 * @param {object} ctx
 * @param {object} ctx.shell      Shell adapter
 * @param {Function} ctx.fileExists  async (path) → boolean
 * @returns {Promise<{path: string, via: string} | null>}
 */
async function resolveLinux(name, ctx) {
  const { shell, fileExists } = ctx;
  const home = os.homedir();

  // Stage 1: Common install dirs.
  const commonDirs = [
    '/usr/bin',
    '/usr/local/bin',
    '/snap/bin',
    `/opt/${name}/${name}`,
    path.join(home, '.local/bin'),
  ];
  for (const dir of commonDirs) {
    const candidate = `${dir}/${name}`;
    if (await fileExists(candidate)) {
      return { path: candidate, via: 'common-dir' };
    }
  }

  // Stage 2: .desktop file lookup. Applications installed via package
  // manager often expose only a .desktop file with the Exec= line.
  const desktopRoots = [
    '/usr/share/applications',
    '/usr/local/share/applications',
    path.join(home, '.local/share/applications'),
    '/var/lib/flatpak/exports/share/applications',
    path.join(home, '.local/share/flatpak/exports/share/applications'),
  ];
  for (const root of desktopRoots) {
    try {
      // Look for <name>.desktop and *<name>*.desktop (case-insensitive).
      const cmd = `ls "${root}" 2>/dev/null | grep -i "${name}" | grep -i "\\.desktop$" | head -1`;
      const r = await shell.run(cmd, { tier: 'read' });
      if (r.stdout && r.stdout.trim()) {
        const file = r.stdout.trim().split('\n')[0].trim();
        const fullPath = `${root}/${file}`;
        if (await fileExists(fullPath)) {
          // Read the Exec= line and use that binary.
          const execCmd = `grep -m 1 "^Exec=" "${fullPath}" | cut -d= -f2- | awk '{print $1}'`;
          const er = await shell.run(execCmd, { tier: 'read' });
          if (er.stdout && er.stdout.trim()) {
            const exe = er.stdout.trim();
            // Exec might be a bare name or absolute path.
            if (exe.startsWith('/') && await fileExists(exe)) {
              return { path: exe, via: 'desktop-file' };
            }
            // Bare name — re-probe via command -v.
            try {
              const cv = await shell.run(`command -v ${exe}`, { tier: 'read' });
              if (cv.stdout && cv.stdout.trim()) {
                const resolvedExe = cv.stdout.trim().split('\n')[0].trim();
                if (await fileExists(resolvedExe)) {
                  return { path: resolvedExe, via: 'desktop-file' };
                }
              }
            } catch { /* skip */ }
          }
        }
      }
    } catch { /* skip */ }
  }

  return null;
}

module.exports = { resolveLinux };
