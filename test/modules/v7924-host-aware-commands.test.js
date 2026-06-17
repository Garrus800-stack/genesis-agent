#!/usr/bin/env node
// Test: v7.9.24 — host-aware command handling
//   1. adaptCommand skips POSIX→cmd.exe tool substitutions when real Unix
//      tools are on PATH, but still applies cmd.exe-syntax fixes.
//   2. Install aliases map the bundled Unix tools to Git for Windows.
//   3. The package-name extractor accepts the tool names (incl. 2-char wc).
//   4. AgentLoopRecovery turns a command-not-found obstacle into an install
//      suggestion instead of a doomed sub-goal.

const { describe, test, assert, assertEqual, run } = require('../harness');
const OSAdapter = require('../../src/agent/capabilities/shell/ShellOSAdapter');
const DB = require('../../src/agent/hexagonal/CommandHandlersInstallDB');
const Detect = require('../../src/agent/hexagonal/CommandHandlersInstallDetect');
const { AgentLoopRecoveryDelegate } = require('../../src/agent/revolution/AgentLoopRecovery');

const BUNDLED = ['bash', 'sed', 'awk', 'wc', 'head', 'tail', 'cut', 'uniq'];

describe('v7.9.24 — adaptCommand gate (Unix tools on PATH)', () => {

  test('default (no Unix tools): POSIX tools are still substituted', () => {
    OSAdapter.setUnixToolsOnPath(false);
    assertEqual(OSAdapter.adaptCommand('grep foo file.txt', 'win32'), 'findstr foo file.txt');
    assertEqual(OSAdapter.adaptCommand('cat foo.txt | wc -l', 'win32'), 'type foo.txt | find /V /C ":"');
    assertEqual(OSAdapter.adaptCommand('ls', 'win32'), 'dir');
  });

  test('Unix tools present: tool substitutions are skipped', () => {
    try {
      OSAdapter.setUnixToolsOnPath(true);
      assertEqual(OSAdapter.adaptCommand('grep foo file.txt', 'win32'), 'grep foo file.txt');
      assertEqual(OSAdapter.adaptCommand('cat foo.txt | wc -l', 'win32'), 'cat foo.txt | wc -l');
      assertEqual(OSAdapter.adaptCommand('ls', 'win32'), 'ls');
      assertEqual(OSAdapter.adaptCommand('sed -i s/a/b/ file', 'win32'), 'sed -i s/a/b/ file');
    } finally {
      OSAdapter.setUnixToolsOnPath(false); // never leak module state to other tests
    }
  });

  test('Unix tools present: cmd.exe-syntax fixes still apply', () => {
    try {
      OSAdapter.setUnixToolsOnPath(true);
      // $VAR → %VAR% (cmd.exe variable syntax, echo is a cmd.exe builtin)
      assertEqual(OSAdapter.adaptCommand('echo $HOME', 'win32'), 'echo %HOME%');
      // path slashes + /dev/null → NUL still apply, but cat is NOT swapped to type
      assertEqual(OSAdapter.adaptCommand('cat src/x.js > /dev/null', 'win32'), 'cat src\\x.js > NUL');
    } finally {
      OSAdapter.setUnixToolsOnPath(false);
    }
  });

  test('flag reset restores default substitution behaviour', () => {
    OSAdapter.setUnixToolsOnPath(false);
    assertEqual(OSAdapter.adaptCommand('grep foo file.txt', 'win32'), 'findstr foo file.txt');
  });

  test('non-Windows is unaffected by the flag', () => {
    try {
      OSAdapter.setUnixToolsOnPath(true);
      assertEqual(OSAdapter.adaptCommand('grep foo file.txt', 'linux'), 'grep foo file.txt');
    } finally {
      OSAdapter.setUnixToolsOnPath(false);
    }
  });
});

