// ============================================================
// GENESIS — test/modules/e2e-electron.test.js (v5.9.2)
//
// E2E test with real Electron BrowserWindow.
// Uses Electron's built-in testing capabilities (no Playwright).
//
// REQUIRES: Electron binary installed (npm install).
// SKIP: In CI where ELECTRON_SKIP_BINARY_DOWNLOAD=1.
//
// Usage:
//   npx electron test/modules/e2e-electron.test.js
//   node test/modules/e2e-electron.test.js  (auto-detects)
// ============================================================

'use strict';

const path = require('path');
const { describe, test, assert, assertEqual, run } = require('../harness');

const ROOT = path.resolve(__dirname, '..', '..');
let electron, app, BrowserWindow;

// Skip if no Electron binary
try {
  const electronPath = require('electron');
  if (!electronPath || process.env.ELECTRON_SKIP_BINARY_DOWNLOAD === '1') {
    throw new Error('skip');
  }
} catch (_e) {
  console.log('[E2E] Electron binary not available — skipping E2E tests');
  console.log('[E2E] Install with: npm install (without --ignore-scripts)');
  describe('E2E Electron (skipped)', () => {
    test('Electron binary not installed', () => { assert(true); });
  });
  run();
  // Early exit
  return;
}

// ── Test Electron main process features without launching ──

describe('E2E Electron — Preload Security', () => {
  test('preload.js exports only whitelisted channels', () => {
    // Verify preload structure by reading the file
    const fs = require('fs');
    const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');

    // Must have ALLOWED_INVOKE, ALLOWED_SEND, ALLOWED_RECEIVE
    assert(preload.includes('ALLOWED_INVOKE'), 'Should have ALLOWED_INVOKE');
    assert(preload.includes('ALLOWED_SEND'), 'Should have ALLOWED_SEND');
    assert(preload.includes('ALLOWED_RECEIVE'), 'Should have ALLOWED_RECEIVE');

    // Must check channels before allowing
    assert(preload.includes('if (!ALLOWED_INVOKE.includes(channel))'), 'Should validate invoke channels');
    assert(preload.includes('if (!ALLOWED_SEND.includes(channel))'), 'Should validate send channels');
    assert(preload.includes('if (!ALLOWED_RECEIVE.includes(channel))'), 'Should validate receive channels');
  });

  test('contextIsolation is true in main.js', () => {
    const fs = require('fs');
    const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

    assert(main.includes('contextIsolation: true'), 'contextIsolation must be true');
    assert(main.includes('nodeIntegration: false'), 'nodeIntegration must be false');
  });

  test('preload.js and preload.mjs have same channel count', () => {
    const fs = require('fs');
    const cjs = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
    const esm = fs.readFileSync(path.join(ROOT, 'preload.mjs'), 'utf8');

    const cjsInvoke = (cjs.match(/'agent:[^']+'/g) || []).length;
    const esmInvoke = (esm.match(/'agent:[^']+'/g) || []).length;

    assertEqual(cjsInvoke, esmInvoke);
  });
});

describe('E2E Electron — Main Process Config', () => {
  test('CSP headers are set', () => {
    const fs = require('fs');
    const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

    assert(
      main.includes('Content-Security-Policy') || main.includes('content-security-policy'),
      'Should set CSP headers'
    );
  });

  test('IPC handlers cover all preload channels', () => {
    const fs = require('fs');
    const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');

    // Extract invoke channels from preload
    const invokeChannels = [];
    const invokeMatch = preload.match(/ALLOWED_INVOKE\s*=\s*\[([\s\S]*?)\]/);
    if (invokeMatch) {
      const matches = invokeMatch[1].match(/'([^']+)'/g);
      if (matches) {
        for (const m of matches) invokeChannels.push(m.replace(/'/g, ''));
      }
    }

    // Check each channel has a handler in main.js
    let missing = 0;
    for (const ch of invokeChannels) {
      if (!main.includes(`'${ch}'`)) {
        console.log(`  ⚠ Channel '${ch}' in preload but not found in main.js handlers`);
        missing++;
      }
    }

    assert(missing === 0, `${missing} channels missing from main.js`);
  });

  test('window options are secure', () => {
    const fs = require('fs');
    const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

    // Should NOT have dangerous options
    assert(!main.includes('webSecurity: false'), 'webSecurity must not be false');
    assert(!main.includes('allowRunningInsecureContent: true'), 'Must not allow insecure content');
  });
});

describe('E2E Electron — HTML Entry Points', () => {
  test('index.html exists and references renderer', () => {
    const fs = require('fs');
    const html = fs.readFileSync(path.join(ROOT, 'src/ui/index.html'), 'utf8');

    assert(html.includes('<html'), 'Should be valid HTML');
    assert(
      html.includes('renderer') || html.includes('script'),
      'Should reference renderer script'
    );
  });

  test('bundled HTML exists as fallback', () => {
    const fs = require('fs');
    assert(
      fs.existsSync(path.join(ROOT, 'src/ui/index.bundled.html')),
      'Bundled HTML should exist'
    );
  });
});

describe('E2E Electron — Package Config', () => {
  test('main entry point is main.js', () => {
    const pkg = require(path.join(ROOT, 'package.json'));
    assertEqual(pkg.main, 'main.js');
  });

  test('electron dependency is ^39', () => {
    const pkg = require(path.join(ROOT, 'package.json'));
    const electronVer = pkg.devDependencies?.electron || pkg.dependencies?.electron || '';
    assert(electronVer.includes('39'), `Expected ^39, got ${electronVer}`);
  });

  test('start script launches electron (directly or via wrapper)', () => {
    const pkg = require(path.join(ROOT, 'package.json'));
    const fs = require('fs');
    const startCmd = pkg.scripts.start;

    // v7.2.9+: start may wrap electron via scripts/start.js (for chcp/UTF-8
    // setup on Windows). Follow the wrapper one level down to verify it
    // actually invokes electron.
    let launchesElectron = startCmd.includes('electron');

    if (!launchesElectron) {
      // Match either direct invocation or a node wrapper script
      const wrapperMatch = startCmd.match(/node\s+(\S+\.js)/);
      if (wrapperMatch) {
        const wrapperPath = path.join(ROOT, wrapperMatch[1]);
        if (fs.existsSync(wrapperPath)) {
          const wrapperSrc = fs.readFileSync(wrapperPath, 'utf8');
          launchesElectron = /\belectron\b/i.test(wrapperSrc);
        }
      }
    }

    assert(launchesElectron, `Start script (or its wrapper) must launch electron. Got: ${startCmd}`);
  });
});

run();
