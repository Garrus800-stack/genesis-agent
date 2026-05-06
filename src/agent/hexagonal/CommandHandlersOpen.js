// @ts-checked-v7.6.0
// ============================================================
// GENESIS — CommandHandlersOpen.js
// v7.6.0 Track A #3 — slim dispatcher. Per-platform resolution
// extracted to CommandHandlersOpenWin.js / OpenLinux.js / OpenDarwin.js.
//
// Responsibilities of this file:
//   - Top-level intent handling (openSoftware, _launch)
//   - Message parsing (_extractOpenTarget, pronoun resolution)
//   - PATH probe — shared across all platforms, lives here
//   - Dispatch to platform-specific resolver based on process.platform
//   - Win-only inner helper _findMainExeInDir (used by Win resolver
//     and by knownPath verification)
//
// Per-platform resolvers are pure async functions that take a name
// + a ctx bag with shell + helpers. They return {path, via} or null.
//
// Future Linux polish (snap-as-Tier-1, transitional snap detection,
// Trust 1 own-user-folders) lands in CommandHandlersOpenLinux.js
// without touching this dispatcher. Same for Win-specific changes.
// ============================================================

'use strict';

const { createLogger } = require('../core/Logger');
const _log = createLogger('CommandHandlersOpen');

const { fileExists: _fileExistsHelper } = require('./CommandHandlersHelpers');
const { _KNOWN_WIN_APPS } = require('./CommandHandlersInstallDB');
const { resolveWin } = require('./CommandHandlersOpenWin');
const { resolveLinux } = require('./CommandHandlersOpenLinux');
const { resolveDarwin } = require('./CommandHandlersOpenDarwin');

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

  // Returns {path, via} or null. Resolution order:
  //   1. knownPath (if caller passed one — verify on disk)
  //   2. PATH probe (where.exe / command -v / which) — shared across platforms
  //   3. Platform-specific resolver (Win/Linux/Darwin)
  // Each candidate is verified to actually exist on disk before being returned.
  async _resolveLaunchPath(name, knownPath) {
    // Build the ctx bag passed to platform resolvers. fileExists is bound
    // to this handler's shell so resolvers don't need to care about it.
    const ctx = {
      shell: this.shell,
      fileExists: (p) => this._fileExists(p),
      findMainExeInDir: (dir, n) => this._findMainExeInDir(dir, n),
    };

    // 1. knownPath shortcut.
    if (knownPath) {
      if (process.platform === 'win32' && !/\.(exe|lnk)$/i.test(knownPath)) {
        // knownPath is a directory on Win — find the main .exe inside it.
        const exe = await this._findMainExeInDir(knownPath, name);
        if (exe) return { path: exe, via: 'install-dir-exe' };
      } else {
        if (await this._fileExists(knownPath)) return { path: knownPath, via: 'known' };
      }
    }

    // 2. PATH probe — shared.
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

    // 3. Platform-specific resolver.
    if (process.platform === 'win32') return await resolveWin(name, ctx);
    if (process.platform === 'darwin') return await resolveDarwin(name, ctx);
    return await resolveLinux(name, ctx);
  },

  async _fileExists(filePath) {
    return _fileExistsHelper(this.shell, filePath);
  },

  // Win-specific: find the main .exe in an install directory. Used both by
  // the knownPath verification above and by the Win resolver's registry
  // lookup. KNOWN_WIN_APPS gives us the canonical .exe per app; for
  // unknown apps we fall back to the first .exe in the directory.
  async _findMainExeInDir(dir, packageName) {
    if (!this.shell) return null;
    const known = _KNOWN_WIN_APPS[packageName.toLowerCase()];
    if (known) {
      const candidate = `${dir}\\${known.exe}`;
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
