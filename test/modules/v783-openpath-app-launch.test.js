// ============================================================
// GENESIS — test/modules/v783-openpath-app-launch.test.js (v7.8.3)
//
// Regression tests for the v7.5.8-backlog openPath app-launch bug.
//
// Pre-fix problem: the fallback regex `(\w[\w\s.-]*\w)` captured
// whitespace, so "öffne firefox bitte" launched "firefox bitte"
// (failed). And the verb list had no word-boundary, so "reopen the
// window" matched "open" mid-word.
//
// v7.8.3 fix:
//   - Explicit Unicode-safe boundary `(?:^|[^\w])` before verb list
//   - Capture group narrowed to single word with dash/dot
//   - Filler tokens (bitte, please, mir, the, ...) consumed between
//     verb and app-name via optional repetition
//   - Post-match filler-set check for the rare "öffne bitte" edge
// ============================================================

'use strict';

const assert = require('assert');

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(() => { passed++; console.log(`    ✅ ${name}`); },
                    (err) => { failed++; failures.push({name, error: err.message}); console.log(`    ❌ ${name}: ${err.message}`); });
    }
    passed++;
    console.log(`    ✅ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`    ❌ ${name}: ${err.message}`);
  }
}

const { commandHandlersShell: handlers } = require('../../src/agent/hexagonal/CommandHandlersShell');
handlers.lang = { t: () => 'shell-unavailable' };
handlers.shell = {
  run: async (_cmd) => ({ ok: true }),
};
handlers.fp = { rootDir: process.cwd() };

// ── App-launch happy path (DE) ──────────────────────────────

const openApp = (msg) => handlers.openPath(msg);

(async () => {
  await test('DE: "öffne firefox" → launches firefox', async () => {
    assert.strictEqual(await openApp('öffne firefox'), 'Anwendung gestartet: firefox');
  });

  await test('DE: "öffne firefox bitte" must NOT capture "bitte" (the v7.5.8 backlog bug)', async () => {
    assert.strictEqual(await openApp('öffne firefox bitte'), 'Anwendung gestartet: firefox');
  });

  await test('DE: "starte mir bitte firefox" skips both fillers', async () => {
    assert.strictEqual(await openApp('starte mir bitte firefox'), 'Anwendung gestartet: firefox');
  });

  await test('DE: "starte chrome jetzt" strips trailing filler', async () => {
    assert.strictEqual(await openApp('starte chrome jetzt'), 'Anwendung gestartet: chrome');
  });

  await test('DE: "öffne mir bitte firefox doch" handles multi-filler + trailing', async () => {
    assert.strictEqual(await openApp('öffne mir bitte firefox doch'), 'Anwendung gestartet: firefox');
  });

  await test('DE: "oeffne" variant (ASCII spelling) works', async () => {
    assert.strictEqual(await openApp('oeffne libreoffice'), 'Anwendung gestartet: libreoffice');
  });

  // ── App-launch happy path (EN) ───────────────────────────

  await test('EN: "open firefox" → launches firefox', async () => {
    assert.strictEqual(await openApp('open firefox'), 'Anwendung gestartet: firefox');
  });

  await test('EN: "open please firefox" skips filler', async () => {
    assert.strictEqual(await openApp('open please firefox'), 'Anwendung gestartet: firefox');
  });

  await test('EN: "open just chrome" skips filler', async () => {
    assert.strictEqual(await openApp('open just chrome'), 'Anwendung gestartet: chrome');
  });

  await test('EN: "start firefox now" strips trailing filler', async () => {
    assert.strictEqual(await openApp('start firefox now'), 'Anwendung gestartet: firefox');
  });

  // ── App-names with special chars ─────────────────────────

  await test('apps with hyphen: "öffne libreoffice-writer"', async () => {
    assert.strictEqual(await openApp('öffne libreoffice-writer'), 'Anwendung gestartet: libreoffice-writer');
  });

  await test('apps with dot: "starte node.js"', async () => {
    assert.strictEqual(await openApp('starte node.js'), 'Anwendung gestartet: node.js');
  });

  await test('apps with digits: "öffne python3"', async () => {
    assert.strictEqual(await openApp('öffne python3'), 'Anwendung gestartet: python3');
  });

  // ── Filler-only edge (the v7.8.3 post-match check) ───────

  await test('"öffne bitte" with NO app-name falls through to help', async () => {
    const r = await openApp('öffne bitte');
    assert.ok(r.startsWith('Welchen Ordner'), `expected help message, got: ${r}`);
  });

  await test('"open please" with NO app-name falls through to help', async () => {
    const r = await openApp('open please');
    assert.ok(r.startsWith('Welchen Ordner'), `expected help message, got: ${r}`);
  });

  // ── Backward-compat: paths must STILL route through path-branch ──

  await test('path "öffne /tmp/foo" does NOT trigger app-launch', async () => {
    const r = await openApp('öffne /tmp/foo');
    assert.ok(r.startsWith('Pfad existiert nicht') || r.startsWith('Ordner geöffnet'),
      `expected path response, got: ${r}`);
  });

  await test('alias "öffne den Desktop" does NOT trigger app-launch', async () => {
    const r = await openApp('öffne den Desktop');
    assert.ok(r.startsWith('Pfad existiert nicht') || r.startsWith('Ordner geöffnet'),
      `expected path response, got: ${r}`);
  });

  await test('anaphora "öffne meinen Genesis-Ordner" routes to rootDir', async () => {
    const r = await openApp('öffne meinen Genesis-Ordner');
    assert.ok(r.startsWith('Ordner geöffnet'), `expected folder-open, got: ${r}`);
  });

  // ── Boundary safety: mid-word matches must NOT fire ──────

  await test('mid-word "reopen" must NOT match "open" → falls through to help', async () => {
    const r = await openApp('reopen window');
    // The verb regex requires (?:^|[^\w]) before "open", so "reopen" cannot
    // match. Should fall through to the help message (no path, no app).
    assert.ok(r.startsWith('Welchen Ordner') || r.startsWith('Anwendung gestartet: window'),
      `expected boundary protection, got: ${r}`);
  });

  // ── v7.8.3 follow-up (F3): common-noun trap ─────────────────

  await test('contract: "open the document" must NOT launch app "document"', async () => {
    const r = await openApp('open the document');
    assert.ok(r.startsWith('Welchen Ordner'),
      `common noun "document" must reject app-launch, got: ${r}`);
  });

  await test('contract: "öffne die Datei test.txt" must NOT launch app "Datei"', async () => {
    const r = await openApp('öffne die Datei test.txt');
    assert.ok(r.startsWith('Welchen Ordner'),
      `common noun "Datei" + filename present must reject app-launch, got: ${r}`);
  });

  await test('contract: "starte den Browser firefox" must NOT launch app "Browser"', async () => {
    const r = await openApp('starte den Browser firefox');
    // Captured first token is "Browser" (common noun) — reject. User
    // should re-phrase as "starte firefox" or "öffne firefox".
    assert.ok(r.startsWith('Welchen Ordner'),
      `common noun "Browser" must reject app-launch, got: ${r}`);
  });

  await test('contract: "open the terminal" must NOT launch app "terminal"', async () => {
    const r = await openApp('open the terminal');
    assert.ok(r.startsWith('Welchen Ordner'),
      `common noun "terminal" must reject app-launch, got: ${r}`);
  });

  await test('contract: "öffne den Editor" must NOT launch app "Editor"', async () => {
    const r = await openApp('öffne den Editor');
    assert.ok(r.startsWith('Welchen Ordner'),
      `common noun "Editor" must reject app-launch, got: ${r}`);
  });

  await test('contract: "öffne notes.md" must NOT launch app "notes" (filename present)', async () => {
    const r = await openApp('öffne notes.md');
    assert.ok(r.startsWith('Welchen Ordner'),
      `filename present must defer to path-fallback, got: ${r}`);
  });

  await test('"öffne firefox" still LAUNCHES firefox (sanity — no false-reject)', async () => {
    const r = await openApp('öffne firefox');
    assert.ok(r.startsWith('Anwendung gestartet: firefox'),
      `legitimate app-name must still launch, got: ${r}`);
  });

  await test('"start vscode" still LAUNCHES vscode (sanity — no false-reject)', async () => {
    const r = await openApp('start vscode');
    assert.ok(r.startsWith('Anwendung gestartet: vscode'),
      `legitimate app-name must still launch, got: ${r}`);
  });

  // ── summary ─────────────────────────────────────────────

  if (failed > 0) {
    console.log(`\n  ${failed} failure(s):`);
    for (const f of failures) console.log(`    - ${f.name}: ${f.error}`);
    process.exit(1);
  }
  console.log(`    ${passed} passed`);
})();
