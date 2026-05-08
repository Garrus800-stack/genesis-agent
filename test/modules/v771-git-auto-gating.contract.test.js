'use strict';

// ============================================================
// v7.7.1-hotfix — Git auto-operations gating contract
//
// Pins the v7.7.1 hotfix:
//   - agency.gitAutoInit + agency.gitAutoCommit are both default false
//   - SelfModel.scan() init+commit is gated behind gitAutoInit
//   - SelfModel.commitSnapshot() is no-op when gitAutoCommit is off
//   - SelfModel.rollback() throws when gitAutoCommit is off
//   - MultiFileRefactor.refactor() autoCommit default is settings-derived
//   - AgentCoreBoot injects settings into selfModel before scan()
//   - settings-defaults.js binds the two new toggles
//   - Language.js has EN + DE strings for both
// ============================================================

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..', '..');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`    ✅ ${name}`); passed++; }
  catch (e) { console.log(`    ❌ ${name}: ${e.message}`); failed++; }
}

// ── Settings defaults ────────────────────────────────────────

test('Settings.js: agency.gitAutoInit default is false', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/Settings.js'), 'utf-8');
  assert.match(src, /gitAutoInit:\s*false/, 'gitAutoInit must default to false');
});

test('Settings.js: agency.gitAutoCommit default is false', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/Settings.js'), 'utf-8');
  assert.match(src, /gitAutoCommit:\s*false/, 'gitAutoCommit must default to false');
});

// ── SelfModel gating ─────────────────────────────────────────

test('SelfModel.js: scan() checks agency.gitAutoInit before git init', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/SelfModel.js'), 'utf-8');
  assert.match(src, /agency\.gitAutoInit/, 'gitAutoInit setting must be referenced');
  // The check must be before the git init call
  const gateIdx = src.indexOf('agency.gitAutoInit');
  const initIdx = src.indexOf("execFileAsync('git', ['init']");
  assert.ok(gateIdx > 0 && initIdx > 0, 'both markers must exist');
  assert.ok(gateIdx < initIdx, 'gate check must come BEFORE git init call');
});

test('SelfModel.js: commitSnapshot() early-returns when gitAutoCommit is off', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/SelfModel.js'), 'utf-8');
  // Locate commitSnapshot method
  const methodMatch = src.match(/async commitSnapshot\([^)]*\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(methodMatch, 'commitSnapshot method must exist');
  assert.match(methodMatch[0], /agency\.gitAutoCommit/,
    'commitSnapshot must reference gitAutoCommit setting');
  // Must early-return (no-op pattern)
  assert.match(methodMatch[0], /\!==\s*true[\s\S]*?return/,
    'commitSnapshot must early-return when gitAutoCommit !== true');
});

test('SelfModel.js: rollback() throws when gitAutoCommit is off', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/SelfModel.js'), 'utf-8');
  const methodMatch = src.match(/async rollback\(\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(methodMatch, 'rollback method must exist');
  assert.match(methodMatch[0], /agency\.gitAutoCommit/,
    'rollback must reference gitAutoCommit setting');
  assert.match(methodMatch[0], /throw new Error/,
    'rollback must throw an Error when disabled');
  assert.match(methodMatch[0], /\.genesis-backups/,
    'rollback error message should mention .genesis-backups/ as fallback');
});

test('SelfModel.js: constructor declares _settings property', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/SelfModel.js'), 'utf-8');
  assert.match(src, /this\._settings\s*=\s*null/,
    'constructor must initialize this._settings to null');
});

// ── AgentCoreBoot injection ──────────────────────────────────

test('AgentCoreBoot.js: injects settings into selfModel before scan()', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/AgentCoreBoot.js'), 'utf-8');
  const injIdx = src.indexOf("selfModel._settings = c.resolve('settings')");
  const scanIdx = src.indexOf('await selfModel.scan()');
  assert.ok(injIdx > 0, '_settings injection must exist');
  assert.ok(scanIdx > 0, 'scan() call must exist');
  assert.ok(injIdx < scanIdx, 'injection must come BEFORE scan()');
});

// ── MultiFileRefactor default flip ───────────────────────────

test('MultiFileRefactor.js: autoCommit default no longer hardcoded true', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/revolution/MultiFileRefactor.js'), 'utf-8');
  // The old hardcoded pattern must not exist anymore
  assert.doesNotMatch(src, /autoCommit\s*=\s*true\s*\}\s*=\s*options/,
    'autoCommit default must not be hardcoded to true');
  // Settings-derived default must exist
  assert.match(src, /agency\.gitAutoCommit/,
    'autoCommit default must reference agency.gitAutoCommit setting');
});

test('MultiFileRefactor.js: constructor accepts settings parameter', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/revolution/MultiFileRefactor.js'), 'utf-8');
  assert.match(src, /constructor\(\s*\{[^}]*settings[^}]*\}/,
    'constructor signature must include settings parameter');
  assert.match(src, /this\._settings\s*=\s*settings/,
    'constructor must store settings as this._settings');
});

// ── UI bindings ──────────────────────────────────────────────

test('settings-defaults.js: set-git-auto-init binding exists', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/ui/modules/settings-defaults.js'), 'utf-8');
  assert.match(src, /'set-git-auto-init'[^}]*'agency\.gitAutoInit'/,
    'set-git-auto-init binding must map to agency.gitAutoInit');
});

test('settings-defaults.js: set-git-auto-commit binding exists', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/ui/modules/settings-defaults.js'), 'utf-8');
  assert.match(src, /'set-git-auto-commit'[^}]*'agency\.gitAutoCommit'/,
    'set-git-auto-commit binding must map to agency.gitAutoCommit');
});

// ── i18n strings ─────────────────────────────────────────────

test('Language.js: EN and DE strings for both settings exist', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/core/Language.js'), 'utf-8');
  // Each setting needs label + off + on + hint, in both languages
  // Total: 2 settings × 4 keys × 2 languages = 16 occurrences
  // (each key appears twice — once in EN dict, once in DE dict)
  const keys = [
    'settings.agency.git_auto_init',
    'settings.git_auto_init.off',
    'settings.git_auto_init.on',
    'settings.git_auto_init.hint',
    'settings.agency.git_auto_commit',
    'settings.git_auto_commit.off',
    'settings.git_auto_commit.on',
    'settings.git_auto_commit.hint',
  ];
  for (const key of keys) {
    const occurrences = (src.match(new RegExp(key.replace(/\./g, '\\.'), 'g')) || []).length;
    assert.ok(occurrences >= 2,
      `key "${key}" must appear at least twice (EN + DE), found ${occurrences}`);
  }
});

console.log(`\n    ${passed} passed · ${failed} failed · v7.7.1 git-auto-gating`);
process.exit(failed > 0 ? 1 : 0);
