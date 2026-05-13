#!/usr/bin/env node
// v7.7.9 (post-Phase-3c.4) — Lessons-pipeline closes early-return paths
//
// Before this fix: Three reflectOnFailure call sites existed in
// AgentLoopPursuit (early-emit, catch-block, final-verification-fail).
// None of them ran when _executeLoop short-circuited via:
//   - _aborted=true (global timeout)
//   - aborted=true (cancel token)
//   - blocked=true (step pre-existence check)
//   - step-limit user-stop
//
// Live evidence: in a 13h burn-in with four plan failures (timeout,
// step blocked, watchdog stalled, repeat) the lessons store ended
// with zero obstacle-resolution lessons even though Phase-3c.2 wired
// the write side correctly. The pipeline was reachable in tests but
// not in the live abort paths.
//
// Two-part fix:
//   1. The global-timeout handler now calls reflectOnFailure inline
//      so a timed-out goal produces a lesson immediately.
//   2. The pursue() return path inspects result.success and the
//      _reflected dedup flag; if the loop returned a failure result
//      and reflection has not yet fired (timeout already covered),
//      reflectOnFailure runs with a synthesized errorMessage that
//      covers blocked-on-resources, generic aborts, and step-limit
//      stops.
//
// All four pre-existing call sites set _reflected=true after
// invocation so the post-return path stays silent and double-records
// cannot occur.

'use strict';

const path = require('path');
const fs = require('fs');
const { describe, test, assert, run } = require('../harness');

const PURSUIT_PATH = path.join(__dirname, '..', '..', 'src/agent/revolution/AgentLoopPursuit.js');
const src = fs.readFileSync(PURSUIT_PATH, 'utf-8');

