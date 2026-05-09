// ============================================================
// GENESIS AGENT — main.js (KERNEL — this file is IMMUTABLE)
// The kernel boots the agent, enforces safety, manages lifecycle.
// The agent CANNOT modify this file or the kernel/ directory.
// ============================================================

// v7.2.9: Windows console UTF-8 — prevents "ÔÇö" / "ÔåÆ" garbage
// in log output. chcp 65001 sets the active codepage for the
// console, which is required for Node's UTF-8 stdout to render
// em-dashes, arrows, and non-ASCII characters correctly.
if (process.platform === 'win32') {
  try {
    require('child_process').execSync('chcp 65001', { stdio: 'ignore', windowsHide: true });
  } catch { /* non-fatal: some terminals don't support chcp */ }
}

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { SafeGuard } = require('./src/kernel/SafeGuard');
const { AgentCore } = require('./src/agent/AgentCore');

// ── Globals ──────────────────────────────────────────────────
let mainWindow = null;
let agent = null;
const PROTECTED_PATHS = [
  path.join(__dirname, 'main.js'),
  path.join(__dirname, 'preload.mjs'),
  path.join(__dirname, 'preload.js'),
  path.join(__dirname, 'src', 'kernel'),
];

// ── Boot Sequence ────────────────────────────────────────────

// FIX v4.12.3 (S-05): Global unhandledRejection handler — safety net for
// any .then() chain missing a .catch(). Logs the error instead of crashing.
process.on('unhandledRejection', (reason, promise) => {
  console.error('[KERNEL] Unhandled promise rejection:', reason?.message || reason);
  if (reason?.stack) console.error('[KERNEL]', reason.stack);
});

