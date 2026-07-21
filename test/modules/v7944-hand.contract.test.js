#!/usr/bin/env node
// GENESIS — v7.9.44 H: the plus. Copy, never move; inbox never auto-emptied.
'use strict';
const { describe, test, assert, run } = require('../harness');
const path = require('path'); const fs = require('fs');
const ROOT = path.resolve(__dirname,'..','..');
const src = (p) => fs.readFileSync(path.join(ROOT,p),'utf8');
describe('v7944 H — source pins across the hand-over chain', () => {
  test('preload allows exactly the new channel', () => {
    assert(src('preload.js').includes("'archive:drop-file'"), 'channel whitelisted');
  });
  test('main handler: inbox beside the releases, collisions numbered, copy never move', () => {
    const t = src('main.js');
    const seg = t.split("'archive:drop-file'")[1].split("'ui:resume-prompt'")[0];
    assert(seg.includes('archiveRoot') && seg.includes("path.join(root, 'inbox')"), 'inbox at the configured archive root (settings path or default beside releases)');
    assert(/\(n\+\+\)/.test(seg), 'collisions numbered');
    assert(!/unlink|rmSync|rename/.test(seg), 'copy, never move; never auto-empty');
  });
  test('r4: the + is a paperclip — attach only remembers (read bytes + chip), no copy, no auto-send', () => {
    const html = src('src/ui/index.html');
    assert(html.includes('btn-attach') && html.includes('attach-chip'), 'attach button + attachment chip exist');
    assert(html.includes('\u25c8'), 'the attach button carries Genesis\u2019 chosen mark ◈ (not a bare +)');
    // v7.9.44 r12: attach logic lives in ONE shared function (chat.attachFile), used by both
    // the ◈ button and drag & drop. No per-path duplicate.
    const c = src('src/ui/modules/chat.js');
    assert(c.includes('setPendingAttachment({ name: file.name, dataB64: b64 })'), 'attach remembers bytes, does not copy yet');
    assert(/async function attachFile[\s\S]{0,400}invoke\('archive:drop-file'/.test(c) === false, 'no copy at attach time — copy happens on send');
    assert(c.includes('async function attachFile') && c.includes('ensureArchive'), 'the one shared attach path exists and gates on the Archive');
    const r = src('src/ui/renderer-main.js');
    assert(!r.includes('the user hat dir eine Datei gelegt'), 'no auto-sent third-person text');
    assert(r.includes("'#attach-chip-remove'"), 'the attachment can be removed before sending — nothing was written');
    // the duplicate drop handler that used to live in renderer-main is gone; drag & drop is wired once
    assert(!/_area\.addEventListener\('drop'/.test(r), 'no second drop handler in renderer-main — drag & drop lives only in drag-drop.js');
    assert(src('src/ui/modules/drag-drop.js').includes('attachFile'), 'drag & drop uses the same shared attachFile');
  });
  test('r4: on send, the file is copied to the Archive THEN the note rides with the text; copy-failure aborts the send', () => {
    const c = src('src/ui/modules/chat.js');
    assert(/_pendingAttachment[\s\S]{0,300}invoke\('archive:drop-file'/.test(c), 'copy happens on send');
    assert(/!res \|\| !res\.ok[\s\S]{0,120}return/.test(c), 'a failed copy aborts the send — no ghost note');
    assert(c.includes("t('chat.attachment_fact'") && /tool:\s*toolName/.test(c), 'r13: the note names the RIGHT tool for the file type so Genesis actually perceives it (was neutral "Attached: path" → he saw only a path)');
    assert(/isImage\s*=[\s\S]{0,80}png\|jpe\?g/.test(c) && /toolName\s*=\s*isImage\s*\?\s*'look-at-image'\s*:\s*'read-archive-file'/.test(c), 'image → look-at-image, everything else → read-archive-file');
    assert(c.includes("t('chat.attachment_alone'") && /msg\s*\?[\s\S]{0,200}attachment_alone/.test(c), 'a file sent WITHOUT words still points Genesis to the tool, then he asks in his own voice');
    assert(c.includes('res.rel'), 'the note carries the real archived path');
    assert(/!msg && !_pendingAttachment/.test(c), 'an attachment alone may be sent without typed text');
  });
  test('r6: the Archive is created by the + (archive:ensure), not by send or boot', () => {
    const m = src('main.js');
    const ensureSeg = m.split("'archive:ensure'")[1].split("'ui:resume-prompt'")[0];
    assert(ensureSeg.includes("mkdirSync(path.join(chosen, 'inbox')") || ensureSeg.includes("mkdirSync(path.join(root, 'inbox')"), 'the + creates inbox at the chosen/remembered place');
    const dropSeg = m.split("'archive:drop-file'")[1].split("'archive:ensure'")[0];
    assert(!dropSeg.includes('mkdirSync'), 'send never creates the folder — no dead code on send');
  });
  test('r6: boot forces nothing', () => {
    const b = src('src/agent/AgentCoreBootWire.js');
    assert(!/mkdirSync\([^)]*'inbox'/.test(b) && !/mkdirSync\([^)]*'projects'/.test(b), 'boot no longer forces inbox/projects');
  });
});
run();
