#!/usr/bin/env node
// ============================================================
// GENESIS — test/modules/v7914-causal-comment-and-dashboard.contract.test.js
//
// v7.9.14 (1a + 1b): comment honesty and dashboard visibility for
// the CausalAnnotation → LessonsStore → SymbolicResolver → IdleMind
// behaviour chain that has existed since v7.9.7 P7.
//
// (1a) The pre-v7.9.14 comment claimed "fired causal:promoted into
// the void with no subscriber" — historically correct for the bus
// event but misleading because it ignored the synchronous lesson
// write twelve lines below. That half-truth fooled a roadmap audit
// into planning a re-implementation of a function already complete.
// This test guards the corrected comment: no more "into the void",
// and the new wording must name SymbolicResolver AND IdleMind AND
// the shared string contract AND the synchronous design rationale.
//
// (1b) CausalAnnotation now has a getReport() method following the
// Frontier convention. AgentCoreHealth wires it as
// organism.causalSuspicion, OrganismRenderers shows it as a
// "🎯 Causal: ..." dashboard line — distinct from the v7.1.6
// suspicionFrontier (novelty-based, ⚠) one line above.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const CAUSAL_SRC = fs.readFileSync(path.join(ROOT, 'src/agent/cognitive/CausalAnnotation.js'), 'utf8');
const HEALTH_SRC = fs.readFileSync(path.join(ROOT, 'src/agent/AgentCoreHealth.js'), 'utf8');
const RENDER_SRC = fs.readFileSync(path.join(ROOT, 'src/ui/renderers/OrganismRenderers.js'), 'utf8');

const { CausalAnnotation } = require(path.join(ROOT, 'src/agent/cognitive/CausalAnnotation'));

describe('v7.9.14 (1a) — comment honesty in CausalAnnotation', () => {

  test('the misleading "into the void" wording is gone', () => {
    assert(!/into the void/i.test(CAUSAL_SRC),
      'CausalAnnotation must not claim "into the void" anymore (pre-v7.9.14 wording that triggered a wrong audit)');
  });

  test('the new comment names SymbolicResolver as a consumer of the lesson', () => {
    assert(/SymbolicResolver/.test(CAUSAL_SRC),
      'comment must reference SymbolicResolver — that is where the lesson filter lives (Z356-359)');
  });

  test('the new comment names IdleMind as a consumer of the self-message', () => {
    assert(/IdleMind/.test(CAUSAL_SRC),
      'comment must reference IdleMind — that is where the goal-token cooldown lives (Z190-215)');
  });

  test('the shared string contract is named in the comment', () => {
    assert(/plan-failure-reflection/.test(CAUSAL_SRC),
      "comment must contain the source-marker string 'plan-failure-reflection' so the next reader sees the contract that links the three modules");
    assert(/causal-suspicion/.test(CAUSAL_SRC),
      "comment must contain the classification 'causal-suspicion'");
  });

  test('the synchronous-write rationale is documented', () => {
    // Why the lesson write is synchronous, not bus-driven: prevents a
    // refactor "just fire the event and let a listener record" that
    // would silently break the loop. The rationale must be in the
    // comment, not just inferable.
    assert(/synchronous|synchron/i.test(CAUSAL_SRC),
      'comment must explain WHY the lesson write is synchronous (so the consequence is in place before the promotion call returns)');
  });

});

