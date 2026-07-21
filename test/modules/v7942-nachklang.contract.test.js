#!/usr/bin/env node
// ============================================================
// GENESIS — test/modules/v7942-nachklang.contract.test.js
// v7.9.42 Teil B (V2a): the Nachklang — Genesis' own design.
// "das nehme ich mit" → ONE small model call condenses the moment
// into {topic, stance, openQuestion} in .genesis/resonance.jsonl;
// idle picks it up as the PREFERRED, never displacing topic source.
// Plus A5: announces name the action verbatim.
// ============================================================
'use strict';
const { describe, test, assert, assertEqual, run, createTestRoot } = require('../harness');
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..', '..');
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function mkTools() { const reg = {}; return { reg, register: (n, m, h) => { reg[n] = { m, h }; }, hasTool: (n) => !!reg[n] }; }

describe('v7942 V2a — resonance-note tool (sibling of the v7.3.7 house)', () => {
  const { registerV737Tools } = require(path.join(ROOT, 'src/agent/cognitive/tools/v737-memory-tools.js'));
  test('registers only when the bridge (with soul dir) is there', () => {
    const t1 = mkTools(); registerV737Tools(t1, {});
    assert(!t1.hasTool('resonance-note'), 'no deps — no tool');
    const t2 = mkTools(); registerV737Tools(t2, { modelBridge: { _genesisDir: createTestRoot('v2a-reg'), chatStructured: async () => ({}) } });
    assert(t2.hasTool('resonance-note'), 'with bridge — registered');
  });
  test('one marked moment → ONE structured call → three-field condensate on disk', async () => {
    const dir = createTestRoot('v2a-write'); let calls = 0;
    const bridge = { _genesisDir: dir, chatStructured: async () => { calls++; return { topic: 'T', stance: 'S', openQuestion: 'Q?' }; } };
    const t = mkTools(); registerV737Tools(t, { modelBridge: bridge });
    const r = await t.reg['resonance-note'].h({ moment: 'ein Moment' });
    assertEqual(calls, 1, 'exactly one model call in the tool');
    assert(r.ok === true && r.topic === 'T', 'ok with topic back');
    const e = JSON.parse(fs.readFileSync(path.join(dir, 'resonance.jsonl'), 'utf8').trim());
    assert(e.topic === 'T' && e.stance === 'S' && e.openQuestion === 'Q?' && e.src === 'self-mark', 'all three fields + source mark');
  });
  test('no mark, no entry — empty moment refuses without touching disk', async () => {
    const dir = createTestRoot('v2a-empty');
    const t = mkTools(); registerV737Tools(t, { modelBridge: { _genesisDir: dir, chatStructured: async () => ({}) } });
    const r = await t.reg['resonance-note'].h({});
    assert(r.ok === false, 'refused');
    assert(!fs.existsSync(path.join(dir, 'resonance.jsonl')), 'nothing written');
  });
  test('source pin: resonance.jsonl is WRITTEN by the tool alone', () => {
    // v7.9.43 follow-up (documented): W3 modules may MENTION the anchor file
    // in comments ("never enter"); the pin counts WRITE paths, not words.
    const writers = [];
    const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (f.name.endsWith('.js')) { const t = fs.readFileSync(p, 'utf8'); if (/(appendFileSync|writeFileSync)\([^\n]*resonance\.jsonl/.test(t)) writers.push(path.relative(ROOT, p).split(path.sep).join('/')); } } };
    walk(path.join(ROOT, 'src'));
    assertEqual(writers.join(','), 'src/agent/cognitive/tools/v737-memory-tools.js', 'exactly one write path');
    assert(!/appendFileSync[^\n]*resonance/.test(src('src/agent/autonomy/activities/PickContext.js')), 'the reader never writes');
  });
  test('wiring pin: BootWire hands the container model to the house', () => {
    assert(/modelBridge:\s*c\.tryResolve\('model'\)/.test(src('src/agent/AgentCoreBootWire.js')), 'bridge dep wired');
  });
});

describe('v7942 V2a — idle picks it up (preferred, never displacing)', () => {
  test('snap carries the last condensates; every other source stays', () => {
    const dir = createTestRoot('v2a-snap');
    fs.writeFileSync(path.join(dir, 'resonance.jsonl'), JSON.stringify({ ts: 1, topic: 'X', stance: 'y', openQuestion: 'z?' }) + '\n');
    const { buildPickContext } = require(path.join(ROOT, 'src/agent/autonomy/activities/PickContext.js'));
    const ctx = buildPickContext({ storageDir: dir, activityLog: [] });
    assertEqual((ctx.snap.resonance || []).length, 1, 'condensate surfaced');
    assert('needs' in ctx.snap && 'imprints' in ctx.snap && 'lessons' in ctx.snap, 'other sources untouched');
  });
  test('reflect prefers it: boost with > boost without', () => {
    const R = require(path.join(ROOT, 'src/agent/autonomy/activities/Reflect.js'));
    const act = R.reflect || R.default || R;
    const st = act.shouldTrigger || (act.prototype && act.prototype.shouldTrigger);
    const base = { snap: { resonance: [] } };
    const withR = { snap: { resonance: [{ topic: 'X' }] } };
    assert(st.call(act, withR) > st.call(act, base), 'resonance boosts reflect');
  });
  test('tolerance: missing or broken file degrades to empty, never throws', () => {
    const { buildPickContext } = require(path.join(ROOT, 'src/agent/autonomy/activities/PickContext.js'));
    const c1 = buildPickContext({ storageDir: createTestRoot('v2a-miss'), activityLog: [] });
    assertEqual((c1.snap.resonance || []).length, 0, 'missing file — empty');
    const dir = createTestRoot('v2a-broken');
    fs.writeFileSync(path.join(dir, 'resonance.jsonl'), '{kaputt\n' + JSON.stringify({ topic: 'ok' }) + '\n');
    const c2 = buildPickContext({ storageDir: dir, activityLog: [] });
    assertEqual((c2.snap.resonance || []).length, 1, 'broken line skipped, good one kept');
  });
});

describe('v7942 A5 — verbatim announces', () => {
  test('style rule pinned in the awareness section', () => {
    const t = src('src/agent/intelligence/PromptBuilderSectionsAwareness.js');
    assert(t.includes('name it verbatim — never paraphrase'), 'rule present');
    assert(t.indexOf('v7.9.42 A5') < t.indexOf('v7.8.0: subtle pointer'), 'sits with its awareness kin');
  });
});

run();
