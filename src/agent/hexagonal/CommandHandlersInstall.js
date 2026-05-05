// @ts-checked-v7.5.9
// ============================================================
// GENESIS — CommandHandlersInstall.js
// ZIP 3 Phase 4a + ZIP 5 Phase 4d (v7.5.9)
//
// Full install pipeline. Three tiers:
//
//   Tier 1 — Package-Manager available
//     winget / choco / scoop on Win, brew on macOS, apt/dnf/pacman
//     on Linux. Detect, then install. Same as ZIP 3.
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
// Prototype-Delegation from CommandHandlers.js via Object.assign.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { createLogger } = require('../core/Logger');
const _log = createLogger('CommandHandlersInstall');

// ── Per-OS package managers ───────────────────────────────────
const _PACKAGE_MANAGERS = {
  win32: [
    { name: 'winget', detect: 'winget --version', install: 'winget install --id {pkg} -e {scope} {location} --silent --accept-source-agreements --accept-package-agreements', bootstrap: 'winget' },
    { name: 'choco', detect: 'choco --version', install: 'choco install {pkg} -y', bootstrap: 'choco' },
    { name: 'scoop', detect: 'scoop --version', install: 'scoop install {pkg}', bootstrap: 'scoop' },
  ],
  darwin: [
    { name: 'brew', detect: 'brew --version', install: 'brew install {pkg}', bootstrap: 'brew' },
  ],
  linux: [
    { name: 'apt', detect: 'apt-get --version', install: 'sudo apt-get install -y {pkg}', bootstrap: null },
    { name: 'dnf', detect: 'dnf --version', install: 'sudo dnf install -y {pkg}', bootstrap: null },
    { name: 'pacman', detect: 'pacman --version', install: 'sudo pacman -S --noconfirm {pkg}', bootstrap: null },
    { name: 'zypper', detect: 'zypper --version', install: 'sudo zypper install -y {pkg}', bootstrap: null },
    { name: 'apk', detect: 'apk --version', install: 'sudo apk add {pkg}', bootstrap: null },
  ],
};

// ── Bootstrap scripts (PM-install commands) ───────────────────
// All PowerShell scripts use bypass execution policy and rely on
// the standard download-and-pipe pattern. The user still gets a
// UAC prompt for elevation. Failure modes are obvious from output.
const _BOOTSTRAP_COMMANDS = {
  win32: {
    winget: {
      // winget is bundled in modern Win10+/Win11. If missing, point
      // the user to the Microsoft Store "App Installer" page —
      // Genesis cannot side-load AppX packages without admin.
      cmd: null,
      manual: 'Öffne Microsoft Store und suche nach "App Installer" (= winget). Installation dort dauert <1min.',
    },
    choco: {
      // Standard chocolatey installer.
      cmd: 'powershell -Command "Set-ExecutionPolicy Bypass -Scope Process -Force; [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072; iex ((New-Object System.Net.WebClient).DownloadString(\'https://community.chocolatey.org/install.ps1\'))"',
      manual: null,
    },
    scoop: {
      // scoop installer; doesn't need admin.
      cmd: 'powershell -Command "Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser; irm get.scoop.sh | iex"',
      manual: null,
    },
  },
  darwin: {
    brew: {
      cmd: '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
      manual: null,
    },
  },
  linux: {},
};