app.whenReady().then(async () => {
  console.log('[KERNEL] Genesis booting...');

  // Phase 1: Initialize SafeGuard
  const guard = new SafeGuard(PROTECTED_PATHS, __dirname);
  guard.lockKernel();

  // Phase 1b (v3.5.4): Hash-lock safety-critical agent files
  // These are outside the kernel but must not be weakened by self-modification.
  guard.lockCritical([
    'src/agent/intelligence/CodeSafetyScanner.js',
    'src/agent/intelligence/VerificationEngine.js',
    'src/agent/core/Constants.js',
    'src/agent/core/EventBus.js',
    'src/agent/core/Container.js',
    // FIX v5.1.0 (M-1x): Worker isolation boundary — agent must not
    // weaken its own sandbox by modifying the worker script.
    'src/agent/capabilities/McpWorker.js',
    // v5.5.0: Self-Preservation Invariants — semantic safety rules.
    // Hash-locked so the agent cannot weaken its own preservation checks.
    'src/agent/core/PreservationInvariants.js',
    // FIX v7.0.8 (S-1): Audit finding — 8 security-relevant files were
    // not hash-locked. Self-modification could have weakened execution
    // isolation, trust evaluation, disclosure policy, or approval gates.
    'src/agent/foundation/Sandbox.js',
    'src/agent/foundation/CapabilityGuard.js',
    'src/agent/foundation/TrustLevelSystem.js',
    'src/agent/foundation/ModuleSigner.js',
    'src/agent/foundation/EarnedAutonomy.js',
    'src/agent/intelligence/DisclosurePolicy.js',
    'src/agent/revolution/ApprovalGate.js',
    'src/agent/organism/ImmuneSystem.js',
    // v7.2.1 (Adversarial Audit): SelfModificationPipeline is the ONLY code path
    // that writes to Genesis source files. Without hash-locking, Genesis could
    // modify its own pipeline to bypass verification, safety scan, and preservation
    // gates. PreservationInvariants rules 3-5 count gate calls but can be gamed
    // by adding a new bypass path without reducing existing call counts.
    'src/agent/hexagonal/SelfModificationPipeline.js',
    // v7.6.2 audit-closeout (M1): the four methods that actually write to disk
    // (modify, _modifyWithDiff, _modifyFullFile, _extractPatches) live in this
    // extracted file since v7.4.3. Without hash-locking it, the v7.2.1 defense
    // chain above is bypassable — Genesis could rewrite the write-side of the
    // pipeline while leaving Pipeline.js untouched. The hash-lock-coverage audit
    // (scripts/audit-hash-lock-coverage.js) prevents recurrence after future splits.
    'src/agent/hexagonal/SelfModificationPipelineModify.js',
    // v7.6.2 audit-closeout (M1, related): VM prototype isolation patterns
    // (Object.freeze, Object.create(null)) live in this file since the v7.1.2
    // Sandbox split. Hash-locking it closes the same defense-in-depth gap as
    // the SANDBOX_ISOLATION PreservationInvariants rule (whose targets were
    // also widened to include this file in the same closeout).
    'src/agent/foundation/SandboxVM.js',
    // v7.6.4 audit-closeout: three files held 2-of-3 self-mod gates each
    // (validateWrite + scanCode) but were excluded from hash-lock because
    // they only write to their own subdirectories (pluginsDir, skillsDir,
    // peer-exchange dir). The argument doesn't hold once you notice these
    // files ARE the only defense against subdirectory-writes — if Genesis
    // rewrote PluginRegistry.js or SkillManager.js it would silently disable
    // the AST-safety scan + path-traversal check for plugin/skill code, and
    // PeerNetworkExchange.js is the surface where peer-code exchange
    // (Camj78-style social-engineering vectors) enters the system. Hash-
    // locking them aligns the protection with their actual responsibility:
    // the only wall between Genesis and unscanned third-party code.
    'src/agent/capabilities/PluginRegistry.js',
    'src/agent/capabilities/SkillManager.js',
    'src/agent/hexagonal/PeerNetworkExchange.js',
  ]);

  // Phase 2: Create window
  // FIX v4.10.0: ESM preload with CJS fallback.
  // Electron 28+ supports ESM preload (.mjs) which enables sandbox:true.
  // However, some Electron 33.x Windows builds fail with
  // "Cannot use import statement outside a module". Detect at boot and
  // FIX v4.13.0: Three-tier preload resolution for sandbox:true on all platforms.
  //   Tier 1: ESM preload (.mjs) — native sandbox:true on Electron 28+
  //   Tier 2: Bundled CJS preload (dist/preload.js) — esbuild eliminates require(),
  //           enabling sandbox:true even without ESM support.
  //   Tier 3: Raw CJS preload (.js) — sandbox:false fallback (requires require())
  const esmPreload = path.join(__dirname, 'preload.mjs');
  const bundledPreload = path.join(__dirname, 'dist', 'preload.js');
  const cjsPreload = path.join(__dirname, 'preload.js');

  let preloadPath, useSandbox, preloadMode;
  const electronMajor = parseInt(process.versions.electron, 10);

  if (fs.existsSync(esmPreload) && electronMajor >= 28 &&
      // FIX v4.13.1: ESM preload fails on Windows sandboxed renderer.
      // Tested: Electron 33, 35, 39 all fail with
      // "Cannot use import statement outside a module" in sandboxed preload.
      // Bundled CJS (Tier 2) has identical security (sandbox:true) — prefer it on Windows.
      // Same failure mode confirmed on Linux (Debian, Electron 33).
      // Renderer DevTools showed: "SyntaxError: Cannot use import statement
      // outside a module at runPreloadScript". Sandbox preload runner does not
      // load ESM across Electron 33–39 on Linux either. Tier 1 is reserved for
      // environments where ESM preload genuinely works (currently: macOS).
      // Linux falls through to Tier 2 (Bundled CJS) — identical sandbox:true.
      !(process.platform === 'win32') &&
      !(process.platform === 'linux')) {
    // Tier 1: ESM — best option
    preloadPath = esmPreload;
    useSandbox = true;
    preloadMode = 'ESM (.mjs)';
  } else if (fs.existsSync(bundledPreload)) {
    // Tier 2: Bundled CJS — no require() calls, sandbox:true works
    preloadPath = bundledPreload;
    useSandbox = true;
    preloadMode = 'Bundled CJS (dist/preload.js)';
  } else {
    // Tier 3: Raw CJS — sandbox:false required
    preloadPath = cjsPreload;
    useSandbox = false;
    preloadMode = 'CJS (.js)';
  }

  console.log(`[KERNEL] Preload: ${preloadMode} — sandbox:${useSandbox}`);
  if (!useSandbox) {
    console.warn('[KERNEL] ⚠ SECURITY: Running with sandbox:false (CJS preload fallback).');
    console.warn('[KERNEL]   contextIsolation:true is still active, but sandbox provides');
    console.warn('[KERNEL]   defense-in-depth. Run "npm run build:bundle" to create bundled');
    console.warn('[KERNEL]   preload and enable sandbox:true on all platforms.');
  }

  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0a0a0f',
    title: 'Genesis',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox:true requires ESM or bundled preload without require() calls.
      // contextIsolation is the real security boundary — sandbox is defense-in-depth.
      sandbox: useSandbox,
    },
  });

  // FIX v4.10.0 (M-4): Content Security Policy — defense-in-depth against XSS.
  // Even though LLM output is sanitized (esc(), safeHref(), HTML-tag stripping),
  // CSP blocks execution of any injected script that slips through.
  // 'unsafe-inline' for style is required by Monaco Editor's dynamic theming.
  // v7.7.5: Monaco AMD → ESM migration. Monaco is now loaded from local
  // dist/monaco/monaco.bundle.js (set as window.monaco via globalName) and
  // workers are local IIFE bundles in dist/monaco/<lang>.worker.js, loaded
  // via `new Worker(URL)`. This eliminates the cdnjs dependency entirely
  // (was: script-src/style-src/font-src/connect-src all needed cdnjs) and
  // the blob:-based worker bootstrap (was: needed for Monaco's AMD loader's
  // own worker creation; ESM workers load directly from 'self').
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self';" +
          " script-src 'self';" +
          " worker-src 'self';" +              // local ESM worker bundles
          " style-src 'self' 'unsafe-inline';" +  // Monaco's dynamic theming needs 'unsafe-inline'
          " font-src 'self' data:;" +          // Monaco codicons (some inlined as data: TTF)
          " img-src 'self' data:;" +
          // FIX v4.10.0: Explicit Ollama + cloud API whitelist instead of open connect-src.
          // Renderer itself doesn't call Ollama (main process does), but CSP should
          // document the policy explicitly. Only 'self' needed for IPC.
          " connect-src 'self';" +
          " object-src 'none';" +
          " base-uri 'none'"
        ],
      },
    });
  });

  // v7.6.0: UI dual-path consolidated. The bundled renderer (esbuild
  // output) became the only loaded UI path. The legacy monolithic
  // src/ui/renderer.js stopped being loaded but the file remained on
  // disk for nine releases as a blueprint reference.
  //
  // v7.7.0: legacy renderer.js + the test that loaded it (renderer.
  // test.js) were finally deleted. UI behavior coverage migrated to
  // 6 per-module test files (test/modules/ui-*-module.test.js) plus
  // the existing security-focused ui-bundle-modules.test.js.
  //
  // The bundle is built by scripts/build-bundle.js, which runs
  // automatically as a postinstall step (see package.json). If
  // npm install finished cleanly, the bundle is already there.
  // If it's missing, we fail fast with a clear message rather than
  // booting silently with a blank window.
  const bundledRenderer = path.join(__dirname, 'dist', 'renderer.bundle.js');
  const htmlPath = path.join(__dirname, 'src', 'ui', 'index.html');
  if (!fs.existsSync(bundledRenderer)) {
    const msg = [
      '',
      '[KERNEL] ERROR: UI bundle missing (dist/renderer.bundle.js).',
      '',
      'The renderer bundle is built by `npm install` (postinstall step).',
      'To rebuild manually, run:  npm run build:ui',
      '',
      'Cannot start the Electron window without it. Exiting.',
      '',
    ].join('\n');
    console.error(msg);
    app.exit(1);
    return;
  }
  console.log('[KERNEL] UI: Bundled renderer (dist/renderer.bundle.js)');
  mainWindow.loadFile(htmlPath);

  // FIX v4.10.0 (M-6): Permission handler — deny all permissions except notifications.
  // Without this, Electron grants all permission requests by default (camera, mic, geo).
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = ['notifications'];
    callback(allowed.includes(permission));
  });

  // FIX v4.10.0 (M-7): Navigation & window-open protection.
  // Prevents LLM-generated links from navigating the main window away from the app,
  // and blocks window.open() / target="_blank" from spawning unsandboxed windows.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      console.warn(`[KERNEL] Blocked navigation to: ${url}`);
      event.preventDefault();
    }
  });

  // FIX v5.0.0 (M-1): Domain allowlist for shell.openExternal().
  // LLM-generated responses could contain crafted phishing links.
  // Only open URLs on known-safe domains without user confirmation.
  const _externalAllowedDomains = new Set([
    'github.com', 'raw.githubusercontent.com', 'gist.github.com',
    'npmjs.com', 'www.npmjs.com', 'registry.npmjs.org',
    'nodejs.org', 'electronjs.org', 'www.electronjs.org',
    'developer.mozilla.org', 'docs.anthropic.com', 'docs.python.org',
    'stackoverflow.com', 'www.stackoverflow.com',
    'en.wikipedia.org', 'pypi.org',
  ]);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      try {
        const hostname = new URL(url).hostname;
        if (_externalAllowedDomains.has(hostname)) {
          require('electron').shell.openExternal(url);
        } else {
          console.warn(`[KERNEL] Blocked openExternal to untrusted domain: ${hostname} (${url.slice(0, 120)})`);
        }
      } catch (e) {
        console.warn(`[KERNEL] Blocked openExternal — invalid URL: ${url.slice(0, 120)}`);
      }
    }
    return { action: 'deny' }; // Never open new Electron windows
  });

  // v7.5.7-fix: Right-click context-menu (cut/copy/paste/select-all).
  // Electron defaults to NO context-menu on right-click — without this
  // hook Genesis chat has only Ctrl+C / Ctrl+V, which is unintuitive on
  // Windows where mouse-right-click is the standard expectation.
  // The menu is built per-click so editable fields get cut/paste, plain
  // text gets copy/select-all only.
  const { Menu: _CtxMenu, MenuItem: _CtxMenuItem } = require('electron');
  mainWindow.webContents.on('context-menu', (_e, params) => {
    const menu = new _CtxMenu();
    const editable = !!params.isEditable;
    const hasSelection = !!(params.selectionText && params.selectionText.length > 0);
    if (editable) {
      menu.append(new _CtxMenuItem({ role: 'cut',       label: 'Ausschneiden', enabled: hasSelection }));
      menu.append(new _CtxMenuItem({ role: 'copy',      label: 'Kopieren',     enabled: hasSelection }));
      menu.append(new _CtxMenuItem({ role: 'paste',     label: 'Einfügen' }));
      menu.append(new _CtxMenuItem({ type: 'separator' }));
      menu.append(new _CtxMenuItem({ role: 'selectAll', label: 'Alles auswählen' }));
    } else if (hasSelection) {
      menu.append(new _CtxMenuItem({ role: 'copy',      label: 'Kopieren' }));
      menu.append(new _CtxMenuItem({ type: 'separator' }));
      menu.append(new _CtxMenuItem({ role: 'selectAll', label: 'Alles auswählen' }));
    } else {
      // Right-click on empty area — minimal menu (just select-all).
      menu.append(new _CtxMenuItem({ role: 'selectAll', label: 'Alles auswählen' }));
    }
    menu.popup({ window: mainWindow });
  });

  // Phase 3: Boot Agent Core
  // v5.2.0: Boot profiles — --minimal (core only), --cognitive (no consciousness), --full (all phases)
  // v6.0.4: Default changed to 'cognitive' — consciousness layer has 0pp impact (A/B validated)
  const bootProfile = process.argv.includes('--minimal') ? 'minimal'
    : process.argv.includes('--full') ? 'full'
    : 'cognitive';
  if (bootProfile !== 'cognitive') console.log(`[KERNEL] Boot profile: ${bootProfile}`);

  // v6.0.4: --skip-phase N[,N] — skip specific phases for A/B benchmarking
  const skipPhaseArg = process.argv.find(a => a.startsWith('--skip-phase'));
  const skipPhases = skipPhaseArg
    ? (process.argv[process.argv.indexOf(skipPhaseArg) + 1] || '').split(',').map(Number).filter(n => n >= 6 && n <= 13)
    : [];

  try {
    agent = new AgentCore({
      rootDir: __dirname,
      guard,
      window: mainWindow,
      bootProfile,
      skipPhases,
    });
    await agent.boot();
    console.log('[KERNEL] Agent booted successfully.');

    // FIX v5.0.0 (L-4): Emit security-degraded event when sandbox:false so the
    // dashboard and HealthMonitor can surface the warning to the operator.
    if (!useSandbox && agent.bus) {
      agent.bus.emit('system:security-degraded', {
        reason: 'Electron sandbox disabled — CJS preload fallback active',
        preloadMode,
        mitigation: 'Run "npm run build:bundle" to enable sandbox:true',
      }, { source: 'Kernel' });
    }
  } catch (err) {
    console.error('[KERNEL] Agent boot failed:', err);
    dialog.showErrorBox('Genesis Boot Error', err.message);
  }
}).catch(err => {
  // FIX v5.1.0: Catch errors thrown before the inner try/catch
  // (SafeGuard init, BrowserWindow creation, preload resolution).
  console.error('[KERNEL] Fatal boot error:', err);
  try { dialog.showErrorBox('Genesis Fatal Error', err.message); } catch (_) {}
});

