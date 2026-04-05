#!/usr/bin/env node
// ============================================================
// GENESIS — v4.0.0 Audit Fix Tests
//
// Tests for all security and quality fixes from the v4.0.0 audit:
//   [S-1] WebFetcher DNS-rebinding defense (safeLookup)
//   [S-2] FileProcessor.importFile path validation
//   [S-3] system-info execFileSync migration
//   [S-6] WebFetcher redirect SSRF validation
//   [Q-2] safeJsonParse utility
//   [Q-3] FileProcessor async migration
//   [S-7] SelfModel async git
// ============================================================

const { test, describe, beforeEach } = require('../harness');
const path = require('path');
const fs = require('fs');

// ── [Q-2] safeJsonParse ──────────────────────────────────

describe('safeJsonParse', () => {
  const { safeJsonParse } = require('../../src/agent/core/utils');

  test('parses valid JSON', (t) => {
    const result = safeJsonParse('{"key":"value"}');
    t.deepEqual(result, { key: 'value' });
  });

  test('returns fallback on invalid JSON', (t) => {
    const result = safeJsonParse('not json', { fallback: true });
    t.deepEqual(result, { fallback: true });
  });

  test('returns null fallback by default', (t) => {
    const result = safeJsonParse('broken');
    t.equal(result, null);
  });

  test('returns array fallback', (t) => {
    const result = safeJsonParse('{bad', []);
    t.deepEqual(result, []);
  });

  test('handles null/undefined input', (t) => {
    t.equal(safeJsonParse(null, 'default'), 'default');
    t.equal(safeJsonParse(undefined, 42), 42);
  });

  test('handles empty string', (t) => {
    const result = safeJsonParse('', {});
    t.deepEqual(result, {});
  });

  test('parses valid arrays', (t) => {
    t.deepEqual(safeJsonParse('[1,2,3]'), [1, 2, 3]);
  });

  test('logs source on failure when provided', (t) => {
    const result = safeJsonParse('{bad', null, 'TestModule');
    t.equal(result, null);
  });
});

// ── [S-1] WebFetcher DNS-Pinning ──────────────────────────

