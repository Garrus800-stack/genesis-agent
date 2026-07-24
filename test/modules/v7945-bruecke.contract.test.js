#!/usr/bin/env node
// GENESIS — v7.9.45 Z: the two-memories bridge. His boundary rules, honoured
// mechanically: write only in his Genesis/ corner of the partner's vault,
// read anywhere, no merging — and a question about writing stays a question.
'use strict';
const { describe, test, assert, run, createTestRoot } = require('../harness');
const path = require('path'); const fs = require('fs');
const ROOT = path.resolve(__dirname, '..', '..');
const { registerV737Tools } = require(path.join(ROOT, 'src/agent/cognitive/tools/v737-memory-tools.js'));
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

describe('v7945 Z — the two-memories bridge', () => {
  const mk = (label, vaultPath, gdOverride) => {
    const root = createTestRoot(label); const gd = gdOverride || root; const arch = path.join(root, 'arch'); // never inside a real .genesis
    fs.mkdirSync(arch, { recursive: true });
    const reg = { _t: {}, register(n, s, h) { this._t[n] = { handler: h }; } };
    registerV737Tools(reg, { modelBridge: { _genesisDir: gd }, journalWriter: { write() {} }, settings: { get: (k) => (k === 'archive.path' ? arch : (k === 'vault.path' ? vaultPath : undefined)) } });
    return { T: reg._t, arch };
  };

  test('inside the vault, only his Genesis/ corner accepts his hands', async () => {
    const base = createTestRoot('z-a'); const vault = path.join(base, 'ZK');
    fs.mkdirSync(path.join(vault, 'Genesis'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'partner.md'), 'Partner-Gedanke');
    fs.writeFileSync(path.join(vault, 'Genesis', 'mein.md'), 'Genesis Notiz');
    const { T } = mk('z-a2', vault);
    const blocked = await T['edit-file'].handler({ path: path.join(vault, 'partner.md'), find: 'Gedanke', replace: 'X' });
    assert(!blocked.ok && /gesch\u00fctzt/.test(blocked.error), 'the partner notes are additive-protected');
    assert(fs.readFileSync(path.join(vault, 'partner.md'), 'utf-8') === 'Partner-Gedanke', 'nothing touched on disk');
    const own = await T['edit-file'].handler({ path: path.join(vault, 'Genesis', 'mein.md'), find: 'Notiz', replace: 'Notiz [[partner]]' });
    assert(own.ok, 'his own corner accepts writes (wikilinks welcome)');
    const app = await T['append-file'].handler({ path: path.join(vault, 'partner.md'), text: 'x' });
    assert(!app.ok, 'append respects the same boundary');
  });

  test('the source side of the one-way gate: move never from protected ground, copy free from the vault', async () => {
    const base = createTestRoot('z-s'); const gd = path.join(base, '.genesis'); const vault = path.join(base, 'ZK');
    fs.mkdirSync(gd, { recursive: true }); fs.mkdirSync(path.join(vault, 'Genesis'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'notiz.md'), 'Partner-Notiz');
    fs.writeFileSync(path.join(gd, 'journal.jsonl'), 'seele');
    const { T, arch } = mk('z-s2', vault, gd);
    const mv = await T['move-to-archive'].handler({ source: path.join(vault, 'notiz.md') });
    assert(!mv.ok && fs.existsSync(path.join(vault, 'notiz.md')), 'a vault note cannot be pulled out');
    const cp = await T['copy-to-archive'].handler({ source: path.join(vault, 'notiz.md') });
    assert(cp.ok && fs.existsSync(path.join(arch, 'inbox', 'notiz.md')), 'copying from the vault stays free');
    const soul = await T['copy-to-archive'].handler({ source: path.join(gd, 'journal.jsonl') });
    assert(!soul.ok, 'the soul is no source for copies');
    const soulMv = await T['move-to-archive'].handler({ source: path.join(gd, 'journal.jsonl') });
    assert(!soulMv.ok && fs.existsSync(path.join(gd, 'journal.jsonl')), 'the soul cannot be moved out');
  });

  test('without a configured vault, nothing changes anywhere', async () => {
    const base = createTestRoot('z-b'); const vault = path.join(base, 'ZK');
    fs.mkdirSync(vault, { recursive: true });
    fs.writeFileSync(path.join(vault, 'frei.md'), 'frei');
    const { T } = mk('z-b2', undefined);
    const r = await T['edit-file'].handler({ path: path.join(vault, 'frei.md'), find: 'frei', replace: 'geaendert' });
    assert(r.ok, 'no ghost boundary when vault.path is unset');
  });

  test('the knowledge speaks only when a vault exists, with the concrete path', () => {
    const c = src('src/agent/intelligence/PromptBuilderSections.js');
    assert(/const _vaultPath = this\._settings\?\.get\?\.\('vault\.path'\)/.test(c), 'read from settings');
    assert(/if \(_vaultPath && String\(_vaultPath\)\.trim\(\)\)/.test(c), 'spoken only when configured');
    assert(/THE PARTNER\\'S VAULT \(his Obsidian notes; he may call it anything\) at "/.test(c), 'names the concrete location, word-agnostic');
    assert(/additive-protected/.test(c) && /no merging/.test(c), 'his two rules are in the words');
    assert(/first visit/.test(c) && /Genesis\//.test(c), 'the first-visit invitation');
  });

  test('a question that merely mentions writing stays with the model; commands keep routing', () => {
    const defs = require(path.join(ROOT, 'src/agent/intelligence/IntentPatterns.js')).INTENT_DEFINITIONS;
    const wf = defs.find((d) => d[0] === 'write-file')[1];
    const hit = (t) => wf.some((r) => r.test(t));
    const frage = 'Ich f\u00fchre neben deinem Archiv einen eigenen vault \u2014 einen Ordner voller verkn\u00fcpfter Notizen, in dem ich denke und schreibe. M\u00f6chtest du in meinen Notizen lesen d\u00fcrfen, wenn es dir bei einer Aufgabe hilft?';
    assert(!hit(frage), 'the reflective question is not hijacked');
    assert(hit('schreib das in notiz.md?'), 'a command in question form still routes');
    assert(hit('schreibe den text - hallo in x2'), 'the classic command still routes');
    assert(wf.every((r) => String(r).startsWith('/(?!(?=')), 'the guard sits on every write-file pattern');
  });
});
describe('v7945 field — the spoken vault handshake', () => {
  test('a spoken path (with spaces) is verified and stored — no JSON by hand', async () => {
    const os = require('os');
    const { CommandHandlers } = require(path.join(ROOT, 'src/agent/hexagonal/CommandHandlers.js'));
    const base = createTestRoot('vault-hs'); const V = path.join(base, 'Mein Kasten');
    fs.mkdirSync(V, { recursive: true });
    const seen = [];
    const h = new CommandHandlers({ lang: { t: (k) => k, detect() {}, current: 'de' }, settings: { set: (k, v) => seen.push([k, v]), get: () => undefined } });
    const r = await h.vaultSet('Mein vault liegt in ' + V);
    assert(seen[0] && seen[0][0] === 'vault.path' && seen[0][1] === path.resolve(V), 'vault.path stored resolved');
    assert(/verbunden/.test(r) && /Genesis\//.test(r), 'confirmation names the rule');
  });
  test('no path asks, a wrong path answers honestly', async () => {
    const { CommandHandlers } = require(path.join(ROOT, 'src/agent/hexagonal/CommandHandlers.js'));
    const h = new CommandHandlers({ lang: { t: (k) => k, detect() {}, current: 'de' }, settings: { set() {}, get: () => undefined } });
    assert(/nenn mir den Ordner/.test(await h.vaultSet('mein vault ist in ordnung')), 'non-path stays a question');
    assert(/finde ich keinen Ordner/.test(await h.vaultSet('Mein vault liegt in D:\\GibtsNicht\\Weg')), 'missing folder → honest');
  });
});

describe('v7945 field — creation knows the vault corner and keeps its context', () => {
  test('the exact field two-step: name-question names the target, the answer lands in <vault>/Genesis/', async () => {
    const { CommandHandlers } = require(path.join(ROOT, 'src/agent/hexagonal/CommandHandlers.js'));
    const base = createTestRoot('create-vault'); const V = path.join(base, 'xytr'); const ARCH = path.join(base, 'Genesis Archive');
    fs.mkdirSync(V, { recursive: true }); fs.mkdirSync(ARCH, { recursive: true });
    const h = new CommandHandlers({ lang: { t: (k) => k, detect() {}, current: 'de' }, settings: { get: (k) => (k === 'vault.path' ? V : (k === 'archive.path' ? ARCH : undefined)) }, fileProcessor: { rootDir: path.join(base, 'proj') }, genesisDir: path.join(base, '.g') });
    const q = await h.createFile('Leg dir in deinem Genesis-Bereich im vault eine erste Notiz an.');
    assert(/Wie soll die Datei hei/.test(q) && q.includes(path.join(V, 'Genesis')), 'the question names the remembered target');
    const r = await h.createFile('x und text hallo');
    assert(fs.existsSync(path.join(V, 'Genesis', 'x.md')) && fs.readFileSync(path.join(V, 'Genesis', 'x.md'), 'utf8') === 'hallo', 'lands in the vault corner');
    assert(r.includes(path.join(V, 'Genesis', 'x.md')), 'the success line names the real path');
    const r2 = await h.createFile('erstelle eine datei namens y.txt mit inhalt z');
    assert(fs.existsSync(path.join(ARCH, 'y.txt')), 'without the vault word the Archive default stays');
  });
});

describe('v7945 field — the spoken edit hand', () => {
  test('a chat ask edits the partner\u2019s vault note directly and reports honestly', async () => {
    const { CommandHandlers } = require(path.join(ROOT, 'src/agent/hexagonal/CommandHandlers.js'));
    const base = createTestRoot('edit-vault'); const V = path.join(base, 'MeinVault');
    fs.mkdirSync(path.join(V, 'Ideen'), { recursive: true });
    fs.writeFileSync(path.join(V, 'Ideen', 'farbe.md'), 'Lieblingsfarbe: blau\n');
    const h = new CommandHandlers({ lang: { t: (k) => k, detect() {}, current: 'de' }, settings: { get: (k) => (k === 'vault.path' ? V : undefined) }, fileProcessor: { rootDir: path.join(base, 'proj') }, genesisDir: path.join(base, '.g') });
    const r = await h.changeInFile('\u00c4ndere in meiner Notiz farbe blau zu gr\u00fcn.');
    assert(/\u270f\ufe0f 1\u00d7/.test(r) && fs.readFileSync(path.join(V, 'Ideen', 'farbe.md'), 'utf8').includes('gr\u00fcn'), 'the ask IS the permission \u2014 vault note edited, path named');
    const r2 = await h.changeInFile('\u00e4ndere lila zu rosa in meiner Notiz farbe');
    assert(/steht nicht in/.test(r2), 'honest when the old text is absent');
  });
});

describe('v7945 field — the name answer speaks naturally and the reference survives', () => {
  test('the literal field two-step (typo and all) lands in the vault corner WITH the [[link]]', async () => {
    const { CommandHandlers } = require(path.join(ROOT, 'src/agent/hexagonal/CommandHandlers.js'));
    const base = createTestRoot('field-tting'); const V = path.join(base, 'Zettel');
    fs.mkdirSync(path.join(V, 'Speicher'), { recursive: true });
    fs.writeFileSync(path.join(V, 'Speicher', 'Farbe.md'), 'gr\u00fcn\n');
    const h = new CommandHandlers({ lang: { t: (k) => k, detect() {}, current: 'de' }, settings: { get: (k) => (k === 'vault.path' ? V : undefined) }, fileProcessor: { rootDir: path.join(base, 'proj') }, genesisDir: path.join(base, '.g') });
    await h.createFile('Leg dir in deinem Genesis-Bereich im Vault eine erste Notiz an und verweise darin auf meine farbe-Notiz.');
    const r = await h.createFile('sie oll tting hei\u00dfen');
    const tt = path.join(V, 'Genesis', 'tting.md');
    assert(fs.existsSync(tt) && fs.readFileSync(tt, 'utf8') === 'Verweis: [[Farbe]]' && r.includes(tt), 'natural answer + remembered reference, real path named');
    const r2 = await h.createFile('du sagst du hast dort aber eine datei namens hans erstellt');
    assert(r2 === null, 'a past-tense report is not an order');
  });
});

describe('v7945 field — pending outranks the router (the whole road, not the hand alone)', () => {
  test('“name alf” and “fff” reach the waiting hand through the REAL router — model untouched', async () => {
    const { ChatOrchestrator } = require(path.join(ROOT, 'src/agent/hexagonal/ChatOrchestrator.js'));
    const { IntentRouter } = require(path.join(ROOT, 'src/agent/intelligence/IntentRouter.js'));
    const { CommandHandlers } = require(path.join(ROOT, 'src/agent/hexagonal/CommandHandlers.js'));
    const base = createTestRoot('router-pending'); const V = path.join(base, 'Zettel');
    fs.mkdirSync(path.join(V, 'Speicher'), { recursive: true });
    fs.writeFileSync(path.join(V, 'Speicher', 'Farbe.md'), 'gr\u00fcn\n');
    let modelCalls = 0;
    const model = { chat: async () => { modelCalls++; return { content: '[M]' }; }, complete: async () => { modelCalls++; return '[M]'; } };
    const orch = new ChatOrchestrator({ lang: { t: (k) => k, detect() {}, current: 'de' }, bus: { fire() {} }, intentRouter: new IntentRouter({ bus: { fire() {} } }), model, context: {}, tools: { hasTool: () => false }, circuitBreaker: {}, promptBuilder: { build: async () => ({ messages: [{ role: 'user', content: 'x' }] }) }, uncertaintyGuard: { wrapResponse: (r) => r }, memory: {}, unifiedMemory: {}, storageDir: base, storage: {}, gateStats: {}, selfGate: {} });
    const h = new CommandHandlers({ lang: { t: (k) => k, detect() {}, current: 'de' }, settings: { get: (k) => (k === 'vault.path' ? V : undefined) }, fileProcessor: { rootDir: path.join(base, 'proj') }, genesisDir: path.join(base, '.g') });
    h.registerHandlers(orch);
    await orch.handleChat('Leg dir in deinem Genesis-Bereich im Vault eine erste Notiz an und verweise darin auf meine farbe-Notiz.');
    const r2 = await orch.handleChat('name alf');
    const alf = path.join(V, 'Genesis', 'alf.md');
    assert(fs.existsSync(alf) && fs.readFileSync(alf, 'utf8') === 'Verweis: [[Farbe]]' && /Datei erstellt: /.test(r2.text) && modelCalls === 0, 'short answer rides the priority road, reference intact, no model');
    await orch.handleChat('Leg dir in deinem Genesis-Bereich im Vault eine Notiz an.');
    await orch.handleChat('warum "D:\\irgendwo\\alf.txt"');
    assert(h._pendingFileRequest && h._pendingFileRequest.kind === 'create', 'a question with a path neither opens nor kills the pending');
    const rB9 = await orch.handleChat('lies x22');
    assert(h._pendingFileRequest && !(fs.existsSync(path.join(V, 'Genesis')) && fs.readdirSync(path.join(V, 'Genesis')).some((f) => /lies/.test(f))), 'a COMMAND between answers keeps its road \u2014 never becomes a file (B9)');
    const r5 = await orch.handleChat('fff');
    assert(fs.existsSync(path.join(V, 'Genesis', 'fff.md')) && /Datei erstellt: /.test(r5.text), 'the thread survives the aside');
  });
});

describe('v7945 field — look-in-my-vault reads, never remembers', () => {
  test('the literal question routes deterministically, answers from the note, source named, zero model', async () => {
    const { ChatOrchestrator } = require(path.join(ROOT, 'src/agent/hexagonal/ChatOrchestrator.js'));
    const { IntentRouter } = require(path.join(ROOT, 'src/agent/intelligence/IntentRouter.js'));
    const { CommandHandlers } = require(path.join(ROOT, 'src/agent/hexagonal/CommandHandlers.js'));
    const base = createTestRoot('vault-lookup'); const V = path.join(base, 'Zettel');
    fs.mkdirSync(path.join(V, 'Speicher'), { recursive: true });
    fs.writeFileSync(path.join(V, 'Speicher', 'Farbe.md'), 'Meine Lieblingsfarbe ist gr\u00fcn.\n');
    let mc = 0;
    const orch = new ChatOrchestrator({ lang: { t: (k) => k, detect() {}, current: 'de' }, bus: { fire() {} }, intentRouter: new IntentRouter({ bus: { fire() {} } }), model: { chat: async () => { mc++; return { content: '[M]' }; }, complete: async () => { mc++; return '[M]'; } }, context: {}, tools: { hasTool: () => false }, circuitBreaker: {}, promptBuilder: { build: async () => ({ messages: [{ role: 'user', content: 'x' }] }) }, uncertaintyGuard: { wrapResponse: (r) => r }, memory: {}, unifiedMemory: {}, storageDir: base, storage: {}, gateStats: {}, selfGate: {} });
    const h = new CommandHandlers({ lang: { t: (k) => k, detect() {}, current: 'de' }, settings: { get: (k) => (k === 'vault.path' ? V : undefined) }, fileProcessor: { rootDir: path.join(base, 'proj') }, genesisDir: path.join(base, '.g') });
    h.registerHandlers(orch);
    const r = await orch.handleChat('Schau in meinen Zettelkasten: was ist meine Lieblingsfarbe?');
    assert(/gr\u00fcn/.test(r.text) && /Farbe\.md/.test(r.text) && mc === 0, 'reads the real note \u2014 stale memory can never answer again');
    const r2 = await orch.handleChat('Schau in meinen Zettelkasten: wie hei\u00dft mein raumschiff?');
    assert(/nichts gefunden/.test(r2.text), 'a miss is honest, not invented');
  });
});

run();
