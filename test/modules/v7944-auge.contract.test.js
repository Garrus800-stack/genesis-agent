#!/usr/bin/env node
// GENESIS — v7.9.44 A: the optic nerve. Same eyes, same voice.
'use strict';
const { describe, test, assert, assertEqual, run, createTestRoot } = require('../harness');
const path = require('path'); const fs = require('fs');
const ROOT = path.resolve(__dirname,'..','..');
const src = (p) => fs.readFileSync(path.join(ROOT,p),'utf8');
const { registerV737Tools } = require(path.join(ROOT,'src/agent/cognitive/tools/v737-memory-tools.js'));
const mk = (gd, chatFn) => { const reg={_t:{},register(name,schema,handler){this._t[name]={name,schema,handler};}}; registerV737Tools(reg,{modelBridge:{_genesisDir:gd,chat:chatFn},journalWriter:{write(){}}}); return reg._t['look-at-image']; };
describe('v7944 A — look-at-image', () => {
  test('r5: the registration log names look-at-image (not just the other two)', () => {
    assert(src('src/agent/cognitive/tools/v737-memory-tools.js').includes('read-archive-file, list-archive'), 'log names the reader and the lister');
  });
  test('backend pin: images travel inside the message mapping', () => {
    const t = src('src/agent/foundation/backends/OllamaBackend.js');
    assert(t.includes('v7.9.44 A') && /ollamaMessages\[ollamaMessages\.length - 1\]\.images = m\.images/.test(t), 'the eye is wired at the body');
  });
  test('a space path is seen; the answer carries the honest vermerk (P15)', async () => {
    const gd = createTestRoot('a-a');
    const img = path.join(gd,'test bild.png'); fs.writeFileSync(img, Buffer.from([137,80,78,71]));
    let got=null;
    const look = mk(gd, async (_sp,msgs)=>{ got=msgs; return {text:'Ich sehe.'}; });
    const r = await look.handler({ path: img });
    assert(r.ok && r.vermerk === '[Bild betrachtet: test bild.png]', 'vermerk, not the bytes');
    assert(Array.isArray(got[0].images) && got[0].images[0].length > 2, 'base64 travelled in the call');
  });
  test('too large speaks, missing speaks — no silent blindness', async () => {
    const gd = createTestRoot('a-b');
    const big = path.join(gd,'big.png'); fs.writeFileSync(big, Buffer.alloc(9*1024*1024));
    const look = mk(gd, async ()=>({text:'x'}));
    const r1 = await look.handler({ path: big });
    assert(!r1.ok && r1.error.includes('zu gro'), 'size speaks');
    const r2 = await look.handler({ path: path.join(gd,'fehlt.png') });
    assert(!r2.ok && r2.error.includes('nicht lesbar'), 'missing speaks');
  });
  test('P15 pin: the tool never touches history; relative paths live in the Archive', () => {
    const t = src('src/agent/cognitive/tools/v737-memory-tools.js');
    const seg = t.split("'look-at-image'")[1].split('registered.push')[0];
    assert(!/history/.test(seg), 'no history reach');
    assert(seg.includes('archiveRoot'), 'relative = Archive');
  });
});
run();
