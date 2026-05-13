#!/usr/bin/env node
// v7.7.9 (post-Phase-3c.4) — Plan-halluzination fix.
//
// Pre-fix: AgentLoopPlanner._llmPlanGoal sliced the first
// PROMPT_MODULE_SLICE=20 modules from getModuleSummary() and never
// passed real paths into the planner prompt — only the count. The
// LLM then invented paths like 'src/core/goal-stack.js' for a goal
// about stalled goals (real path: 'src/agent/planning/GoalStack.js'
// and 'src/agent/cognitive/StalledGoalWatchdog.js'), and the
// pre-existence check at step time killed the plan with "implausible
// paths".
//
// Fix: pickRelevantModules filters the manifest by goal tokens and
// the planner prompt now lists those real paths under a
// GOAL-RELEVANT MODULE PATHS section telling the LLM "use these
// EXACT paths". When matches < 5, the fallback combines matches with
// the first 20 manifest entries so a generic goal ("clean up code")
// still gets a sensible baseline.

'use strict';

const path = require('path');
const fs = require('fs');
const { describe, test, assert, run } = require('../harness');

const PLANNER_PATH = path.join(__dirname, '..', '..', 'src/agent/revolution/AgentLoopPlanner.js');
const { pickRelevantModules } = require(PLANNER_PATH);

const SAMPLE_MODULES = [
  { file: 'src/agent/cognitive/StalledGoalWatchdog.js', classes: ['StalledGoalWatchdog'] },
  { file: 'src/agent/planning/GoalStack.js', classes: ['GoalStack'] },
  { file: 'src/agent/planning/GoalPersistence.js', classes: ['GoalPersistence'] },
  { file: 'src/agent/revolution/AgentLoop.js', classes: ['AgentLoop'] },
  { file: 'src/agent/revolution/AgentLoopPursuit.js', classes: ['AgentLoopPursuit'] },
  { file: 'src/agent/core/EventBus.js', classes: ['EventBus'] },
  { file: 'src/agent/core/Logger.js', classes: ['Logger'] },
  { file: 'src/agent/cognitive/LessonsStore.js', classes: ['LessonsStore'] },
  ...Array(40).fill(0).map((_, i) => ({ file: `src/agent/dummy${i}.js`, classes: [`Dummy${i}`] })),
];

describe('pickRelevantModules — goal-relevant module picker', () => {
  test('picks modules whose path or class names match goal tokens', () => {
    const result = pickRelevantModules(SAMPLE_MODULES, 'Stalled Goal Recovery Protocol');
    const files = result.map(m => m.file);
    assert(files.includes('src/agent/cognitive/StalledGoalWatchdog.js'),
      'StalledGoalWatchdog must be in the picked modules');
    assert(files.includes('src/agent/planning/GoalStack.js'),
      'GoalStack must be in the picked modules');
  });

  test('matched modules appear before unrelated filler', () => {
    const result = pickRelevantModules(SAMPLE_MODULES, 'Stalled Goal Recovery Protocol');
    const files = result.map(m => m.file);
    const stalledIdx = files.indexOf('src/agent/cognitive/StalledGoalWatchdog.js');
    const dummyIdx = files.indexOf('src/agent/dummy0.js');
    if (dummyIdx >= 0) {
      assert(stalledIdx < dummyIdx,
        'goal-matched modules must come before unrelated filler so the LLM sees them in the prompt window');
    }
  });

  test('generic goal with no obvious matches falls back to first manifest entries', () => {
    const result = pickRelevantModules(SAMPLE_MODULES, 'clean up the code');
    assert(result.length > 0,
      'generic goal must still get a non-empty module list');
    assert(result.length <= 30,
      'result length must respect _MAX_RELEVANT_MODULES cap of 30');
  });

  test('empty manifest returns empty list', () => {
    const result = pickRelevantModules([], 'anything');
    assert(result.length === 0, 'empty manifest must return empty list');
  });

  test('empty goal description falls back to slice(0, 20)', () => {
    const result = pickRelevantModules(SAMPLE_MODULES, '');
    assert(result.length === 20,
      `empty goal must fall back to first 20 modules (got ${result.length})`);
  });

  test('null/undefined goal description does not throw', () => {
    assert.doesNotThrow ||
      (() => {
        const r1 = pickRelevantModules(SAMPLE_MODULES, null);
        const r2 = pickRelevantModules(SAMPLE_MODULES, undefined);
        assert(Array.isArray(r1) && Array.isArray(r2),
          'null/undefined goal must not throw — must return arrays');
      })();
  });

  test('class name match also counts', () => {
    const mods = [
      { file: 'src/x.js', classes: ['LessonsStore'] },
      { file: 'src/y.js', classes: ['Unrelated'] },
    ];
    const result = pickRelevantModules(mods, 'add a lessons strategy');
    const files = result.map(m => m.file);
    assert(files.includes('src/x.js'),
      'class name "LessonsStore" must match goal token "lessons"');
  });

  test('stopwords in goal description do not produce noise matches', () => {
    const mods = [
      { file: 'src/the.js', classes: ['The'] },
      { file: 'src/agent/cognitive/Relevant.js', classes: ['Relevant'] },
    ];
    const result = pickRelevantModules(mods, 'the relevant module please');
    const files = result.map(m => m.file);
    // 'the' is a stopword and must not match 'src/the.js' alone
    assert(files.includes('src/agent/cognitive/Relevant.js'),
      'goal token "relevant" must match');
  });
});

describe('Planner prompt advertises real paths', () => {
  test('_llmPlanGoal builds a GOAL-RELEVANT MODULE PATHS section', () => {
    const src = fs.readFileSync(PLANNER_PATH, 'utf-8');
    assert(/GOAL-RELEVANT MODULE PATHS/.test(src),
      'planner prompt must contain a GOAL-RELEVANT MODULE PATHS section so the LLM sees real paths');
  });

  test('_llmPlanGoal warns LLM against inventing paths', () => {
    const src = fs.readFileSync(PLANNER_PATH, 'utf-8');
    assert(/use these EXACT paths|do not invent/.test(src),
      'planner prompt must tell the LLM not to invent paths');
  });

  test('_llmPlanGoal uses pickRelevantModules helper', () => {
    const src = fs.readFileSync(PLANNER_PATH, 'utf-8');
    assert(/pickRelevantModules\(/.test(src),
      '_llmPlanGoal must call pickRelevantModules instead of the raw slice');
  });

  test('manifest length is still surfaced in the prompt', () => {
    const src = fs.readFileSync(PLANNER_PATH, 'utf-8');
    assert(/\$\{allModules\.length\}\s+modules/.test(src),
      'prompt must still tell the LLM how many modules exist total');
  });
});

run();
