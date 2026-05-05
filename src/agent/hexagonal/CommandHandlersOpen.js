// @ts-checked-v7.5.9
'use strict';

const { createLogger } = require('../core/Logger');
const _log = createLogger('CommandHandlersOpen');

const _PRONOUN_PATTERN = /^(?:es|das|ihn|sie|the\s+app|it)$/i;

const CommandHandlersOpen = {

  async openSoftware(message) {
    const trustLevel = (typeof this.trustLevelSystem?.getLevel === 'function')
      ? this.trustLevelSystem.getLevel() : 1;
    if (trustLevel < 1) {
      return `[OPEN-GUARD] Anwendungs-Start gesperrt im Trust-Level SUPERVISED.`;
    }

    const target = this._extractOpenTarget(message);
    if (!target.name) {
      const last = (typeof this._getLastInstalled === 'function') ? this._getLastInstalled() : null;
      if (last && last.packageName && target.usedPronoun) {
        return await this._launch(last.packageName, last.installPath);
      }
      if (last && last.packageName) {
        return `Was soll ich öffnen? Beispiel: \`/open ${last.packageName}\``;
      }
      return `Was soll ich öffnen? Beispiel: \`/open firefox\``;
    }

    let preamble = '';
    if (target.extraTokens) {
      preamble = `(Hinweis: zusätzliche Argumente "${target.extraTokens}" wurden ignoriert — /open startet nur die Anwendung.)\n\n`;
    }
    const result = await this._launch(target.name, null);
    return preamble + result;
  },

  async _launch(name, knownPath) {
    if (!this.shell) return 'Shell nicht verfügbar';

    const resolved = await this._resolveLaunchPath(name, knownPath);
    if (!resolved) {
      // v7.5.9 Linux-fix: platform-specific search-source list. Pre-fix
      // hardcoded "Windows-Registry, Start-Menu-Shortcuts" even on Linux.
      const sources = process.platform === 'win32'
        ? 'PATH-Probe, Windows-Registry, Standard-Programme, Start-Menu-Shortcuts'
        : process.platform === 'darwin'
          ? 'PATH-Probe, /Applications'
          : 'PATH-Probe (which/command -v), /usr/bin, /usr/local/bin, /snap/bin, ~/.local/bin, .desktop-Files';
      const hint = process.platform === 'win32'
        ? `Falls die Anwendung im Start-Menü auftaucht aber Genesis sie nicht findet, sag mir den genauen Namen wie er dort steht.`
        : `Falls die Anwendung installiert ist aber nicht gefunden wird, gib mir den vollen Pfad: \`/open /pfad/zur/binary\`.`;
      return [
        `**${name}** ist nicht aufzuspüren.`,
        ``,
        `Probiert: ${sources}.`,
        hint,
      ].join('\n');
    }

    const launchCmd = process.platform === 'win32'
      ? `cmd /c start "" "${resolved.path}"`
      : process.platform === 'darwin' ? `open "${resolved.path}"` : `xdg-open "${resolved.path}"`;
    _log.info(`[OPEN] launching: ${launchCmd}  (via=${resolved.via})`);

    try {
      const r = await this.shell.run(launchCmd, { tier: 'write', timeout: 5000 });
      if (r.ok === false || (r.exitCode !== 0 && r.exitCode !== undefined)) {
        const errMsg = (r.stderr || '').trim() || 'unbekannter Fehler';
        return `**${name}** konnte nicht gestartet werden: ${errMsg}\n\nVersuchter Pfad: \`${resolved.path}\``;
      }
      return `**${name}** gestartet ✅\n\nPfad: \`${resolved.path}\` _(via ${resolved.via})_`;
    } catch (err) {
      return `**${name}** konnte nicht gestartet werden: ${err.message}`;
    }
  },

  // Returns {path, via} or null. Each candidate is verified to actually
  // exist on disk before being returned.
  async _resolveLaunchPath(name, knownPath) {
    if (knownPath) {
      if (process.platform === 'win32' && !/\.(exe|lnk)$/i.test(knownPath)) {
        const exe = await this._findMainExeInDir(knownPath, name);
        if (exe) return { path: exe, via: 'install-dir-exe' };
      } else {
        if (await this._fileExists(knownPath)) return { path: knownPath, via: 'known' };
      }
    }

    // Stage 1: PATH probe.
    const probes = process.platform === 'win32'
      ? [`where.exe ${name}`, `where.exe ${name}.exe`]
      : [`command -v ${name}`, `which ${name}`];
    for (const probe of probes) {
      try {
        const r = await this.shell.run(probe, { tier: 'read' });
        if ((r.ok !== false) && (r.exitCode === 0 || r.exitCode === undefined) && r.stdout) {
          const firstLine = r.stdout.trim().split('\n')[0].trim();
          if (firstLine && await this._fileExists(firstLine)) {
            return { path: firstLine, via: 'path' };
          }
        }
      } catch { /* skip */ }
    }

    if (process.platform !== 'win32') {
      // Linux/macOS: stage 2+3 — common install dirs and (Linux) .desktop files.
      const home = require('os').homedir();
      const commonDirs = process.platform === 'darwin'
        ? ['/Applications', '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin']
        : ['/usr/bin', '/usr/local/bin', '/snap/bin', '/opt/' + name + '/' + name,
           require('path').join(home, '.local/bin')];
      for (const dir of commonDirs) {
        const candidate = process.platform === 'darwin' && dir === '/Applications'
          ? `${dir}/${name}.app`
          : `${dir}/${name}`;
        if (await this._fileExists(candidate)) {
          return { path: candidate, via: 'common-dir' };
        }
      }
      // Linux .desktop file lookup — applications installed via package
      // manager often expose only a .desktop file with the Exec= line.
      if (process.platform === 'linux') {
        const desktopRoots = [
          '/usr/share/applications',
          '/usr/local/share/applications',
          require('path').join(home, '.local/share/applications'),
          '/var/lib/flatpak/exports/share/applications',
          require('path').join(home, '.local/share/flatpak/exports/share/applications'),
        ];
        for (const root of desktopRoots) {
          try {
            // Look for <name>.desktop and *<name>*.desktop (case-insensitive).
            const cmd = `ls "${root}" 2>/dev/null | grep -i "${name}" | grep -i "\\.desktop$" | head -1`;
            const r = await this.shell.run(cmd, { tier: 'read' });
            if (r.stdout && r.stdout.trim()) {
              const file = r.stdout.trim().split('\n')[0].trim();
              const fullPath = `${root}/${file}`;
              if (await this._fileExists(fullPath)) {
                // Read the Exec= line and use that binary.
                const execCmd = `grep -m 1 "^Exec=" "${fullPath}" | cut -d= -f2- | awk '{print $1}'`;
                const er = await this.shell.run(execCmd, { tier: 'read' });
                if (er.stdout && er.stdout.trim()) {
                  const exe = er.stdout.trim();
                  // Exec might be a bare name or absolute path.
                  if (exe.startsWith('/') && await this._fileExists(exe)) {
                    return { path: exe, via: 'desktop-file' };
                  }
                  // Bare name — re-probe via command -v.
                  try {
                    const cv = await this.shell.run(`command -v ${exe}`, { tier: 'read' });
                    if (cv.stdout && cv.stdout.trim()) {
                      const resolvedExe = cv.stdout.trim().split('\n')[0].trim();
                      if (await this._fileExists(resolvedExe)) {
                        return { path: resolvedExe, via: 'desktop-file' };
                      }
                    }
                  } catch { /* skip */ }
                }
              }
            }
          } catch { /* skip */ }
        }
      }
      return null;
    }

    // Stage 2: Standard install dirs (Windows).
    const KNOWN_APPS = {
      'winrar':    { dir: 'WinRAR',          exe: 'WinRAR.exe' },
      '7zip':      { dir: '7-Zip',           exe: '7zFM.exe' },
      'notepad++': { dir: 'Notepad++',       exe: 'notepad++.exe' },
      'vlc':       { dir: 'VideoLAN\\VLC',   exe: 'vlc.exe' },
      'firefox':   { dir: 'Mozilla Firefox', exe: 'firefox.exe' },
      'chrome':    { dir: 'Google\\Chrome\\Application', exe: 'chrome.exe' },
    };
    const known = KNOWN_APPS[name.toLowerCase()];
    if (known) {
      const candidates = [
        `C:\\Program Files\\${known.dir}\\${known.exe}`,
        `C:\\Program Files (x86)\\${known.dir}\\${known.exe}`,
      ];
      for (const c of candidates) {
        if (await this._fileExists(c)) return { path: c, via: 'install-dir' };
      }
    }

    // Stage 3: Registry — but VERIFY .exe exists inside the dir.
    try {
      const cmd = `reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall" /s /f "${name}" /d 2>nul | findstr /I "InstallLocation"`;
      const r = await this.shell.run(cmd, { tier: 'read', timeout: 8000 });
      if (r.stdout && r.stdout.trim()) {
        const m = r.stdout.match(/REG_SZ\s+(.+?)$/im);
        if (m && m[1]) {
          const dir = m[1].trim();
          const exe = await this._findMainExeInDir(dir, name);
          if (exe && await this._fileExists(exe)) {
            return { path: exe, via: 'registry+exe' };
          }
        }
      }
    } catch { /* skip */ }

    // Stage 4: Start-Menu .lnk lookup. winget installs into
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
        const r = await this.shell.run(cmd, { tier: 'read' });
        if (r.stdout && r.stdout.trim()) {
          const first = r.stdout.trim().split('\n')[0].trim();
          if (first && /\.lnk$/i.test(first) && /[\\\/]/.test(first)) {
            return { path: first, via: 'startmenu-lnk' };
          }
        }
      } catch { /* skip */ }
    }

    return null;
  },

  async _fileExists(filePath) {
    if (!this.shell) return false;
    if (process.platform === 'win32') {
      try {
        const r = await this.shell.run(`if exist "${filePath}" echo FOUND`, { tier: 'read' });
        return /FOUND/.test(r.stdout || '');
      } catch { return false; }
    }
    try {
      const r = await this.shell.run(`test -e "${filePath}" && echo FOUND`, { tier: 'read' });
      return /FOUND/.test(r.stdout || '');
    } catch { return false; }
  },

  async _findMainExeInDir(dir, packageName) {
    if (!this.shell) return null;
    const KNOWN_EXES = {
      'winrar':    'WinRAR.exe',
      '7zip':      '7zFM.exe',
      'notepad++': 'notepad++.exe',
      'vlc':       'vlc.exe',
      'firefox':   'firefox.exe',
      'chrome':    'chrome.exe',
    };
    const known = KNOWN_EXES[packageName.toLowerCase()];
    if (known) {
      const candidate = `${dir}\\${known}`;
      if (await this._fileExists(candidate)) return candidate;
    }
    try {
      const r = await this.shell.run(`dir /b "${dir}\\*.exe" 2>nul`, { tier: 'read' });
      if (r.stdout && r.stdout.trim()) {
        const first = r.stdout.trim().split('\n')[0].trim();
        if (first) {
          const candidate = `${dir}\\${first}`;
          if (await this._fileExists(candidate)) return candidate;
        }
      }
    } catch { /* skip */ }
    return null;
  },

  _extractOpenTarget(message) {
    if (typeof message !== 'string') return { name: null, usedPronoun: false, extraTokens: null };
    const slashMatch = message.match(/(?:^|\s)\/open\s+(.+)/i);
    if (slashMatch) {
      const tokens = slashMatch[1].trim().split(/\s+/);
      const first = tokens[0];
      if (_PRONOUN_PATTERN.test(first)) return { name: null, usedPronoun: true, extraTokens: null };
      return {
        name: first,
        usedPronoun: false,
        extraTokens: tokens.length > 1 ? tokens.slice(1).join(' ') : null,
      };
    }
    const freeText = message.match(
      /(?:öffne|starte?|run|launch|f[üu]hre)\s+(?:mir\s+)?(?:bitte\s+)?(.+?)(?:\s+aus)?\s*$/i
    );
    if (freeText) {
      const tokens = freeText[1].trim().split(/\s+/);
      const first = tokens[0];
      if (_PRONOUN_PATTERN.test(first)) return { name: null, usedPronoun: true, extraTokens: null };
      return {
        name: first,
        usedPronoun: false,
        extraTokens: tokens.length > 1 ? tokens.slice(1).join(' ') : null,
      };
    }
    return { name: null, usedPronoun: false, extraTokens: null };
  },
};

module.exports = { commandHandlersOpen: CommandHandlersOpen };
module.exports.commandHandlersOpen._PRONOUN_PATTERN = _PRONOUN_PATTERN;