// ── IPC Rate Limiter (v3.7.0 — KERNEL) ──────────────────────
// Protects Agent from rapid-fire IPC floods by a compromised or
// buggy renderer. Per-channel token bucket: fast channels (chat)
// get generous limits; heavy channels (save, sandbox) get strict.
// Read-only getters are exempt. Lives in kernel = agent can't weaken it.

class _IPCRateLimiter {
  constructor() {
    this._buckets = new Map(); // channel → { tokens, max, refillPerSec, lastRefill }
    this._stats = { allowed: 0, rejected: 0 };
  }

  /** Configure a channel. max=burst capacity, refillPerSec=tokens/second */
  configure(channel, max, refillPerSec) {
    this._buckets.set(channel, { tokens: max, max, refillPerSec, lastRefill: Date.now() });
  }

  /** Try to consume one token. Returns true if allowed. */
  tryConsume(channel) {
    const b = this._buckets.get(channel);
    if (!b) { this._stats.allowed++; return true; } // Unconfigured = unlimited
    const now = Date.now();
    b.tokens = Math.min(b.max, b.tokens + (now - b.lastRefill) / 1000 * b.refillPerSec);
    b.lastRefill = now;
    if (b.tokens >= 1) { b.tokens--; this._stats.allowed++; return true; }
    this._stats.rejected++;
    return false;
  }

  getStats() { return { ...this._stats, channels: this._buckets.size }; }
}

const _ipcLimiter = new _IPCRateLimiter();
// Heavy/expensive channels: strict limits
_ipcLimiter.configure('agent:chat', 10, 2);               // 10 burst, 2/sec refill
_ipcLimiter.configure('agent:save-file', 20, 5);           // 20 burst, 5/sec
_ipcLimiter.configure('agent:run-in-sandbox', 5, 1);       // 5 burst, 1/sec
_ipcLimiter.configure('agent:clone', 2, 0.1);              // 2 burst, 1 per 10sec
_ipcLimiter.configure('agent:loop-approve', 10, 2);
_ipcLimiter.configure('agent:loop-reject', 10, 2);
_ipcLimiter.configure('agent:mcp-add-server', 5, 1);
_ipcLimiter.configure('agent:import-file', 10, 2);
_ipcLimiter.configure('agent:execute-file', 5, 1);
_ipcLimiter.configure('agent:switch-model', 3, 0.5);
// Read-only getters: unconfigured = unlimited (no entry in _buckets)

