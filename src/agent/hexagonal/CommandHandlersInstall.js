// @ts-checked-v7.6.0
// ============================================================
// GENESIS — CommandHandlersInstall.js
// ZIP 3 Phase 4a + ZIP 5 Phase 4d (v7.5.9), v7.6.0 Track A #2 split.
//
// Top-level install handler. Three tiers:
//
//   Tier 1 — Package-Manager available
//     winget / choco / scoop on Win, brew on macOS, apt/dnf/pacman
//     on Linux. Detect, then install.
//
//   Tier 2 — Package-Manager missing → bootstrap (Trust ≥ 2)
//     Win: try `Add-AppxPackage` for winget via PowerShell, or
//          fetch the choco install script.
//     macOS: brew installer via curl-pipe.
//     Linux: apt is always present on Debian-likes; on others,
//            return a clear "manual install required" message.
//
//   Tier 3 — Bootstrap not possible OR user wants a direct download
//     Lookup the requested package in the SOFTWARE_DB. If we have
//     a known direct URL, download to ~/Downloads via Invoke-WebRequest
//     / curl, then auto-launch the installer (Trust 2+) so the user
//     only has to click the UAC prompt.
//
// Settings:
//   install.allowAutoInstall: false (default)
//     False = preview-only (Tier 1 only, dry-run output).
//     True + Trust 2+ = run Tier 1 + Tier 2 automatically.
//   install.fullAutonomy: false (default)
//     True + Trust 2+ = also run Tier 3 (download + auto-launch).
//     This is the "Genesis macht alles selber" toggle.
//   install.preferredPackageManager: 'auto'
//   install.downloadDir: '~/Downloads' (default)
//
// Trust gates (cannot be overridden by settings):
//   Trust 0 (SUPERVISED): hard block — only manual instructions.
//   Trust 1 (ASSISTED): preview-only by default.
//   Trust 2+ (AUTONOMOUS / FULL_AUTONOMY): full pipeline if settings on.
//
// What CANNOT be automated on Windows:
//   The UAC elevation prompt. When Genesis launches an installer,
//   Windows shows the standard UAC dialog. This is an OS-level
//   security boundary; no setting circumvents it. Genesis prepares
//   everything, the user does one click.
//
// ── v7.6.0 Track A #2 — split structure ──
//   CommandHandlersInstallDB.js     — pure-data tables (~190 LOC)
//   CommandHandlersInstallDetect.js — detection + helper mixin (~260 LOC)
//   CommandHandlersInstall.js       — Tier 1/2/3 pipeline (this file, ~340 LOC)
//
//   The Detect mixin is wired into this object via Object.assign at
//   the bottom of this file, same pattern as ModelBridgeAvailability /
//   ModelBridgeDiscovery (v7.5.6, v7.5.8).
//
// Prototype-Delegation from CommandHandlers.js via Object.assign.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { createLogger } = require('../core/Logger');
const _log = createLogger('CommandHandlersInstall');

const _db = require('./CommandHandlersInstallDB');
const _detectMixin = require('./CommandHandlersInstallDetect');
// v7.8.4: lazy Node v22 LTS resolver — replaces hardcoded v22.22.2
// in _SOFTWARE_DB.nodejs with a live nodejs.org/dist/index.json
// query (24h cache, hardcoded fallback). Pinned to v22 major;
// a bump to v24 is its own explicit decision, not a silent drift.
const { NodeVersionResolver } = require('../capabilities/NodeVersionResolver');

const {
  _PACKAGE_MANAGERS,
  _BOOTSTRAP_COMMANDS,
  _SOFTWARE_DB,
  _PACKAGE_ALIASES,
  _PACKAGE_NAME_RE,
} = _db;