describe('v7.9.14 (1b) — getReport() for dashboard', () => {

  test('getReport exists and follows the Frontier shape', () => {
    const ca = new CausalAnnotation({});
    assert(typeof ca.getReport === 'function', 'getReport must exist');
    const r = ca.getReport();
    assert(r && typeof r === 'object', 'getReport must return an object');
    assert('dashboardLine' in r && 'count' in r && 'topSuspect' in r,
      'getReport must return { dashboardLine, count, topSuspect }');
  });

  test('empty state: no promoted actions → empty dashboardLine', () => {
    const ca = new CausalAnnotation({});
    const r = ca.getReport();
    assertEqual(r.dashboardLine, '', 'dashboardLine must be empty when nothing is promoted');
    assertEqual(r.count, 0, 'count must be 0');
    assertEqual(r.topSuspect, null, 'topSuspect must be null');
  });

  test('single promoted action: no "N suspect actions" prefix', () => {
    const ca = new CausalAnnotation({});
    ca._suspicion.set('fs.unlink', { failCount: 8, successCount: 1, observations: 9, lastSeen: Date.now() });
    ca._promoted.add('fs.unlink');
    const r = ca.getReport();
    assertEqual(r.count, 1);
    assertEqual(r.dashboardLine, 'fs.unlink (89%/9)',
      'single action must render without prefix — natural reading');
    assertEqual(r.topSuspect.action, 'fs.unlink');
  });

  test('multiple actions: prefix + top 3, sorted by suspicion desc', () => {
    const ca = new CausalAnnotation({});
    ca._suspicion.set('low',  { failCount: 1, successCount: 2, observations: 3, lastSeen: Date.now() });
    ca._suspicion.set('high', { failCount: 9, successCount: 1, observations: 10, lastSeen: Date.now() });
    ca._suspicion.set('mid',  { failCount: 6, successCount: 4, observations: 10, lastSeen: Date.now() });
    ca._promoted.add('low');
    ca._promoted.add('high');
    ca._promoted.add('mid');
    const r = ca.getReport();
    assertEqual(r.count, 3);
    // High first (90%), mid second (60%), low last (33%)
    assert(r.dashboardLine.startsWith('3 suspect actions — high (90%/10), mid (60%/10), low'),
      `expected high→mid→low order, got: ${r.dashboardLine}`);
    assertEqual(r.topSuspect.action, 'high');
  });

  test('more than 3: top 3 with "+N more" suffix', () => {
    const ca = new CausalAnnotation({});
    for (let i = 0; i < 5; i++) {
      const key = `act${i}`;
      // Decreasing suspicion: act0 90%, act1 80%, act2 70%, act3 60%, act4 50%
      const fails = 9 - i;
      const ok = 1 + i;
      ca._suspicion.set(key, { failCount: fails, successCount: ok, observations: 10, lastSeen: Date.now() });
      ca._promoted.add(key);
    }
    const r = ca.getReport();
    assertEqual(r.count, 5);
    assert(r.dashboardLine.includes('+2 more'),
      `must show "+2 more" when 5 promoted, got: ${r.dashboardLine}`);
    // Top 3 are act0, act1, act2 — act3 and act4 are hidden behind +2 more
    assert(r.dashboardLine.includes('act0') && r.dashboardLine.includes('act1') && r.dashboardLine.includes('act2'),
      'top 3 must appear by name');
    assert(!r.dashboardLine.includes('act3') && !r.dashboardLine.includes('act4'),
      'beyond top 3 must NOT appear by name — only "+N more"');
  });

  test('tie-breaker: equal suspicion → higher observation count first', () => {
    const ca = new CausalAnnotation({});
    // Both 50% suspicion, but one has more observations
    ca._suspicion.set('fewer', { failCount: 1, successCount: 1, observations: 2,  lastSeen: Date.now() });
    ca._suspicion.set('more',  { failCount: 5, successCount: 5, observations: 10, lastSeen: Date.now() });
    ca._promoted.add('fewer');
    ca._promoted.add('more');
    const r = ca.getReport();
    // "more" first because more observations = more reliable signal
    assert(r.dashboardLine.indexOf('more') < r.dashboardLine.indexOf('fewer'),
      `tie should be broken by observation count desc, got: ${r.dashboardLine}`);
  });

  test('only promoted actions count, not all observations', () => {
    // Critical: dashboard surfaces what crossed the threshold, not noise
    const ca = new CausalAnnotation({});
    ca._suspicion.set('promoted',     { failCount: 8, successCount: 1, observations: 9, lastSeen: Date.now() });
    ca._suspicion.set('not-promoted', { failCount: 5, successCount: 5, observations: 10, lastSeen: Date.now() });
    ca._promoted.add('promoted'); // only this one is in the promoted set
    const r = ca.getReport();
    assertEqual(r.count, 1, 'count must reflect promoted set only');
    assert(r.dashboardLine.includes('promoted') && !r.dashboardLine.includes('not-promoted'),
      'only promoted action must appear');
  });

});

describe('v7.9.14 (1b) — dashboard wiring', () => {

  test('AgentCoreHealth wires causalSuspicion into the organism block', () => {
    assert(/causalSuspicion:\s*safe\('causalAnnotation',\s*ca\s*=>\s*ca\.getReport\(\)\)/.test(HEALTH_SRC),
      'AgentCoreHealth must wire organism.causalSuspicion via safe(causalAnnotation, getReport)');
  });

  test('OrganismRenderers renders the causalSuspicion dashboard line', () => {
    assert(/organism\.causalSuspicion\?\.dashboardLine/.test(RENDER_SRC),
      'OrganismRenderers must read organism.causalSuspicion.dashboardLine');
    assert(/Causal:\s/.test(RENDER_SRC),
      'render line must label the new element as "Causal: " — distinct from the ⚠ Novelty suspicionFrontier');
  });

  test('the Causal line is rendered AFTER the lessonFrontier line', () => {
    // Position matters: keeps the visual grouping (frontier reports together)
    const lessonIdx = RENDER_SRC.indexOf('lessonFrontier?.dashboardLine');
    const causalIdx = RENDER_SRC.indexOf('causalSuspicion?.dashboardLine');
    assert(lessonIdx > 0 && causalIdx > 0, 'both lines must exist');
    assert(causalIdx > lessonIdx,
      'causalSuspicion line must come after lessonFrontier line');
  });

  test('the new line uses a different icon than the novelty suspicionFrontier', () => {
    // suspicionFrontier (v7.1.6, novelty) uses ⚠ (\u26a0). The new
    // causalSuspicion line must use a different glyph so the two
    // are visually distinguishable in the dashboard.
    const renderLines = RENDER_SRC.split('\n').filter(l => l.includes('dashboardLine'));
    const noveltyLine = renderLines.find(l => l.includes('suspicionFrontier'));
    const causalLine  = renderLines.find(l => l.includes('causalSuspicion'));
    assert(noveltyLine && causalLine, 'both render lines must exist');
    assert(noveltyLine.includes('\\u26a0'), 'novelty line must keep its ⚠ icon');
    assert(!causalLine.includes('\\u26a0'), 'causal line must NOT reuse the ⚠ icon (would cause visual confusion)');
  });

});

if (require.main === module) run();