// ── IPC Input Validation (v4.10.0 — KERNEL) ──────────────────
// FIX v4.10.0 (Audit P1-05): Defense-in-depth type validation.
// Even with contextIsolation + CSP, validate all renderer inputs
// in the kernel before passing them to the agent.
// FIX v4.10.0: Added length limit to prevent DoS via giant messages.
function _validateStr(v, name, maxLen = 0) {
  if (typeof v !== 'string' || v.length === 0) return `${name} must be a non-empty string`;
  if (maxLen > 0 && v.length > maxLen) return `${name} exceeds max length (${maxLen})`;
  return null;
}

// ── IPC Channel Contract ─────────────────────────────────────
// All communication between UI and Agent goes through these channels.

const CHANNELS = {
  // UI → Agent
  'agent:chat': async (event, message) => {
    if (!agent) return { error: 'Agent not booted' };
    const err = _validateStr(message, 'message', 100000);
    if (err) return { error: err };
    return await agent.handleChat(message);
  },

  'agent:chat:stop': async () => {
    if (agent) agent.stopGeneration();
    return { ok: true };
  },

  'agent:get-self-model': async () => {
    if (!agent) return null;
    return agent.getSelfModel();
  },

  'agent:get-file': async (event, filePath) => {
    if (!agent) return null;
    const err = _validateStr(filePath, 'filePath');
    if (err) return { error: err };
    return agent.readOwnFile(filePath);
  },

  'agent:save-file': async (event, payload) => {
    if (!agent) return { error: 'Agent not booted' };
    if (!payload || typeof payload !== 'object') return { error: 'Invalid payload' };
    const { filePath, content } = payload;
    const e1 = _validateStr(filePath, 'filePath');
    if (e1) return { error: e1 };
    if (typeof content !== 'string') return { error: 'content must be a string' };
    // FIX v6.1.1: Resolve ~ paths to home directory for user-requested saves
    if (filePath.startsWith('~')) {
      const os = require('os');
      const path = require('path');
      const fs = require('fs');
      const resolved = filePath.replace(/^~[/\\]/, os.homedir() + path.sep);
      const dir = path.dirname(resolved);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(resolved, content, 'utf-8');
      return { ok: true, path: resolved };
    }
    return agent.writeOwnFile(filePath, content);
  },

  // FIX v6.1.1: Open a file/folder in the system default application.
  // v7.6.3 S2-fix: path-allowlist symmetric to _externalAllowedDomains.
  // Pre-fix, agent:open-path opened any absolute path that existed —
  // including ~/.ssh/id_rsa, /etc/passwd, /root/secret.key. The
  // restrictor list (contextIsolation + sandbox + IPC-whitelist) is
  // active, but this channel is whitelisted, and an LLM-crafted tool-call
  // could pick a sensitive target. Risk is low (no exfiltration; OS only
  // displays the file) but the asymmetry vs openExternal was a finding
  // in the v7.6.3 erweiterte Analyse-report.
  'agent:open-path': async (event, filePath) => {
    if (!agent) return { error: 'Agent not booted' };
    const e = _validateStr(filePath, 'filePath');
    if (e) return { error: e };
    const path = require('path');
    const os = require('os');
    const fs = require('fs');
    // Resolve ~ to home directory
    let resolved = filePath
      .replace(/^~[/\\]/, os.homedir() + path.sep)
      .replace(/^~$/, os.homedir());
    // If not absolute, try relative to project root
    if (!path.isAbsolute(resolved)) {
      resolved = path.resolve(agent.rootDir, resolved);
    }

    // v7.6.3 S2: path-allowlist. Allow only paths under known-safe roots.
    // Symmetric to _externalAllowedDomains for openExternal.
    const _pathAllowedRoots = [
      agent.rootDir,
      path.join(os.homedir(), 'Documents'),
      path.join(os.homedir(), 'Dokumente'),  // German localized
      path.join(os.homedir(), 'Downloads'),
      path.join(os.homedir(), 'Desktop'),
      path.join(os.homedir(), 'Schreibtisch'),  // German localized
      path.join(os.homedir(), 'Pictures'),
      path.join(os.homedir(), 'Bilder'),  // German localized
      path.join(os.homedir(), 'Music'),
      path.join(os.homedir(), 'Musik'),  // German localized
      path.join(os.homedir(), 'Videos'),
    ];
    const resolvedAbs = path.resolve(resolved);
    const isUnderAllowed = _pathAllowedRoots.some(root => {
      const rootAbs = path.resolve(root) + path.sep;
      const rootSelf = path.resolve(root);
      return resolvedAbs.startsWith(rootAbs) || resolvedAbs === rootSelf;
    });
    if (!isUnderAllowed) {
      console.warn(`[KERNEL] Blocked open-path — outside allowed roots: ${resolvedAbs}`);
      return { error: `Path outside allowed roots: ${resolvedAbs}` };
    }

    if (!fs.existsSync(resolved)) {
      return { error: `Path not found: ${resolved}` };
    }
    try {
      const { shell } = require('electron');
      await shell.openPath(resolved);
      return { ok: true, path: resolved };
    } catch (err) { return { error: err.message }; }
  },

  'agent:run-in-sandbox': async (event, code) => {
    if (!agent) return { error: 'Agent not booted' };
    const err = _validateStr(code, 'code');
    if (err) return { error: err };
    return agent.runInSandbox(code);
  },

  'agent:get-file-tree': async () => {
    if (!agent) return [];
    return agent.getFileTree();
  },

  'agent:get-health': async () => {
    if (!agent) return null;
    return agent.getHealth();
  },

  // v7.2.4: Direct filesystem check for first-boot detection.
  // The health-based check was unreliable due to IPC timing — health data
  // could be empty even after boot completed. This handler checks the
  // filesystem directly: if memory.json or session-history.json exist in
  // .genesis/, it's not a first boot. No timing dependency.
  'agent:is-first-boot': async () => {
    try {
      const fs = require('fs');
      const path = require('path');
      const genesisDir = path.join(__dirname, '.genesis');
      if (!fs.existsSync(genesisDir)) return { firstBoot: true };

      // v7.3.3 fix: Genesis creates .genesis/ and default JSON files on
      // its very first run, so file existence + size alone isn't enough.
      // What really defines "not-first-boot" is: has the user ever talked
      // to Genesis? That's a non-zero episode count in memory.json.
      const memoryPath = path.join(genesisDir, 'memory.json');
      if (fs.existsSync(memoryPath)) {
        try {
          const raw = fs.readFileSync(memoryPath, 'utf-8');
          const mem = JSON.parse(raw);
          const episodes = Array.isArray(mem.episodes) ? mem.episodes
            : Array.isArray(mem) ? mem
            : [];
          if (episodes.length > 0) return { firstBoot: false };
        } catch (_e) { /* malformed memory.json → treat as first boot */ }
      }

      // Also check session-history as a secondary signal (some builds store there)
      const sessionPath = path.join(genesisDir, 'session-history.json');
      if (fs.existsSync(sessionPath)) {
        try {
          const raw = fs.readFileSync(sessionPath, 'utf-8');
          const sess = JSON.parse(raw);
          const sessions = Array.isArray(sess.sessions) ? sess.sessions
            : Array.isArray(sess) ? sess
            : [];
          if (sessions.length > 0) return { firstBoot: false };
        } catch (_e) { /* malformed → next */ }
      }

      // Empty .genesis/ or only default files with zero real interaction → first boot
      return { firstBoot: true };
    } catch (_e) { return { firstBoot: true }; }
  },

  'agent:switch-model': async (event, modelName) => {
    if (!agent) return { error: 'Agent not booted' };
    const err = _validateStr(modelName, 'modelName');
    if (err) return { error: err };
    return agent.switchModel(modelName);
  },

  'agent:list-models': async () => {
    if (!agent) return [];
    return agent.listModels();
  },

  // FIX v6.0.3 (H-3): Validate config structure before passing to cloneSelf()
  'agent:clone': async (event, config) => {
    if (!agent) return { error: 'Agent not booted' };
    if (!config || typeof config !== 'object' || Array.isArray(config)) return { error: 'config must be a plain object' };
    return agent.cloneSelf(config);
  },

  'agent:import-file': async (event, sourcePath) => {
    if (!agent) return { error: 'Agent not booted' };
    const err = _validateStr(sourcePath, 'sourcePath');
    if (err) return { error: err };
    if (!agent.container.has('fileProcessor')) return { error: 'FileProcessor not available' };
    const fp = agent.container.resolve('fileProcessor');
    return fp.importFile(sourcePath);
  },

  'agent:file-info': async (event, filePath) => {
    if (!agent) return null;
    const err = _validateStr(filePath, 'filePath');
    if (err) return null;
    if (!agent.container.has('fileProcessor')) return null;
    const fp = agent.container.resolve('fileProcessor');
    return fp.getFileInfo(filePath);
  },

  'agent:execute-file': async (event, filePath) => {
    if (!agent) return { error: 'Agent not booted' };
    const err = _validateStr(filePath, 'filePath');
    if (err) return { error: err };
    if (!agent.container.has('fileProcessor')) return { error: 'FileProcessor not available' };
    const fp = agent.container.resolve('fileProcessor');
    return fp.executeFile(filePath);
  },

  // FIX v4.12.7 (Audit-05): Channel name is misleading — reads are NOT
  // unrestricted. FileProcessor._resolve() enforces rootDir/uploadDir scope.
  // Kept name for backwards compatibility; consider renaming to
  // 'agent:read-project-file' in next major version.
  'agent:read-external-file': async (event, filePath) => {
    if (!agent) return null;
    const err = _validateStr(filePath, 'filePath');
    if (err) return null;
    if (!agent.container.has('fileProcessor')) return null;
    const fp = agent.container.resolve('fileProcessor');
    return fp.readFile(filePath);
  },

  'agent:get-settings': async () => {
    if (!agent) return null;
    const settings = JSON.parse(JSON.stringify(agent.container.resolve('settings').getAll()));
    // FIX v4.12.4 (M-03): Mask API keys before sending to renderer.
    // Keys are stored in full but never exposed via IPC to reduce
    // the blast radius if the renderer is compromised.
    if (settings?.models?.anthropicApiKey) {
      const k = settings.models.anthropicApiKey;
      settings.models.anthropicApiKey = k.length > 8 ? k.slice(0, 4) + '****' + k.slice(-4) : '****';
    }
    if (settings?.models?.openaiApiKey) {
      const k = settings.models.openaiApiKey;
      settings.models.openaiApiKey = k.length > 8 ? k.slice(0, 4) + '****' + k.slice(-4) : '****';
    }
    return settings;
  },

  'agent:set-setting': async (event, payload) => {
    if (!agent) return { error: 'Not booted' };
    if (!payload || typeof payload !== 'object') return { error: 'Invalid payload' };
    const { key, value } = payload;
    const err = _validateStr(key, 'key');
    if (err) return { error: err };
    // FIX v6.0.3 (L-1): Reject non-serializable value types
    if (typeof value === 'function' || typeof value === 'symbol') return { error: 'value must be serializable' };
    agent.container.resolve('settings').set(key, value);
    // If API key changed, reconfigure model bridge
    if (key === 'models.anthropicApiKey' && value) {
      agent.container.resolve('model').configureBackend('anthropic', { apiKey: value });
    }
    if (key === 'models.openaiApiKey' && value) {
      const s = agent.container.resolve('settings');
      const baseUrl = s.get('models.openaiBaseUrl');
      const models = s.get('models.openaiModels') || [];
      if (baseUrl) agent.container.resolve('model').configureBackend('openai', { baseUrl, apiKey: value, models });
    }
    if (key === 'models.openaiBaseUrl' && value) {
      const s = agent.container.resolve('settings');
      const apiKey = s.get('models.openaiApiKey');
      const models = s.get('models.openaiModels') || [];
      if (apiKey) agent.container.resolve('model').configureBackend('openai', { baseUrl: value, apiKey, models });
    }
    // v4.10.0: Switch active model when preferred model changes
    if (key === 'models.preferred' && value) {
      try { await agent.switchModel(value); } catch (_e) { /* model not available yet */ }
    }
    // v5.1.0: When any role changes, reload all roles into ModelBridge
    if (key.startsWith('models.roles.')) {
      try {
        const roles = agent.container.resolve('settings').get('models.roles') || {};
        agent.container.resolve('model').setRoles(roles);
      } catch (_e) { /* best-effort */ }
    }
    return { ok: true };
  },

  // v7.5.7-fix Phase 3: batch-set multiple settings in a single IPC.
  // UI was previously sending one IPC per setting (4-8 per Save click),
  // each triggering listeners and producing log spam. This handler
  // applies all changes through Settings.setBatch (single _save call,
  // toggle events fired only at the end).
  'agent:set-settings-batch': async (event, payload) => {
    if (!agent) return { error: 'Not booted' };
    if (!payload || !Array.isArray(payload.entries)) return { error: 'Invalid payload (expected entries[])' };
    const validated = [];
    for (const entry of payload.entries) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [key, value] = entry;
      if (typeof key !== 'string' || !key) continue;
      if (typeof value === 'function' || typeof value === 'symbol') continue;
      validated.push([key, value]);
    }
    const settings = agent.container.resolve('settings');
    const changes = settings.setBatch(validated);

    // v7.5.7-fix Phase 3 Etappe 3: per-change log line so users can
    // verify in the log which settings actually changed and to what.
    // Sensitive keys (API keys, etc.) are redacted to first 4 chars.
    if (changes.length > 0) {
      const log = require('./src/agent/core/Logger').createLogger('Settings');
      const SENSITIVE = new Set(['models.anthropicApiKey', 'models.openaiApiKey', 'peer.discoveryToken']);
      for (const c of changes) {
        const redact = (v) => {
          if (SENSITIVE.has(c.key)) {
            if (typeof v === 'string' && v.length > 0) return v.slice(0, 4) + '…(redacted)';
            return v ? '(set)' : '(empty)';
          }
          if (Array.isArray(v)) return `[${v.length} items]`;
          if (typeof v === 'object' && v !== null) return JSON.stringify(v).slice(0, 60);
          return String(v);
        };
        log.info(`[CHANGE] ${c.key}: ${redact(c.from)} → ${redact(c.to)}`);
      }
    }

    // Side-effects equivalent to single set-setting handler, but only
    // run them once for each side-effect topic (apiKey/preferred/roles).
    const changedKeys = new Set(changes.map(c => c.key));
    if (changedKeys.has('models.anthropicApiKey')) {
      const v = settings.get('models.anthropicApiKey');
      if (v) { try { agent.container.resolve('model').configureBackend('anthropic', { apiKey: v }); } catch (_e) {} }
    }
    if (changedKeys.has('models.openaiApiKey') || changedKeys.has('models.openaiBaseUrl') || changedKeys.has('models.openaiModels')) {
      const apiKey = settings.get('models.openaiApiKey');
      const baseUrl = settings.get('models.openaiBaseUrl');
      const models = settings.get('models.openaiModels') || [];
      if (apiKey && baseUrl) { try { agent.container.resolve('model').configureBackend('openai', { baseUrl, apiKey, models }); } catch (_e) {} }
    }
    if (changedKeys.has('models.preferred')) {
      const v = settings.get('models.preferred');
      if (v) { try { await agent.switchModel(v); } catch (_e) {} }
    }
    // Roles: ANY role change → setRoles called once with full object
    if ([...changedKeys].some(k => k.startsWith('models.roles.'))) {
      try {
        const roles = settings.get('models.roles') || {};
        agent.container.resolve('model').setRoles(roles);
      } catch (_e) {}
    }

    return { ok: true, changes };
  },

  'agent:get-goals': async () => {
    if (!agent) return [];
    return agent.container.tryResolve('goalStack')?.getAll() ?? [];
  },

  'agent:get-goal-tree': async () => {
    if (!agent) return [];
    return agent.container.tryResolve('goalStack')?.getGoalTree() ?? [];
  },

  'agent:undo': async () => {
    if (!agent) return { ok: false, error: 'Agent not booted' };
    return agent.undo();
  },

  'agent:get-lang-strings': async () => {
    if (!agent) return { _lang: 'en' };
    return agent.container.resolve('lang').getUIStrings();
  },

  'agent:set-lang': async (event, langCode) => {
    if (!agent) return { ok: false };
    const err = _validateStr(langCode, 'langCode');
    if (err) return { ok: false, error: err };
    agent.container.resolve('lang').set(langCode);
    return { ok: true, lang: langCode };
  },

  // MCP (Model Context Protocol)
  'agent:mcp-status': async () => {
    if (!agent) return null;
    return agent.container.tryResolve('mcpClient')?.getStatus() ?? null;
  },

  'agent:mcp-add-server': async (event, config) => {
    if (!agent) return { error: 'MCP not available' };
    const mcp = agent.container.tryResolve('mcpClient');
    if (!mcp) return { error: 'MCP not available' };
    if (!config || typeof config !== 'object') return { error: 'Invalid config' };
    if (typeof config.name !== 'string' || !config.name) return { error: 'config.name must be a non-empty string' };
    return mcp.addServer(config);
  },

  // FIX v6.0.3 (M-1): Validate name parameter
  'agent:mcp-remove-server': async (event, name) => {
    if (!agent) return false;
    if (typeof name !== 'string' || !name) return false;
    return agent.container.tryResolve('mcpClient')?.removeServer(name) ?? false;
  },

  // FIX v6.0.3 (M-1): Validate name parameter
  'agent:mcp-reconnect': async (event, name) => {
    if (!agent) return { error: 'MCP not available' };
    const err = _validateStr(name, 'name');
    if (err) return { error: err };
    const mcp = agent.container.tryResolve('mcpClient');
    if (!mcp) return { error: 'MCP not available' };
    return mcp.reconnect(name);
  },

  'agent:mcp-start-server': async () => {
    if (!agent) return { error: 'MCP not available' };
    const mcp = agent.container.tryResolve('mcpClient');
    if (!mcp) return { error: 'MCP not available' };
    const port = await mcp.startServer();
    return { ok: true, port };
  },

  // v5.9.0: Stop Genesis MCP server
  'agent:mcp-stop-server': async () => {
    if (!agent) return { error: 'Agent not booted' };
    const mcp = agent.container.tryResolve('mcpClient');
    if (!mcp || !mcp.mcpServer) return { error: 'MCP server not running' };
    await mcp.mcpServer.stop();
    return { ok: true };
  },

  // v3.5.0: Agent Loop (autonomous goal execution)
  'agent:loop-status': async () => {
    if (!agent) return null;
    const status = agent.container.tryResolve('agentLoop')?.getStatus() ?? null;
    // FIX v6.1.1: Sanitize for IPC structured clone — strip non-serializable values
    try { return status ? JSON.parse(JSON.stringify(status)) : null; } catch { return null; }
  },

  'agent:loop-approve': async () => {
    if (!agent) return { ok: false };
    const loop = agent.container.tryResolve('agentLoop');
    if (!loop) return { ok: false };
    loop.approve();
    return { ok: true };
  },

  // FIX v6.0.3 (M-1): Validate reason parameter
  'agent:loop-reject': async (event, reason) => {
    if (!agent) return { ok: false };
    const loop = agent.container.tryResolve('agentLoop');
    if (!loop) return { ok: false };
    loop.reject(typeof reason === 'string' ? reason.slice(0, 1000) : 'User rejected');
    return { ok: true };
  },

  'agent:loop-stop': async () => {
    if (!agent) return { ok: false };
    const loop = agent.container.tryResolve('agentLoop');
    if (!loop) return { ok: false };
    loop.stop();
    return { ok: true };
  },

  // v7.4.5: GoalDriver — status, queue, resume-decision
  'agent:goal-driver-status': async () => {
    if (!agent) return null;
    const driver = agent.container.tryResolve('goalDriver');
    if (!driver) return null;
    try { return JSON.parse(JSON.stringify(driver.getStatus())); }
    catch { return null; }
  },

  'agent:goal-driver-queue': async () => {
    if (!agent) return [];
    const driver = agent.container.tryResolve('goalDriver');
    if (!driver) return [];
    try { return JSON.parse(JSON.stringify(driver.getQueue())); }
    catch { return []; }
  },

  'agent:resume-decision': async (_event, payload) => {
    if (!agent) return { ok: false };
    if (!payload || typeof payload.goalId !== 'string'
        || typeof payload.decision !== 'string') {
      return { ok: false, error: 'invalid payload' };
    }
    const { bus } = require('./src/agent/core/EventBus');
    bus.emit('ui:resume-decision', {
      goalId: payload.goalId,
      decision: payload.decision,
      rememberAs: payload.rememberAs,
    }, { source: 'IPC' });
    return { ok: true };
  },

  // v3.5.0: Session info
  'agent:get-session': async () => {
    if (!agent) return null;
    return agent.container.tryResolve('sessionPersistence')?.getReport() ?? null;
  },

  // v4.0.0: EventBus debug data for Dashboard
  'agent:get-event-debug': async () => {
    if (!agent) return null;
    const { bus } = require('./src/agent/core/EventBus');
    return {
      // FIX v4.12.7 (Audit-06): Reduced from 80 to 40 — less IPC overhead per dashboard refresh
      history: bus.getHistory(40),
      stats: bus.getStats(),
      // FIX v4.12.8: Raised from 8 to 12. With 95 services across 13 phases,
      // high-traffic events like chat:completed (10) and user:message (9) have
      // legitimately many listeners. 8 caused constant false-positive warnings.
      // FIX v7.3.2: Raised from 12 to 15. chat:completed now has 13 listeners
      // after CoreMemories wired in v7.3.2 — it's architecturally a fan-out
      // event (EmotionalState, Metabolism, UserModel, Anticipator,
      // SolutionAccumulator, SelfOptimizer, VectorMemory, CausalAnnotation,
      // TaskOutcomeTracker, CoreMemories, LearningService, HealthMonitor,
      // FitnessEvaluator). 15 gives headroom for 1-2 more natural consumers
      // while still catching real runaway-listener bugs.
      listenerReport: bus.getListenerReport({ warnThreshold: 15 }),
      registeredEvents: bus.getRegisteredEvents().length,
    };
  },

  // v5.5.0: Reasoning Trace UI — causal decision chains for Dashboard
  'agent:get-reasoning-traces': async () => {
    if (!agent) return null;
    const tracer = agent.container.tryResolve('reasoningTracer');
    if (!tracer) return { traces: [], stats: { total: 0, byType: {} } };
    return {
      traces: tracer.getTraces(20),
      stats: tracer.getStats(),
    };
  },

  // v5.9.0: Architecture Reflection data for Dashboard
  'agent:get-architecture': async () => {
    if (!agent) return null;
    const ar = agent.container.tryResolve('architectureReflection');
    if (!ar) return null;
    return ar.getSnapshot();
  },

  // v5.9.2: Full graph data for interactive architecture visualization
  'agent:get-architecture-graph': async () => {
    if (!agent) return null;
    const ar = agent.container.tryResolve('architectureReflection');
    if (!ar) return null;
    return ar.getGraphData();
  },

  // v5.9.0: Project Intelligence data for Dashboard
  'agent:get-project-intel': async () => {
    if (!agent) return null;
    const pi = agent.container.tryResolve('projectIntelligence');
    if (!pi) return null;
    return pi.getProfile();
  },

  // v5.9.0: Dynamic Tool Synthesis log for Dashboard
  'agent:get-tool-synthesis': async () => {
    if (!agent) return null;
    const dts = agent.container.tryResolve('dynamicToolSynthesis');
    if (!dts) return null;
    return dts.getStats();
  },

  // v5.9.7 (V6-11): Task Outcome stats for Dashboard
  'agent:get-task-outcomes': async () => {
    if (!agent) return null;
    const tracker = agent.container.tryResolve('taskOutcomeTracker');
    if (!tracker) return null;
    return tracker.getAggregateStats();
  },

  // v5.9.8 (V6-11): CognitiveSelfModel — full diagnostic report
  'agent:get-selfmodel-report': async () => {
    if (!agent) return null;
    const sm = agent.container.tryResolve('cognitiveSelfModel');
    if (!sm) return null;
    return sm.getReport();
  },

  // v6.1.0: Self-modification gate statistics
  'agent:get-gate-stats': async () => {
    if (!agent) return null;
    const pipeline = agent.container.tryResolve('selfModPipeline');
    return pipeline?.getGateStats?.() ?? null;
  },

  // v6.0.0 (V6-7): MemoryConsolidator — compaction report + manual trigger
  'agent:get-consolidation-report': async () => {
    if (!agent) return null;
    const mc = agent.container.tryResolve('memoryConsolidator');
    if (!mc) return null;
    return mc.getReport();
  },

  'agent:trigger-consolidation': async () => {
    if (!agent) return null;
    const mc = agent.container.tryResolve('memoryConsolidator');
    if (!mc) return null;
    return mc.consolidate();
  },

  // v6.0.0 (V6-8): TaskRecorder — replay list + diff
  'agent:get-replay-report': async () => {
    if (!agent) return null;
    const tr = agent.container.tryResolve('taskRecorder');
    if (!tr) return null;
    return tr.getReport();
  },

  // FIX v6.0.3 (H-2): Validate replay diff IDs
  'agent:get-replay-diff': async (_event, idA, idB) => {
    if (!agent) return null;
    const e1 = _validateStr(idA, 'idA', 200);
    if (e1) return { error: e1 };
    const e2 = _validateStr(idB, 'idB', 200);
    if (e2) return { error: e2 };
    const tr = agent.container.tryResolve('taskRecorder');
    if (!tr) return null;
    return tr.diff(idA, idB);
  },

  // v6.0.1: CostGuard — budget status
  'agent:get-cost-budget': async () => {
    if (!agent) return null;
    const cg = agent.container.tryResolve('costGuard');
    if (!cg) return null;
    return cg.getUsage();
  },

  // v6.0.1: BackupManager — export/import
  'agent:export-data': async () => {
    if (!agent) return null;
    const bm = agent.container.tryResolve('backupManager');
    if (!bm) return null;
    return bm.export();
  },

  // FIX v6.0.3 (H-1): Validate filePath + restrict to home directory scope
  'agent:import-data': async (_event, filePath) => {
    if (!agent) return null;
    const err = _validateStr(filePath, 'filePath');
    if (err) return { error: err };
    const resolved = require('path').resolve(filePath);
    const homeDir = require('os').homedir();
    if (!resolved.startsWith(homeDir + require('path').sep) && resolved !== homeDir) {
      return { error: 'Import path must be within home directory' };
    }
    const bm = agent.container.tryResolve('backupManager');
    if (!bm) return null;
    return bm.import(filePath);
  },

  // v6.0.1: CrashLog — recent entries
  'agent:get-crash-log': async () => {
    if (!agent) return null;
    const cl = agent.container.tryResolve('crashLog');
    if (!cl) return null;
    return { entries: cl.getRecent(50), stats: cl.getStats() };
  },

  // v6.0.1: AutoUpdater — check for updates
  'agent:check-update': async () => {
    if (!agent) return null;
    const au = agent.container.tryResolve('autoUpdater');
    if (!au) return null;
    return au.checkForUpdate();
  },

  // v6.0.2: Adaptation meta-cognitive loop
  'agent:get-adaptation-report': async () => {
    if (!agent) return null;
    const strategy = agent.container.tryResolve('adaptiveStrategy');
    return strategy?.getReport() || null;
  },

  'agent:run-adaptation-cycle': async () => {
    if (!agent) return null;
    const strategy = agent.container.tryResolve('adaptiveStrategy');
    if (!strategy) return null;
    const result = await strategy.runCycle();
    // Strip non-serializable revert function
    if (result) { const { revert, ...rest } = result; return rest; }
    return null;
  },

  // v6.0.5 (V6-10): NetworkSentinel — network status + force probe
  'agent:get-network-status': async () => {
    if (!agent) return null;
    const ns = agent.container.tryResolve('networkSentinel');
    return ns?.getStatus() || null;
  },

  'agent:force-network-probe': async () => {
    if (!agent) return null;
    const ns = agent.container.tryResolve('networkSentinel');
    if (!ns) return null;
    return ns.forceProbe();
  },

  // v6.0.5: ExecutionProvenance — trace report
  'agent:get-provenance-report': async () => {
    if (!agent) return null;
    const ep = agent.container.tryResolve('executionProvenance');
    if (!ep) return null;
    return {
      stats: ep.getStats(),
      recentTraces: ep.getRecentTraces(10),
      lastTrace: ep.getLastTrace(),
    };
  },

  // v6.0.7: Earned Autonomy — per-action trust report
  'agent:get-autonomy-report': async () => {
    if (!agent) return null;
    const ea = agent.container.tryResolve('earnedAutonomy');
    const trust = agent.container.tryResolve('trustLevelSystem');
    return {
      report: ea?.getReport() || [],
      stats: ea?.getStats() || {},
      trustStatus: trust?.getStatus() || null,
    };
  },

  'agent:stream-chunk': null, // Agent -> UI (push only)
  'agent:stream-done': null,  // Agent -> UI (push only, stream complete)
  'agent:status-update': null, // Agent -> UI (push only)
  'agent:open-in-editor': null, // Agent -> UI (push only)
  'agent:loop-progress': null,  // v3.5.0: Agent -> UI (push only)
  'agent:loop-approval-needed': null, // v3.5.0: Agent -> UI (push only)
  // v7.6.0: declared after audit §3.4 — these were emitted via push() in
  // AgentCoreWire.js (line 194, 227) and listened for in renderer-main.js,
  // but were missing from this CHANNELS contract. validate-channels.js
  // flagged the drift. Adding them as null entries (push-only) keeps the
  // contract list complete and prevents future drift.
  'agent:chat-system-message': null, // Agent -> UI (push only — system messages in chat)
  'ui:resume-prompt': null,           // Agent -> UI (push only — resume previous goal?)
};

