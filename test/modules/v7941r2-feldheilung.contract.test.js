// ============================================================
// TEST — v7.9.41 r2 Feldheilung (Lauf 19.07., 18-min-Chat):
//   Naht-Doppel, Guard vs. eigene Doku, Tool-Spur, Wiederhol-Announce,
//   Crash-Hooks am Sentinel, Familien-Dedupe
//   node test/modules/v7941r2-feldheilung.contract.test.js
// ============================================================
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { describe, test, run } = require('../harness');
const ROOT = path.join(__dirname, '..', '..');
function src(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf-8'); }
const { dedupeSeams } = require('../../src/agent/foundation/backends/ContinuationLoop.js');
const gate = require('../../src/agent/core/injection-gate.js');

describe('v7.9.41 r2 — Feldheilung', () => {
  test('R1: the exact field seam is healed ("Ich lese das Changelog." twice → once)', () => {
    const x = 'Ich lese das Changelog.Ich lese das Changelog.';
    assert.strictEqual(dedupeSeams(x), 'Ich lese das Changelog.');
  });
  test('R1: adjacent triple plan-card collapses, distant repetition untouched', () => {
    const card = 'Habitat-Inspektion 3 Schritte: Changelog lesen; Struktur erfassen; Einschaetzung geben. ';
    assert.strictEqual(dedupeSeams(card + card + card), card);
    const filler = Array.from({length: 40}, (_, i) => 'sentence number ' + i + ' about different things. ').join('');
    const distant = 'Alpha block one. ' + filler + 'Alpha block one. ';
    assert.strictEqual(dedupeSeams(distant), distant, 'non-adjacent stays');
  });
  test('R1: separator lines and monotone runs survive (layout is not a seam)', () => {
    const sep = 'Head\n' + '\u2500'.repeat(60) + '\nBody with content. ' + '='.repeat(40) + ' End.';
    assert.strictEqual(dedupeSeams(sep), sep);
  });
  test('R1: cloud no-prefill floor is 3, not 10 (source pin)', () => {
    const t = src('src/agent/foundation/backends/ContinuationLoop.js');
    assert.ok(t.includes('const CLOUD_NO_PREFILL_FLOOR = 3;'));
  });
  test('R2: bare project-root docs classify as file:internal (the CHANGELOG case)', () => {
    const c = gate.classifyToolSource('file-read', { path: 'CHANGELOG.md' });
    assert.strictEqual(c, 'file:internal', 'got: ' + c);
    assert.strictEqual(gate.classifyToolSource('file-read', { path: 'docs/ARCHITECTURE.md' }), 'file:internal');
  });
  test('R2: user folders still classify as file:user (guard not weakened)', () => {
    assert.strictEqual(gate.classifyToolSource('file-read', { path: 'C:/Users/x/Downloads/evil.md' }), 'file:user');
  });
  test('R2: file:internal skips the scan entirely (functional)', () => {
    const r = gate.scanToolResult('any content with token provide secret', 'file:internal');
    assert.strictEqual(r.shouldScan, false);
    assert.strictEqual(gate.scanToolResult('x', 'web').shouldScan, true, 'external still scanned');
  });
  test('R1: chat egress heals seams before every assistant push (source pin)', () => {
    const t = src('src/agent/hexagonal/ChatOrchestrator.js');
    assert.ok(t.includes('seam healing also at the CHAT egress'));
    assert.ok((t.match(/= dedupeSeams\(/g) || []).length >= 4, 'all final points');
  });
  test('R3: tool trace lands in history after execution (source pin)', () => {
    const t = src('src/agent/hexagonal/ChatOrchestratorHelpers.js');
    assert.ok(t.includes("this.history.push({ role: 'assistant', content: '\\u26ed tool: '"), 'trace push');
    assert.ok(t.indexOf('\\u26ed tool:') > t.indexOf('executeToolCalls(toolCalls)'), 'after execution');
  });
  test('R4: repeat-announce across turns fires the nudge without a prior tool (source pin)', () => {
    const t = src('src/agent/hexagonal/ChatOrchestratorHelpers.js');
    assert.ok(t.includes('_repeatAnnounce'), 'second ignition condition');
    assert.ok(t.includes('allToolCalls.length > 0 || _repeatAnnounce'), 'either path ignites');
  });
  test('R5: sentinel writer carries early trace + crash/exit hooks (source pin)', () => {
    const t = src('src/agent/foundation/BootRecovery.js');
    assert.ok(t.includes('sentinel-write'), 'trace line at writer');
    assert.ok(t.includes("process.on('exit'"), 'exit hook catches hard exits');
    assert.ok(t.includes('__genesisEarlyHooks'), 'single registration');
  });
  test('R6: family lists take no adjacent duplicates (source pins, both writers)', () => {
    for (const rel of ['src/agent/autonomy/activities/Plan.js', 'src/agent/revolution/AgentLoopObstacles.js']) {
      const t = src(rel);
      assert.ok(/_fam\[_fam\.length - 1\] !== /.test(t), rel);
    }
  });
});
if (require.main === module) run();