const CommandHandlersInstall = {

  async installSoftware(message) {
    if (!this.shell) return this.lang?.t?.('agent.shell_unavailable') || 'Shell nicht verfügbar';

    // v7.5.9 ZIP8: Strip a duplicated leading "/install" prefix so
    // "/install /install winrar" works the same as "/install winrar".
    // This happens when the user types the slash, then auto-complete
    // or muscle memory adds another. Also covers "/install-software".
    let cleanedMessage = message;
    if (typeof cleanedMessage === 'string') {
      cleanedMessage = cleanedMessage.replace(/^\s*\/install(?:-software)?\s+(?=\/install)/i, '');
    }

    // 1. Extract package name + optional custom install location.
    const info = this._extractPackageInfo(cleanedMessage);
    const packageName = info.name;
    const customLocation = info.location;
    if (!packageName) {
      return 'Welche Software soll installiert werden? Beispiel: "/install firefox" oder "/install winrar D:\\Programme\\WinRAR"';
    }
    if (!_PACKAGE_NAME_RE.test(packageName)) {
      return `Paketname "${packageName}" sieht ungültig aus. Erlaubt sind Buchstaben, Zahlen, "." "-" "_" "+".`;
    }

    // 2. Check trust + settings.
    const settings = this.settings;
    const allowAuto = settings?.get?.('install.allowAutoInstall', false);
    const fullAutonomy = settings?.get?.('install.fullAutonomy', false);
    // 'machine' = system-wide install (Program Files), needs admin
    // 'user'    = per-user install (AppData), no admin
    // 'auto'    = winget default (varies per package)
    const installScope = settings?.get?.('install.scope', 'machine');
    const trustLevel = (typeof this.trustLevelSystem?.getLevel === 'function')
      ? this.trustLevelSystem.getLevel() : 1;

    if (trustLevel < 1) {
      return `[INSTALL-GUARD] Software-Installation gesperrt im Trust-Level SUPERVISED. Höhere Trust-Stufe nötig.`;
    }

    // 3. Check if software is already installed (skip work if yes).
    const already = await this._checkAlreadyInstalled(packageName);
    if (already.found) {
      // Set _lastInstalled so a follow-up "öffne es" can resolve the
      // pronoun even when no install actually ran in this session.
      if (typeof this._setLastInstalled === 'function') {
        this._setLastInstalled(packageName, already.path || null);
      }
      const lines = [`**${packageName}** ist bereits installiert (gefunden via: ${already.via})`];
      if (already.path) {
        lines.push(`Pfad: \`${already.path}\``);
      }
      lines.push(``, `Zum Öffnen: \`/open ${packageName}\``);
      return lines.join('\n');
    }

    // 4. Tier 1 — Package-Manager available?
    const pm = await this._detectPackageManager(settings);

    if (pm) {
      const resolvedId = this._resolveAlias(packageName, pm.name);
      // Substitute {pkg}, {scope} and {location} (winget) in the install template.
      let scopeFlag = '';
      let locationFlag = '';
      if (pm.name === 'winget') {
        if (installScope === 'machine') scopeFlag = '--scope machine';
        else if (installScope === 'user') scopeFlag = '--scope user';
        if (customLocation) {
          // Quote the path so spaces (e.g. "Program Files") survive.
          locationFlag = `--location "${customLocation}"`;
        }
      }
      const cmd = pm.install
        .replace('{pkg}', resolvedId)
        .replace('{scope}', scopeFlag)
        .replace('{location}', locationFlag)
        .replace(/\s+/g, ' ')
        .trim();
      // v7.5.9 Linux-fix: when the install command starts with `sudo`,
      // force `sudo -n` (non-interactive). Pre-fix: sudo silently waited
      // on stdin for a password the chat UI cannot provide — Genesis
      // appeared to hang or returned ambiguous "installiert ✅" without
      // anything actually being installed. With -n, sudo fails fast if
      // no cached credential is available; we then surface a clear
      // "copy this command into a terminal" message to the user.
      const cmdForExec = cmd.replace(/^sudo\s+(?!-n\b)/, 'sudo -n ');
      const canExecute = allowAuto && trustLevel >= 2;

      if (!canExecute) {
        return [
          `**Tier 1 — Package-Manager:** ${pm.name} gefunden ✅`,
          ``,
          `Würde ausführen:`,
          `\`${cmd}\``,
          ``,
          this._previewWhyNotExecuting(allowAuto, trustLevel),
        ].join('\n');
      }

      _log.info(`[INSTALL] Tier 1: ${cmdForExec}`);
      try {
        const result = await this.shell.run(cmdForExec, { tier: 'write' });
        // v7.5.9 Linux-fix: detect "sudo -n" failure (no cached credential).
        // sudo writes "a password is required" or "a terminal is required"
        // to stderr and exits with code 1.
        const stderrText = (result.stderr || result.errorOutput || '').toString();
        const sudoNeedsPassword = /sudo:\s*(a password is required|a terminal is required)/i.test(stderrText);
        if (sudoNeedsPassword) {
          return [
            `**${packageName}** — Installation braucht ein Passwort.`,
            ``,
            `Genesis kann \`sudo\` nicht beantworten (das Chat-Fenster hat keine Passwort-Eingabe). Bitte führe diesen Befehl selbst im Terminal aus:`,
            ``,
            '```bash',
            cmd,  // the original command without -n
            '```',
            ``,
            `Danach: \`/open ${packageName}\``,
          ].join('\n');
        }
        // v7.5.9 ZIP8: After install, verify the binary is now reachable
        // and surface the install path. Plus: clean winget's carriage-
        // return progress animation so the output doesn't show 40 lines
        // of "█▒ 0%, █▒ 1%, █▒ 2%..." stacked on top of each other.
        const cleanedOut = this._cleanInstallerOutput(result.stdout || result.output || '');
        const verify = await this._checkAlreadyInstalled(packageName);

        // Remember the just-installed package so a follow-up "öffne es"
        // can resolve the pronoun. Module-level state is fine here —
        // there's only one user per Genesis instance.
        if (this.bus && typeof this.bus.fire === 'function') {
          this.bus.fire('install:completed', { packageName, path: verify.path || null }, { source: 'CommandHandlersInstall' });
        }
        if (typeof this._setLastInstalled === 'function') {
          this._setLastInstalled(packageName, verify.path || null);
        }

        const lines = [`**${packageName}** via ${pm.name} installiert ✅`];
        // Show the actual command that ran — makes scope/location transparent.
        lines.push(``, `Befehl: \`${cmd}\``);
        if (verify.found) {
          lines.push(``, `Pfad: \`${verify.path}\` (gefunden via ${verify.via})`);
          // Heads-up when the resolved path is the .lnk shortcut, which
          // means winget did not respect --scope machine for this package.
          if (verify.via === 'startmenu-lnk' && installScope === 'machine') {
            lines.push(``, `Hinweis: Trotz \`--scope machine\` wurde nur ein Start-Menu-Shortcut gefunden. Manche winget-Pakete (wie WinRAR) ignorieren \`--scope\` und installieren immer im selben Bereich. Das Programm lässt sich trotzdem öffnen mit \`/open ${packageName}\`.`);
          }
        } else {
          lines.push(``, `(Installation gemeldet, aber Pfad nicht gefunden — eventuell ist ein neuer Shell-Start nötig damit PATH neu geladen wird.)`);
        }
        if (cleanedOut) {
          lines.push(``, '```', cleanedOut.slice(0, 1000), '```');
        }
        lines.push(``, `Zum Öffnen: \`/open ${packageName}\``);
        return lines.join('\n');
      } catch (err) {
        // Tier 1 failed — fall through to Tier 3.
        _log.warn(`[INSTALL] Tier 1 failed: ${err.message}`);
        // v7.5.9 Linux-fix: if the failure is sudo-needs-password,
        // tell the user to copy the command rather than fall through
        // to Tier 3 download (apt failed because of password, not
        // because the package is unavailable).
        if (/sudo:\s*(a password is required|a terminal is required)/i.test(err.message || '')) {
          return [
            `**${packageName}** — Installation braucht ein Passwort.`,
            ``,
            `Genesis kann \`sudo\` nicht beantworten. Bitte führe diesen Befehl selbst im Terminal aus:`,
            ``,
            '```bash',
            cmd,
            '```',
            ``,
            `Danach: \`/open ${packageName}\``,
          ].join('\n');
        }
        return await this._tryTier3DirectDownload(packageName, fullAutonomy, trustLevel,
          `Tier 1 (${pm.name}) fehlgeschlagen: ${err.message}`);
      }
    }

    // 5. Tier 2 — Bootstrap a Package-Manager if possible.
    const bootstrapResult = await this._tryTier2Bootstrap(allowAuto, trustLevel);
    if (bootstrapResult.installed) {
      // PM is now available; recurse once.
      _log.info(`[INSTALL] Tier 2: bootstrapped ${bootstrapResult.pmName}, retrying install`);
      return await this.installSoftware(message);
    }

    // 6. Tier 3 — Direct download from SOFTWARE_DB.
    return await this._tryTier3DirectDownload(packageName, fullAutonomy, trustLevel,
      `Kein Package-Manager auf System.${bootstrapResult.attemptInfo}`);
  },

  // ── Tier 2: bootstrap a package manager ──────────────────────
  async _tryTier2Bootstrap(allowAuto, trustLevel) {
    const platform = process.platform;
    const bootstrapMap = _BOOTSTRAP_COMMANDS[platform];
    if (!bootstrapMap) {
      return { installed: false, attemptInfo: ` Bootstrap auf Plattform ${platform} nicht unterstützt.` };
    }
    if (!allowAuto || trustLevel < 2) {
      const options = Object.keys(bootstrapMap).join(', ');
      return {
        installed: false,
        attemptInfo: ` Bootstrap-Optionen verfügbar (${options}), aber Setting "install.allowAutoInstall" oder Trust-Level zu niedrig.`,
      };
    }

    // Try bootstraps in order. winget first on Win (cleanest), choco second.
    const tryOrder = platform === 'win32' ? ['winget', 'choco', 'scoop'] : Object.keys(bootstrapMap);
    for (const pmName of tryOrder) {
      const bs = bootstrapMap[pmName];
      if (!bs) continue;
      if (bs.cmd === null) {
        // Manual-only path (e.g. winget on a system where AppX side-load isn't possible)
        _log.info(`[INSTALL] Bootstrap ${pmName} requires manual step: ${bs.manual}`);
        continue;
      }
      _log.info(`[INSTALL] Tier 2 bootstrap attempt: ${pmName}`);
      try {
        const result = await this.shell.run(bs.cmd, { tier: 'write', timeout: 120000 });
        if (result.exitCode === 0 || result.code === 0) {
          // Verify it's actually now available.
          const verify = await this.shell.run(`${pmName} --version`, { tier: 'read' });
          if (verify.exitCode === 0 || verify.code === 0) {
            return { installed: true, pmName };
          }
        }
        _log.warn(`[INSTALL] Bootstrap ${pmName} returned non-zero: ${result.exitCode || result.code}`);
      } catch (err) {
        _log.warn(`[INSTALL] Bootstrap ${pmName} failed: ${err.message}`);
      }
    }
    return { installed: false, attemptInfo: ` Bootstrap-Versuche (${tryOrder.join(', ')}) sind alle gescheitert.` };
  },

  // ── Tier 3: direct download + auto-launch installer ──────────
  async _tryTier3DirectDownload(packageName, fullAutonomy, trustLevel, leadIn) {
    const lower = packageName.toLowerCase();
    let dbEntry = _SOFTWARE_DB[lower];
    const platform = process.platform;

    // v7.8.4: for nodejs, resolve the current v22 LTS lazily. Falls back
    // to the static _SOFTWARE_DB.nodejs entry on fetch/parse failure
    // (offline scenarios). Resolver is pinned to v22 major.
    if (lower === 'nodejs') {
      try {
        const cacheDir = path.join(this.rootDir || process.cwd(), '.genesis', 'cache');
        const resolver = new NodeVersionResolver({ cacheDir });
        const resolved = await resolver.resolve();
        dbEntry = resolved.urls;
        _log.debug(`[INSTALL] node resolver source=${resolved.source} version=${resolved.version}`);
      } catch (err) {
        // resolver is supposed to never throw, but stay defensive
        _log.warn(`[INSTALL] node resolver unexpectedly threw: ${err.message} — using static DB`);
      }
    }

    const variant = dbEntry?.[platform];

    if (!variant) {
      return [
        leadIn,
        ``,
        `**Tier 3 — Direct Download:** Kein Eintrag in der Software-DB für "${packageName}".`,
        ``,
        `Für gängige Software wie firefox, chrome, vscode, git, python, nodejs, vlc, 7zip, winrar, notepad++ kennt Genesis offizielle Direct-URLs.`,
        ``,
        `Für andere Software: bitte vom Hersteller herunterladen oder einen Package-Manager (winget/choco/scoop) installieren.`,
      ].join('\n');
    }

    // Variant has a pure-URL case (no installer file, just a redirect page)
    if (!variant.filename || !variant.url.match(/\.(exe|msi|pkg|dmg|zip)(\?|$)/i)) {
      return [
        leadIn,
        ``,
        `**Tier 3 — Direct Download:** ${variant.label}`,
        ``,
        `Vendor-Seite: ${variant.url}`,
        variant.note || 'Bitte selbst von dieser Seite herunterladen.',
      ].join('\n');
    }

    // Real installer URL — proceed with download.
    if (!fullAutonomy || trustLevel < 2) {
      return [
        leadIn,
        ``,
        `**Tier 3 — Direct Download verfügbar:** ${variant.label}`,
        ``,
        `URL: ${variant.url}`,
        `Würde nach \`~/Downloads/${variant.filename}\` herunterladen und Installer öffnen.`,
        ``,
        `Aktiviert mit Setting "install.fullAutonomy" + Trust 2 (AUTONOMOUS).`,
        `Wichtig: Windows zeigt einen UAC-Dialog beim Installer-Start — den musst du selbst klicken.`,
      ].join('\n');
    }

    // Execute: download + auto-launch.
    const downloadDir = this._getDownloadDir();
    const targetFile = path.join(downloadDir, variant.filename);
    try {
      // Ensure dir exists
      if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });

      const downloadCmd = this._buildDownloadCommand(variant.url, targetFile);
      _log.info(`[INSTALL] Tier 3: downloading ${variant.url}`);
      const dl = await this.shell.run(downloadCmd, { tier: 'write', timeout: 300000 });
      if ((dl.exitCode !== 0 && dl.code !== 0) || !fs.existsSync(targetFile)) {
        return [
          leadIn,
          ``,
          `**Tier 3 fehlgeschlagen** beim Download.`,
          dl.stderr ? `Fehler: ${dl.stderr.slice(0, 500)}` : '',
          ``,
          `Manueller Download: ${variant.url}`,
        ].filter(Boolean).join('\n');
      }

      // Auto-launch installer.
      const launchCmd = this._buildLaunchCommand(targetFile);
      _log.info(`[INSTALL] Tier 3: launching ${targetFile}`);
      await this.shell.run(launchCmd, { tier: 'write', timeout: 5000 }).catch(() => {});

      return [
        `**${variant.label}** heruntergeladen und Installer gestartet ✅`,
        ``,
        `Datei: \`${targetFile}\``,
        `Größe: ${this._formatSize(targetFile)}`,
        ``,
        process.platform === 'win32'
          ? `**Wichtig:** Windows zeigt jetzt einen UAC-Dialog. Klicke "Ja", um die Installation fortzusetzen.`
          : `Installer wurde geöffnet — folge den Schritten auf dem Bildschirm.`,
      ].join('\n');
    } catch (err) {
      return [
        leadIn,
        ``,
        `**Tier 3 fehlgeschlagen:** ${err.message}`,
        ``,
        `Manueller Download: ${variant.url}`,
      ].join('\n');
    }
  },

  // ── Helpers ──────────────────────────────────────────────────

  // v7.5.9 ZIP8/ZIP9: Clean winget/choco/brew progress-bar noise.
  // winget produces several kinds of progress noise:
  //   1. Spinner frames: lines with only `-`, `\`, `|`, `/` characters
  //   2. Bar with percent: "  ████▒▒▒  37%"
  //   3. Bar with bytes:   "  ████▒▒▒  1024 KB / 2.90 MB"
  // We drop all three categories, plus empty lines and adjacent dupes.
  // What survives is the substantive output ("Found an existing package",
  // version strings, errors, etc.).
  _cleanInstallerOutput(raw) {
    if (typeof raw !== 'string' || !raw) return '';
    const lines = raw.split(/\r\n|\r|\n/).map(l => l.replace(/\s+$/, '')).filter(l => l.trim());
    const filtered = lines.filter(l => {
      // Spinner-only lines (pure `-`, `\`, `|`, `/` plus whitespace).
      if (/^[\s\-\\|\/]+$/.test(l)) return false;
      // Progress-bar lines — bars (full or half blocks) plus a measurement.
      // Match if the line contains bar chars AND ends with either:
      //   - a percent value
      //   - a bytes value like "1024 KB / 2.90 MB"
      if (/[█▒░▓▏▎▍▌▋▊▉]/.test(l) &&
          /(\d{1,3}\s*%|\d+(?:\.\d+)?\s*(?:B|KB|MB|GB)\s*\/\s*\d+(?:\.\d+)?\s*(?:B|KB|MB|GB))\s*$/i.test(l)) {
        return false;
      }
      return true;
    });
    const out = [];
    for (const l of filtered) {
      if (out.length && out[out.length - 1] === l) continue;
      out.push(l);
    }
    return out.join('\n');
  },
};

// v7.6.0 Track A #2: wire detection + helper methods from the Detect mixin.
// Object.assign copies own enumerable properties; the resulting handler
// behaves identically to the pre-split monolithic object. Same pattern
// as ModelBridgeAvailability / ModelBridgeDiscovery (v7.5.6, v7.5.8).
Object.assign(CommandHandlersInstall, _detectMixin);

module.exports = { commandHandlersInstall: CommandHandlersInstall };

// Test-Hooks: re-export the data tables so tests like v756-fix and
// v759-zip4 that read `commandHandlersInstall._SOFTWARE_DB` keep working.
module.exports.commandHandlersInstall._PACKAGE_NAME_RE = _PACKAGE_NAME_RE;
module.exports.commandHandlersInstall._PACKAGE_MANAGERS = _PACKAGE_MANAGERS;
module.exports.commandHandlersInstall._PACKAGE_ALIASES = _PACKAGE_ALIASES;
module.exports.commandHandlersInstall._SOFTWARE_DB = _SOFTWARE_DB;
module.exports.commandHandlersInstall._BOOTSTRAP_COMMANDS = _BOOTSTRAP_COMMANDS;
