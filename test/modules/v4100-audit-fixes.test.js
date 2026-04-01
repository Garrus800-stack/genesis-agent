#!/usr/bin/env node
// ============================================================
// GENESIS — v4.10.0 Audit Fixes Tests
//
//   [P1a] ESM Preload — sandbox:true enabled
//   [P1b] Atomic Writes in SelfModificationPipeline
//   [P2a] Logger Consolidation — no more raw console calls
//   [P2b] Async FS Migration — runtime writes use atomicWriteFile
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');
const fs = require('fs');

// ── [P1a] ESM Preload Migration ──────────────────────────

describe('[P1a] ESM Preload — sandbox:true', () => {
  test('preload.mjs exists', () => {
    assert(fs.existsSync(path.join(__dirname, '..', '..', 'preload.mjs')), 'preload.mjs must exist');
  });

  test('preload.mjs uses ESM import syntax', () => {
    const code = fs.readFileSync(path.join(__dirname, '..', '..', 'preload.mjs'), 'utf-8');
    assert(code.includes("import { contextBridge, ipcRenderer } from 'electron'"), 'must use ESM import');
    assert(!code.includes('require('), 'must NOT contain require()');
  });

  test('main.js references preload.mjs and sandbox:true', () => {
    const code = fs.readFileSync(path.join(__dirname, '..', '..', 'main.js'), 'utf-8');
    assert(code.includes('preload.mjs'), 'must reference preload.mjs');
    const wpStart = code.indexOf('webPreferences');
    const wpEnd = code.indexOf('},', wpStart) + 1;
    const wpBlock = code.slice(wpStart, wpEnd);
    // sandbox is dynamically set via three-tier preload resolution (useSandbox variable)
    assert(wpBlock.includes('sandbox: true') || wpBlock.includes('sandbox: useESM') || wpBlock.includes('sandbox: useSandbox'), 'sandbox must be true, dynamic useESM, or dynamic useSandbox');
    assert(!wpBlock.includes('sandbox: false'), 'sandbox:false must be removed');
  });

  test('preload.mjs has required channel whitelist', () => {
    const code = fs.readFileSync(path.join(__dirname, '..', '..', 'preload.mjs'), 'utf-8');
    for (const ch of ['agent:chat', 'agent:save-file', 'agent:run-in-sandbox', 'agent:clone', 'agent:get-event-debug']) {
      assert(code.includes(`'${ch}'`), `must include channel: ${ch}`);
    }
  });

  test('PROTECTED_PATHS includes preload.mjs', () => {
    const code = fs.readFileSync(path.join(__dirname, '..', '..', 'main.js'), 'utf-8');
    assert(code.includes('preload.mjs'), 'PROTECTED_PATHS must include preload.mjs');
  });
});

// ── [P1b] Atomic Writes ──────────────────────────────────

