#!/usr/bin/env node
// GENESIS — v7.9.44 r14: the Archive becomes a workspace. Genesis can now create
// (default = Archive), edit one spot in place, append to grow, and bring files in.
'use strict';
const { describe, test, assert, run, createTestRoot } = require('../harness');
const path = require('path'); const fs = require('fs');
const ROOT = path.resolve(__dirname, '..', '..');
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const { registerV737Tools } = require(path.join(ROOT, 'src/agent/cognitive/tools/v737-memory-tools.js'));

function mkTools(gd, archivePath) {
  const reg = { _t: {}, register(name, schema, handler) { this._t[name] = { name, schema, handler }; } };
  const settings = { get: (k) => (k === 'archive.path' ? archivePath : undefined) };
  registerV737Tools(reg, { modelBridge: { _genesisDir: gd, chat: async () => ({}) }, journalWriter: { write() {} }, settings });
  return reg._t;
}

describe('v7944 Werkstatt — the Archive as a workspace', () => {
  test('all four workshop tools are registered', () => {
    const c = src('src/agent/cognitive/tools/v737-memory-tools.js');
    for (const n of ['edit-file', 'append-file', 'copy-to-archive', 'move-to-archive']) {
      assert(c.includes("register('" + n + "'"), n + ' is registered');
    }
  });

  test('edit-file replaces ONE spot in place (does not rewrite the whole file)', async () => {
    const gd = createTestRoot('w-a'); const arch = path.join(gd, 'arch'); fs.mkdirSync(arch, { recursive: true });
    const T = mkTools(gd, arch);
    await T['append-file'].handler({ path: 'doc.txt', text: 'alpha beta gamma' });
    const r = await T['edit-file'].handler({ path: 'doc.txt', find: 'beta', replace: 'BETA' });
    assert(r.ok, 'edit succeeded');
    assert(fs.readFileSync(path.join(arch, 'doc.txt'), 'utf-8') === 'alpha BETA gamma', 'only the one spot changed');
  });

  test('edit-file refuses a missing or ambiguous anchor', async () => {
    const gd = createTestRoot('w-b'); const arch = path.join(gd, 'arch'); fs.mkdirSync(arch, { recursive: true });
    const T = mkTools(gd, arch);
    await T['append-file'].handler({ path: 'd.txt', text: 'x y x' });
    const miss = await T['edit-file'].handler({ path: 'd.txt', find: 'zzz', replace: 'q' });
    assert(!miss.ok, 'missing anchor rejected');
    const amb = await T['edit-file'].handler({ path: 'd.txt', find: 'x', replace: 'q' });
    assert(!amb.ok, 'ambiguous anchor rejected');
  });

  test('append-file grows a file and keeps the original; creates when absent', async () => {
    const gd = createTestRoot('w-c'); const arch = path.join(gd, 'arch'); fs.mkdirSync(arch, { recursive: true });
    const T = mkTools(gd, arch);
    const r = await T['append-file'].handler({ path: 'grow.txt', text: 'first' });
    assert(r.ok && fs.existsSync(path.join(arch, 'grow.txt')), 'created on first append');
    await T['append-file'].handler({ path: 'grow.txt', text: 'second' });
    const c = fs.readFileSync(path.join(arch, 'grow.txt'), 'utf-8');
    assert(c.startsWith('first') && c.includes('second'), 'original kept, new appended');
  });

  test('copy keeps the source, move removes it', async () => {
    const gd = createTestRoot('w-d'); const arch = path.join(gd, 'arch'); fs.mkdirSync(path.join(arch, 'inbox'), { recursive: true });
    const T = mkTools(gd, arch);
    const ext = path.join(gd, 'outside.txt'); fs.writeFileSync(ext, 'data');
    const rc = await T['copy-to-archive'].handler({ source: ext });
    assert(rc.ok && fs.existsSync(path.join(arch, 'inbox', 'outside.txt')) && fs.existsSync(ext), 'copy: in archive, source stays');
    const ext2 = path.join(gd, 'moveme.txt'); fs.writeFileSync(ext2, 'd');
    const rm = await T['move-to-archive'].handler({ source: ext2 });
    assert(rm.ok && fs.existsSync(path.join(arch, 'inbox', 'moveme.txt')) && !fs.existsSync(ext2), 'move: in archive, source gone');
  });

  test('writes into the soul, secrets, or system are refused', async () => {
    const gd = createTestRoot('w-e'); const arch = path.join(gd, 'arch'); fs.mkdirSync(arch, { recursive: true });
    const T = mkTools(gd, arch);
    const soul = await T['append-file'].handler({ path: '/x/.genesis/self-model.json', text: 'x' });
    const sys = await T['edit-file'].handler({ path: '/etc/hosts', find: 'a', replace: 'b' });
    const key = await T['append-file'].handler({ path: '/tmp/id_rsa', text: 'x' });
    assert(!soul.ok && !sys.ok && !key.ok, 'soul, system, and secret writes blocked');
  });

  test('createFile carries the Archive-default resolver', () => {
    const c = src('src/agent/hexagonal/CommandHandlersFileView.js');
    assert(c.includes('function _archiveDir('), 'archive-dir resolver present');
    assert(/let dir = \(_arch &&[^)]*existsSync\(_arch\)\) \? _arch : rootDir/.test(c), 'default is Archive when it exists, else project');
  });

  test('r15: spoken create commands route; capability questions stay with the model', () => {
    const defs = require(path.join(ROOT, 'src/agent/intelligence/IntentPatterns.js')).INTENT_DEFINITIONS;
    const cf = defs.find((d) => d[0] === 'create-file')[1];
    const hits = (m) => cf.some((r) => r.test(m));
    assert(hits('kannst ein dokument erstellen mit namen it und inhalt text: hallo test'), 'question / verb-at-end form routes');
    assert(hits('eine datei anlegen namens notiz mit inhalt x'), 'anlegen form routes');
    assert(!hits('welche dateien kann man erstellen?'), 'capability question stays with the model');
    assert(!hits('lies das dokument plan und erstelle eine zusammenfassung'), 'compound read+summarize is not hijacked');
  });

  test('r15: a name keeps its spaces; content sheds the instruction shell', async () => {
    const gd = createTestRoot('w-f');
    const H = require(path.join(ROOT, 'src/agent/hexagonal/CommandHandlersFileView.js')).commandHandlersFileView;
    const ctx = { fp: { rootDir: gd } };
    await H.createFile.call(ctx, 'erstelle ein text dokument mit namen Genesis 01 und inhalt da fügst du das ein: hallo Wrorld .');
    assert(fs.existsSync(path.join(gd, 'Genesis 01.txt')), 'name keeps its spaces');
    assert(fs.readFileSync(path.join(gd, 'Genesis 01.txt'), 'utf-8') === 'hallo Wrorld .', 'instruction shell stripped, pure text written');
    await H.createFile.call(ctx, 'kannst ein dokument erstellen mit namen it und inhalt text: hallo test');
    assert(fs.readFileSync(path.join(gd, 'it.txt'), 'utf-8') === 'hallo test', '"text:" prefix stripped');
    await H.createFile.call(ctx, 'erstelle ein dokument mit namen c1 der text in dem dokument ist test');
    assert(fs.existsSync(path.join(gd, 'c1.txt')), 'name stops before the content clause (field-proven form kept)');
    await H.createFile.call(ctx, 'erstelle ein dokument namens brief mit inhalt Fügen Sie hier bitte nichts hinzu.');
    assert(fs.readFileSync(path.join(gd, 'brief.txt'), 'utf-8') === 'Fügen Sie hier bitte nichts hinzu.', 'formal content is NOT stripped');
  });

  test('r16: the net reports a break, never blocks, stays silent when valid', async () => {
    const gd = createTestRoot('w-g'); const arch = path.join(gd, 'arch'); fs.mkdirSync(arch, { recursive: true });
    const T = mkTools(gd, arch);
    await T['append-file'].handler({ path: 's.js', text: 'function f(){ return 1; }' });
    const r1 = await T['edit-file'].handler({ path: 's.js', find: 'return 1; }', replace: 'return 1;' });
    assert(r1.ok && /gebrochen/.test(r1.content), 'break is reported in the result');
    assert(fs.readFileSync(path.join(arch, 's.js'), 'utf-8') === 'function f(){ return 1;', 'the write still happened (never blocked)');
    const r2 = await T['edit-file'].handler({ path: 's.js', find: 'return 1;', replace: 'return 1; }' });
    assert(r2.ok && !/gebrochen/.test(r2.content), 'valid edit gets no warning');
    const r3 = await T['append-file'].handler({ path: 'n.txt', text: 'prose' });
    assert(r3.ok && !/gebrochen/.test(r3.content), 'non-checkable extensions pass untouched');
  });

  test('r16: check-file gives a verdict without content; compare-files shows only the difference', async () => {
    const gd = createTestRoot('w-h'); const arch = path.join(gd, 'arch'); fs.mkdirSync(arch, { recursive: true });
    const T = mkTools(gd, arch);
    fs.writeFileSync(path.join(arch, 'bad.js'), 'function f(){');
    const c1 = await T['check-file'].handler({ path: 'bad.js' });
    assert(c1.ok && /\u2717/.test(c1.content) && !c1.content.includes('function f(){'), 'error verdict, no content leak');
    fs.writeFileSync(path.join(arch, 'good.js'), 'const x = 1;');
    const c2 = await T['check-file'].handler({ path: 'good.js' });
    assert(/\u2713/.test(c2.content), 'valid verdict');
    fs.writeFileSync(path.join(arch, 'a.txt'), 'z1\nz2\nz3');
    fs.writeFileSync(path.join(arch, 'b.txt'), 'z1\nz2X\nz3');
    const v = await T['compare-files'].handler({ a: 'a.txt', b: 'b.txt' });
    assert(v.ok && v.content.includes('z2X') && !v.content.includes('z1') && !v.content.includes('z3'), 'only the differing middle is shown');
    const same = await T['compare-files'].handler({ a: 'a.txt', b: 'a.txt' });
    assert(/identisch/.test(same.content), 'identical is named');
  });

  test('r16: a missed anchor names the nearest line; file-write carries the mirrored net', async () => {
    const gd = createTestRoot('w-i'); const arch = path.join(gd, 'arch'); fs.mkdirSync(arch, { recursive: true });
    const T = mkTools(gd, arch);
    fs.writeFileSync(path.join(arch, 'g.js'), 'const x = 1;');
    const m = await T['edit-file'].handler({ path: 'g.js', find: 'const x = 2;', replace: 'y' });
    assert(!m.ok && /Zeile 1/.test(m.error) && /const x = 1;/.test(m.error), 'nearest line offered');
    const c = src('src/agent/intelligence/ToolRegistryBuiltins.js');
    assert(/warning: 'string\?'/.test(c) && /syntaktisch gebrochen/.test(c) && /vm'\)\.Script\)/.test(c.replace(/require\('/g, "'")) || (c.includes("require('vm').Script") && c.includes('warning:')), 'file-write mirrors the net and declares warning');
  });
});
run();
