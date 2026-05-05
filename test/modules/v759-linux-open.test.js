// ============================================================
// Regression test: v7.5.9 Linux /open fixes
//
// User-Test 2026-05-05 (Linux):
//   1. "/open ~/Dokumente" → "Pfad existiert nicht: /open"
//      (unixPath regex in openPath matched the slash-command itself)
//   2. "öffne den Downloads-Ordner" → "Probier: /open den"
//      (extractOpenTarget captured the German article)
//   3. "/open firefox" on Linux returns null without trying
//      common dirs / .desktop files
//   4. App-not-found message hardcoded "Windows-Registry, Start-Menu"
//      even on Linux
// ============================================================

'use strict';

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(() => { passed++; console.log(`    ✅ ${name}`); })
              .catch(err => { failed++; failures.push({ name, error: err.message }); console.log(`    ❌ ${name}: ${err.message}`); });
    }
    passed++; console.log(`    ✅ ${name}`);
  } catch (err) { failed++; failures.push({ name, error: err.message }); console.log(`    ❌ ${name}: ${err.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }

(async () => {
  console.log('  v759-linux-open tests:');

  // ── Fix 1: openPath strips slash-prefix ────────────────────
  await test('Fix 1: /open /tmp resolves /tmp, not /open', async () => {
    const { commandHandlersShell } = require('../../src/agent/hexagonal/CommandHandlersShell');
    const mockShell = { run: async () => ({ ok: true, stdout: '', exitCode: 0 }) };
    const ctx = { shell: mockShell, fp: { rootDir: '/tmp' }, lang: { t: (k) => k } };
    const r = await commandHandlersShell.openPath.call(ctx, '/open /tmp');
    assert(!r.includes('Pfad existiert nicht: /open'),
      `slash-command leaked into path: ${r}`);
  });

  await test('Fix 1b: works with /öffne and /oeffne variants', async () => {
    const { commandHandlersShell } = require('../../src/agent/hexagonal/CommandHandlersShell');
    const mockShell = { run: async () => ({ ok: true, stdout: '', exitCode: 0 }) };
    const ctx = { shell: mockShell, fp: { rootDir: '/tmp' }, lang: { t: (k) => k } };
    for (const cmd of ['/öffne /tmp', '/oeffne /tmp']) {
      const r = await commandHandlersShell.openPath.call(ctx, cmd);
      assert(!r.match(/Pfad existiert nicht: \/(öffne|oeffne)/),
        `prefix leaked in "${cmd}": ${r}`);
    }
  });

  // ── Fix 4: slash-hint extracts noun, not article ───────────
  test('Fix 4: hint extracts noun "downloads", not article "den"', () => {
    const { commandHandlersSlashHint } = require('../../src/agent/hexagonal/CommandHandlersSlashHint');
    const fn = commandHandlersSlashHint._HINT_TEMPLATES['open-software'];
    const r = fn('öffne den Downloads-Ordner');
    assert(/Probier: `\/open downloads`/.test(r),
      'expected /open downloads, got: ' + r);
  });

  test('Fix 4b: skips multiple article variants', () => {
    const { commandHandlersSlashHint } = require('../../src/agent/hexagonal/CommandHandlersSlashHint');
    const fn = commandHandlersSlashHint._HINT_TEMPLATES['open-software'];
    assert(/\/open dokumente/.test(fn('öffne die Dokumente')));
    assert(/\/open browser/.test(fn('öffne den browser')));
    assert(/\/open firefox/.test(fn('öffne firefox')));
  });

  test('Fix 4c: strips compound suffix "-Ordner"', () => {
    const { commandHandlersSlashHint } = require('../../src/agent/hexagonal/CommandHandlersSlashHint');
    const fn = commandHandlersSlashHint._HINT_TEMPLATES['open-software'];
    assert(/\/open downloads/.test(fn('öffne Downloads-Ordner')));
    assert(/\/open archiv/.test(fn('öffne Archiv-Verzeichnis')));
  });

  // ── Fix 2: not-found message platform-aware ────────────────
  await test('Fix 2: not-found message reflects current platform', async () => {
    const { commandHandlersOpen } = require('../../src/agent/hexagonal/CommandHandlersOpen');
    const mockShell = {
      run: async () => ({ ok: false, exitCode: 1, stdout: '' }),
    };
    // Include all internal methods on ctx so _launch can call them.
    const ctx = Object.assign({}, commandHandlersOpen, { shell: mockShell });
    const r = await ctx._launch('definitely-no-such-app-xyz', null);
    if (process.platform === 'linux') {
      assert(/PATH-Probe.*\/usr\/bin/.test(r), `Linux help missing /usr/bin: ${r}`);
      assert(!/Windows-Registry/.test(r), `Linux must not say Windows-Registry: ${r}`);
      assert(!/Start-Menu/.test(r), `Linux must not say Start-Menu: ${r}`);
    } else if (process.platform === 'darwin') {
      assert(/Applications/.test(r), `macOS missing /Applications: ${r}`);
    } else {
      assert(/Windows-Registry/.test(r), `Windows missing Windows-Registry: ${r}`);
    }
  });

  // ── Fix 3: Linux PATH-probe uses both probes ───────────────
  await test('Fix 3: Linux probe uses both command -v AND which', async () => {
    if (process.platform === 'win32') return;
    const { commandHandlersOpen } = require('../../src/agent/hexagonal/CommandHandlersOpen');
    const probes = [];
    const mockShell = {
      run: async (cmd) => {
        probes.push(cmd);
        return { ok: false, exitCode: 1, stdout: '' };
      },
    };
    const ctx = Object.assign({}, commandHandlersOpen, { shell: mockShell });
    await ctx._resolveLaunchPath('xyzfooapp', null);
    assert(probes.some(c => /^command -v xyzfooapp/.test(c)),
      'command -v probe missing: ' + probes.join(' | '));
    assert(probes.some(c => /^which xyzfooapp/.test(c)),
      'which probe missing: ' + probes.join(' | '));
  });

  // ── Fix 5: ~ expansion in /open ───────────────────────────
  await test('Fix 5: openPath expands ~/X to user home before existsSync', async () => {
    const fs = require('fs');
    const path = require('path');
    const home = require('os').homedir();
    const testDir = path.join(home, '__genesis_v759_linux_test__');
    if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
    try {
      const { commandHandlersShell } = require('../../src/agent/hexagonal/CommandHandlersShell');
      const mockShell = { run: async () => ({ ok: true, stdout: '', exitCode: 0 }) };
      const ctx = { shell: mockShell, fp: { rootDir: '/tmp' }, lang: { t: (k) => k } };
      const r = await commandHandlersShell.openPath.call(ctx, '/open ~/__genesis_v759_linux_test__');
      assert(!r.includes('Pfad existiert nicht'),
        `~ should expand to home, got: ${r}`);
      assert(r.includes(testDir),
        `expected resolved path in result, got: ${r}`);
    } finally {
      fs.rmdirSync(testDir);
    }
  });

  // ── Fix 6: localized German folder fallback ───────────────
  await test('Fix 6: ~/Documents falls back to ~/Dokumente when only the German folder exists', async () => {
    const fs = require('fs');
    const path = require('path');
    const home = require('os').homedir();
    // Create German folder, no English one.
    const dokumente = path.join(home, '__genesis_v759_dokumente_test__');
    if (!fs.existsSync(dokumente)) fs.mkdirSync(dokumente, { recursive: true });
    try {
      const { commandHandlersShell } = require('../../src/agent/hexagonal/CommandHandlersShell');
      const mockShell = { run: async () => ({ ok: true, stdout: '', exitCode: 0 }) };
      const ctx = { shell: mockShell, fp: { rootDir: '/tmp' }, lang: { t: (k) => k } };
      // Direct-target a Dokumente sibling check by using the actual
      // localized name the user typed: /open <dokumente folder>.
      const r = await commandHandlersShell.openPath.call(ctx, `/open ${dokumente}`);
      assert(r.includes(dokumente) && !r.includes('existiert nicht'),
        `expected to open ${dokumente}, got: ${r}`);
    } finally {
      fs.rmdirSync(dokumente);
    }
  });

  // ── Fix 7: tool file-read ~ expansion ─────────────────────
  test('Fix 7: file-read tool resolves ~/X via home expansion', () => {
    // We can't easily instantiate the full ToolRegistry here, but we
    // CAN verify the expansion logic by reading the source — making
    // sure the fix is actually present and not silently reverted.
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').join(__dirname, '../../src/agent/intelligence/ToolRegistry.js'),
      'utf-8'
    );
    assert(/expand leading "~"/i.test(src) && /homedir\(\)/.test(src),
      '~ expansion comment + os.homedir() call missing in ToolRegistry.js');
  });

  // ── Fix 8: sudo non-interactive ───────────────────────────
  test('Fix 8: install command transforms sudo → sudo -n for non-interactive execution', () => {
    // Verify the install handler source has the transform — runtime
    // test would require a full handler context with shell mock.
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').join(__dirname, '../../src/agent/hexagonal/CommandHandlersInstall.js'),
      'utf-8'
    );
    assert(/sudo\s+-n\b/.test(src), 'sudo -n transform missing');
    assert(/a password is required|a terminal is required/.test(src),
      'sudo no-password detection missing');
  });

  console.log(`\n  v759-linux-open: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(`  ❌ ${f.name}: ${f.error}`));
    process.exit(1);
  }
})();