// Register all invoke handlers (with rate limiting)
for (const [channel, handler] of Object.entries(CHANNELS)) {
  if (handler) {
    ipcMain.handle(channel, (event, ...args) => {
      if (!_ipcLimiter.tryConsume(channel)) {
        console.warn(`[KERNEL:IPC] Rate limited: ${channel}`);
        return { error: 'Rate limited — too many requests', rateLimited: true };
      }
      return handler(event, ...args);
    });
  }
}

// Streaming: rate-limited separately
ipcMain.on('agent:request-stream', (event, message) => {
  // FIX v4.10.0: Same length validation as agent:chat invoke handler
  if (typeof message !== 'string' || !message || message.length > 100000) return;
  if (!_ipcLimiter.tryConsume('agent:chat')) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent:stream-chunk', '[Rate limited — please wait]');
      mainWindow.webContents.send('agent:stream-done');
    }
    return;
  }
  if (!agent) {
    // v7.5.9 B2: send stream-done so UI doesn't hang in '...' state.
    // Pre-fix the early-return left the renderer stuck in streaming mode
    // with no chunk and no done-signal. Symmetric to the rate-limit branch
    // above.
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent:stream-chunk', '[Agent not ready — please retry]');
      mainWindow.webContents.send('agent:stream-done');
    }
    return;
  }
  agent.handleChatStream(message, (chunk) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent:stream-chunk', chunk);
    }
  }, () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent:stream-done');
    }
  });
});

