// ============================================================
// GENESIS — test/modules/OpenPathAppLaunch.test.js
// Direct contract test for the OpenPathAppLaunch.tryAppLaunch
// helper extracted from CommandHandlersShell.openPath in v7.8.3.
// The function is already exercised indirectly via the
// v783-openpath-app-launch suite, but the architectural-fitness
// coverage check looks for a test file that names the module —
// this file satisfies it and pins the three rejection gates plus
// the success and error returns.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');

const { tryAppLaunch } = require(path.resolve(__dirname, '..', '..', 'src/agent/hexagonal/OpenPathAppLaunch'));

function makeShell({ result = { ok: true }, throws = null } = {}) {
  return {
    calls: [],
    async run(cmd) {
      this.calls.push(cmd);
      if (throws) throw new Error(throws);
      return result;
    },
  };
}

describe('OpenPathAppLaunch contract', () => {
  test('returns null when message has no verb', async () => {
    const shell = makeShell();
    const r = await tryAppLaunch('was ist mit dem wetter', shell);
    assertEqual(r, null);
    assertEqual(shell.calls.length, 0);
  });

  test('returns null when captured token is a filler', async () => {
    const shell = makeShell();
    const r = await tryAppLaunch('öffne bitte mal', shell);
    // 'mal' is a filler; nothing real to launch.
    assertEqual(r, null);
  });

  test('returns null when captured token is a common noun', async () => {
    const shell = makeShell();
    // 'datei' is a generic noun, not an app name
    const r = await tryAppLaunch('öffne die datei', shell);
    assertEqual(r, null);
  });

  test('returns null when message contains a filename + open verb (anaphora-protect)', async () => {
    const shell = makeShell();
    // 'open <file.ext>' should defer to the path-extraction branch
    const r = await tryAppLaunch('open report.pdf', shell);
    assertEqual(r, null);
  });

  test('launches app for a real verb + non-filler + non-noun token', async () => {
    const shell = makeShell({ result: { ok: true } });
    const r = await tryAppLaunch('starte notepad', shell);
    assert(r && r.launched === true, `expected launched: ${JSON.stringify(r)}`);
    assertEqual(r.name, 'notepad');
    assert(shell.calls.length >= 1, 'shell.run must have been called');
  });

  test('returns launched=false with error message when shell throws', async () => {
    const shell = makeShell({ throws: 'spawn ENOENT' });
    const r = await tryAppLaunch('starte notepad', shell);
    assert(r && r.launched === false, `expected launch failure: ${JSON.stringify(r)}`);
    assert(/spawn ENOENT|error/i.test(r.error || ''),
      `expected error to surface: ${r.error}`);
  });
});

run();
