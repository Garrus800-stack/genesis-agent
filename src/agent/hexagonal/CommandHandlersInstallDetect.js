// @ts-checked-v7.6.0
// ============================================================
// GENESIS — CommandHandlersInstallDetect.js
// v7.6.0 Track A #2 — split from CommandHandlersInstall.js
//
// Detection + helper mixin for the install handler. Wired to the
// main handler via Object.assign() so all methods share `this`
// (which carries shell, bus, lang, settings).
//
// Three groups of methods:
//
//   1. Already-installed detection
//      _checkAlreadyInstalled — top-level. PATH probe + Win lookup.
//      _fileExistsCheck       — platform-aware file-exists.
//      _findWindowsApp        — Windows: known dirs + Registry +
//                               Start-Menu .lnk (with KNOWN_APPS).
//
//   2. Package-manager + alias resolution
//      _detectPackageManager  — finds the first available PM.
//      _pmAvailable           — runs the PM's `--version` probe.
//      _resolveAlias          — package name → PM-specific id.
//
//   3. Message parsing + path/URL helpers
//      _extractPackageInfo    — { name, location } from message.
//      _extractPackageName    — verb-prefix-aware name extraction.
//      _previewWhyNotExecuting — why a Tier-1 preview-only path.
//      _getDownloadDir         — ~/Downloads or settings override.
//      _buildDownloadCommand   — PowerShell IWR / curl.
//      _buildLaunchCommand     — start / open / xdg-open per platform.
//      _formatSize             — bytes → KB / MB.
//
//   4. Last-installed memory
//      _setLastInstalled / _getLastInstalled — module-singleton
//      state for "öffne es" follow-up after an install.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  _PACKAGE_MANAGERS,
  _PACKAGE_ALIASES,
  _KNOWN_WIN_APPS,
} = require('./CommandHandlersInstallDB');
const { fileExists } = require('./CommandHandlersHelpers');

// v7.5.9 ZIP8: Track the most-recently-installed package so a follow-up
// "öffne es" / "starte es" can resolve the pronoun to the actual binary
// instead of having the LLM guess (and sometimes confabulate "Anwendung
// gestartet: es" when there's no real referent).
let _lastInstalled = null;

