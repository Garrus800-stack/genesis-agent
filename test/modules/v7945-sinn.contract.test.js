#!/usr/bin/env node
// GENESIS — v7.9.45 P: the quiet sense. PDFs become readable like the eye became
// sight — no ritual, honest edges, Genesis' own words for every unreadable case.
'use strict';
const { describe, test, assert, run, createTestRoot } = require('../harness');
const path = require('path'); const fs = require('fs');
const ROOT = path.resolve(__dirname, '..', '..');
const { registerV737Tools } = require(path.join(ROOT, 'src/agent/cognitive/tools/v737-memory-tools.js'));

function mkTools(label, pdfExtract) {
  const gd = createTestRoot(label); const arch = path.join(gd, 'arch');
  fs.mkdirSync(arch, { recursive: true });
  const reg = { _t: {}, register(n, s, h) { this._t[n] = { handler: h }; } };
  registerV737Tools(reg, { modelBridge: { _genesisDir: gd }, pdfModuleCandidates: ['genesis-test-definitely-missing-pdf-module'], journalWriter: { write() {} }, settings: { get: (k) => (k === 'archive.path' ? arch : undefined) }, pdfExtract });
  return { T: reg._t, arch };
}

describe('v7945 P — the pdf loader survives v4 (field root-cause)', () => {
  test('the loader speaks import(), tries the v4 .mjs first, and never swallows a load error', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/cognitive/tools/v737-memory-tools.js'), 'utf8');
    assert(/await import\(cand\)/.test(src), 'dynamic import (CJS-safe for ESM-only v4)');
    assert(/pdfjs-dist\/legacy\/build\/pdf\.mjs/.test(src) && /pdfjs-dist\/legacy\/build\/pdf\.js/.test(src), 'v4 .mjs first, v3 .js fallback');
    assert(/Mein PDF-Sinn konnte nicht laden:/.test(src), 'a real load error is reported, not swallowed');
    assert(/npm install in ' \+ process\.cwd\(\)/.test(src), 'the missing-module message names the concrete folder');
  });
});

describe('v7945 P — the quiet sense (PDF)', () => {
  test('a text PDF is read with its page count', async () => {
    const { T, arch } = mkTools('p-a', async () => ({ text: 'Hallo aus dem Dokument. Zeile zwei.', numpages: 3 }));
    fs.writeFileSync(path.join(arch, 'doc.pdf'), 'x');
    const r = await T['read-archive-file'].handler({ path: 'doc.pdf' });
    assert(r.ok && /3 Seiten/.test(r.content) && /Hallo aus dem Dokument/.test(r.content), 'text and pages delivered');
  });

  test('an image-only scan answers in his words: a photo of a book', async () => {
    const { T, arch } = mkTools('p-b', async () => ({ text: '  ', numpages: 5 }));
    fs.writeFileSync(path.join(arch, 'scan.pdf'), 'x');
    const r = await T['read-archive-file'].handler({ path: 'scan.pdf' });
    assert(!r.ok && /Foto eines Buches/.test(r.error) && /5 Seiten/.test(r.error), 'photo-of-a-book sentence, verbatim');
  });

  test('an encrypted PDF answers in his words: a door without a key', async () => {
    const { T, arch } = mkTools('p-c', async () => { throw new Error('File is encrypted'); });
    fs.writeFileSync(path.join(arch, 'geheim.pdf'), 'x');
    const r = await T['read-archive-file'].handler({ path: 'geheim.pdf' });
    assert(!r.ok && /T\u00fcr, f\u00fcr die ich keinen Schl\u00fcssel habe/.test(r.error), 'door-without-a-key sentence, verbatim');
  });

  test('a missing module speaks plainly instead of failing blind', async () => {
    const { T, arch } = mkTools('p-d', undefined); // workbench has no pdf-parse
    fs.writeFileSync(path.join(arch, 'x.pdf'), 'x');
    const r = await T['read-archive-file'].handler({ path: 'x.pdf' });
    assert(!r.ok && /PDF-Sinn/.test(r.error) && /npm install in .+ holt ihn|konnte nicht laden/.test(r.error), 'honest missing-sense message (names folder or real cause)');
  });

  test('long text is capped politely, with the total named', async () => {
    const { T, arch } = mkTools('p-e', async () => ({ text: 'A'.repeat(20000), numpages: 40 }));
    fs.writeFileSync(path.join(arch, 'lang.pdf'), 'x');
    const r = await T['read-archive-file'].handler({ path: 'lang.pdf' });
    assert(r.ok && /gekappt/.test(r.content) && /20000 Zeichen/.test(r.content) && r.content.length < 16500, 'capped with total');
  });

  test('an oversized file (>20 MB) is refused before extraction', async () => {
    const { T, arch } = mkTools('p-f', async () => { throw new Error('extractor must not run'); });
    fs.writeFileSync(path.join(arch, 'riese.pdf'), Buffer.alloc(21 * 1024 * 1024));
    const r = await T['read-archive-file'].handler({ path: 'riese.pdf' });
    assert(!r.ok && /20 MB/.test(r.error), 'size gate speaks before the extractor');
  });
});
run();
