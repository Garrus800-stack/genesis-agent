#!/usr/bin/env node
// v7.7.9 Phase 3b — Bug-fix bundle from Phase 3 burn-in.
//
// Burn-in 2026-05-11 (15h Win run, 309 IdleMind thoughts, 1 organic
// self-message, 9 suppressions in /proactive-status) exposed:
//
//   Bug 1a — abort-return missing `error` field
//     GoalDriver._beginPursuit reads result.error to extract errMsg.
//     _executeLoop's abort path returned summary but not error, so
//     GoalDriver got '' → log "backing off 5s: <empty>".
//
//   Bug 1c — reflection gap on catch + final-verification paths
//     Only _emitFailure (early-return) called reflectOnFailure. A
//     thrown pursuit or a verification-fail emitted agent-loop:complete
//     but skipped plan-failure-reflection entirely.
//
//   Bug 2 — IdleMind novelty pinned at floor
//     thoughtCount counted every tick (incl. goal/research/observe).
//     After ~12 ticks novelty hit its 0.30 floor regardless of how many
//     of those were insight-class. Live: 309 thoughts → novelty stuck at
//     0.30, only 1/9 idle-thoughts passed novFloor 0.65.
//
//   Bug 3 — min-interval too conservative
//     30 min between any two self-messages suppressed 7/8 publishable
//     thoughts in a 28 min window. Daily soft-cap (8) + per-kind floors
//     + score dampener are the real throttles; 10 min reads the data.

'use strict';

const { describe, test, assert, run } = require('../harness');
const fs = require('fs');
const path = require('path');

const PURSUIT_PATH = path.join(__dirname, '..', '..', 'src/agent/revolution/AgentLoopPursuit.js');
const IDLEMIND_PATH = path.join(__dirname, '..', '..', 'src/agent/autonomy/IdleMind.js');
const SETTINGS_PATH = path.join(__dirname, '..', '..', 'src/agent/foundation/Settings.js');

describe('Bug 1a — abort-return includes `error` field for GoalDriver resolve-side', () => {
  test('AgentLoopPursuit abort-return carries both summary and error', () => {
    const src = fs.readFileSync(PURSUIT_PATH, 'utf-8');
    // Find the abort-return block (cancelToken.isCancelled || _aborted)
    const abortBlock = src.match(/_cancelToken\?\.\s*isCancelled\s*\|\|\s*this\._aborted[\s\S]{0,500}?return\s*\{[\s\S]*?steps:\s*this\.executionLog\s*\}/);
    assert(abortBlock, 'expected abort-return block to be present');
    const blockText = abortBlock[0];
    assert(/summary:\s*\w+/.test(blockText),
      'abort-return must include summary field');
    assert(/error:\s*\w+/.test(blockText),
      'abort-return must include error field so GoalDriver._beginPursuit (which reads result.error) sees the reason');
  });

  test('rationale references Phase 3b bug-1a', () => {
    const src = fs.readFileSync(PURSUIT_PATH, 'utf-8');
    assert(/Phase 3b.*bug-1a|bug-1a.*Phase 3b/i.test(src),
      'block must be marked as Phase 3b bug-1a so future readers find the trail');
  });
});

