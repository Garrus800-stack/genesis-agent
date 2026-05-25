#!/usr/bin/env node
// ============================================================
// GENESIS — test/modules/v7911-shell-path-adapter.contract.test.js
//
// v7.9.11: ShellOSAdapter.adaptCommand now converts forward-slash
// paths to backslashes on Windows. cmd switches (/V, /C, /e etc.)
// and quoted strings stay intact.
//
// Reproduces Garrus's Win field-trace 2026-05-25 scenario where
// `cat src/agent/X.js` adapted to `type src/agent/X.js` and cmd.exe
// interpreted `/agent` as switches `/a /g /e /n /t`, producing
// "Die Syntax für den Dateinamen ist falsch".
// ============================================================

'use strict';

const { describe, test, assertEqual, run } = require('../harness');
const { adaptCommand } = require('../../src/agent/capabilities/shell/ShellOSAdapter');

describe('v7.9.11 — ShellOSAdapter forward-slash path conversion', () => {

  // ── Win: paths get converted ─────────────────────────────

  test('Win: cat src/agent/X.js → type src\\agent\\X.js (the field-trace case)', () => {
    assertEqual(adaptCommand('cat src/agent/X.js', 'win32'), 'type src\\agent\\X.js');
  });

  test('Win: echo src/x.js > out → echo src\\x.js > out', () => {
    assertEqual(adaptCommand('echo src/x.js > out', 'win32'), 'echo src\\x.js > out');
  });

  test('Win: cat ./src/x.js → type .\\src\\x.js (relative path)', () => {
    assertEqual(adaptCommand('cat ./src/x.js', 'win32'), 'type .\\src\\x.js');
  });

  test('Win: ls ../parent/dir → dir ..\\parent\\dir (parent-relative)', () => {
    assertEqual(adaptCommand('ls ../parent/dir', 'win32'), 'dir ..\\parent\\dir');
  });

  // ── Win: cmd switches must stay intact (Bug 3 protection) ─

  test('Win: find /V /C ":" preserved (single-letter switches)', () => {
    assertEqual(adaptCommand('find /V /C ":"', 'win32'), 'find /V /C ":"');
  });

  test('Win: find /v /c "" gets normalised to find /V /C ":" (existing v7.5.4 find-rewriter, not my fix)', () => {
    // Note: this isn't my v7.9.11 path-adapter doing anything — it's the
    // existing find/grep canonicaliser at line ~135 of ShellOSAdapter
    // which rewrites the LLM-hallucinated `find /v /c ""` form to the
    // quote-safe `find /V /C ":"` form. Asserting the post-rewrite shape
    // here so a future change to that rewriter is caught.
    assertEqual(adaptCommand('find /v /c ""', 'win32'), 'find /V /C ":"');
  });

  test('Win: xcopy /e /i src/foo dst/bar — switches preserved + paths converted', () => {
    assertEqual(adaptCommand('xcopy /e /i src/foo dst/bar', 'win32'), 'xcopy /e /i src\\foo dst\\bar');
  });

  test('Win: rmdir /s /q somedir preserved', () => {
    assertEqual(adaptCommand('rmdir /s /q somedir', 'win32'), 'rmdir /s /q somedir');
  });

  test('Win: dir /b preserved', () => {
    assertEqual(adaptCommand('dir /b', 'win32'), 'dir /b');
  });

  // ── Win: preserved (POSIX absolute, URLs, quoted, single /) ─

  test('Win: cat /var/log/syslog stays POSIX (absolute system path, fails loudly)', () => {
    assertEqual(adaptCommand('cat /var/log/syslog', 'win32'), 'type /var/log/syslog');
  });

  test('Win: curl https://example.com/api unchanged', () => {
    assertEqual(adaptCommand('curl https://example.com/api', 'win32'), 'curl https://example.com/api');
  });

  test('Win: find . -path "./src/x.js" — quoted path preserved', () => {
    assertEqual(adaptCommand('find . -path "./src/x.js"', 'win32'), 'find . -path "./src/x.js"');
  });

  test('Win: echo / stays single-slash', () => {
    assertEqual(adaptCommand('echo /', 'win32'), 'echo /');
  });

  // ── Linux/Mac: no conversion at all ──────────────────────

  test('Linux: cat src/agent/X.js unchanged (early-return guard)', () => {
    assertEqual(adaptCommand('cat src/agent/X.js', 'linux'), 'cat src/agent/X.js');
  });

  test('darwin: no conversion either', () => {
    assertEqual(adaptCommand('cat src/agent/X.js', 'darwin'), 'cat src/agent/X.js');
  });

});

if (require.main === module) run();