describe('v7.9.24 — install aliases map bundled tools to Git for Windows', () => {

  test('winget alias resolves each bundled tool to Git.Git', () => {
    for (const tool of BUNDLED) {
      assertEqual(Detect._resolveAlias(tool, 'winget'), 'Git.Git', `${tool} → winget`);
    }
  });

  test('choco alias resolves each bundled tool to git', () => {
    for (const tool of BUNDLED) {
      assertEqual(Detect._resolveAlias(tool, 'choco'), 'git', `${tool} → choco`);
    }
  });

  test('no Linux PM keys (native there): apt resolution falls back to the name', () => {
    // On Linux these tools are native; mapping sed to a "git" package would
    // be wrong, so the alias has no apt/dnf/... keys and _resolveAlias
    // returns the bare name (which _checkAlreadyInstalled then finds on PATH).
    assertEqual(Detect._resolveAlias('sed', 'apt'), 'sed');
    assertEqual(Detect._resolveAlias('awk', 'pacman'), 'awk');
  });

  test('find/sort are NOT aliased (native cmd.exe equivalents exist)', () => {
    assertEqual(Detect._resolveAlias('find', 'winget'), 'find');
    assertEqual(Detect._resolveAlias('sort', 'winget'), 'sort');
  });

  test('Tier-3 fallback DB points each bundled tool at Git for Windows', () => {
    for (const tool of BUNDLED) {
      const entry = DB._SOFTWARE_DB[tool];
      assert(entry && entry.win32, `${tool} has a win32 fallback entry`);
      assert(/gitforwindows\.org/.test(entry.win32.url), `${tool} → gitforwindows.org`);
    }
  });

  test('the bundled-tool DB entries share one descriptor (no duplication)', () => {
    assert(DB._SOFTWARE_DB['sed'] === DB._SOFTWARE_DB['awk']);
    assert(DB._SOFTWARE_DB['wc'] === DB._SOFTWARE_DB['bash']);
  });
});

describe('v7.9.24 — package-name extraction for the bundled tools', () => {

  test('install <tool> extracts the bare tool name (incl. 2-char wc)', () => {
    for (const tool of BUNDLED) {
      assertEqual(Detect._extractPackageName(`install ${tool}`), tool);
    }
  });

  test('German verb "installiere <tool>" also works', () => {
    assertEqual(Detect._extractPackageName('installiere sed'), 'sed');
  });
});

describe('v7.9.24 — AgentLoopRecovery install-suggestion bridge', () => {

  function makeDelegate(commandHandlers) {
    const loop = {
      bus: {
        _container: { resolve: (name) => (name === 'commandHandlers' ? commandHandlers : null) },
        fire: () => {},
      },
    };
    return new AgentLoopRecoveryDelegate(loop);
  }

  test('calls installSoftware with a verb prefix and surfaces the preview', async () => {
    let calledWith = null;
    const handlers = {
      installSoftware: async (msg) => { calledWith = msg; return '**Tier 1 — Package-Manager:** winget gefunden'; },
    };
    const delegate = makeDelegate(handlers);
    const progress = [];
    const text = await delegate._suggestInstallForMissingCommand(
      { type: 'command-not-found', command: 'sed' },
      (e) => progress.push(e),
    );
    assertEqual(calledWith, 'install sed'); // verb prefix is required by _extractPackageName
    assert(text.includes('sed'));
    assert(/not available on this host/.test(text));
    assert(text.includes('winget gefunden'));
    assertEqual(progress.length, 1);
    assertEqual(progress[0].phase, 'install-suggestion');
    assertEqual(progress[0].command, 'sed');
  });

  test('returns null when no commandHandlers are wired', async () => {
    const delegate = makeDelegate(null);
    const text = await delegate._suggestInstallForMissingCommand(
      { type: 'command-not-found', command: 'sed' }, () => {},
    );
    assertEqual(text, null);
  });

  test('returns null when the handler yields an empty preview', async () => {
    const handlers = { installSoftware: async () => '   ' };
    const delegate = makeDelegate(handlers);
    const text = await delegate._suggestInstallForMissingCommand(
      { type: 'command-not-found', command: 'sed' }, () => {},
    );
    assertEqual(text, null);
  });

  test('returns null for an obstacle without a command', async () => {
    const handlers = { installSoftware: async () => 'should not be called' };
    const delegate = makeDelegate(handlers);
    const text = await delegate._suggestInstallForMissingCommand({ type: 'command-not-found' }, () => {});
    assertEqual(text, null);
  });
});

run();
