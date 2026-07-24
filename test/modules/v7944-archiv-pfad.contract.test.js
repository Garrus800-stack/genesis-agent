#!/usr/bin/env node
// GENESIS — v7.9.44 r6 (the user' one way): the + owns the Archive location.
// First + with no Archive → a folder picker opens → the chosen place gets
// inbox/ + projects/ and is remembered → the file goes in. Next + → same
// place, no questions. No settings field, no dead code on send.
'use strict';
const { describe, test, assert, run } = require('../harness');
const path = require('path'); const fs = require('fs');
const ROOT = path.resolve(__dirname,'..','..');
const src = (p) => fs.readFileSync(path.join(ROOT,p),'utf8');
const WR = require(path.join(ROOT,'src/agent/cognitive/WorkRegistry.js'));

describe('v7944 r6 — the + owns the Archive location', () => {
  test('there is an archive:ensure channel, in the CHANNELS contract and both preloads', () => {
    const m = src('main.js');
    const seg = m.split('const CHANNELS')[1];
    assert(seg.includes("'archive:ensure'"), 'channel is in the contract');
    assert(src('preload.js').includes("'archive:ensure'") && src('preload.mjs').includes("'archive:ensure'"), 'both preload lists allow it');
  });
  test('archive:ensure opens a folder picker when nothing is chosen, and remembers the choice', () => {
    const m = src('main.js');
    const seg = m.split("'archive:ensure'")[1].split("'ui:resume-prompt'")[0];
    assert(seg.includes('showOpenDialog') && seg.includes("'openDirectory'"), 'a directory picker opens');
    assert(seg.includes('message:') && seg.includes("tr('ui.dialog_archive_message'"), 'the dialog message follows the app language (not hardcoded German)');
    assert(seg.includes("tr('ui.dialog_archive_title'") && seg.includes("tr('ui.dialog_archive_button'"), 'title + button also localized');
    assert(!seg.includes('braucht er einen Ordner'), 'no hardcoded German sentence in the dialog anymore');
    assert(seg.includes('created: true'), 'first-time creation is flagged so the UI can confirm where it landed');
    assert(seg.includes("'Genesis Archive'") && seg.includes("mkdirSync(path.join(chosen, 'inbox')"), 'inbox/ is created at the chosen place');
    assert(seg.includes("settings.set('archive.path'"), 'the chosen location is remembered for next time');
    assert(/configured[\s\S]{0,200}mkdirSync\(path\.join\(root, 'inbox'\)/.test(seg), 'if already chosen, it reuses the same place without asking');
  });
  test('r12: ONE shared gate in chat.js — both the ◈ button and drag & drop use it; no duplicate handler', () => {
    const c = src('src/ui/modules/chat.js');
    // the single gate lives in chat.js
    assert(/async function ensureArchive\(\)[\s\S]{0,400}invoke\('archive:ensure'\)/.test(c), 'ensureArchive gate exists in chat.js');
    assert(/async function attachFile\(file\)[\s\S]{0,120}ensureArchive\(\)/.test(c), 'attachFile gates on the Archive before reading bytes');
    assert(/ensureArchive[\s\S]{0,400}canceled[\s\S]{0,40}return false/.test(c), 'cancelling the picker aborts cleanly');
    assert(/r\.created[\s\S]{0,120}showToast/.test(c), 'first-time creation is confirmed with the location');
    const r = src('src/ui/renderer-main.js');
    // r18 (the user's order): the button delegates to attachButtonClick — the
    // FIRST click runs the folder pick alone (r6 order), every later click opens
    // the chooser synchronously inside the gesture. No await may sit between the
    // click and .click() (r17 field finding: Chromium blocks a spent gesture).
    assert(/btn-attach[^\n]{0,60}attachButtonClick\(\)/.test(r), 'the ◈ delegates to attachButtonClick');
    assert(!/btn-attach[^\n]{0,80}await ensureArchive/.test(r), 'no activation-consuming await sits between the click and the chooser');
    const ch = src('src/ui/modules/chat.js');
    assert(/function attachButtonClick\(\)\s*\{\s*if \(_archiveReady\)[^}]{0,120}\.click\(\)/.test(ch), 'ready → chooser opens synchronously in the gesture');
    assert(/ensureArchive\(\)\.then[\s\S]{0,160}archive_click_again/.test(ch), 'first time → folder pick FIRST, then the one-more-click hint');
    assert(/archive:status/.test(ch) && /_archiveReady = true/.test(ch), 'readiness is loaded read-only at start and set after ensure');
    const lang = src('src/agent/core/Language.js');
    assert((lang.match(/ui\.archive_click_again/g) || []).length === 4, 'the hint exists in all four locales');
    assert(!/_area\.addEventListener\('drop'/.test(r), 'no duplicate drop handler in renderer-main');
    // drag & drop is wired exactly once, in drag-drop.js, using the same shared attachFile
    const d = src('src/ui/modules/drag-drop.js');
    assert(d.includes('attachFile') && /addEventListener\('drop'/.test(d), 'drag & drop lives once in drag-drop.js and uses attachFile');
    assert(!/invoke\(['"]agent:import-file['"]/.test(d), 'the old import-file drag path is gone — no two systems');
  });
  test('r11: if the Archive vanished at send time, the picker reopens and the drop retries — never a dead end', () => {
    const c = src('src/ui/modules/chat.js');
    assert(/res\.code === 'missing'[\s\S]{0,200}invoke\('archive:ensure'\)/.test(c), 'a missing Archive at send reopens the picker');
    assert(/ens && ens\.ok[\s\S]{0,160}drop-file/.test(c), 'then the drop is retried once');
    assert(!/archive_missing[\s\S]{0,80}Einstellungen/.test(src('src/agent/core/Language.js')), 'the missing message no longer points at the removed Settings field');
  });
  test('send creates NO folder — no dead code on the send path; missing Archive speaks plainly', () => {
    const m = src('main.js');
    const dropSeg = m.split("'archive:drop-file'")[1].split("'archive:ensure'")[0];
    assert(!dropSeg.includes('mkdirSync'), 'send never creates the folder');
    assert(/existsSync\(inbox\)[\s\S]{0,120}code: 'missing'/.test(dropSeg), 'missing Archive returns a CODE (localized in the UI), not a German sentence');
  });
  test('boot creates nothing; there is no settings path field anymore', () => {
    const b = src('src/agent/AgentCoreBootWire.js');
    assert(!/mkdirSync\([^)]*'inbox'/.test(b) && !/mkdirSync\([^)]*'projects'/.test(b), 'no forced mkdir at boot');
    assert(!src('src/ui/index.html').includes('set-archive-path'), 'the settings path field is gone — the + handles location');
  });
  test('r9: an existing Archive (soul travelled across reinstall) is reused, never overwritten', () => {
    const m = src('main.js');
    const seg = m.split("'archive:ensure'")[1].split("'ui:resume-prompt'")[0];
    // recursive:true on an existing inbox/projects is a no-op → files untouched
    assert(seg.includes("mkdirSync(path.join(root, 'inbox'), { recursive: true })"), 'reuse is safe: recursive mkdir touches nothing that exists');
    assert(seg.includes('reuses them') || seg.includes('nothing is overwritten'), 'the reuse intent is documented');
  });
  test('r9: a saved path that no longer works falls through to the picker — no dead end', () => {
    const m = src('main.js');
    const seg = m.split("'archive:ensure'")[1].split("'ui:resume-prompt'")[0];
    // the reuse block is wrapped so a failure does NOT return an error — it falls to the picker
    assert(/configured && String\(configured\)\.trim\(\)\) \{\s*try \{/.test(seg), 'the reuse attempt is guarded');
    assert(/catch \(_e\) \{[\s\S]{0,300}\}\s*\}\s*\/\/ not chosen yet, or the saved path no longer works/.test(seg) || seg.includes('fall through to the'), 'on failure it falls through to the picker instead of dead-ending');
  });
  test('the resolver still honours the remembered path (one source of truth)', () => {
    const gd = path.join(require('os').tmpdir(), 'r6-'+Date.now());
    const chosen = path.join(require('os').tmpdir(), 'r6-arch-'+Date.now());
    assert(WR.archiveRoot(gd, { get: (k) => k === 'archive.path' ? chosen : undefined }) === path.resolve(chosen), 'remembered path wins');
  });
  test('r13 REGRESSION: every archive-path resolver gets REAL settings — never the phantom agent.settings', () => {
    // The bug: drop-file passed agent.settings (never set → undefined), so archiveRoot fell
    // back to the DEFAULT path and could not find an Archive the user placed elsewhere →
    // "missing" on every send. And the tools got no settings at all. Pin the fix.
    const m = src('main.js');
    const dropBlock = m.split("'archive:drop-file'")[1].split("'archive:ensure'")[0];
    assert(!/agent\.settings/.test(dropBlock), 'drop-file must NOT use the phantom agent.settings');
    assert(/resolve\('settings'\)/.test(dropBlock) && /archiveRoot\(/.test(dropBlock), 'drop-file resolves settings from the container before calling archiveRoot');
    const w = src('src/agent/AgentCoreBootWire.js');
    assert(/registerV737Tools\([\s\S]{0,600}settings:\s*c\.tryResolve\('settings'\)/.test(w), 'the archive tools are wired WITH settings so they resolve the chosen path');
    // and the resolver actually ignores a phantom (undefined) settings by using the default —
    // proving why the missing settings caused the wrong path
    const gd = path.join(require('os').tmpdir(), 'r13-'+Date.now());
    const def = WR.archiveRoot(gd, undefined);
    const chosen = path.join(require('os').tmpdir(), 'r13-chosen-'+Date.now());
    const real = WR.archiveRoot(gd, { get: (k) => k === 'archive.path' ? chosen : undefined });
    assert(def !== real && real === path.resolve(chosen), 'undefined settings → default (the bug); real settings → chosen (the fix)');
  });
});
run();