const CommandHandlersInstallDetect = {

  _setLastInstalled(packageName, installPath) {
    // Module-singleton state — one user per Genesis instance, fine.
    _lastInstalled = { packageName, installPath, timestamp: Date.now() };
  },

  _getLastInstalled() {
    if (!_lastInstalled) return null;
    // Expire after 10 minutes — stale references shouldn't resolve.
    if (Date.now() - _lastInstalled.timestamp > 600000) return null;
    return _lastInstalled;
  },

  async _checkAlreadyInstalled(packageName) {
    const lower = packageName.toLowerCase();
    // Layer 1: PATH lookup. Fast, works for CLI tools.
    const probes = process.platform === 'win32'
      ? [`where.exe ${lower}`, `where.exe ${lower}.exe`]
      : [`which ${lower}`];
    for (const probe of probes) {
      try {
        const result = await this.shell.run(probe, { tier: 'read' });
        if ((result.ok !== false) && (result.exitCode === 0 || result.exitCode === undefined) && result.stdout) {
          const firstLine = result.stdout.trim().split('\n')[0];
          if (firstLine && firstLine.length > 2 && await this._fileExistsCheck(firstLine)) {
            return { found: true, via: 'PATH', path: firstLine };
          }
        }
      } catch { /* skip */ }
    }

    // Layer 2 (Win): Windows-specific GUI-app lookup.
    if (process.platform === 'win32') {
      const winFound = await this._findWindowsApp(lower);
      if (winFound) return winFound;
    }
    return { found: false };
  },

  async _fileExistsCheck(filePath) {
    return fileExists(this.shell, filePath);
  },

  async _findWindowsApp(lower) {
    // Stage 1: Standard install dirs. KNOWN_WIN_APPS lives in
    // CommandHandlersInstallDB.js — single source of truth, also
    // used by CommandHandlersOpenWin.js.
    const known = _KNOWN_WIN_APPS[lower];
    if (known) {
      const candidates = [
        `C:\\Program Files\\${known.dir}\\${known.exe}`,
        `C:\\Program Files (x86)\\${known.dir}\\${known.exe}`,
      ];
      for (const c of candidates) {
        if (await this._fileExistsCheck(c)) {
          return { found: true, via: 'install-dir', path: c };
        }
      }
    }

    // Stage 2: Registry — VERIFY the install dir contains the .exe.
    // Earlier versions returned the registry's InstallLocation blindly,
    // which led to "Pfad: C:\Program Files\WinRAR" being shown even when
    // nothing was actually there.
    try {
      const cmd = `reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall" /s /f "${lower}" /d 2>nul | findstr /I "InstallLocation"`;
      const r = await this.shell.run(cmd, { tier: 'read', timeout: 8000 });
      if (r.stdout && r.stdout.trim()) {
        const match = r.stdout.match(/REG_SZ\s+(.+?)$/im);
        if (match && match[1]) {
          const dir = match[1].trim();
          if (dir) {
            // Try to find the actual .exe inside the dir.
            const knownExe = known ? known.exe : null;
            if (knownExe) {
              const candidate = `${dir}\\${knownExe}`;
              if (await this._fileExistsCheck(candidate)) {
                return { found: true, via: 'registry', path: candidate };
              }
            }
            // Generic fallback inside dir.
            try {
              const lr = await this.shell.run(`dir /b "${dir}\\*.exe" 2>nul`, { tier: 'read' });
              if (lr.stdout && lr.stdout.trim()) {
                const first = lr.stdout.trim().split('\n')[0].trim();
                if (first) {
                  const candidate = `${dir}\\${first}`;
                  if (await this._fileExistsCheck(candidate)) {
                    return { found: true, via: 'registry', path: candidate };
                  }
                }
              }
            } catch { /* skip */ }
          }
        }
      }
    } catch { /* skip */ }

    // Stage 3: Start-Menu .lnk shortcut. winget often installs into
    // %LOCALAPPDATA%\Microsoft\WinGet\Packages and only puts a .lnk
    // into the Start Menu. Windows resolves the .lnk to the real .exe
    // on launch, so a verified .lnk is sufficient.
    //
    // Matching is exact: a request for "git" only matches "git.lnk",
    // not "GitHub Desktop.lnk" or "GitKraken.lnk". Substring matching
    // produced false-positives ("git" → found "GitHub Desktop", reported
    // as installed even when plain Git wasn't).
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
          // Only accept if the result actually looks like a .lnk file path —
          // some shells/mocks return arbitrary stdout on unmatched commands.
          if (first && /\.lnk$/i.test(first) && /[\\\/]/.test(first)) {
            return { found: true, via: 'startmenu-lnk', path: first };
          }
        }
      } catch { /* skip */ }
    }

    return null;
  },

  async _detectPackageManager(settings) {
    const candidates = _PACKAGE_MANAGERS[process.platform];
    if (!candidates) return null;
    const preferred = settings?.get?.('install.preferredPackageManager', 'auto');
    if (preferred && preferred !== 'auto') {
      const match = candidates.find(p => p.name === preferred);
      if (match && await this._pmAvailable(match)) return match;
    }
    for (const pm of candidates) {
      if (await this._pmAvailable(pm)) return pm;
    }
    return null;
  },

  async _pmAvailable(pm) {
    try {
      const r = await this.shell.run(pm.detect, { tier: 'read' });
      return r.exitCode === 0 || r.code === 0;
    } catch { return false; }
  },

  _resolveAlias(packageName, pmName) {
    const lower = packageName.toLowerCase();
    return _PACKAGE_ALIASES[lower]?.[pmName] || packageName;
  },

  // Returns { name, location } — location is null unless the user
  // appended a target path like "/install winrar D:\Programme\WinRAR".
  // The path is detected as a token starting with [A-Z]: or `/` or `~`.
  _extractPackageInfo(message) {
    const name = this._extractPackageName(message);
    if (!name) return { name: null, location: null };
    // Look for an absolute path anywhere after the package name.
    // Win drive: D:\Programme\WinRAR  (with optional spaces inside, so
    // we match through end of message). POSIX: /opt/winrar.
    const winPath = message.match(/\b([A-Za-z]:[\\\/][^\r\n]*?)(?:\s*$|\s{2,})/);
    if (winPath && winPath[1]) {
      const trimmed = winPath[1].trim();
      // Sanity: must be at least drive: + 2 chars
      if (trimmed.length >= 3) return { name, location: trimmed };
    }
    const posixPath = message.match(/\s(\/[a-zA-Z][^\s]*)/);
    if (posixPath && posixPath[1]) {
      return { name, location: posixPath[1] };
    }
    return { name, location: null };
  },

  _extractPackageName(message) {
    if (typeof message !== 'string') return null;
    const lower = message.toLowerCase();
    const ARTICLES = new Set(['die','das','den','the','alle','all','ein','eine','einen','a','an','der','dem','des']);
    const verbPrefixes = [
      /(?:installier(?:e|t|st)?|install)\s+(?:mir\s+)?(?:bitte\s+)?(.+)/i,
      /(?:lad(?:e|s|et)?|download)\s+(?:mir\s+)?(.+?)\s+(?:runter|herunter|down)/i,
      /(?:setze?|setup)\s+(.+?)\s+auf\b/i,
    ];
    let after = null;
    for (const re of verbPrefixes) {
      const m = lower.match(re);
      if (m && m[1]) { after = m[1].trim(); break; }
    }
    if (!after) return null;
    const tokens = after.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return null;
    const first = tokens[0];
    if (ARTICLES.has(first)) return null;
    const _PACKAGE_NAME_RE = require('./CommandHandlersInstallDB')._PACKAGE_NAME_RE;
    if (_PACKAGE_NAME_RE.test(first)) {
      // Space-collapse for "win rar" / "vs code" / "notepad ++" → "winrar" / "vscode" / "notepad++"
      if (tokens.length >= 2) {
        const second = tokens[1];
        if (!ARTICLES.has(second) && /^[a-z0-9+]{2,5}$/i.test(second) && /^[a-z]{2,4}$/i.test(first)) {
          const collapsed = (first + second).toLowerCase();
          if (_PACKAGE_NAME_RE.test(collapsed)) return collapsed;
        }
      }
      return first;
    }
    return null;
  },

  _previewWhyNotExecuting(allowAuto, trustLevel) {
    if (!allowAuto) return 'Setting "install.allowAutoInstall" ist false (default). Aktiviere in Settings für autonomen Install.';
    if (trustLevel < 1) return `Trust-Level ${trustLevel} reicht nicht — AUTONOMOUS (1) oder höher nötig.`;
    return 'Bestätigung erforderlich.';
  },

  _getDownloadDir() {
    const settings = this.settings;
    const fromSetting = settings?.get?.('install.downloadDir', null);
    if (fromSetting) {
      // Expand ~ if user used it.
      return fromSetting.replace(/^~(?=\/|\\|$)/, os.homedir());
    }
    return path.join(os.homedir(), 'Downloads');
  },

  _buildDownloadCommand(url, targetFile) {
    if (process.platform === 'win32') {
      // PowerShell Invoke-WebRequest — handles redirects.
      return `powershell -Command "Invoke-WebRequest -Uri '${url}' -OutFile '${targetFile}' -UseBasicParsing"`;
    }
    return `curl -fsSL '${url}' -o '${targetFile}'`;
  },

  _buildLaunchCommand(filePath) {
    if (process.platform === 'win32') {
      // `start` opens with the default handler. .exe → executes,
      // .msi → msiexec, .zip → explorer. UAC kicks in for installers.
      return `cmd /c start "" "${filePath}"`;
    }
    if (process.platform === 'darwin') {
      return `open "${filePath}"`;
    }
    return `xdg-open "${filePath}"`;
  },

  _formatSize(filePath) {
    try {
      const bytes = fs.statSync(filePath).size;
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    } catch { return '?'; }
  },
};

module.exports = CommandHandlersInstallDetect;
