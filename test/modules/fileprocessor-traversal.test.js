// ============================================================
// TEST: FileProcessor — Path Traversal Guard (F-02 fix)
// ============================================================

const path = require('path');
const fs = require('fs');
const os = require('os');
const { describe, test, assert, assertThrows, run, createTestRoot } = require('../harness');

describe('FileProcessor — Path Traversal (v4.0.0)', () => {
  const rootDir = createTestRoot('fileprocessor');
  const uploadsDir = path.join(rootDir, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'test.js'), '// test', 'utf-8');
  fs.writeFileSync(path.join(uploadsDir, 'upload.txt'), 'upload', 'utf-8');

  // Minimal mock for sandbox
  const mockSandbox = { execute: async () => ({ output: '', error: null }) };
  const { FileProcessor } = require('../../src/agent/capabilities/FileProcessor');
  const fp = new FileProcessor(rootDir, mockSandbox);

  test('resolves relative paths within rootDir', () => {
    const resolved = fp._resolve('test.js');
    assert(resolved.startsWith(rootDir), `Expected ${resolved} to start with ${rootDir}`);
  });

  test('resolves relative paths in uploads', () => {
    const resolved = fp._resolve('uploads/upload.txt');
    assert(resolved.startsWith(rootDir), `Expected ${resolved} to start with ${rootDir}`);
  });

  test('blocks absolute path outside rootDir', () => {
    assertThrows(() => fp._resolve('/etc/passwd'));
  });

  test('blocks absolute path with traversal', () => {
    assertThrows(() => fp._resolve(path.join(rootDir, '..', '..', 'etc', 'passwd')));
  });

  test('blocks absolute path to system directory', () => {
    // Platform-appropriate system path
    const sysPath = process.platform === 'win32'
      ? 'C:\\Windows\\System32\\config\\sam'
      : '/usr/local/bin/something';
    assertThrows(() => fp._resolve(sysPath));
  });

  test('allows path within uploadDir', () => {
    const resolved = fp._resolve(path.join(uploadsDir, 'upload.txt'));
    assert(resolved.includes('upload.txt'));
  });
});

run();
