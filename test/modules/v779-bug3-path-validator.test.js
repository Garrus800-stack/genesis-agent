#!/usr/bin/env node
// v7.7.9 Phase 3 — Bug 3 regression test
//
// Live-Befund (Garrus, 2026-05-10): step blocked — missing resources:
//   file:logs\self-statement.log
// The path "logs\self-statement.log" does not exist in the codebase
// (correct path is .genesis/self-statement-log/). The LLM hallucinated.
// Without intervention, the goal blocked forever, waiting for a resource
// that would never appear.
//
// Fix: in AgentLoopSteps._executeStep, before returning blocked=true,
// run _filterImplausibleFilePaths on missing tokens. If ALL missing
// tokens are implausible file:-paths, fail the step instead of blocking.
// The reflection path then triggers normally.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { describe, test, assert, assertEqual, run } = require('../harness');
const { _filterImplausibleFilePaths } = require('../../src/agent/revolution/PathPlausibility');

describe('_filterImplausibleFilePaths — empty / invalid input', () => {
  test('empty array → empty array', () => {
    assertEqual(_filterImplausibleFilePaths([], '/some/root').length, 0);
  });
  test('non-array → empty array', () => {
    assertEqual(_filterImplausibleFilePaths(null, '/some/root').length, 0);
    assertEqual(_filterImplausibleFilePaths(undefined, '/some/root').length, 0);
  });
  test('non-file: tokens are ignored (not flagged implausible)', () => {
    const r = _filterImplausibleFilePaths(['skill:foo', 'tool:bar', 'service:baz'], '/some/root');
    assertEqual(r.length, 0);
  });
});

describe('_filterImplausibleFilePaths — relative paths', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-test-'));

  test('relative path whose parent does not exist → implausible', () => {
    // tmpDir exists but tmpDir/nonexistent does not
    const r = _filterImplausibleFilePaths(
      ['file:nonexistent/file.log'],
      tmpDir
    );
    assertEqual(r.length, 1, 'should flag implausible');
    assertEqual(r[0], 'file:nonexistent/file.log');
  });

  test('relative path whose parent exists → plausible (could be created)', () => {
    // tmpDir exists
    const r = _filterImplausibleFilePaths(
      ['file:newfile.txt'],  // parent = tmpDir itself, exists
      tmpDir
    );
    assertEqual(r.length, 0, 'should NOT flag — step can legitimately create');
  });

  test('the exact live bug: file:logs/self-statement.log → implausible (no logs/ exists)', () => {
    // Use a real path where we know logs/ doesn't exist
    const r = _filterImplausibleFilePaths(
      ['file:logs/self-statement.log'],
      tmpDir
    );
    assertEqual(r.length, 1, 'logs/ does not exist → should be implausible');
  });

  test('windows-style separators are normalized', () => {
    const r = _filterImplausibleFilePaths(
      ['file:logs\\self-statement.log'],
      tmpDir
    );
    assertEqual(r.length, 1, 'should handle backslash paths');
  });

  // Cleanup
  test('cleanup tmpDir', () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    assert(!fs.existsSync(tmpDir));
  });
});

describe('_filterImplausibleFilePaths — existing files', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-test-'));
  // Create a real file inside tmpDir
  const realFile = path.join(tmpDir, 'real.txt');
  fs.writeFileSync(realFile, 'hello');

  test('existing absolute path → plausible', () => {
    const r = _filterImplausibleFilePaths(
      [`file:${realFile}`],
      tmpDir
    );
    assertEqual(r.length, 0, 'existing path must be plausible');
  });

  test('existing relative path → plausible', () => {
    const r = _filterImplausibleFilePaths(
      ['file:real.txt'],
      tmpDir
    );
    assertEqual(r.length, 0, 'existing relative path must be plausible');
  });

  test('cleanup', () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    assert(!fs.existsSync(tmpDir));
  });
});

describe('_filterImplausibleFilePaths — absolute paths outside scope', () => {
  test('absolute random path → implausible', () => {
    const r = _filterImplausibleFilePaths(
      ['file:/etc/nonexistent/xyz.txt'],
      '/some/genesis/root'
    );
    // Path doesn't exist AND is outside root, tmp, home
    assertEqual(r.length, 1);
  });

  test('absolute path inside rootDir → plausible (if parent exists)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-test-'));
    const insidePath = path.join(tmpDir, 'sub', 'file.log');
    // Parent (sub/) does NOT exist — so this is implausible even though
    // the absolute path is "within root" structurally. The function checks
    // parent existence for relative paths but for absolute we only check
    // root containment + file existence.
    const r = _filterImplausibleFilePaths(
      [`file:${insidePath}`],
      tmpDir
    );
    // Absolute, file doesn't exist, but inside rootDir → plausible
    // (the step can create it within its own scope)
    assertEqual(r.length, 0, 'absolute path inside rootDir is plausible');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('absolute path in tmpdir → plausible', () => {
    const r = _filterImplausibleFilePaths(
      [`file:${path.join(os.tmpdir(), 'genesis-scratch-xyz.json')}`],
      '/some/other/root'
    );
    assertEqual(r.length, 0, 'tmp paths are always plausible');
  });
});

describe('AgentLoopSteps integration — implausible paths fail not block', () => {
  test('source: failure-return is used when ALL missing tokens are implausible', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src/agent/revolution/AgentLoopSteps.js'),
      'utf-8',
    );
    // The fix must (a) call _filterImplausibleFilePaths, (b) when
    // ALL missing are implausible, return WITHOUT blocked=true.
    assert(/_filterImplausibleFilePaths\(/.test(src),
      'AgentLoopSteps must call _filterImplausibleFilePaths');
    assert(/implausiblePaths\.length\s*===\s*check\.missing\.length/.test(src),
      'AgentLoopSteps must check that ALL missing are implausible before failing');
    assert(/Plausibility check failed for:/.test(src),
      'failure message must be informative');
  });

  test('source: blocked branch preserved when at least one resource is plausible', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src/agent/revolution/AgentLoopSteps.js'),
      'utf-8',
    );
    // Block-fallthrough must still be intact — we don't want to break
    // legitimate resource-waits.
    assert(/blocked:\s*true/.test(src),
      'blocked=true return path must still exist');
    assert(/blockedByResources:\s*check\.missing/.test(src),
      'blockedByResources must still be set in block path');
  });
});

run();
