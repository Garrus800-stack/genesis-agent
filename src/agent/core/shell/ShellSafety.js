// @ts-checked-v5.8
// ============================================================
// GENESIS — ShellSafety.js (v7.5.4)
//
// Pure security functions for shell command execution. No state,
// no event bus, no i18n — helpers return result codes that the
// orchestrator translates and emits.
//
// Extracted from ShellAgent.js as part of the v7.5.4 split.
// ============================================================

'use strict';

const path = require('path');

// ── Blocked patterns per permission tier ────────────────────
// Frozen so all ShellAgent instances share the same object without
// risk of test-mutation cross-contamination.
const BLOCKED_PATTERNS = Object.freeze({
  observe: /./, // Intentional: observe tier has no shell access — blocks ALL commands
  read: /\b(rm|del|mv|move|cp|copy|mkdir|rmdir|chmod|chown|kill|shutdown|reboot|mkfs|dd\s+if|format|>\s)/i,
  write: new RegExp([
    // Direct system destruction
    /rm\s+-rf\s+\//.source,
    /mkfs/.source,
    /dd\s+if=\/dev/.source,
    /format\s+[a-z]:/.source,
    /shutdown/.source,
    /reboot/.source,
    /kill\s+-9\s+1\b/.source,
    />\s*\/dev/.source,
    // FIX v3.5.0: Bypass vectors via encoding/aliasing
    /\\x[0-9a-f]{2}/i.source,             // hex-encoded chars in commands
    /\$\(.*\b(rm|dd|mkfs|kill)\b/.source, // command substitution wrapping destructive ops
    /`.*\b(rm|dd|mkfs|kill)\b/.source,    // backtick command substitution
    /\|\s*(ba)?sh\b/.source,              // piping to shell (curl|sh, wget|bash)
    /\bsource\s/.source,                  // sourcing unknown scripts
    /\b\.\s+\//.source,                   // dot-sourcing (. /path/script)
    /\bpython\d?\s+-c\s/.source,          // python -c "arbitrary code"
    /\bnode\s+-e\s/.source,               // node -e "arbitrary code"
    /\bperl\s+-e\s/.source,               // perl -e "arbitrary code"
    /\bruby\s+-e\s/.source,               // ruby -e "arbitrary code"
    /\bcurl\s.*\|\s/.source,              // curl piped to anything
    /\bwget\s.*\|\s/.source,              // wget piped to anything
    /\bchmod\s+[0-7]*[67][0-7]{2}/.source, // chmod with setuid/setgid bits
    /\bcrontab\b/.source,                 // crontab manipulation
    /\bsymlink|ln\s+-s/.source,           // symlink creation (can bypass SafeGuard paths)
    /\bmkfifo\b/.source,                  // named pipes (can be used for injection)
    /\biptables\b/.source,                // firewall manipulation
    /\bsystemctl\s+(stop|disable|mask)/.source, // service disruption
    /\bpkill\s/.source,                   // process kill by name
    /\bkillall\s/.source,                 // mass process kill
  ].join('|'), 'i'),
  system: /\b(mkfs|dd\s+if=\/dev\/zero|format\s+[a-z]:.*\/[qy])\b/i,
});

// ── Sanitize ──────────────────────────────────────────────────
/**
 * Sanitize a command string before any further processing.
 * Blocks null bytes, newlines, and excessive length that could bypass
 * blocklist regex or exploit shell parsing.
 *
 * @param {string} command
 * @param {{maxChars?: number}} [opts]
 * @returns {{ ok: boolean, command?: string, error?: string }}
 */
function sanitizeCommand(command, opts = {}) {
  const maxChars = opts.maxChars || 100000;
  if (typeof command !== 'string') return { ok: false, error: 'Command must be a string' };
  if (command.length > maxChars) return { ok: false, error: `Command exceeds ${maxChars / 1024}KB limit` };
  // Null bytes can truncate strings in C-based shell parsers
  if (command.includes('\0')) return { ok: false, error: 'Null byte in command' };
  // Newlines can inject additional commands in shell mode
  const cleaned = command.replace(/[\r\n]+/g, ' ').trim();
  if (!cleaned) return { ok: false, error: 'Empty command' };
  // NFKC normalization — converts Unicode confusables (fullwidth ｒｍ → rm,
  // homoglyphs, etc.) so blocklist regex can match.
  const normalized = cleaned.normalize('NFKC');
  return { ok: true, command: normalized };
}

// ── Sandbox ──────────────────────────────────────────────────
/**
 * v7.5.9 ZIP2 Phase 1: 3-Tier Sandbox with trust + scope coupling.
 *
 * The original (pre-ZIP2) sandbox blocked ALL absolute paths outside
 * rootDir, regardless of trust level. Live-evidence on a Win-Rechner
 * showed this is too strict for an "autonomous AI": Genesis couldn't
 * even open a folder on the user's Desktop.
 *
 * Three orthogonal axes decide if a path is allowed:
 *
 *   1. SCOPE (where is the path?)
 *      - in rootDir       → always OK (project work)
 *      - in user-home     → safe-area ('Desktop', 'Documents', 'Downloads',
 *                            'Pictures', 'Videos', 'Music', 'Genesis-Projects',
 *                            'Genesis-Clones')
 *      - other user-home  → outside the safe-area
 *      - system-path      → '/etc', 'C:\Windows', '/System', '/usr/bin' etc.
 *      - secret-file      → '*.env', '*.pem', '*.key', '~/.ssh/', '~/.aws/credentials'
 *
 *   2. INTENT (read or write?)
 *      - 'read'   → ls/cat/dir/type/find/explorer
 *      - 'write'  → touch/echo>/mv/rm/mkdir
 *      - We classify via the command verb. When in doubt, treat as 'write'.
 *
 *   3. TRUST (what level is the user comfortable with?)
 *      - 0 SUPERVISED      → only rootDir, both read+write
 *      - 1 AUTONOMOUS (def) → rootDir+user-home both; system blocked
 *      - 2 FULL_AUTONOMY    → everything except secret/system
 *
 * BLOCKED regardless of trust:
 *   - secret files (*.env, *.pem, *.key, .aws/credentials, .ssh/*)
 *   - critical system paths (/etc, C:\Windows, /System, /usr/bin,
 *     /sbin, ~/.bashrc, ~/.zshrc, ~/AppData/Roaming, ~/Library/Preferences)
 *   - drive-root recursive scans (dir /s C:\, where /r C:\)
 *
 * Settings.sandbox.readScope overrides the default scope for trust level 1+:
 *   - 'project' (legacy)  → only rootDir
 *   - 'user-home' (default) → user-home safe-area
 *   - 'permissive' (FULL_AUTONOMY only) → almost everything
 *
 * @param {string} command
 * @param {string|null|undefined} rootDir
 * @param {{platform?: string, trustLevel?: number, readScope?: string, settings?: object}} [opts]
 * @returns {{ok: boolean, reason?: string, hint?: string}}
 */
function checkRootDirSandbox(command, rootDir, opts = {}) {
  if (!rootDir) return { ok: true };
  const platform = opts.platform || process.platform;
  const isWindows = platform === 'win32';
  // v7.5.9 Linux-fix: when an explicit platform is passed (cross-platform
  // tests), use the matching path module so Win-paths don't get treated
  // as relative-to-cwd on Linux. Pre-fix: path.resolve('C:\\Program Files\\...')
  // on Linux became '/cwd/C:\\Program Files\\...' which then matched the
  // user's home dir → _isUserHomeSafeArea returned 'schreibtisch' → with
  // trust=2 the test passed instead of correctly rejecting outside-rootDir.
  const _path = isWindows ? path.win32 : path.posix;
  const root = _path.resolve(rootDir).toLowerCase();

  // Resolve trust + scope from opts/settings. Default trust = 1 (AUTONOMOUS).
  const trustLevel = (typeof opts.trustLevel === 'number')
    ? opts.trustLevel
    : (opts.settings?.get?.('trust.level') ?? 1);
  const readScope = opts.readScope
    || opts.settings?.get?.('sandbox.readScope')
    || 'user-home';
  const allowUserHome = opts.settings?.get?.('sandbox.allowUserHome');

  // Find absolute path tokens. (Same regex strategy as pre-ZIP2.)
  const winQuoted = [...command.matchAll(/["']([A-Za-z]:[\\/][^"']*)["']/g)].map(m => m[1]);
  const winUnquoted = (command.match(/(?:^|\s)([A-Za-z]:[\\/](?:[^\s"';|&<>]*))/g) || [])
    .map(s => s.trim());
  // v7.5.9 ZIP2 fix: POSIX-path detection is unconditional on platform.
  // Why: a Win user running `cat /etc/passwd` via Git-Bash — or simply
  // a typo that happens to look like a POSIX path — must still hit the
  // critical-system-path block. The previous "isWindows ? [] : ..."
  // gating left a hole through which POSIX system paths slipped on Win.
  const posixQuoted = [...command.matchAll(/["'](\/[^"']*)["']/g)].map(m => m[1]);
  const posixUnquoted = (command.match(/(?:^|\s)(\/(?:home|usr|var|etc|opt|tmp|root|mnt|srv|bin|sbin|lib|proc|sys|run|boot|System|Library)\/[^\s"';|&<>]*)/g) || [])
    .map(s => s.trim());
  const candidates = [...winQuoted, ...winUnquoted, ...posixQuoted, ...posixUnquoted];

  // Drive-root recursive scans always blocked.
  if (/\bdir\s+\/s\s+[A-Za-z]:[\\/]?\s*$/i.test(command)
      || /\bwhere\s+\/r\s+[A-Za-z]:[\\/]?\s/i.test(command)) {
    return {
      ok: false,
      reason: 'recursive scan from a drive root (dir /s C:\\, where /r C:\\) is not allowed. Scope the path to the working directory.',
    };
  }

  if (candidates.length === 0) return { ok: true };

  // v7.5.9 ZIP2 v3: pre-resolve raw-pattern check for POSIX system paths.
  // On Windows, path.resolve('/etc/passwd') becomes 'C:\etc\passwd' — the
  // POSIX startsWith check in _isCriticalSystemPath then fails. Catch the
  // raw input first: if a candidate looks like a POSIX system path before
  // resolve, block it immediately. This closes the cross-platform hole.
  for (const raw of candidates) {
    const rawLower = raw.toLowerCase();
    for (const p of _CRITICAL_SYSTEM_PATHS_POSIX) {
      if (rawLower.startsWith(p) || rawLower === p.replace(/\/$/, '')) {
        return {
          ok: false,
          reason: `path "${raw}" is outside rootDir (${rootDir}) — and is a critical system path (${p}). Always blocked regardless of trust level.`,
          hint: 'System paths like /etc, C:\\Windows, ~/.ssh, ~/AppData/Roaming are off-limits.',
        };
      }
    }
  }

  // Classify command intent (read vs write).
  const intent = _classifyCommandIntent(command, isWindows);

  for (const raw of candidates) {
    const abs = _path.resolve(raw).toLowerCase();

    // (a) inside rootDir → always OK.
    // We use loose startsWith (not "+path.sep") because on Linux test
    // containers running with Windows-style rootDir tokens, path.sep is
    // '/' but the path tokens contain '\'. The pre-ZIP2 sandbox used
    // loose startsWith for the same reason; we preserve that here.
    if (abs.startsWith(root)) continue;

    // (b) ALWAYS-blocked: secret-files / critical system paths.
    // These ignore trust and scope — even FULL_AUTONOMY can't touch them.
    //
    // Two narrow exceptions for app-launching workflows:
    //  1. Launch (.lnk/.exe) anywhere in user-home with intent=launch.
    //  2. Read-listing inside well-known shortcut directories (Start
    //     Menu, Programs, WinGet packages). These are public-by-design
    //     locations: Windows itself enumerates them constantly. Reading
    //     them is needed to discover installed apps after winget runs;
    //     blocking it makes /install + /open useless for any package
    //     that landed in user-scope. Other AppData paths (.env, configs,
    //     creds) stay blocked because they don't match these patterns.
    const blockedSystem = _isCriticalSystemPath(abs, isWindows);
    if (blockedSystem) {
      const isShortcutArea = /[\\\/]start menu[\\\/]/i.test(abs)
        || /[\\\/]microsoft[\\\/]winget[\\\/]packages[\\\/]/i.test(abs);
      const isLaunchableShortcut = intent === 'launch'
        && /\.(lnk|exe)$/i.test(abs)
        && (isShortcutArea || /[\\\/]programs[\\\/]/i.test(abs));
      const isReadLookupInShortcutArea = intent === 'read' && isShortcutArea;
      if (!isLaunchableShortcut && !isReadLookupInShortcutArea) {
        return {
          ok: false,
          reason: `path "${raw}" is outside rootDir (${rootDir}) — and is a critical system path (${blockedSystem}). Always blocked regardless of trust level.`,
          hint: 'System paths like /etc, C:\\Windows, ~/.ssh, ~/AppData/Roaming are off-limits.',
        };
      }
      // Allowed: launch-of-shortcut or read-listing in shortcut area.
    }
    const blockedSecret = _isSecretFile(abs);
    if (blockedSecret) {
      return {
        ok: false,
        reason: `path "${raw}" is outside rootDir and looks like a secret file (${blockedSecret}). Always blocked.`,
        hint: 'Files matching *.env, *.pem, *.key, .aws/credentials, ~/.ssh/* are off-limits.',
      };
    }

    // (c) Trust-gated: outside rootDir but in user-home safe-area.
    const userHomeMatch = _isUserHomeSafeArea(abs, isWindows);
    if (userHomeMatch && (allowUserHome !== false) && readScope !== 'project') {
      // user-home access enabled. v7.9.7: AUTONOMOUS+ (1,2) → read+write.
      // SUPERVISED (0) → block.
      if (trustLevel >= 1) continue;
      return {
        ok: false,
        reason: `path "${raw}" is in your user-home (${userHomeMatch}), but trust level ${trustLevel} (SUPERVISED) blocks access there.`,
        hint: 'Raise trust to AUTONOMOUS (Settings → Behavior → Trust) to access user-home paths.',
      };
    }

    // (c2) Launch (.lnk/.exe) anywhere in user-home with trust ≥ 1 (AUTONOMOUS+).
    // GUI installers (winget user-scope, portable apps) often place
    // their .lnk shortcuts in non-safe-area subfolders of user-home
    // (Start Menu, AppData/Local). Launching a shortcut is read-only-
    // execute. Restricted to AUTONOMOUS+ so SUPERVISED can't
    // be tricked into spawning random user-scope binaries.
    if (intent === 'launch' && trustLevel >= 1) {
      const home = (require('os').homedir() || '').toLowerCase();
      if (home && abs.startsWith(home) && /\.(lnk|exe)$/i.test(abs)) {
        continue;
      }
    }

    // (d) Permissive scope — FULL_AUTONOMY only, almost everything outside system/secret.
    if (readScope === 'permissive' && trustLevel >= 2) continue;

    // (e) Otherwise — outside scope.
    return {
      ok: false,
      reason: `path "${raw}" is outside rootDir (${rootDir}) and not in the allowed scope.`,
      hint: trustLevel === 0
        ? 'Trust SUPERVISED only allows paths inside the project directory.'
        : `User-home access requires sandbox.readScope='user-home' (default) or 'permissive'. Current scope: ${readScope}.`,
    };
  }
  return { ok: true };
}

// ── Helpers for Phase 1 sandbox tiers ──────────────────────

const _CRITICAL_SYSTEM_PATHS_POSIX = [
  '/etc/', '/System/', '/usr/bin/', '/usr/sbin/', '/sbin/', '/bin/',
  '/proc/', '/sys/', '/dev/', '/boot/', '/var/log/auth',
];
const _CRITICAL_SYSTEM_PATHS_WIN_LC = [
  'c:\\windows\\', 'c:\\program files\\windowsapps\\',
  'c:\\system volume information\\',
];
const _CRITICAL_HOMEFILES = [
  '.bashrc', '.zshrc', '.profile', '.bash_profile',
  '.gitconfig', '.npmrc',
];

function _isCriticalSystemPath(absLower, isWindows) {
  // v7.5.9 ZIP2 fix: check both POSIX and Win critical paths regardless
  // of platform. A Win user via Git-Bash can absolutely hit /etc, and
  // a Linux user can typo C:\Windows. The OS doesn't make a path
  // unreachable — only the FS does, and we don't trust the FS here.
  for (const p of _CRITICAL_SYSTEM_PATHS_POSIX) {
    if (absLower.startsWith(p)) return p;
  }
  // Win critical paths use anchored substring match (not just
  // startsWith) because path.resolve() on Linux of a Win path like
  // 'C:\Windows\System32' produces '/cwd/C:\Windows\System32' —
  // the drive-letter is no longer at position 0, but the rest of
  // the path still contains the critical pattern.
  for (const p of _CRITICAL_SYSTEM_PATHS_WIN_LC) {
    if (absLower.startsWith(p) || absLower.includes(p)) return p;
  }
  if (/[\\/]appdata[\\/]roaming[\\/]/i.test(absLower)) return 'AppData/Roaming';
  if (absLower.includes('/library/preferences/')) return 'Library/Preferences';
  // .ssh / .aws / .config — cross-platform under home
  if (/[\\/]\.ssh[\\/]/i.test(absLower)) return '.ssh';
  if (/[\\/]\.aws[\\/]/i.test(absLower)) return '.aws';
  if (/[\\/]\.gnupg[\\/]/i.test(absLower)) return '.gnupg';
  // critical home files: end-of-path match
  for (const f of _CRITICAL_HOMEFILES) {
    if (absLower.endsWith('/' + f) || absLower.endsWith('\\' + f)) return f;
  }
  void isWindows;  // kept in signature for callers
  return null;
}

function _isSecretFile(absLower) {
  // file extensions
  if (/\.env(\.\w+)?$/i.test(absLower)) return '.env';
  if (/\.pem$/i.test(absLower)) return '.pem';
  if (/\.key$/i.test(absLower)) return '.key';
  if (/\.p12$/i.test(absLower)) return '.p12';
  if (/\.pfx$/i.test(absLower)) return '.pfx';
  // known secret filenames
  if (/[\\/](id_rsa|id_ed25519|id_ecdsa|id_dsa)(\.pub)?$/i.test(absLower)) return 'ssh-key';
  if (/[\\/]credentials$/i.test(absLower) && /[\\/]\.aws[\\/]/i.test(absLower)) return 'aws-credentials';
  return null;
}

function _isUserHomeSafeArea(absLower, isWindows) {
  // Cross-platform user-home detection. We check the absolute path against
  // common user-home subfolders. Trust the OS-level home discovery via
  // os.homedir() (cached).
  const home = (require('os').homedir() || '').toLowerCase();
  if (!home || !absLower.startsWith(home)) return null;
  // Reject mixed-resolution: when path.resolve() on Linux is fed a Win-path
  // it produces "/cwd/c:\foo\bar" — which trivially startsWith(home) when
  // the project lives under home. The Win-drive-letter substring is the
  // smoking gun. If absLower has "/<letter>:[\\/]" past the home prefix,
  // the abs path is a Win-path artifact, not a real user-home subdir.
  // (Real Linux paths never embed a drive-letter; real Win paths never
  // start with a Linux home prefix.)
  const tail = absLower.slice(home.length);
  if (/[\\/][a-z]:[\\/]/.test(tail)) return null;
  const rel = tail.replace(/^[\\/]+/, '');
  // Genesis-managed dirs (always allowed in user-home)
  if (/^(genesis-projects|genesis-clones|genesis-outposts)([\\/]|$)/i.test(rel)) {
    return rel.split(/[\\/]/)[0];
  }
  // Standard user-content folders (Desktop, Documents, Downloads, etc.)
  const safe = [
    'desktop', 'documents', 'downloads', 'pictures', 'videos', 'music',
    'public', 'projects', 'workspace', 'src', 'code', 'dev',
    'schreibtisch', 'dokumente', 'bilder', 'videos', 'musik',  // DE
    'bureau', 'documents', 'téléchargements',  // FR
  ];
  for (const s of safe) {
    if (rel === s || rel.startsWith(s + '/') || rel.startsWith(s + '\\')) return s;
  }
  return null;
}

function _classifyCommandIntent(command, isWindows) {
  // Strip leading whitespace and any "cd X &&" prefix.
  const cmd = command.replace(/^\s*cd\s+\S+\s*&&\s*/i, '').trim();

  // Detect read-only-launch: `cmd /c start "" "<path>"` (Win) or
  // `open <path>` (mac) or `xdg-open <path>` (Linux). These spawn a
  // process to open an existing file/app — they don't write anywhere.
  // Treated as 'launch' so the sandbox can permit .lnk/.exe targets in
  // user-home areas that are normally off-limits for writes.
  if (/^cmd\s+\/c\s+start\s+/i.test(cmd)) return 'launch';
  if (/^(open|xdg-open)\s+/i.test(cmd)) return 'launch';

  // First whitespace-bounded token = primary verb.
  const verb = cmd.split(/\s+/)[0]?.toLowerCase() || '';
  // Strip path prefix from verb (e.g. /usr/bin/ls → ls)
  const verbBase = verb.replace(/^.*[\\/]/, '');
  const universalReadVerbs = [
    'cat', 'ls', 'find', 'grep', 'head', 'tail', 'wc', 'less', 'more',
    'pwd', 'echo', 'stat', 'file', 'which', 'open', 'xdg-open',
    'type', 'dir', 'where', 'findstr', 'explorer', 'start',
    'tree', 'cd',
  ];
  void isWindows;
  if (universalReadVerbs.includes(verbBase)) return 'read';
  return 'write';
}

// ── Blocked-pattern check ───────────────────────────────────
/**
 * Check whether a command matches the blocked pattern for a given tier.
 *
 * @param {string} command
 * @param {string} tier — one of 'observe' | 'read' | 'write' | 'system'
 * @param {object} [patterns] — defaults to BLOCKED_PATTERNS
 * @returns {{ok: boolean, reason?: string, tier?: string}}
 */
function checkBlockedPattern(command, tier, patterns = BLOCKED_PATTERNS) {
  const pattern = patterns[tier];
  if (pattern && pattern.test(command)) {
    return { ok: false, reason: 'BLOCKED_TIER', tier };
  }
  return { ok: true };
}

// ── Rate-limit ──────────────────────────────────────────────
/**
 * Build a fresh rate-limit state object pre-initialized for the given tiers.
 * Mirrors the v7.5.3 constructor behavior (one bucket per tier in RATE_LIMITS).
 *
 * @param {string[]} tiers
 * @returns {Object<string, number[]>}
 */
function buildRateLimitState(tiers) {
  const state = {};
  for (const tier of tiers) state[tier] = [];
  return state;
}

/**
 * Check whether a command is allowed under the per-tier rate limit.
 * Mutates `state` by appending the current timestamp on a successful check.
 *
 * @param {Object<string, number[]>} state — mutable rate-limit state
 * @param {string} tier
 * @param {Object<string, number>} limits — { read: 60, write: 20, system: 5 }
 * @param {number} windowMs
 * @returns {{ok: boolean, count?: number, limit?: number}}
 */
function checkRateLimit(state, tier, limits, windowMs) {
  const limit = limits[tier];
  if (!limit) return { ok: true }; // Unknown tier — allow (matches v7.5.3 semantics)
  if (!state[tier]) state[tier] = [];
  const now = Date.now();
  const windowStart = now - windowMs;
  state[tier] = state[tier].filter(ts => ts > windowStart);
  if (state[tier].length >= limit) {
    return { ok: false, count: state[tier].length, limit };
  }
  state[tier].push(now);
  return { ok: true };
}

module.exports = {
  BLOCKED_PATTERNS,
  sanitizeCommand,
  checkRootDirSandbox,
  checkBlockedPattern,
  buildRateLimitState,
  checkRateLimit,
};
