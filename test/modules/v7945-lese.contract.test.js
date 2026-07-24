#!/usr/bin/env node
// GENESIS — v7.9.45 field: the reading bridge. "was steht in x22" must reach
// the Archive (PDF sense included) without any tool incantation — the exact
// field case is pinned end to end: attachment-note quote, bare name, project
// precedence, and the small-model redirect hint.
'use strict';
const { describe, test, assert, run, createTestRoot } = require('../harness');
const path = require('path'); const fs = require('fs');
const ROOT = path.resolve(__dirname, '..', '..');
const { CommandHandlers } = require(path.join(ROOT, 'src/agent/hexagonal/CommandHandlers.js'));
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

const { ToolRegistry } = require(path.join(ROOT, 'src/agent/intelligence/ToolRegistry.js'));
const { registerV737Tools } = require(path.join(ROOT, 'src/agent/cognitive/tools/v737-memory-tools.js'));

// The REAL registry rides in every case — a stub once mirrored an API that
// did not exist (.get) and the contract slept through a field failure.
const mkImg = (label) => {
  const base = createTestRoot(label);
  const PROJ = path.join(base, 'proj'); const ARCH = path.join(base, 'Genesis Archive');
  fs.mkdirSync(path.join(ARCH, 'inbox'), { recursive: true }); fs.mkdirSync(PROJ, { recursive: true });
  fs.writeFileSync(path.join(ARCH, 'inbox', 'shot.png'), Buffer.from([137, 80, 78, 71]));
  const h = new CommandHandlers({ lang: { t: (k) => k, detect() {}, current: 'de' }, settings: { get: (k) => (k === 'archive.path' ? ARCH : undefined) }, fileProcessor: { rootDir: PROJ }, genesisDir: path.join(base, '.g') });
  const reg = new ToolRegistry({ bus: { fire() {} }, lang: { t: (k) => k } });
  registerV737Tools(reg, { modelBridge: { _genesisDir: path.join(base, '.g'), chat: async () => ({ content: 'BILD-STUB: beschrieben.' }) }, journalWriter: { write() {} }, settings: { get: (k) => (k === 'archive.path' ? ARCH : undefined) } });
  return { h, orch: { tools: reg }, ARCH };
};

const mk = (label) => {
  const base = createTestRoot(label);
  const PROJ = path.join(base, 'proj'); const ARCH = path.join(base, 'Genesis Archive');
  fs.mkdirSync(path.join(ARCH, 'inbox'), { recursive: true }); fs.mkdirSync(PROJ, { recursive: true });
  fs.writeFileSync(path.join(ARCH, 'inbox', 'x22.pdf'), '%PDF-fake');
  fs.writeFileSync(path.join(PROJ, 'readme.md'), 'projekt-inhalt');
  const h = new CommandHandlers({ lang: { t: (k) => k, detect() {}, current: 'de' }, settings: { get: (k) => (k === 'archive.path' ? ARCH : undefined) }, fileProcessor: { rootDir: PROJ }, genesisDir: path.join(base, '.g') });
  const reg = new ToolRegistry({ bus: { fire() {} }, lang: { t: (k) => k } });
  registerV737Tools(reg, { modelBridge: { _genesisDir: path.join(base, '.g') }, journalWriter: { write() {} }, settings: { get: (k) => (k === 'archive.path' ? ARCH : undefined) }, pdfExtract: async () => ({ text: 'Bestellung 4711: zwei Kisten Ehrlichkeit.', numpages: 2 }) });
  return { h, orch: { tools: reg } };
};

describe('v7945 field — the reading bridge', () => {
  test('a truly unknown name still asks instead of guessing (fresh session)', async () => {
    const { h, orch } = mk('lese-f5');
    const r = await h.readFile('was steht in voelligunbekannt', orch);
    assert(/nicht gefunden|Welche Datei/.test(r), 'honest not-found or question');
  });

  test('the exact field turn: the attachment-note quote reaches the Archive hand', async () => {
    const { h, orch } = mk('lese-f2');
    const r = await h.readFile('kannst mir sagen was in x22 steht [Anhang in deinem Archiv: "inbox/x22.pdf". Nimm ihn wahr.]', orch);
    assert(/\ud83d\udcd5/.test(r) && /2 Seiten/.test(r) && /Bestellung 4711/.test(r) && !/%PDF/.test(r), 'the REAL archive hand serves extracted content — never raw bytes');
  });

  test('a bare name finds the file in the chosen Archive inbox', async () => {
    const { h, orch } = mk('lese-f3');
    const r = await h.readFile('was steht in x22', orch);
    assert(/\ud83d\udcd5/.test(r) && /Bestellung 4711/.test(r), 'bare name → chosen Archive → extracted content');
  });

  test('project files keep precedence over the Archive', async () => {
    const { h, orch } = mk('lese-f4');
    const r = await h.readFile('lies readme.md', orch);
    assert(/^\ud83d\udcc4 readme\.md gelesen/.test(r) && /projekt-inhalt/.test(r), 'plain project read unchanged');
  });

  test('the intent knows PDFs and the builtin points the small model home', () => {
    const defs = require(path.join(ROOT, 'src/agent/intelligence/IntentPatterns.js')).INTENT_DEFINITIONS;
    const rf = defs.find((d) => d[0] === 'read-file')[1];
    assert(rf.some((r) => r.test('lies inbox/x22.pdf')), 'lies inbox/x.pdf routes deterministically');
    assert((src('src/agent/intelligence/IntentPatterns.js').match(/conf\|sh\|py\|pdf\|png\|jpe\?g\|gif\|webp\)/g) || []).length >= 6, 'pdf AND images in every read extension list');
    assert(/liegen im Genesis Archive; nutze read-archive-file/.test(src('src/agent/intelligence/ToolRegistryBuiltins.js')), 'file-read redirect hint');
    assert(/String\(input && input\.path \|\| ''\)/.test(src('src/agent/intelligence/ToolRegistryBuiltins.js')), 'the hint reads input.path — the field variable, not a ghost');
    const fv = src('src/agent/hexagonal/CommandHandlersFileView.js');
    assert(/_reg\.hasTool\('read-archive-file'\)/.test(fv) && /executeSingleTool\('read-archive-file'/.test(fv), 'delegation speaks the REAL registry API (hasTool + executeSingleTool)');
    assert(/this\.readFile\(msg, orchestrator\)/.test(src('src/agent/hexagonal/CommandHandlers.js')), 'the orchestrator rides into readFile');
  });
});
describe('v7945 field — images ride the same bridge', () => {
  test('"was ist auf dem shot.png zu sehen" delegates to look-at-image deterministically', async () => {
    const { h, orch, ARCH } = mkImg('lese-img');
    const r = await h.readFile('was ist auf dem shot.png zu sehen', orch);
    assert(/BILD-STUB/.test(r), 'the vision hand answers, not the model\u2019s imagination');
  });
});

run();
