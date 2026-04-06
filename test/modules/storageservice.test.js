#!/usr/bin/env node
// Test: StorageService — file-based JSON/text storage with caching
const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmpDir = path.join(os.tmpdir(), `genesis-storage-test-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });

const { StorageService } = require('../../src/agent/foundation/StorageService');

function create() { return new StorageService(tmpDir); }

describe('StorageService', () => {

  test('constructor creates base directory', () => {
    const dir = path.join(tmpDir, 'sub');
    const s = new StorageService(dir);
    assert(fs.existsSync(dir), 'should create dir');
  });

  test('writeJSON + readJSON roundtrip', () => {
    const s = create();
    s.writeJSON('test1.json', { hello: 'world', n: 42 });
    const data = s.readJSON('test1.json');
    assertEqual(data.hello, 'world');
    assertEqual(data.n, 42);
  });

  test('readJSON returns default for missing file', () => {
    const s = create();
    const data = s.readJSON('missing.json', { fallback: true });
    assertEqual(data.fallback, true);
  });

  test('readJSON returns null default for missing file', () => {
    const s = create();
    assertEqual(s.readJSON('missing2.json'), null);
  });

  test('writeText + readText roundtrip', () => {
    const s = create();
    s.writeText('test.txt', 'hello world');
    assertEqual(s.readText('test.txt'), 'hello world');
  });

  test('readText returns default for missing file', () => {
    const s = create();
    assertEqual(s.readText('missing.txt', 'fallback'), 'fallback');
  });

  test('appendText appends content', () => {
    const s = create();
    s.writeText('append.txt', 'line1\n');
    s.appendText('append.txt', 'line2\n');
    const content = s.readText('append.txt');
    assert(content.includes('line1'), 'should contain line1');
    assert(content.includes('line2'), 'should contain line2');
  });

  test('writeJSON creates subdirectories', () => {
    const s = create();
    s.writeJSON('deep/nested/data.json', { ok: true });
    const data = s.readJSON('deep/nested/data.json');
    assertEqual(data.ok, true);
  });

  test('readJSON caches results', () => {
    const s = create();
    s.writeJSON('cached.json', { v: 1 });
    const a = s.readJSON('cached.json');
    // Modify file directly
    fs.writeFileSync(path.join(tmpDir, 'cached.json'), '{"v":2}');
    // Should return cached value (within TTL)
    const b = s.readJSON('cached.json');
    assertEqual(b.v, 1); // cached
  });

  test('async writeJSON + readJSON', async () => {
    const s = create();
    await s.writeJSONAsync('async.json', { async: true });
    const data = await s.readJSONAsync('async.json');
    assertEqual(data.async, true);
  });

  test('async readJSON returns default for missing', async () => {
    const s = create();
    const data = await s.readJSONAsync('missing-async.json', { d: 1 });
    assertEqual(data.d, 1);
  });

  test('async writeText + readText', async () => {
    const s = create();
    await s.writeTextAsync('async.txt', 'async content');
    const text = await s.readTextAsync('async.txt');
    assertEqual(text, 'async content');
  });

  test('path traversal is rejected', () => {
    const s = create();
    let threw = false;
    try { s.readJSON('../../../etc/passwd'); } catch { threw = true; }
    assert(threw, 'should reject path traversal');
  });

  test('writeJSON overwrites existing file', () => {
    const s = create();
    s.writeJSON('overwrite.json', { v: 1 });
    s.writeJSON('overwrite.json', { v: 2 });
    assertEqual(s.readJSON('overwrite.json').v, 2);
  });
});

run();
try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* */ }