describe('AgentLoopPursuit — early-return paths reach reflectOnFailure', () => {
  test('global-timeout handler invokes a reflect helper', () => {
    // Anchor: the timeout handler block must contain a reflection call
    // (reflectIfNeeded after v7.7.9 post-Phase-3c.4 refactor).
    const startIdx = src.indexOf('Global timeout (${TIMEOUTS.AGENT_LOOP_GLOBAL}ms) reached');
    assert(startIdx > 0, 'timeout-handler anchor must be present');
    const slice = src.slice(startIdx, startIdx + 2000);
    assert(slice.includes('reflectIfNeeded(') || slice.includes('reflectOnFailure('),
      'timeout-handler must call a reflection helper — without it, every timed-out goal silently drops the obstacle-resolution lesson');
  });

  test('return-path after _executeLoop reflects on failure via reflectIfNeeded', () => {
    // v7.7.9 (post-Phase-3c.4) refactor: the dedup _reflected check
    // moved into the reflectIfNeeded helper, so the return-path branch
    // is now a plain `if (!result.success)` followed by reflectIfNeeded.
    const branchIdx = src.search(/if\s*\(\s*!\s*result\.success\s*\)/);
    assert(branchIdx > 0,
      'return-path must guard reflection with !result.success');
    const branchSlice = src.slice(branchIdx, branchIdx + 1000);
    assert(branchSlice.includes('reflectIfNeeded('),
      'return-path branch must call reflectIfNeeded');
  });

  test('blocked-on-resources path produces a non-empty errorMessage', () => {
    // Source of the synthesized errorMessage moved to
    // composeFailureMessage in AgentLoopPursuitReflection (v7.7.9
    // post-Phase-3c.4 refactor). Without it, recordReflection sees empty
    // errorMessage, classifyFailure returns 'unclassified', and the
    // stableClass gate drops the lesson.
    const reflPath = path.join(__dirname, '..', '..', 'src/agent/revolution/AgentLoopPursuitReflection.js');
    const reflSrc = fs.readFileSync(reflPath, 'utf-8');
    assert(reflSrc.includes('Blocked on missing resources:'),
      'composeFailureMessage helper must synthesize errorMessage from blockedByResources');
  });

  test('all five failure paths reach a reflection helper', () => {
    // v7.7.9 (post-Phase-3c.4): five failure paths (early-emit,
    // timeout-handler, return-path, catch-block, verification-fail)
    // each call reflectIfNeeded. The helper handles dedup via _reflected
    // internally, so call sites no longer set the flag themselves.
    const reflectCount = (src.match(/reflectIfNeeded\s*\(/g) || []).length;
    assert(reflectCount >= 5,
      `expected >=5 reflectIfNeeded call sites, found ${reflectCount}`);
  });

  test('_reflected flag is initialized per pursuit', () => {
    assert(/this\._reflected\s*=\s*false/.test(src),
      '_reflected must be reset to false at the start of each pursue() call');
  });
});

describe('Reflection on the return-path covers known failure shapes', () => {
  test('errorMessage composition is centralised in composeFailureMessage helper', () => {
    // v7.7.9 (post-Phase-3c.4) refactor: the priority order
    // (blocked → result.error → result.summary → synthesized) lives in
    // AgentLoopPursuitReflection.composeFailureMessage, not inline.
    // The return-path branch passes the loop result through the helper.
    const branchIdx = src.search(/if\s*\(\s*!\s*result\.success\s*\)/);
    const branchSlice = src.slice(branchIdx, branchIdx + 1000);
    assert(branchSlice.includes('composeFailureMessage('),
      'return-path branch must call composeFailureMessage(result, stepCount) to build the errorMessage');
  });

  test('composeFailureMessage helper is imported from PursuitReflection', () => {
    assert(/composeFailureMessage[^,)]*\}.*=.*require.*AgentLoopPursuitReflection/.test(src.replace(/\n/g, ' ')),
      'composeFailureMessage must be imported from AgentLoopPursuitReflection');
  });

  test('composeFailureMessage prioritises blocked-on-resources over generic errors', () => {
    const reflPath = path.join(__dirname, '..', '..', 'src/agent/revolution/AgentLoopPursuitReflection.js');
    const reflSrc = fs.readFileSync(reflPath, 'utf-8');
    const helperIdx = reflSrc.indexOf('function composeFailureMessage');
    assert(helperIdx > 0, 'composeFailureMessage helper must be defined in reflection module');
    const helperSlice = reflSrc.slice(helperIdx, helperIdx + 700);
    const blockedIdx = helperSlice.indexOf('result.blocked');
    const genericIdx = helperSlice.indexOf('result.error || result.summary');
    assert(blockedIdx > 0 && genericIdx > blockedIdx,
      'blocked-branch must come before the generic branch in composeFailureMessage so resource-list takes precedence');
  });

  test('composeFailureMessage returns a non-empty fallback', () => {
    // Unit test: load helper and exercise the synthesized-fallback path.
    const { composeFailureMessage } = require(path.join(__dirname, '..', '..', 'src/agent/revolution/AgentLoopPursuitReflection'));
    const result = composeFailureMessage({ success: false }, 7);
    assert(typeof result === 'string' && result.length > 0,
      'composeFailureMessage must never return empty — classifyFailure relies on a non-empty string');
    assert(result.includes('7'),
      'synthesized fallback must reference the step count so classifyFailure can categorise');
  });

  test('composeFailureMessage prefers explicit result.error', () => {
    const { composeFailureMessage } = require(path.join(__dirname, '..', '..', 'src/agent/revolution/AgentLoopPursuitReflection'));
    const result = composeFailureMessage({ success: false, error: 'boom' }, 3);
    assert(result === 'boom',
      `errorMessage must prefer result.error over synthesized fallback (got '${result}')`);
  });

  test('composeFailureMessage handles blocked result', () => {
    const { composeFailureMessage } = require(path.join(__dirname, '..', '..', 'src/agent/revolution/AgentLoopPursuitReflection'));
    const result = composeFailureMessage({ success: false, blocked: true, blockedByResources: ['file:foo.js', 'file:bar.js'] }, 5);
    assert(result.includes('foo.js') && result.includes('bar.js'),
      `blocked branch must list resources (got '${result}')`);
  });
});

run();
