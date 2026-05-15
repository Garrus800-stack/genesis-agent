// ============================================================
// Regression test: openPath path-extraction
//
// v7.5.6 Live-Befund (2026-05-02 Windows): pre-fix `openPath` was
// matching any "/foo/bar" anywhere in the message via the unixPath
// regex. So "zeig mir den inhalt von .genesis/self-statements/
// 2026-05-02.jsonl" was greedy-matched as just "/self-statements/
// 2026-05-02.jsonl", a bogus absolute path. Windows-Explorer falls
// back to its Documents default for an invalid abs-path, which is
// what the user saw.
//
// Fix:
//   (1) anchor unixPath at start-of-string OR whitespace
//   (2) add relPath support (./foo, ../foo, .name/foo) — resolved
//       against this.fp.rootDir, same anchor openWorkspace uses.
//
// This test pins the path-extraction logic against the live evidence.
// ============================================================

'use strict';

const path = require('path');
const os = require('os');

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
function assertEqual(a, b, m) { if (a !== b) throw new Error(`${m || 'not equal'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

(async () => {
  console.log('  openpath-path-extraction tests:');

  // Stub fs.existsSync to always return true for the path-extraction tests.
  // The existence-check (Bug #9) is tested separately below — we don't want
  // the existence-check to short-circuit the extraction tests.
  const fs = require('fs');
  const realExistsSync = fs.existsSync;
  const stubbedPaths = new Set();
  const stubExistence = (enable) => {
    if (enable) {
      fs.existsSync = (p) => {
        if (stubbedPaths.has('__all__')) return true;
        if (stubbedPaths.has(p)) return true;
        return realExistsSync(p);
      };
    } else {
      fs.existsSync = realExistsSync;
    }
  };

  const { commandHandlersShell } = require('../../src/agent/hexagonal/CommandHandlersShell');

  // ──────────────────────────────────────────────────────────────
  // Mock-context: spy on this.shell.run so we can capture which path
  // openPath actually tried to open. We don't need a real OS-call.
  // ──────────────────────────────────────────────────────────────

  function makeMockCtx({ rootDir = '/home/garrus/Genesis' } = {}) {
    const calls = [];
    return {
      shell: {
        run: async (cmd, _tier) => {
          calls.push(cmd);
          return { ok: true, exitCode: 0, stdout: '', stderr: '' };
        },
      },
      lang: { t: (k) => k },
      fp: { rootDir },
      _calls: calls,
    };
  }

  // Helper: extract the path that openPath passed to the shell command.
  // explorer/open/xdg-open all wrap with quotes — extract between quotes.
  function extractedPath(cmd) {
    const m = cmd.match(/["']([^"']+)["']/);
    return m ? m[1] : null;
  }

  // ──────────────────────────────────────────────────────────────
  // Bug #7 — relative-path support
  // (existence-check stubbed for these — tests focus on path extraction)
  // ──────────────────────────────────────────────────────────────

  stubbedPaths.add('__all__');
  stubExistence(true);

  await test('relative path .genesis/self-statements resolves against rootDir', async () => {
    const ctx = makeMockCtx({ rootDir: '/home/garrus/Genesis' });
    await commandHandlersShell.openPath.call(ctx, 'zeig mir den inhalt von .genesis/self-statements/2026-05-02.jsonl');
    assertEqual(ctx._calls.length, 1, 'expected one shell.run call');
    const opened = extractedPath(ctx._calls[0]);
    assertEqual(opened, path.resolve('/home/garrus/Genesis', '.genesis/self-statements/2026-05-02.jsonl'),
      'relative path must resolve against rootDir, not be treated as absolute');
  });

  await test('"./foo" resolves against rootDir', async () => {
    const ctx = makeMockCtx({ rootDir: '/home/garrus/Genesis' });
    await commandHandlersShell.openPath.call(ctx, 'öffne ./foo/bar.txt');
    const opened = extractedPath(ctx._calls[0]);
    assertEqual(opened, path.resolve('/home/garrus/Genesis', './foo/bar.txt'));
  });

  await test('"../foo" resolves against rootDir', async () => {
    const ctx = makeMockCtx({ rootDir: '/home/garrus/Genesis' });
    await commandHandlersShell.openPath.call(ctx, 'öffne ../foo/bar.txt');
    const opened = extractedPath(ctx._calls[0]);
    assertEqual(opened, path.resolve('/home/garrus/Genesis', '../foo/bar.txt'));
  });

  await test('".genesis/foo" (dot-prefixed name) resolves against rootDir', async () => {
    const ctx = makeMockCtx({ rootDir: '/home/garrus/Genesis' });
    await commandHandlersShell.openPath.call(ctx, 'open .genesis/foo');
    const opened = extractedPath(ctx._calls[0]);
    assertEqual(opened, path.resolve('/home/garrus/Genesis', '.genesis/foo'));
  });

  // ──────────────────────────────────────────────────────────────
  // Pre-existing behaviour — must NOT regress
  // ──────────────────────────────────────────────────────────────

  await test('absolute unix path /etc/passwd is preserved', async () => {
    const ctx = makeMockCtx();
    await commandHandlersShell.openPath.call(ctx, 'öffne /etc/passwd');
    const opened = extractedPath(ctx._calls[0]);
    assertEqual(opened, '/etc/passwd');
  });

  await test('absolute unix path with leading whitespace', async () => {
    const ctx = makeMockCtx();
    await commandHandlersShell.openPath.call(ctx, 'open /var/log');
    const opened = extractedPath(ctx._calls[0]);
    assertEqual(opened, '/var/log');
  });

  await test('home-relative path ~/.config is expanded to homedir', async () => {
    // v7.8.7: original test expected '~/.config' preserved, but v7.5.9
    // Linux-fix expands tilde BEFORE shell.run by design — child_process
    // spawn without shell=true doesn't tilde-expand, so a preserved tilde
    // would be passed as literal "~/.config" to xdg-open and fail.
    // existsSync also doesn't shell-expand. The expansion is the contract.
    const ctx = makeMockCtx();
    await commandHandlersShell.openPath.call(ctx, 'öffne ~/.config');
    const opened = extractedPath(ctx._calls[0]);
    assertEqual(opened, path.join(os.homedir(), '.config'));
  });

  await test('Windows full path is preserved', async () => {
    const ctx = makeMockCtx();
    await commandHandlersShell.openPath.call(ctx, 'öffne C:\\Users\\Garrus\\Desktop');
    const opened = extractedPath(ctx._calls[0]);
    assertEqual(opened, 'C:\\Users\\Garrus\\Desktop');
  });

  await test('Windows path with trailing punctuation is stripped', async () => {
    const ctx = makeMockCtx();
    await commandHandlersShell.openPath.call(ctx, 'öffne C:\\foo\\bar.');
    const opened = extractedPath(ctx._calls[0]);
    assertEqual(opened, 'C:\\foo\\bar');
  });

  await test('Quoted path overrides any other heuristic', async () => {
    const ctx = makeMockCtx({ rootDir: '/home/garrus/Genesis' });
    await commandHandlersShell.openPath.call(ctx, 'öffne "/some/quoted/path"');
    const opened = extractedPath(ctx._calls[0]);
    assertEqual(opened, '/some/quoted/path');
  });

  await test('Folder alias "Schreibtisch" resolves to home/Desktop', async () => {
    const ctx = makeMockCtx();
    await commandHandlersShell.openPath.call(ctx, 'öffne den Schreibtisch');
    const opened = extractedPath(ctx._calls[0]);
    assertEqual(opened, path.join(os.homedir(), 'Desktop'));
  });

  // ──────────────────────────────────────────────────────────────
  // The pre-fix bug: greedy-match must NOT slice ".genesis/foo" into "/foo"
  // ──────────────────────────────────────────────────────────────

  await test('REGRESSION: ".genesis/x" must NOT degrade to "/x" via greedy unix-match', async () => {
    const ctx = makeMockCtx({ rootDir: '/home/garrus/Genesis' });
    await commandHandlersShell.openPath.call(ctx, 'öffne .genesis/x');
    const opened = extractedPath(ctx._calls[0]);
    // Pre-fix this would have been '/x' (the bug). Post-fix must be the
    // resolved relative path.
    assertEqual(opened, path.resolve('/home/garrus/Genesis', '.genesis/x'));
    assert(opened !== '/x', 'must not slice the dot-prefix off');
  });

  await test('REGRESSION: "foo/bar" inside a sentence must not match as "/bar"', async () => {
    const ctx = makeMockCtx({ rootDir: '/home/garrus/Genesis' });
    // "den inhalt von foo/bar" — no quotes, no leading slash, no dot.
    // Pre-fix would have matched "/bar" (greedy) — post-fix should fall
    // through to app-launch path or "Welchen Ordner..." prompt.
    const result = await commandHandlersShell.openPath.call(ctx, 'zeig mir den inhalt von foo/bar');
    // Either the app-launch fired (Anwendung gestartet) or fell through
    // to the prompt — both are acceptable. What is NOT acceptable is
    // calling explorer with a sliced "/bar" path.
    if (ctx._calls.length > 0) {
      const opened = extractedPath(ctx._calls[0]);
      assert(opened !== '/bar',
        `must not slice "foo/bar" into "/bar", got: ${opened}`);
    }
  });

  // ──────────────────────────────────────────────────────────────
  // Bug #9 — existence check before OS-open-call
  //
  // Live-Befund nach Bug #7: Bug #7 resolved den Pfad korrekt, aber
  // wenn der Pfad gar nicht existiert, ruft Windows-Explorer den
  // Default-Documents-Ordner auf statt einer Fehlermeldung. Fix:
  // vor dem OS-Open-Call mit fs.existsSync prüfen.
  //
  // Stub für diese Tests deaktiviert — wir wollen das echte Verhalten.
  // ──────────────────────────────────────────────────────────────

  stubbedPaths.delete('__all__');
  stubExistence(false);

  await test('Non-existent path returns "Pfad existiert nicht" — no shell call', async () => {
    const ctx = makeMockCtx({ rootDir: '/home/garrus/Genesis' });
    // /home/garrus/Genesis/.genesis/foo definitiv nicht existent in CI/test
    const result = await commandHandlersShell.openPath.call(ctx, 'öffne .genesis/foo');
    assertEqual(ctx._calls.length, 0, 'shell.run must NOT be called for non-existent paths');
    assert(result.startsWith('Pfad existiert nicht'),
      `expected "Pfad existiert nicht", got: ${result}`);
  });

  await test('Non-existent absolute path returns clear error — no shell call', async () => {
    const ctx = makeMockCtx();
    const result = await commandHandlersShell.openPath.call(ctx, 'öffne /this/path/does/not/exist');
    assertEqual(ctx._calls.length, 0);
    assert(result.startsWith('Pfad existiert nicht'),
      `expected "Pfad existiert nicht", got: ${result}`);
  });

  await test('Existing path proceeds to shell.run', async () => {
    // Use the actual test-file directory, which definitely exists.
    const ctx = makeMockCtx();
    const existingDir = __dirname; // /path/to/test/modules
    await commandHandlersShell.openPath.call(ctx, `öffne "${existingDir}"`);
    assertEqual(ctx._calls.length, 1, 'shell.run must be called for existing paths');
    const opened = extractedPath(ctx._calls[0]);
    assertEqual(opened, existingDir);
  });

  console.log(`\n  openpath-path-extraction: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\n  Failures:');
    failures.forEach(f => console.log(`    - ${f.name}: ${f.error}`));
    process.exit(1);
  }
})();