// ── Software direct-download DB ───────────────────────────────
// Curated list of known-good direct URLs for popular software.
// Used as Tier-3 fallback when no PM is available. Each entry can
// have per-OS variants. Filename is what the file is saved as in
// Downloads — Windows installers with .exe extension auto-launch
// when opened, .msi too. .pkg on macOS opens the installer.
//
// Adding entries is safe — direct URLs go to the official vendor.
// Updating versions is best-effort; many vendors have a "latest"
// redirect we use where possible.
const _SOFTWARE_DB = {
  'winrar': {
    win32: { url: 'https://www.win-rar.com/fileadmin/winrar-versions/sfxen.exe', filename: 'winrar-installer.exe', label: 'WinRAR' },
  },
  '7zip': {
    win32: { url: 'https://www.7-zip.org/a/7z2408-x64.exe', filename: '7zip-installer.exe', label: '7-Zip' },
  },
  'firefox': {
    win32: { url: 'https://download.mozilla.org/?product=firefox-stub&os=win&lang=de', filename: 'firefox-installer.exe', label: 'Firefox' },
    darwin: { url: 'https://download.mozilla.org/?product=firefox-latest&os=osx&lang=de', filename: 'Firefox.dmg', label: 'Firefox' },
  },
  'chrome': {
    win32: { url: 'https://dl.google.com/chrome/install/latest/chrome_installer.exe', filename: 'chrome-installer.exe', label: 'Google Chrome' },
  },
  'vscode': {
    win32: { url: 'https://code.visualstudio.com/sha/download?build=stable&os=win32-x64-user', filename: 'vscode-installer.exe', label: 'Visual Studio Code' },
    darwin: { url: 'https://code.visualstudio.com/sha/download?build=stable&os=darwin-universal', filename: 'VSCode.zip', label: 'Visual Studio Code' },
  },
  'git': {
    win32: { url: 'https://gitforwindows.org/', filename: null, label: 'Git for Windows', note: 'Direkter Installer-Download nicht möglich (Vendor-Seite redirect-only). Öffne den Link.' },
  },
  'python': {
    win32: { url: 'https://www.python.org/downloads/windows/', filename: null, label: 'Python', note: 'Wähle Version auf der python.org-Seite.' },
  },
  'nodejs': {
    win32: { url: 'https://nodejs.org/dist/v20.18.1/node-v20.18.1-x64.msi', filename: 'nodejs-v20.18.1.msi', label: 'Node.js v20 LTS' },
    darwin: { url: 'https://nodejs.org/dist/v20.18.1/node-v20.18.1.pkg', filename: 'nodejs-v20.18.1.pkg', label: 'Node.js v20 LTS' },
  },
  'notepad++': {
    win32: { url: 'https://github.com/notepad-plus-plus/notepad-plus-plus/releases/download/v8.7.1/npp.8.7.1.Installer.x64.exe', filename: 'notepad-plus-plus.exe', label: 'Notepad++' },
  },
  'vlc': {
    win32: { url: 'https://get.videolan.org/vlc/3.0.21/win64/vlc-3.0.21-win64.exe', filename: 'vlc-installer.exe', label: 'VLC Media Player' },
    darwin: { url: 'https://get.videolan.org/vlc/3.0.21/macosx/vlc-3.0.21-universal.dmg', filename: 'VLC.dmg', label: 'VLC Media Player' },
  },
};