describe('WebFetcher SSRF defense', () => {
  const { WebFetcher } = require('../../src/agent/foundation/WebFetcher');
  let fetcher;

  beforeEach(() => {
    fetcher = new WebFetcher({});
  });

  test('_isPrivateIP blocks 127.x.x.x', (t) => {
    t.ok(fetcher._isPrivateIP('127.0.0.1'));
    t.ok(fetcher._isPrivateIP('127.0.0.2'));
  });

  test('_isPrivateIP blocks 10.x.x.x', (t) => {
    t.ok(fetcher._isPrivateIP('10.0.0.1'));
    t.ok(fetcher._isPrivateIP('10.255.255.255'));
  });

  test('_isPrivateIP blocks 192.168.x.x', (t) => {
    t.ok(fetcher._isPrivateIP('192.168.1.1'));
  });

  test('_isPrivateIP blocks 172.16-31.x.x', (t) => {
    t.ok(fetcher._isPrivateIP('172.16.0.1'));
    t.ok(fetcher._isPrivateIP('172.31.255.255'));
  });

  test('_isPrivateIP blocks IPv6 loopback', (t) => {
    t.ok(fetcher._isPrivateIP('::1'));
  });

  test('_isPrivateIP blocks IPv4-mapped loopback', (t) => {
    t.ok(fetcher._isPrivateIP('::ffff:127.0.0.1'));
  });

  test('_isPrivateIP allows public IPs', (t) => {
    t.ok(!fetcher._isPrivateIP('8.8.8.8'));
    t.ok(!fetcher._isPrivateIP('1.1.1.1'));
    t.ok(!fetcher._isPrivateIP('93.184.216.34'));
  });

  test('_safeLookup rejects private resolved IPs', (t) => {
    const dns = require('dns');
    const origLookup = dns.lookup;
    dns.lookup = (h, o, cb) => cb(null, '127.0.0.1', 4);
    fetcher._safeLookup('evil.example.com', {}, (err, addr) => {
      t.ok(err);
      t.ok(err.message.includes('SSRF blocked'));
    });
    dns.lookup = origLookup;
  });

  test('_safeLookup allows public resolved IPs', (t) => {
    const dns = require('dns');
    const origLookup = dns.lookup;
    dns.lookup = (h, o, cb) => cb(null, '93.184.216.34', 4);
    fetcher._safeLookup('example.com', {}, (err, address) => {
      t.ok(!err);
      t.equal(address, '93.184.216.34');
    });
    dns.lookup = origLookup;
  });

  test('_safeLookup rejects IPv4-mapped private', (t) => {
    const dns = require('dns');
    const origLookup = dns.lookup;
    dns.lookup = (h, o, cb) => cb(null, '::ffff:10.0.0.1', 6);
    fetcher._safeLookup('sneaky.example.com', {}, (err) => {
      t.ok(err);
      t.ok(err.message.includes('SSRF'));
    });
    dns.lookup = origLookup;
  });

  // [S-6] Redirect validation
  test('_validateUrl blocks redirect to localhost', (t) => {
    const result = fetcher._validateUrl('http://127.0.0.1:11434/api/tags');
    t.ok(!result.ok);
  });

  test('_validateUrl blocks redirect to 10.x', (t) => {
    const result = fetcher._validateUrl('http://10.0.0.1/internal');
    t.ok(!result.ok);
  });

  test('_validateUrl allows public URLs', (t) => {
    const result = fetcher._validateUrl('https://example.com/page');
    t.ok(result.ok);
    t.ok(result.parsed);
  });

  test('_validateUrl blocks numeric decimal IPs', (t) => {
    const result = fetcher._validateUrl('http://2130706433/');
    t.ok(!result.ok);
  });

  test('_validateUrl blocks hex IPs', (t) => {
    const result = fetcher._validateUrl('http://0x7f000001/');
    t.ok(!result.ok);
  });

  test('_validateUrl blocks non-HTTP protocols', (t) => {
    const result = fetcher._validateUrl('ftp://example.com/file');
    t.ok(!result.ok);
  });

  test('_validateUrl blocks 169.254.x.x link-local', (t) => {
    const result = fetcher._validateUrl('http://169.254.169.254/latest/meta-data/');
    t.ok(!result.ok, 'AWS metadata endpoint must be blocked');
  });
});

// ── [S-2] FileProcessor.importFile path guard ─────────────

