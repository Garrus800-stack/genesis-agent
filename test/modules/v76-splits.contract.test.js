// ============================================================
// GENESIS — test/modules/v76-splits.contract.test.js
//
// Contract tests for the four split files introduced in v7.6.0
// (Track A #2 + #3). Each split file is intentionally focused and
// has a small, stable export surface — these tests pin that surface
// so that file moves, function renames, or accidental shape
// changes surface immediately rather than at integration test time.
//
// Audit §4.3 (v7.6.0): introduced these as direct-coverage tests
// for the four split modules that previously had only indirect
// coverage via the v759-zip3/zip4/linux-open integration tests.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

describe('v76-splits contract: CommandHandlersInstallDB', () => {

  test('exposes the five required exports', () => {
    const DB = require(path.join(ROOT, 'src/agent/hexagonal/CommandHandlersInstallDB'));
    assert(DB._PACKAGE_MANAGERS, 'missing _PACKAGE_MANAGERS');
    assert(DB._BOOTSTRAP_COMMANDS, 'missing _BOOTSTRAP_COMMANDS');
    assert(DB._SOFTWARE_DB, 'missing _SOFTWARE_DB');
    assert(DB._PACKAGE_ALIASES, 'missing _PACKAGE_ALIASES');
    assert(DB._PACKAGE_NAME_RE, 'missing _PACKAGE_NAME_RE');
  });

  test('exposes _KNOWN_WIN_APPS shape (audit §4.3)', () => {
    const DB = require(path.join(ROOT, 'src/agent/hexagonal/CommandHandlersInstallDB'));
    const known = DB._KNOWN_WIN_APPS;
    assert(known, 'missing _KNOWN_WIN_APPS');
    assert(typeof known === 'object', '_KNOWN_WIN_APPS must be an object');
    // Each entry must have a dir + exe — single source of truth for
    // both Open and Install handlers.
    for (const [name, entry] of Object.entries(known)) {
      assert(entry.dir, `${name}: missing .dir`);
      assert(entry.exe, `${name}: missing .exe`);
      assert(/\.exe$/i.test(entry.exe), `${name}: .exe must end with .exe`);
    }
  });

  test('package-name regex rejects shell metachars', () => {
    const { _PACKAGE_NAME_RE } = require(path.join(ROOT, 'src/agent/hexagonal/CommandHandlersInstallDB'));
    assert(_PACKAGE_NAME_RE.test('firefox'));
    assert(_PACKAGE_NAME_RE.test('vscode'));
    assert(_PACKAGE_NAME_RE.test('7zip'));
    assert(!_PACKAGE_NAME_RE.test('foo;bar'));
    assert(!_PACKAGE_NAME_RE.test('foo bar'));
    assert(!_PACKAGE_NAME_RE.test('foo|bar'));
  });

  test('PACKAGE_MANAGERS lists each platform Genesis claims to support', () => {
    const { _PACKAGE_MANAGERS } = require(path.join(ROOT, 'src/agent/hexagonal/CommandHandlersInstallDB'));
    assert(Array.isArray(_PACKAGE_MANAGERS.win32) && _PACKAGE_MANAGERS.win32.length > 0);
    assert(Array.isArray(_PACKAGE_MANAGERS.darwin) && _PACKAGE_MANAGERS.darwin.length > 0);
    assert(Array.isArray(_PACKAGE_MANAGERS.linux) && _PACKAGE_MANAGERS.linux.length > 0);
  });

});

describe('v76-splits contract: CommandHandlersInstallDetect', () => {

  test('exposes detection methods as a mixin object (audit §4.3)', () => {
    const detect = require(path.join(ROOT, 'src/agent/hexagonal/CommandHandlersInstallDetect'));
    // The mixin gets Object.assign'd onto CommandHandlersInstall, so its
    // top-level keys must be functions.
    const expected = [
      '_setLastInstalled', '_getLastInstalled',
      '_checkAlreadyInstalled', '_fileExistsCheck', '_findWindowsApp',
      '_detectPackageManager', '_pmAvailable', '_resolveAlias',
      '_extractPackageInfo', '_extractPackageName',
      '_previewWhyNotExecuting', '_getDownloadDir',
      '_buildDownloadCommand', '_buildLaunchCommand', '_formatSize',
    ];
    for (const m of expected) {
      assert(typeof detect[m] === 'function', `${m} must be a function`);
    }
  });

  test('install handler has detect-mixin methods after Object.assign (integration)', () => {
    const { commandHandlersInstall } = require(path.join(ROOT, 'src/agent/hexagonal/CommandHandlersInstall'));
    assert(typeof commandHandlersInstall._checkAlreadyInstalled === 'function',
      'detect mixin not wired into install handler');
    assert(typeof commandHandlersInstall._findWindowsApp === 'function');
    assert(typeof commandHandlersInstall.installSoftware === 'function',
      'install handler must keep installSoftware on the dispatcher');
  });

});

describe('v76-splits contract: CommandHandlersOpenWin', () => {

  test('exports resolveWin as async function with arity 2 (audit §4.3)', () => {
    const mod = require(path.join(ROOT, 'src/agent/hexagonal/CommandHandlersOpenWin'));
    assert(typeof mod.resolveWin === 'function');
    assertEqual(mod.resolveWin.length, 2, 'resolveWin signature: (name, ctx)');
  });

  test('Win resolver imports KNOWN_WIN_APPS from DB (single source of truth)', () => {
    // Ensure the resolver does not redeclare KNOWN_APPS inline. If a
    // future edit re-introduces inline data, this test surfaces the
    // duplication. We grep the source — runtime introspection of
    // imports is expensive for a contract test.
    const fs = require('fs');
    const src = fs.readFileSync(
      path.join(ROOT, 'src/agent/hexagonal/CommandHandlersOpenWin.js'), 'utf8');
    assert(src.includes("require('./CommandHandlersInstallDB')"),
      'CommandHandlersOpenWin.js must import KNOWN_WIN_APPS from DB');
    assert(!/const\s+KNOWN_APPS\s*=\s*\{/.test(src),
      'CommandHandlersOpenWin.js must not redeclare KNOWN_APPS inline');
  });

});

describe('v76-splits contract: CommandHandlersOpenLinux', () => {

  test('exports resolveLinux as async function with arity 2 (audit §4.3)', () => {
    const mod = require(path.join(ROOT, 'src/agent/hexagonal/CommandHandlersOpenLinux'));
    assert(typeof mod.resolveLinux === 'function');
    assertEqual(mod.resolveLinux.length, 2, 'resolveLinux signature: (name, ctx)');
  });

  test('Linux resolver covers .desktop file lookup branch', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      path.join(ROOT, 'src/agent/hexagonal/CommandHandlersOpenLinux.js'), 'utf8');
    assert(/\.desktop/.test(src), 'must include .desktop file lookup');
    assert(/share\/applications/.test(src), 'must include share/applications root');
    assert(/Exec=/.test(src), 'must read Exec= line from .desktop');
  });

  test('Linux resolver covers /snap/bin and ~/.local/bin', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      path.join(ROOT, 'src/agent/hexagonal/CommandHandlersOpenLinux.js'), 'utf8');
    assert(src.includes('/snap/bin'), 'snap path must be checked');
    assert(src.includes('.local/bin'), 'user-local bin must be checked');
  });

});

run();
