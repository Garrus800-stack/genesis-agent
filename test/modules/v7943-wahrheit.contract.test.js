#!/usr/bin/env node
// ============================================================
// GENESIS — test/modules/v7943-wahrheit.contract.test.js
// v7.9.43 W1: the truth guard. Field 19.07.: the model wrote perfect
// trace optics into its answer while nothing ran. Model-written glyph
// lines are always removed; a marker appears only when the named tool
// did NOT really run; real :229 traces are never touched.
// ============================================================
'use strict';
const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..', '..');
const { sanitizeModelToolLines } = require(path.join(ROOT, 'src/agent/hexagonal/ChatToolTruth.js'));
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('v7943 W1 — the guard on model text', () => {
  test('the exact field line is stripped and flagged when nothing ran', () => {
    const fieldLine = 'Danke, the user.\n\n\u26ed tool: resonance-note() \u2192 ok';
    const out = sanitizeModelToolLines(fieldLine, new Set());
    assert(!out.includes('\u26ed tool:'), 'glyph line gone');
    assert(out.includes('nicht ausgef\u00fchrt: resonance-note'), 'visible marker names the tool');
    assert(out.startsWith('Danke, the user.'), 'the honest prose stays');
  });
  test('real-run lines are removed silently — the :229 trace is the only trace', () => {
    const out = sanitizeModelToolLines('Text\n\u26ed tool: journal-write() \u2192 ok', new Set(['journal-write']));
    assertEqual(out, 'Text', 'no duplicate, no marker');
  });
  test('argument optics from real traces also match (field: open-in-editor)', () => {
    const out = sanitizeModelToolLines('\u26ed tool: open-in-editor(zwei-staedte.html) \u2192 ok', new Set());
    assert(out.includes('nicht ausgef\u00fchrt: open-in-editor'), 'args variant caught');
  });
  test('multiple imitated lines, one marker per name, text order preserved', () => {
    const t = 'A\n\u26ed tool: x() \u2192 ok\nB\n\u26ed tool: x() \u2192 ok\n\u26ed tool: y(z) \u2192 error\nC';
    const out = sanitizeModelToolLines(t, new Set());
    assert(/A\s*\n\s*B\s*\n\s*C/.test(out.split('[')[0]), 'prose intact and ordered');
    assertEqual((out.match(/nicht ausgef\u00fchrt: x/g) || []).length, 1, 'x marked once');
    assert(out.includes('nicht ausgef\u00fchrt: y'), 'y marked');
  });
  test('text without the glyph passes through untouched (fast path)', () => {
    const t = 'ganz normale Antwort mit tool: worten aber ohne Zeichen';
    assertEqual(sanitizeModelToolLines(t, new Set()), t, 'byte-identical');
  });
});

describe('v7943 W1 — wiring pins', () => {
  test('orchestrator sanitizes at BOTH final pushes, before dedupe', () => {
    const t = src('src/agent/hexagonal/ChatOrchestrator.js');
    const hits = (t.match(/dedupeSeams\(sanitizeModelToolLines\(/g) || []).length;
    assertEqual(hits, 2, 'both push sites guarded');
    assert(t.includes("require('./ChatToolTruth.js')"), 'module wired');
  });
  test('helpers collect what REALLY ran, right at the execute site', () => {
    const t = src('src/agent/hexagonal/ChatOrchestratorHelpers.js');
    assert(/this\._execNames = new Set\(\)/.test(t), 'fresh set per turn');
    const i = t.indexOf('executeToolCalls(toolCalls);');
    assert(i > -1 && t.slice(i, i + 220).includes('this._execNames.add(r.name)'), 'collected at :229 execute');
  });
  test('the real trace push stays untouched by the guard (negative pin)', () => {
    const guard = src('src/agent/hexagonal/ChatToolTruth.js');
    assert(!/history/.test(guard), 'guard never reaches into history');
    const helpers = src('src/agent/hexagonal/ChatOrchestratorHelpers.js');
    assert(helpers.includes("content: '\\u26ed tool: ' + _tr.slice(0, 300)"), ':229 trace byte-identical');
  });
  test('A5 sister rule sits with its kin; both under the tool condition', () => {
    const t = src('src/agent/intelligence/PromptBuilderSectionsAwareness.js');
    const i = t.indexOf('Never write the \\u26ed trace line yourself');
    assert(i > -1, 'sister rule present');
    assert(i > t.indexOf('name it verbatim'), 'right after the verbatim rule');
  });
  test('A1 rest: the CODE prompt demands double-quoted absolute paths', () => {
    const t = src('src/agent/revolution/AgentLoopStepsCode.js');
    assert(t.includes('ALWAYS double-quote any absolute path'), 'quote rule in SANDBOX RULES');
    assert(t.indexOf('ALWAYS double-quote') > t.indexOf('NEVER use relative'), 'sits inside the rules chain');
  });
  test('D-2: the registered log now counts resonance-note', () => {
    const t = src('src/agent/cognitive/tools/v737-memory-tools.js');
    assert(/_log\.info\('\[v737-tools\] Registered \(v7\.9\.42\): resonance-note'\)/.test(t), 'log line present');
  });
});

run();