describe('FileProcessor importFile path guard', () => {
  const tmpRoot = path.join(__dirname, '..', '..', 'sandbox', '_fp_test_' + Date.now());
  const uploadDir = path.join(tmpRoot, 'uploads');
  const nullBus = { emit: () => {}, fire: () => {}, on: () => () => {} };

  beforeEach(() => {
    if (!fs.existsSync(tmpRoot)) fs.mkdirSync(tmpRoot, { recursive: true });
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
  });

  test('blocks import from /etc/passwd', (t) => {
    const { FileProcessor } = require('../../src/agent/capabilities/FileProcessor');
    const fp = new FileProcessor(tmpRoot, {}, nullBus);
    const result = fp.importFile('/etc/passwd');
    t.ok(result.error);
    t.ok(result.error.includes('blocked') || result.error.includes('not found'));
  });

  test('blocks import from /root/.ssh/id_rsa', (t) => {
    const { FileProcessor } = require('../../src/agent/capabilities/FileProcessor');
    const fp = new FileProcessor(tmpRoot, {}, nullBus);
    const result = fp.importFile('/root/.ssh/id_rsa');
    t.ok(result.error);
  });

  test('allows import from project root', (t) => {
    const { FileProcessor } = require('../../src/agent/capabilities/FileProcessor');
    const fp = new FileProcessor(tmpRoot, {}, nullBus);
    const testFile = path.join(tmpRoot, 'test-import.txt');
    fs.writeFileSync(testFile, 'test data', 'utf-8');
    const result = fp.importFile(testFile);
    t.ok(!result.error);
    t.equal(result.name, 'test-import.txt');
    try { fs.unlinkSync(testFile); } catch { /* ok */ }
    try { fs.unlinkSync(path.join(uploadDir, 'test-import.txt')); } catch { /* ok */ }
  });

  test('sanitizes targetName with directory traversal', (t) => {
    const { FileProcessor } = require('../../src/agent/capabilities/FileProcessor');
    const fp = new FileProcessor(tmpRoot, {}, nullBus);
    const testFile = path.join(tmpRoot, 'safe.txt');
    fs.writeFileSync(testFile, 'safe', 'utf-8');
    const result = fp.importFile(testFile, '../../etc/evil.txt');
    if (!result.error) {
      t.equal(result.name, 'evil.txt', 'should strip ../ from targetName');
      t.ok(result.path.startsWith(uploadDir), 'dest must be in uploads/');
    } else {
      t.pass('blocked traversal targetName');
    }
    try { fs.unlinkSync(testFile); } catch { /* ok */ }
    try { fs.unlinkSync(path.join(uploadDir, 'evil.txt')); } catch { /* ok */ }
  });

  test('cleanup', (t) => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ok */ }
    t.pass('cleaned up');
  });
});

// ── [S-3] system-info execFileSync migration ──────────────

describe('system-info skill shell safety', () => {
  test('does not import execSync', (t) => {
    const code = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'skills', 'system-info', 'index.js'),
      'utf-8'
    );
    t.ok(!code.includes('{ execSync }'), 'should not destructure execSync');
    t.ok(code.includes('execFileSync'), 'should use execFileSync');
  });

  test('uses EncodedCommand for PowerShell', (t) => {
    const code = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'skills', 'system-info', 'index.js'),
      'utf-8'
    );
    t.ok(code.includes('EncodedCommand'), 'should use Base64 EncodedCommand');
  });

  test('execute returns valid system info', async (t) => {
    const { SystemInfoSkill } = require('../../src/skills/system-info/index');
    const skill = new SystemInfoSkill();
    const result = await skill.execute({});
    t.ok(result.os.platform);
    t.ok(result.cpu.cores > 0);
    t.ok(result.memory.total);
    t.ok(result.node);
  });
});

// ── [Q-3] FileProcessor async lifecycle ───────────────────

describe('FileProcessor async lifecycle', () => {
  const nullBus = { emit: () => {}, fire: () => {}, on: () => () => {} };

  test('has asyncLoad method', (t) => {
    const { FileProcessor } = require('../../src/agent/capabilities/FileProcessor');
    const fp = new FileProcessor('/tmp/genesis-test', {}, nullBus);
    t.ok(typeof fp.asyncLoad === 'function');
  });

  test('asyncLoad returns a Promise', (t) => {
    const { FileProcessor } = require('../../src/agent/capabilities/FileProcessor');
    const fp = new FileProcessor('/tmp/genesis-test', {}, nullBus);
    const result = fp.asyncLoad();
    t.ok(result instanceof Promise, 'asyncLoad should return a Promise');
    result.catch(() => {}); // prevent unhandled rejection
  });

  test('_detectRuntimes is async', (t) => {
    const { FileProcessor } = require('../../src/agent/capabilities/FileProcessor');
    const fp = new FileProcessor('/tmp/genesis-test', {}, nullBus);
    const result = fp._detectRuntimes();
    t.ok(result instanceof Promise, '_detectRuntimes should return a Promise');
    result.catch(() => {}); // prevent unhandled rejection
  });

  test('constructor sets node=true by default', (t) => {
    const { FileProcessor } = require('../../src/agent/capabilities/FileProcessor');
    const fp = new FileProcessor('/tmp/genesis-test', {}, nullBus);
    t.ok(fp.runtimes.node === true, 'node should be true without asyncLoad');
  });
});

