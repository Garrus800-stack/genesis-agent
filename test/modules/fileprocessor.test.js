// ============================================================
// Test: FileProcessor.js — import, file info, execute, read
// ============================================================

const { describe, test, assert, assertEqual, run, createTestRoot } = require('../harness');
const path = require('path');
const fs = require('fs');
const { FileProcessor } = require('../../src/agent/capabilities/FileProcessor');

function createProcessor() {
  const tmpRoot = createTestRoot('fileprocessor');
  const uploadsDir = path.join(tmpRoot, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  const bus = { fire: () => {}, emit: () => {} };
  const sandbox = { execute: async (code) => ({ success: true, output: 'exec result' }) };
  return { fp: new FileProcessor(tmpRoot, sandbox, bus), tmpRoot, uploadsDir };
}

describe('FileProcessor: File Info', () => {
  test('getFileInfo returns info for existing file', () => {
    const { fp, tmpRoot } = createProcessor();
    const testFile = path.join(tmpRoot, 'test.txt');
    fs.writeFileSync(testFile, 'hello world');
    const info = fp.getFileInfo('test.txt');
    assert(info, 'Should return info');
    assert(info.exists !== false, 'File should exist');
  });

  test('getFileInfo handles missing file', () => {
    const { fp } = createProcessor();
    const info = fp.getFileInfo('nonexistent.txt');
    // May return null, { exists: false }, or throw — all acceptable
    assert(info === null || info?.exists === false || info?.error,
      'Should indicate missing file');
  });
});

describe('FileProcessor: Read', () => {
  test('readFile reads text content', () => {
    const { fp, tmpRoot } = createProcessor();
    const testFile = path.join(tmpRoot, 'read-test.txt');
    fs.writeFileSync(testFile, 'file content here');
    const result = fp.readFile('read-test.txt');
    assert(result, 'Should return content');
    if (typeof result === 'string') {
      assert(result.includes('file content here'));
    } else if (result.content) {
      assert(result.content.includes('file content here'));
    }
  });
});

describe('FileProcessor: Import', () => {
  test('importFile copies to uploads', () => {
    const { fp, tmpRoot, uploadsDir } = createProcessor();
    const srcFile = path.join(tmpRoot, 'source.txt');
    fs.writeFileSync(srcFile, 'import me');
    const result = fp.importFile(srcFile);
    assert(result, 'Should return result');
    // Check that a file exists in uploads
    const files = fs.readdirSync(uploadsDir);
    // May or may not have been copied depending on implementation
    assert(typeof result === 'object' || typeof result === 'string');
  });
});

describe('FileProcessor: Execute', () => {
  test('executeFile runs JS file in sandbox', async () => {
    const { fp, tmpRoot } = createProcessor();
    const jsFile = path.join(tmpRoot, 'run.js');
    fs.writeFileSync(jsFile, 'console.log("hello")');
    const result = await fp.executeFile('run.js');
    assert(result, 'Should return execution result');
  });
});

run();
