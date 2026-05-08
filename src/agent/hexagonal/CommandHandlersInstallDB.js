// @ts-checked-v7.6.0
// ============================================================
// GENESIS — CommandHandlersInstallDB.js
// v7.6.0 Track A #2 — split from CommandHandlersInstall.js
//
// Pure data file. Holds the four lookup tables and the regex
// used by the install handler:
//
//   _PACKAGE_MANAGERS  — per-OS PM definitions (winget, brew, apt, …)
//   _BOOTSTRAP_COMMANDS — how to install a missing PM (Tier 2)
//   _SOFTWARE_DB       — direct-download URLs (Tier 3 fallback)
//   _PACKAGE_ALIASES   — name → PM-specific package-id mapping
//   _PACKAGE_NAME_RE   — input validation regex
//
// No methods, no `this`. Anyone can require() this without side
// effects.
// ============================================================

'use strict';

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
    // v7.7.2: bumped to v22 LTS aligned with engines.node (was v20.18.1).
    // v22.x is in Maintenance LTS until April 2027; v22.22.2 is the latest
    // 22.x with security-fixes (CVE-2025-55131, CVE-2026-21637).
    win32: { url: 'https://nodejs.org/dist/v22.22.2/node-v22.22.2-x64.msi', filename: 'nodejs-v22.22.2.msi', label: 'Node.js v22 LTS' },
    darwin: { url: 'https://nodejs.org/dist/v22.22.2/node-v22.22.2.pkg', filename: 'nodejs-v22.22.2.pkg', label: 'Node.js v22 LTS' },
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

// ── Known Windows apps (install-dir + main .exe) ──────────────
// Used by both the install handler (post-install verification via
// _findWindowsApp) and the open handler (locating an installed app's
// .exe under Program Files). Single source of truth — adding a new
// app here surfaces it in both places automatically.
const _KNOWN_WIN_APPS = {
  'winrar':    { dir: 'WinRAR',                       exe: 'WinRAR.exe' },
  '7zip':      { dir: '7-Zip',                        exe: '7zFM.exe' },
  'notepad++': { dir: 'Notepad++',                    exe: 'notepad++.exe' },
  'vlc':       { dir: 'VideoLAN\\VLC',                exe: 'vlc.exe' },
  'firefox':   { dir: 'Mozilla Firefox',              exe: 'firefox.exe' },
  'chrome':    { dir: 'Google\\Chrome\\Application',  exe: 'chrome.exe' },
};

module.exports = {
  _PACKAGE_MANAGERS,
  _BOOTSTRAP_COMMANDS,
  _SOFTWARE_DB,
  _PACKAGE_ALIASES,
  _PACKAGE_NAME_RE,
  _KNOWN_WIN_APPS,
};
