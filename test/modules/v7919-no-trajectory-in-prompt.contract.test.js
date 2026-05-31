#!/usr/bin/env node
// ============================================================
// GENESIS — test/modules/v7919-no-trajectory-in-prompt.contract.test.js
//
// v7.9.19 — pins the architectural property documented in
// docs/ONTOGENESIS.md ("Expectations do not belong in the runtime
// prompt"): the trajectory / calibration / directions files are read
// ONLY by their owning services, and never by a prompt-building
// module. This is the real guard — the prose explains why, the test
// makes it impossible to erode unnoticed.
//
// Mechanism: scan every .js under src/ for a literal reference to any
// of the trajectory-family data filenames. The set of files that
// reference them must be exactly the owning trio. A new reader — in
// particular any prompt-builder — breaks this test and forces a
// conscious decision rather than a silent regression.
// ============================================================

'use strict';

const { describe, test, assert, assertDeepEqual, run } = require('../harness');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

// The trajectory-family data files (self-observation data — must stay
// out of the generation substrate).
const TRAJECTORY_FILE_RE =
  /self-trajectory(\.jsonl|\.draft\.json|-events\.jsonl|-directions\.jsonl|-calibration\.jsonl)/;

// The only modules allowed to reference those files: the data owners
// (writer/reader services), reached for review, scoring, and counting.
// No prompt-builder is on this list — that is the whole point.
const ALLOWED = [
  'src/agent/cognitive/EventCounter.js',
  'src/agent/cognitive/SelfTrajectory.js',
  'src/agent/cognitive/TrajectoryCalibration.js',
].sort();

// A non-exhaustive denylist of known runtime-prompt builders. None of
// these may reference the trajectory files. Explicit so the failure is
// self-explaining if one ever does.
const PROMPT_BUILDERS = [
  'src/agent/intelligence/PromptBuilderSections.js',
  'src/agent/intelligence/PromptBuilderSectionsAwareness.js',
  'src/agent/cognitive/CognitiveSelfModel.js',
  'src/agent/cognitive/ContextCollector.js',
  'src/agent/intelligence/ContextManager.js',
  'src/agent/intelligence/ReasoningEngine.js',
  'src/agent/hexagonal/ChatOrchestrator.js',
  'src/agent/hexagonal/ChatOrchestratorHelpers.js',
];

function jsFilesUnder(dir) {
  return fs.readdirSync(dir, { recursive: true })
    .map(p => String(p).replace(/\\/g, '/'))
    .filter(p => p.endsWith('.js'));
}

function matchingFiles() {
  const out = [];
  for (const rel of jsFilesUnder(SRC)) {
    const abs = path.join(SRC, rel);
    let stat;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (!stat.isFile()) continue;
    const text = fs.readFileSync(abs, 'utf8');
    if (TRAJECTORY_FILE_RE.test(text)) out.push('src/' + rel);
  }
  return out.sort();
}

describe('v7.9.19 — no prompt-builder reads the trajectory files (contract)', () => {
  test('exactly the owning trio references the trajectory-family filenames', () => {
    assertDeepEqual(matchingFiles(), ALLOWED,
      'only EventCounter / SelfTrajectory / TrajectoryCalibration may read these files');
  });

  test('no known prompt-builder references the trajectory files', () => {
    const matches = new Set(matchingFiles());
    for (const pb of PROMPT_BUILDERS) {
      // Several prompt-builders may not exist under this exact path over
      // time; the contract is only meaningful for the ones that do.
      const exists = fs.existsSync(path.join(ROOT, pb));
      assert(!matches.has(pb),
        `prompt-builder ${pb} must not read the trajectory files${exists ? '' : ' (also: path not found)'}`);
    }
  });

  test('the SelfTrajectory draft-generation prompt is the sanctioned reader, not a runtime-prompt leak', () => {
    // SelfTrajectory itself composes the draft-generation prompt (the
    // self-trajectory-review context). That is the allowed look-back
    // path, not the runtime chat prompt. Asserted here so the trio
    // membership of SelfTrajectory reads as intentional.
    assert(ALLOWED.includes('src/agent/cognitive/SelfTrajectory.js'),
      'SelfTrajectory is an allowed reader (review context, not runtime prompt)');
  });
});

if (require.main === module) run();