// v7.3.3: Welcome streaming — generates a returning-boot greeting through
// the WelcomeService. If the service is not available or the LLM is not
// ready, the renderer gets { ok: false, reason } and should display a
// system message rather than a fake agent utterance.
// v5.6.0 SA-P4: Forward UI heartbeat to EventBus for EmbodiedPerception
ipcMain.on('ui:heartbeat', (_event, data) => {
  if (!agent || typeof data !== 'object') return;
  try {
    agent.bus?.emit('ui:heartbeat', data, { source: 'main:ipc' });
  } catch (_e) { /* non-critical */ }
});

// ── Lifecycle ────────────────────────────────────────────────
// FIX v3.5.0: Prevented double-shutdown race condition.
// window-all-closed now awaits shutdown THEN quits.
// before-quit only acts if shutdown wasn't called yet.
app.on('window-all-closed', async () => {
  if (agent) await agent.shutdown();
  app.quit();
});

app.on('before-quit', (e) => {
  if (agent && !agent._shutdownCalled) {
    e.preventDefault();
    agent.shutdown().finally(() => app.quit());
  }
});

// ── Global Error Handlers (v4.12.1 — KERNEL) ───────────────
// FIX v4.12.1 [P2-05]: uncaughtException handler.
// unhandledRejection handler is at top of file (v4.12.3 S-05).

process.on('uncaughtException', (err) => {
  console.error('[KERNEL] Uncaught exception:', err);
  // FIX v6.0.3 (L-7): INTENTIONAL — no process.exit() here.
  // Node.js docs recommend exit after uncaughtException, but Electron manages
  // its own lifecycle (dialog, crash reporter, GPU process supervision).
  // Forcing exit here would bypass Electron's shutdown sequence and skip
  // agent.shutdown() → data loss risk. The CrashLog service captures the error
  // for diagnostics. If the process is truly unrecoverable, Electron will
  // terminate via its own crash handler.
});
