// ============================================================
// TEST — v7.9.41 r3: the act core — said = done.
//   node test/modules/v7941r3-actcore.contract.test.js
// Field 19.07.: five turns of "Ich lese das Changelog" with zero tool
// calls; "schaue dir den CHANGELOG an" answered with a question back.
// The SYSTEM now plans read-only tool steps deterministically from the
// user's demand or the model's own announcement — model-agnostic.
// ============================================================
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { describe, test, run } = require('../harness');
const ROOT = path.join(__dirname, '..', '..');
const { planActFromText } = require('../../src/agent/hexagonal/ChatActCore.js');
function src(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf-8'); }

describe('v7.9.41 r3 — Act-Kern', () => {
  test('the exact field announcements become acts', () => {
    for (const s of ['Ich lese das Changelog.', 'Ich lese den CHANGELOG jetzt wirklich.']) {
      const a = planActFromText(s);
      assert.ok(a && a.name === 'file-read' && a.input.path === 'CHANGELOG.md', s);
    }
  });
  test('the exact field demands become acts', () => {
    for (const s of ['schaue dir den CHANGELOG an', 'fasse den CHANGELOG zusammen']) {
      const a = planActFromText(s);
      assert.ok(a && a.input.path === 'CHANGELOG.md', s);
    }
  });
  test('explicit paths win over known-doc names', () => {
    const a = planActFromText('lies docs/ARCHITECTURE.md und sag mir was drin steht');
    assert.deepStrictEqual(a.input, { path: 'docs/ARCHITECTURE.md' });
  });
  test('structure intent maps to file-list', () => {
    const a = planActFromText('Habitat-Struktur erfassen: Verzeichnisse, Konfiguration');
    assert.ok(a && a.name === 'file-list');
  });
  test('question form "was steht im X" acts too', () => {
    assert.strictEqual(planActFromText('was steht im README').input.path, 'README.md');
  });
  test('conversation stays conversation (no false acts)', () => {
    for (const s of ['wie ist dein Zustand?', 'Ich freue mich über das Angebot.', 'du kannst ja und nein sagen', 'was denkst du gerade?']) {
      assert.strictEqual(planActFromText(s), null, s);
    }
  });
  test('read-only scope: the core never plans write or shell', () => {
    const t = src('src/agent/hexagonal/ChatActCore.js');
    assert.ok(!/name: 'shell'|name: 'file-write'/.test(t), 'read-only by construction');
  });
  test('helpers wire the act BEFORE the nudge fallback, capped (source pins)', () => {
    const t = src('src/agent/hexagonal/ChatOrchestratorHelpers.js');
    assert.ok(t.includes("require('./ChatActCore.js').planActFromText(text)"), 'announcement source');
    assert.ok(t.includes('planActFromText(String(userMessage'), 'user-demand source (round 0)');
    assert.ok(t.indexOf('ChatActCore') < t.indexOf('announcesNext'), 'act before announce machinery');
    assert.ok(t.includes('_acts < 2'), 'capped');
    assert.ok(t.includes('close act-guard'), 'nudge stays reachable as fallback');
  });
  test('missing tools self-heal already exists (ToolSynth on first call — source pin)', () => {
    const hits = ['src/agent/intelligence', 'src/agent/cognitive']
      .flatMap(d => { try { return fs.readdirSync(path.join(ROOT, d)).map(f => path.join(d, f)); } catch (_e) { return []; } })
      .filter(f => f.endsWith('.js'))
      .some(f => /Auto-synthesized .* on first call|synthesizeOnMissing|auto-synth/i.test(src(f)));
    assert.ok(hits, 'the field log showed it live: Auto-synthesized "read_source" on first call');
  });
});
if (require.main === module) run();
