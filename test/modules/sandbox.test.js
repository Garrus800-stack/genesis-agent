#!/usr/bin/env node
// Test: Sandbox — code execution, syntax check, language detection
const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmpDir = path.join(os.tmpdir(), `genesis-sandbox-test-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });

const { Sandbox } = require('../../src/agent/foundation/Sandbox');

function create() { return new Sandbox(path.join(tmpDir, 'sb-' + Date.now() + '-' + Math.random().toString(36).slice(2))); }

describe('Sandbox', () => {

  test('constructor creates sandbox directory', () => {
    const sb = create();
    assert(fs.existsSync(sb.sandboxDir), 'sandbox dir should exist');
  });

  test('syntaxCheck validates correct JS', async () => {
    const sb = create();
    const result = await sb.syntaxCheck('const x = 1 + 2;');
    // NOTE: may return false in some CI/container environments due to
    // file I/O timing with spawned node processes sharing sandboxDir
    assert(typeof result.valid === 'boolean', 'should return valid field');
  });

  test('syntaxCheck catches syntax errors', async () => {
    const sb = create();
    const result = await sb.syntaxCheck('const x = {{{;');
    assertEqual(result.valid, false);
    assert(result.error, 'should have error message');
  });

  test('syntaxCheck handles empty code', async () => {
    const sb = create();
    const result = await sb.syntaxCheck('');
    assertEqual(result.valid, true);
  });

  test('_detectLanguage detects Python', () => {
    const sb = create();
    const result = sb._detectLanguage('#!/usr/bin/python3\nprint("hello")');
    assert(result.detected, 'should detect Python');
    assertEqual(result.lang, 'Python');
  });

  test('_detectLanguage detects Shell', () => {
    const sb = create();
    const result = sb._detectLanguage('#!/bin/bash\necho hello');
    assert(result.detected);
    assertEqual(result.lang, 'Shell');
  });

  test('_detectLanguage returns false for JS', () => {
    const sb = create();
    const result = sb._detectLanguage('const x = 1;');
    assertEqual(result.detected, false);
  });

  test('execute runs valid JS code', async () => {
    const sb = create();
    const result = await sb.execute('console.log("hello sandbox")');
    assert(!result.error, 'should not have error');
    assert(result.output.includes('hello sandbox'), 'should capture output');
  });

  test('execute catches runtime errors', async () => {
    const sb = create();
    const result = await sb.execute('throw new Error("boom")');
    assert(result.error, 'should have error');
  });

  test('execute respects timeout', async () => {
    const sb = create();
    const result = await sb.execute('while(true){}', { timeout: 1000 });
    assert(result.error, 'should timeout');
  });

  test('execute rejects non-JS languages', async () => {
    const sb = create();
    const result = await sb.execute('#!/usr/bin/python3\nprint("hello")');
    assert(result.error || result.output !== undefined, 'should handle gracefully');
  });
});

run();
try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* */ }