describe('Bug 1c — reflection on catch-path and final-verification-fail-path', () => {
  test('catch-path calls a reflection helper', () => {
    const src = fs.readFileSync(PURSUIT_PATH, 'utf-8');
    // v7.7.9 (post-Phase-3c.4): all reflection sites use reflectIfNeeded.
    const catchBlock = src.match(/\}\s*catch\s*\(\s*err\s*\)\s*\{[\s\S]*?\}\s*\)\s*;\s*\/\/\s*end of CorrelationContext\.run/);
    assert(catchBlock, 'expected catch(err) block to be present');
    assert(/reflectIfNeeded\s*\(/.test(catchBlock[0]) || /reflectOnFailure\s*\(/.test(catchBlock[0]),
      'catch-path must call a reflection helper to close the reflection gap');
  });

  test('final-verification-fail path calls a reflection helper', () => {
    const src = fs.readFileSync(PURSUIT_PATH, 'utf-8');
    // After the agent-loop:complete emit at end of _executeLoop, we
    // expect a guarded reflection call (reflectIfNeeded after refactor).
    assert(/if\s*\(\s*!\s*verification\.success\s*\)\s*\{[\s\S]{0,400}?(reflectIfNeeded|reflectOnFailure)\s*\(/.test(src),
      'final-verification-fail path must call a reflection helper when verification.success===false');
  });

  test('reflection helper is imported from PursuitReflection', () => {
    const src = fs.readFileSync(PURSUIT_PATH, 'utf-8');
    assert(/require\(['"]\.\/AgentLoopPursuitReflection['"]\)/.test(src),
      'AgentLoopPursuitReflection must remain required');
    assert(/reflectIfNeeded|reflectOnFailure/.test(src),
      'reflection helper must be destructured from the require');
  });

  test('rationale references Phase 3b bug-1c', () => {
    const src = fs.readFileSync(PURSUIT_PATH, 'utf-8');
    assert(/Phase 3b.*bug-1c|bug-1c.*Phase 3b|Phase 3b\/c4/i.test(src),
      'reflection-gap fixes must remain marked (Phase 3b bug-1c or Phase 3b/c4)');
  });
});

describe('Bug 2 — IdleMind insightThoughtCount drives novelty (not bare thoughtCount)', () => {
  test('insightThoughtCount field initialised in constructor', () => {
    const src = fs.readFileSync(IDLEMIND_PATH, 'utf-8');
    assert(/this\.insightThoughtCount\s*=\s*0/.test(src),
      'insightThoughtCount must be initialised in constructor');
  });

  test('insightThoughtCount only incremented for INSIGHT_ACTIVITIES', () => {
    const src = fs.readFileSync(IDLEMIND_PATH, 'utf-8');
    // The increment must be guarded by isInsight (INSIGHT_ACTIVITIES check).
    assert(/if\s*\(\s*isInsight\s*\)[\s\S]{0,80}?this\.insightThoughtCount\s*=/.test(src),
      'insightThoughtCount must only increment when isInsight is true');
  });

  test('novelty formula uses insight-derived count, not raw thoughtCount', () => {
    const src = fs.readFileSync(IDLEMIND_PATH, 'utf-8');
    // The novelty = Math.max(0.30, 0.85 - 0.05 * ...) line must NOT use
    // thoughtCount directly inside the decay expression — it must use
    // either insightThoughtCount or a derived noveltyCount.
    const noveltyLine = src.match(/const\s+novelty\s*=\s*Math\.max\([\s\S]{0,200}?\);/);
    assert(noveltyLine, 'novelty assignment must be present');
    const noveltyText = noveltyLine[0];
    assert(!/0\.05\s*\*\s*Math\.max\(0,\s*\(this\.thoughtCount/.test(noveltyText),
      'novelty must not directly use this.thoughtCount in decay (pre-fix shape)');
    assert(/noveltyCount|insightThoughtCount/.test(noveltyText),
      'novelty must use noveltyCount or insightThoughtCount');
  });

  test('Phase 3b rationale comment present', () => {
    const src = fs.readFileSync(IDLEMIND_PATH, 'utf-8');
    assert(/Phase 3b/i.test(src),
      'IdleMind must carry Phase 3b annotation explaining the insight-only counter');
  });
});

describe('Bug 3 — proactive.minIntervalMs reduced to 10 min', () => {
  test('Settings default minIntervalMs is 10 * 60 * 1000 (not 30 * 60 * 1000)', () => {
    const src = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    // Find the proactive block and the minIntervalMs key inside.
    const proactiveBlock = src.match(/proactive:\s*\{[\s\S]*?\n\s+\}/);
    assert(proactiveBlock, 'expected proactive settings block');
    assert(/minIntervalMs:\s*10\s*\*\s*60\s*\*\s*1000/.test(proactiveBlock[0]),
      'minIntervalMs must default to 10 * 60 * 1000 ms (10 min)');
    assert(!/minIntervalMs:\s*30\s*\*\s*60\s*\*\s*1000/.test(proactiveBlock[0]),
      'old 30-min value must no longer be the default');
  });

  test('clamp range still validates (≥ 30s ≤ 24h)', () => {
    const src = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    // The clamp() call enforces the range. We do not change it — verify
    // the boundaries are intact (30s..24h) so user can still set lower
    // or higher if they want.
    assert(/clamp\(['"]proactive\.minIntervalMs['"]\s*,\s*30\s*\*\s*1000\s*,\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000\)/.test(src),
      'clamp range for minIntervalMs must remain 30s..24h');
  });

  test('rationale comment notes Phase 3b burn-in data', () => {
    const src = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    assert(/Phase 3b/.test(src),
      'minIntervalMs line must reference Phase 3b reason for the change');
  });
});

describe('Phase 3b — overall regression invariants', () => {
  test('AgentLoopPursuit.js stays under 700 LOC after Phase 3b additions', () => {
    const src = fs.readFileSync(PURSUIT_PATH, 'utf-8');
    const loc = src.split('\n').length;
    assert(loc < 700,
      `AgentLoopPursuit.js has ${loc} LOC — must stay under 700 (File-Size-Guard threshold).`);
  });

  test('no duplicate agent-loop:complete emit added (single emit per failure path)', () => {
    const src = fs.readFileSync(PURSUIT_PATH, 'utf-8');
    // The catch-path still has exactly one bus.fire('agent-loop:complete') —
    // we added reflection AFTER it, not a second emit.
    const catchBlock = src.match(/\}\s*catch\s*\(\s*err\s*\)\s*\{[\s\S]*?return\s*\{\s*success:\s*false,\s*error:\s*err\.message/);
    assert(catchBlock, 'expected catch block to be parseable');
    const emitCount = (catchBlock[0].match(/bus\.fire\(['"]agent-loop:complete['"]/g) || []).length;
    assert(emitCount === 1,
      `catch-path must emit agent-loop:complete exactly once (found ${emitCount})`);
  });

  test('reflection call sites cover all failure paths', () => {
    const src = fs.readFileSync(PURSUIT_PATH, 'utf-8');
    // v7.7.9 (post-Phase-3c.4): reflection sites use reflectIfNeeded
    // (centralised). Services dict + dedup live in the helper.
    const calls = src.match(/reflectIfNeeded\([^)]*\)/g) || [];
    assert(calls.length >= 4,
      `expected at least 4 reflectIfNeeded calls (early-emit, timeout, return-path, catch, verify); found ${calls.length}`);
  });
});

run();