// ── [S-7] SelfModel async git ─────────────────────────────

describe('SelfModel async git', () => {
  test('commitSnapshot uses async execFile', (t) => {
    const code = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'agent', 'foundation', 'SelfModel.js'),
      'utf-8'
    );
    // Extract just the commitSnapshot method
    const csStart = code.indexOf('async commitSnapshot');
    const csEnd = code.indexOf('}', code.indexOf('}', csStart) + 1) + 1;
    const csBody = code.slice(csStart, csEnd);
    t.ok(csBody.includes('await execFileAsync'), 'commitSnapshot should use await execFileAsync');
    t.ok(!csBody.includes('execFileSync'), 'commitSnapshot should NOT use execFileSync');
  });

  test('rollback uses async execFile', (t) => {
    const code = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'agent', 'foundation', 'SelfModel.js'),
      'utf-8'
    );
    const rbStart = code.indexOf('async rollback');
    const rbBody = code.slice(rbStart, rbStart + 300);
    t.ok(rbBody.includes('await execFileAsync'), 'rollback should use await execFileAsync');
  });

  test('boot-time git init remains sync (acceptable)', (t) => {
    const code = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'agent', 'foundation', 'SelfModel.js'),
      'utf-8'
    );
    // Git init runs once at boot before window is interactive — sync is OK
    t.ok(code.includes('execFileSync(\'git\', [\'init\']') ||
         code.includes('execFileSync(\'git\', [\"init\"]'), 'git init can be sync');
  });
});

// ── robustJsonParse regression ────────────────────────────

describe('robustJsonParse regression', () => {
  const { robustJsonParse } = require('../../src/agent/core/utils');

  test('handles markdown fences', (t) => {
    t.deepEqual(robustJsonParse('```json\n{"key": "value"}\n```'), { key: 'value' });
  });

  test('handles trailing commas', (t) => {
    t.deepEqual(robustJsonParse('{"a": 1, "b": 2,}'), { a: 1, b: 2 });
  });

  test('returns null for unfixable', (t) => {
    t.equal(robustJsonParse('just text'), null);
    t.equal(robustJsonParse(null), null);
    t.equal(robustJsonParse(''), null);
  });

  test('extracts JSON from surrounding text', (t) => {
    const result = robustJsonParse('Here is the result: {"status": "ok"} end.');
    t.deepEqual(result, { status: 'ok' });
  });
});

// ── [S-4] Sandbox.executeExternal + FileProcessor routing ─