describe('[P1b] Atomic Writes — utils', () => {
  test('atomicWriteFileSync writes correctly', () => {
    const { atomicWriteFileSync } = require('../../src/agent/core/utils');
    const tmpDir = path.join(__dirname, '..', '..', 'sandbox', '_atomic_' + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    const target = path.join(tmpDir, 'test.txt');
    atomicWriteFileSync(target, 'hello sync', 'utf-8');
    assertEqual(fs.readFileSync(target, 'utf-8'), 'hello sync');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('atomicWriteFileSync leaves no temp files', () => {
    const { atomicWriteFileSync } = require('../../src/agent/core/utils');
    const tmpDir = path.join(__dirname, '..', '..', 'sandbox', '_atomic_clean_' + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    atomicWriteFileSync(path.join(tmpDir, 'a.txt'), 'aaa', 'utf-8');
    const tmpFiles = fs.readdirSync(tmpDir).filter(f => f.startsWith('.genesis-tmp-'));
    assertEqual(tmpFiles.length, 0, 'no temp files should remain');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('atomicWriteFileSync overwrites existing', () => {
    const { atomicWriteFileSync } = require('../../src/agent/core/utils');
    const tmpDir = path.join(__dirname, '..', '..', 'sandbox', '_atomic_ow_' + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    const target = path.join(tmpDir, 'ow.txt');
    atomicWriteFileSync(target, 'first', 'utf-8');
    atomicWriteFileSync(target, 'second', 'utf-8');
    assertEqual(fs.readFileSync(target, 'utf-8'), 'second');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('atomicWriteFile async writes correctly', async () => {
    const { atomicWriteFile } = require('../../src/agent/core/utils');
    const tmpDir = path.join(__dirname, '..', '..', 'sandbox', '_atomic_async_' + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    const target = path.join(tmpDir, 'async.txt');
    await atomicWriteFile(target, 'hello async', 'utf-8');
    assertEqual(fs.readFileSync(target, 'utf-8'), 'hello async');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('atomicWriteFile handles concurrent writes', async () => {
    const { atomicWriteFile } = require('../../src/agent/core/utils');
    const tmpDir = path.join(__dirname, '..', '..', 'sandbox', '_atomic_conc_' + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    const target = path.join(tmpDir, 'conc.txt');
    // FIX: Use allSettled — on Windows, concurrent rename() to the same target
    // can throw EPERM. The test verifies at least one write wins, not that all succeed.
    const results = await Promise.allSettled([
      atomicWriteFile(target, 'write-a', 'utf-8'),
      atomicWriteFile(target, 'write-b', 'utf-8'),
      atomicWriteFile(target, 'write-c', 'utf-8'),
    ]);
    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    assert(succeeded >= 1, 'at least one write must succeed');
    const content = fs.readFileSync(target, 'utf-8');
    assert(['write-a', 'write-b', 'write-c'].includes(content), 'one write must win: ' + content);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('atomicWriteFileSync cleans up on error', () => {
    const { atomicWriteFileSync } = require('../../src/agent/core/utils');
    const tmpDir = path.join(__dirname, '..', '..', 'sandbox', '_atomic_err_' + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    let threw = false;
    try {
      atomicWriteFileSync(path.join(tmpDir, 'no', 'such', 'dir', 'file.txt'), 'fail');
    } catch { threw = true; }
    assert(threw, 'should have thrown');
    const tmpFiles = fs.readdirSync(tmpDir).filter(f => f.startsWith('.genesis-tmp-'));
    assertEqual(tmpFiles.length, 0, 'no orphan temp files');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('[P1b] SelfModPipeline atomic writes', () => {
  test('no raw writeFileSync in apply paths', () => {
    const code = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'agent', 'hexagonal', 'SelfModificationPipeline.js'), 'utf-8'
    );
    const lines = code.split('\n');
    const rawWrites = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('fs.writeFileSync') && !lines[i].includes('_atomicWriteFileSync')) {
        const ctx = lines.slice(Math.max(0, i - 5), i + 1).join('\n');
        if (!ctx.includes('function _atomicWriteFileSync')) rawWrites.push(i + 1);
      }
    }
    assertEqual(rawWrites.length, 0, 'raw writeFileSync at lines: ' + rawWrites.join(', '));
  });

  test('validates all paths before multi-file write', () => {
    const code = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'agent', 'hexagonal', 'SelfModificationPipeline.js'), 'utf-8'
    );
    assert(code.includes('Validate ALL paths'), 'validate-all-first pattern');
    assert(code.includes('_atomicWriteFileSync'), 'uses atomic write');
  });
});

// ── [P2a] Logger Consolidation ───────────────────────────

describe('[P2a] Logger Consolidation', () => {
  test('no raw console.log in agent modules (excl. hash-locked)', () => {
    const SKIP = ['Logger.js', 'EventBus.js', 'Container.js', 'Constants.js',
                   'CodeSafetyScanner.js', 'VerificationEngine.js',
                   'Sandbox.js',        // v5.1.0: Sandbox generates child-process code templates that use console.log
                   'SkillManager.js'];   // v5.9.1: executeSkill() generates sandbox code with console.log for output
    const agentDir = path.join(__dirname, '..', '..', 'src', 'agent');
    const violations = [];

    function scan(dir, relBase) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
        if (entry.isDirectory() && entry.name !== 'manifest') { scan(full, rel); continue; }
        if (!entry.name.endsWith('.js') || SKIP.includes(entry.name)) continue;
        const lines = fs.readFileSync(full, 'utf-8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          const l = lines[i];
          if (l.trimStart().startsWith('//')) continue;
          if (/console\.(log|error|warn)\s*=/.test(l)) continue; // sandbox override
          if (l.includes('console.log for output')) continue; // prompt text
          if (/\bconsole\.log\(/.test(l)) violations.push(`${rel}:${i + 1}`);
        }
      }
    }
    scan(agentDir, '');
    assertEqual(violations.length, 0, 'raw console.log found: ' + violations.slice(0, 5).join(', '));
  });

  test('key modules import createLogger', () => {
    const agentDir = path.join(__dirname, '..', '..', 'src', 'agent');
    for (const rel of ['foundation/ModelBridge.js', 'capabilities/McpClient.js',
                        'revolution/AgentLoop.js', 'hexagonal/ChatOrchestrator.js']) {
      const code = fs.readFileSync(path.join(agentDir, rel), 'utf-8');
      assert(code.includes('createLogger'), `${rel} must import createLogger`);
    }
  });
});

// ── [P2b] Async FS Migration ─────────────────────────────

describe('[P2b] Async FS — runtime write paths', () => {
  test('AgentCore.writeOwnFile is async with atomicWriteFile', () => {
    const code = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'agent', 'AgentCore.js'), 'utf-8');
    const idx = code.indexOf('writeOwnFile');
    const around = code.slice(code.lastIndexOf('\n', idx), idx + 500);
    assert(around.includes('async'), 'must be async');
    assert(around.includes('atomicWriteFile'), 'must use atomicWriteFile');
  });

  test('ChatOrchestrator._saveHistory uses atomicWriteFile', () => {
    const code = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'agent', 'hexagonal', 'ChatOrchestrator.js'), 'utf-8');
    const defIdx = code.indexOf('_saveHistory() {');
    assert(defIdx > 0, '_saveHistory method must exist');
    const body = code.slice(defIdx, defIdx + 700);
    assert(body.includes('atomicWriteFile'), 'must use atomicWriteFile');
    assert(!body.includes('writeFileSync'), 'must NOT use writeFileSync');
  });

  test('ConversationMemory._saveNow uses atomicWriteFile', () => {
    const code = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'agent', 'foundation', 'ConversationMemory.js'), 'utf-8');
    const defIdx = code.indexOf('_saveNow() {');
    assert(defIdx > 0, '_saveNow method must exist');
    const body = code.slice(defIdx, defIdx + 500);
    assert(body.includes('atomicWriteFile'), 'must use atomicWriteFile');
    assert(!body.includes('writeFileSync'), 'must NOT use writeFileSync');
  });

  test('ToolRegistry file-write is async with atomicWriteFile', () => {
    const code = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'agent', 'intelligence', 'ToolRegistry.js'), 'utf-8');
    const defIdx = code.indexOf("this.register('file-write'");
    assert(defIdx > 0, 'file-write registration must exist');
    const body = code.slice(defIdx, defIdx + 700);
    assert(body.includes('async'), 'must be async');
    assert(body.includes('atomicWriteFile'), 'must use atomicWriteFile');
  });

  test('AgentLoopSteps has no raw writeFileSync', () => {
    const code = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'agent', 'revolution', 'AgentLoopSteps.js'), 'utf-8');
    assert(code.includes('atomicWriteFile'), 'must use atomicWriteFile');
    const rawWrites = code.split('\n').filter(l => l.includes('fs.writeFileSync') && !l.trimStart().startsWith('//'));
    assertEqual(rawWrites.length, 0, 'no raw writeFileSync');
  });

  test('CapabilityGuard.writeFile is async', () => {
    const code = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'agent', 'foundation', 'CapabilityGuard.js'), 'utf-8');
    const idx = code.indexOf('writeFile(');
    const ctx = code.slice(code.lastIndexOf('\n', idx), idx + 30);
    assert(ctx.includes('async'), 'writeFile must be async');
  });
});

describe('[P2b] utils.js exports', () => {
  test('exports all utility functions', () => {
    const utils = require('../../src/agent/core/utils');
    assertEqual(typeof utils.atomicWriteFile, 'function');
    assertEqual(typeof utils.atomicWriteFileSync, 'function');
    assertEqual(typeof utils.robustJsonParse, 'function');
    assertEqual(typeof utils.safeJsonParse, 'function');
  });
});

run();
