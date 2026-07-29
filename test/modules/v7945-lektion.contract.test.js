#!/usr/bin/env node
// GENESIS — v7.9.45 K: the correction lesson. The partner's correction becomes
// a CANDIDATE; only a real accept-lesson run makes it a lesson (his .43
// sovereignty pattern). The field proof rides as the first pinned case.
'use strict';
const { describe, test, assert, run, createTestRoot } = require('../harness');
const path = require('path'); const fs = require('fs');
const ROOT = path.resolve(__dirname, '..', '..');
const CH = require(path.join(ROOT, 'src/agent/cognitive/CorrectionHeuristic.js'));
const CC = require(path.join(ROOT, 'src/agent/cognitive/CorrectionCandidates.js'));
const { registerV737Tools } = require(path.join(ROOT, 'src/agent/cognitive/tools/v737-memory-tools.js'));
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

describe('v7945 K — the correction lesson', () => {
  test('the field case becomes a candidate; one per chat; praise, code and rants stay silent', () => {
    const dir = createTestRoot('k-a');
    const orch = { model: { _genesisDir: dir } };
    CH.observeUser(orch, 'du sollst nur antworten es war eine frage?');
    assert(CC.decay(dir).open.length === 1, 'the field correction is laid down');
    CH.observeUser(orch, 'nein, das war falsch');
    assert(CC.decay(dir).open.length === 1, 'at most one candidate per chat');
    const dir2 = createTestRoot('k-b'); const o2 = { model: { _genesisDir: dir2 } };
    CH.observeUser(o2, 'nicht schlecht, das gef\u00e4llt mir');
    CH.observeUser(o2, '```js\ndas war falsch\n```');
    CH.observeUser(o2, 'nein ' + 'x'.repeat(500));
    assert(CC.decay(dir2).open.length === 0, 'praise, code blocks and over-long turns are filtered');
  });

  test('the offer names the card id and the confirming tool', () => {
    const dir = createTestRoot('k-c');
    CC.add(dir, { sourceText: 'du sollst nur antworten' });
    const off = CC.pickOffer(dir);
    assert(off && off.block.includes(off.card.id) && /accept-lesson/.test(off.block), 'id and tool are spoken');
  });

  test('accept-lesson records the lesson, removes the card, and is honest about unknowns', async () => {
    const dir = createTestRoot('k-d'); const arch = path.join(dir, 'A'); fs.mkdirSync(arch, { recursive: true });
    const card = CC.add(dir, { sourceText: 'erst antworten, dann handeln' });
    const rec = [];
    const reg = { _t: {}, register(n, s, h) { this._t[n] = { handler: h }; } };
    registerV737Tools(reg, { modelBridge: { _genesisDir: dir }, journalWriter: { write() {} }, settings: { get: (k) => (k === 'archive.path' ? arch : undefined) }, lessonsStore: { record: (l) => rec.push(l) } });
    const r = await reg._t['accept-lesson'].handler({ id: card.id, strategy: 'zuerst die Frage beantworten' });
    assert(r.ok && rec.length === 1 && rec[0].category === 'correction' && rec[0].strategy === 'zuerst die Frage beantworten', 'a real run records the lesson');
    assert(CC.get(dir, card.id) === null, 'the card is removed by the tool itself');
    const miss = await reg._t['accept-lesson'].handler({ id: 'gibtsnicht' });
    assert(!miss.ok && /finde ich nicht/.test(miss.error), 'unknown cards answer honestly');
  });

  test('the wiring is complete: both chat paths observe, the offer block is spoken', () => {
    const orch = src('src/agent/hexagonal/ChatOrchestrator.js') + '\n' + src('src/agent/hexagonal/ChatOrchestratorStream.js') /* v7.9.48: split */;
    assert((orch.match(/_observeCorrection && this\._observeCorrection\(this, message\)/g) || []).length === 2, 'both user-push paths carry the hook');
    const wire = src('src/agent/AgentCoreBootWire.js');
    assert(/CorrectionHeuristic\.js'\)\.observeUser/.test(wire) && /_pickCorrectionOffer/.test(wire), 'BootWire wires heuristic and offer (phase-clean)');
    assert(/lessonsStore:\s+c\.tryResolve\('lessonsStore'\)/.test(wire), 'the lessons store rides into the tool deps');
    const extra = src('src/agent/intelligence/PromptBuilderSectionsExtra.js');
    assert(/_correctionOfferBlock\(\)/.test(extra) && /_ko = this\._correctionOfferBlock\(\); if \(_ko\) parts\.push\(_ko\);/.test(extra), 'the offer joins the prompt beside the resonance card');
    const tools = src('src/agent/cognitive/tools/v737-memory-tools.js');
    assert(/move-to-archive, accept-lesson'\)/.test(tools), 'the registered log counts accept-lesson');
  });
});
run();