describe('[S-4] External Language Sandbox', () => {
  test('Sandbox has executeExternal method', (t) => {
    const { Sandbox } = require('../../src/agent/foundation/Sandbox');
    const sb = new Sandbox('/tmp/genesis-test-s4');
    t.ok(typeof sb.executeExternal === 'function', 'executeExternal exists');
  });

  test('executeExternal uses safeEnv without secrets', async (t) => {
    const code = fs.readFileSync(
      path.join(__dirname, '../../src/agent/foundation/Sandbox.js'), 'utf-8'
    );
    const extSection = code.slice(code.indexOf('async executeExternal'));
    t.ok(extSection.includes('safeEnv'), 'uses minimal safeEnv');
    t.ok(!extSection.includes('process.env,'), 'does not pass full process.env');
    t.ok(!extSection.includes('...process.env'), 'does not spread process.env');
    t.ok(extSection.includes('PYTHONDONTWRITEBYTECODE'), 'Python safety flags');
    t.ok(extSection.includes('cwd: this.sandboxDir'), 'CWD is sandbox dir');
  });

  test('executeExternal copies file into sandbox dir', (t) => {
    const code = fs.readFileSync(
      path.join(__dirname, '../../src/agent/foundation/Sandbox.js'), 'utf-8'
    );
    const extSection = code.slice(code.indexOf('async executeExternal'));
    t.ok(extSection.includes('copyFileSync(filePath, sandboxCopy)'), 'copies file to sandbox');
    t.ok(extSection.includes('_cleanFile(sandboxCopy)'), 'cleans up copy after execution');
  });

  test('executeExternal audits execution', (t) => {
    const code = fs.readFileSync(
      path.join(__dirname, '../../src/agent/foundation/Sandbox.js'), 'utf-8'
    );
    const extSection = code.slice(code.indexOf('async executeExternal'));
    t.ok(extSection.includes("_audit('executeExternal'"), 'audit logged');
  });

  test('FileProcessor routes non-JS through Sandbox.executeExternal', (t) => {
    const code = fs.readFileSync(
      path.join(__dirname, '../../src/agent/capabilities/FileProcessor.js'), 'utf-8'
    );
    t.ok(code.includes('sandbox.executeExternal'), 'calls sandbox.executeExternal');
    // No naked execFileAsync for execution in FileProcessor
    const execSection = code.slice(code.indexOf('async executeFile'));
    const afterSandbox = execSection.slice(0, execSection.indexOf('// ── Import'));
    t.ok(!afterSandbox.includes('execFileAsync(bin,'), 'no naked execFileAsync for execution');
  });

  test('FileProcessor executeFile returns sandboxed flag', (t) => {
    const code = fs.readFileSync(
      path.join(__dirname, '../../src/agent/capabilities/FileProcessor.js'), 'utf-8'
    );
    const execSection = code.slice(code.indexOf('async executeFile'));
    t.ok(execSection.includes('sandboxed: true') || execSection.includes('result.sandboxed'),
      'sandboxed flag in result or event');
  });

  test('Sandbox.executeExternal handles timeout', (t) => {
    const code = fs.readFileSync(
      path.join(__dirname, '../../src/agent/foundation/Sandbox.js'), 'utf-8'
    );
    const extSection = code.slice(code.indexOf('async executeExternal'));
    t.ok(extSection.includes('err.killed'), 'handles killed/timeout');
    t.ok(extSection.includes('Timeout'), 'returns timeout error message');
  });

  test('Sandbox.executeExternal runs Python in sandbox dir', async (t) => {
    // Only run if Python is available
    const { Sandbox } = require('../../src/agent/foundation/Sandbox');
    const sb = new Sandbox('/tmp/genesis-test-s4');

    // Create a test Python file that prints CWD
    const testFile = path.join('/tmp', 'genesis_s4_test.py');
    fs.writeFileSync(testFile, 'import os; print(os.getcwd())', 'utf-8');

    try {
      const { execFileSync } = require('child_process');
      execFileSync('python3', ['--version'], { stdio: 'pipe', timeout: 2000 });
    } catch {
      try {
        const { execFileSync } = require('child_process');
        execFileSync('python', ['--version'], { stdio: 'pipe', timeout: 2000 });
      } catch {
        // Python not available — skip
        t.ok(true, 'Python not available — test skipped');
        try { fs.unlinkSync(testFile); } catch {}
        return;
      }
    }

    const pythonBin = (() => {
      try {
        require('child_process').execFileSync('python3', ['--version'], { stdio: 'pipe' });
        return 'python3';
      } catch { return 'python'; }
    })();

    const result = await sb.executeExternal(pythonBin, [], testFile, [], { language: 'python' });
    try { fs.unlinkSync(testFile); } catch {}

    t.ok(!result.error, 'no error: ' + (result.error || ''));
    t.ok(result.output.includes(sb.sandboxDir) || result.output.includes('sandbox'),
      'CWD should be sandbox dir, got: ' + result.output.trim());
    t.ok(result.sandboxed === true, 'sandboxed flag is true');
  });
});