// ── PM-specific package-id aliases ────────────────────────────
// Linux: apt (Debian/Ubuntu), dnf (Fedora/RHEL), pacman (Arch).
// snap/flatpak listed when they're the most reliable source for
// closed-source apps not in distro repos (Chrome, VSCode).
const _PACKAGE_ALIASES = {
  'winrar':    { winget: 'RARLab.WinRAR', choco: 'winrar' /* Linux: use unrar/rar from distro repos directly */ },
  '7zip':      { winget: '7zip.7zip', choco: '7zip', apt: 'p7zip-full', dnf: 'p7zip', pacman: 'p7zip' },
  'firefox':   { winget: 'Mozilla.Firefox', choco: 'firefox', brew: '--cask firefox', apt: 'firefox', dnf: 'firefox', pacman: 'firefox' },
  'chrome':    { winget: 'Google.Chrome', choco: 'googlechrome', brew: '--cask google-chrome' /* Linux: not in standard repos, use google's .deb or flatpak */ },
  'chromium':  { apt: 'chromium-browser', dnf: 'chromium', pacman: 'chromium' },
  'vscode':    { winget: 'Microsoft.VisualStudioCode', choco: 'vscode', brew: '--cask visual-studio-code', snap: 'code --classic' },
  'code':      { snap: 'code --classic' /* alias for vscode via snap */ },
  'git':       { winget: 'Git.Git', choco: 'git', brew: 'git', apt: 'git', dnf: 'git', pacman: 'git', zypper: 'git', apk: 'git' },
  'python':    { winget: 'Python.Python.3.12', choco: 'python', brew: 'python', apt: 'python3', dnf: 'python3', pacman: 'python', zypper: 'python3', apk: 'python3' },
  'nodejs':    { winget: 'OpenJS.NodeJS', choco: 'nodejs', brew: 'node', apt: 'nodejs', dnf: 'nodejs', pacman: 'nodejs', zypper: 'nodejs', apk: 'nodejs' },
  'notepad++': { winget: 'Notepad++.Notepad++', choco: 'notepadplusplus' /* Linux alternative: gedit, kate */ },
  'vlc':       { winget: 'VideoLAN.VLC', choco: 'vlc', brew: '--cask vlc', apt: 'vlc', dnf: 'vlc', pacman: 'vlc', zypper: 'vlc' },
  'gimp':      { winget: 'GIMP.GIMP', choco: 'gimp', brew: '--cask gimp', apt: 'gimp', dnf: 'gimp', pacman: 'gimp', zypper: 'gimp' },
  'inkscape':  { winget: 'Inkscape.Inkscape', apt: 'inkscape', dnf: 'inkscape', pacman: 'inkscape', zypper: 'inkscape' },
  'docker':    { winget: 'Docker.DockerDesktop', apt: 'docker.io', dnf: 'docker', pacman: 'docker', zypper: 'docker' },
  'curl':      { apt: 'curl', dnf: 'curl', pacman: 'curl', zypper: 'curl', apk: 'curl', brew: 'curl' },
  'wget':      { apt: 'wget', dnf: 'wget', pacman: 'wget', zypper: 'wget', apk: 'wget', brew: 'wget' },
  'htop':      { apt: 'htop', dnf: 'htop', pacman: 'htop', zypper: 'htop', apk: 'htop', brew: 'htop' },
};

const _PACKAGE_NAME_RE = /^[a-z0-9][a-z0-9._+-]{1,49}$/i;

// v7.5.9 ZIP8: Track the most-recently-installed package so a follow-up
// "öffne es" / "starte es" can resolve the pronoun to the actual binary
// instead of having the LLM guess (and sometimes confabulate "Anwendung
// gestartet: es" when there's no real referent).
let _lastInstalled = null;

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
    const dbEntry = _SOFTWARE_DB[lower];
    const platform = process.platform;
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

  async _findWindowsApp(lower) {
    // Stage 1: Standard install dirs.
    const KNOWN_APPS = {
      'winrar':      { dir: 'WinRAR',          exe: 'WinRAR.exe' },
      '7zip':        { dir: '7-Zip',           exe: '7zFM.exe' },
      'notepad++':   { dir: 'Notepad++',       exe: 'notepad++.exe' },
      'vlc':         { dir: 'VideoLAN\\VLC',   exe: 'vlc.exe' },
      'firefox':     { dir: 'Mozilla Firefox', exe: 'firefox.exe' },
      'chrome':      { dir: 'Google\\Chrome\\Application', exe: 'chrome.exe' },
    };
    const known = KNOWN_APPS[lower];
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
    if (trustLevel < 2) return `Trust-Level ${trustLevel} reicht nicht — AUTONOMOUS (2) oder höher nötig.`;
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

module.exports = { commandHandlersInstall: CommandHandlersInstall };
module.exports.commandHandlersInstall._PACKAGE_NAME_RE = _PACKAGE_NAME_RE;
module.exports.commandHandlersInstall._PACKAGE_MANAGERS = _PACKAGE_MANAGERS;
module.exports.commandHandlersInstall._PACKAGE_ALIASES = _PACKAGE_ALIASES;
module.exports.commandHandlersInstall._SOFTWARE_DB = _SOFTWARE_DB;
module.exports.commandHandlersInstall._BOOTSTRAP_COMMANDS = _BOOTSTRAP_COMMANDS;
