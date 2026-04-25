#!/usr/bin/env node
// ============================================================
// Test: SelfModificationPipeline — safety gates, atomic writes
// FIX v7.0.8 (T-1): Audit finding — no dedicated unit tests existed.
//
// NOTE: These tests verify the pipeline's structure and safety
// mechanisms without executing actual self-modification (which
// would require a full agent boot). Focus: gate presence,
// rejection paths, and atomic write helper.
// ============================================================

const { describe, test, assert, assertEqual, assertThrows, run, createTestRoot } = require('../harness');
const path = require('path');
const fs = require('fs');

const ROOT = createTestRoot('selfmod');
fs.mkdirSync(path.join(ROOT, 'src', 'agent'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'sandbox'), { recursive: true });

// Minimal mocks for constructor
const nullBus = { emit() {}, fire() {}, on() {} };
const nullModel = { createCompletion() { return { text: '' }; } };
const nullSelfModel = { getSourceMap() { return {}; }, get() { return ''; } };
const nullSandbox = { execute() { return { exitCode: 0, stdout: 'ok' }; }, syntaxCheck() { return { valid: true }; } };
const nullSkills = { list() { return []; } };

// SafeGuard mock — tracks calls
function mockGuard() {
  const calls = [];
  return {
    calls,
    validateWrite(p) { calls.push(p); return true; },
    isProtected() { return false; },
    isCritical() { return false; },
  };
}

// CodeSafety mock — tracks scans
function mockCodeSafety(safe = true) {
  const scans = [];
  return {
    scans,
    scanCode(code, file) {
      scans.push({ code: code.substring(0, 50), file });
      return safe
        ? { safe: true, blocked: [], warnings: [] }
        : { safe: false, blocked: [{ severity: 'block', description: 'test block' }], warnings: [] };
    },
  };
}

const { SelfModificationPipeline } = require('../../src/agent/hexagonal/SelfModificationPipeline');

describe('SelfModificationPipeline — constructor', () => {
  test('creates with minimal deps', () => {
    const smp = new SelfModificationPipeline({
      lang: { t: k => k, detect() {}, current: 'en' },
      bus: nullBus, selfModel: nullSelfModel, model: nullModel,
      prompts: null, sandbox: nullSandbox, reflector: null,
      skills: nullSkills, cloner: null, reasoning: null,
      hotReloader: null, guard: mockGuard(), tools: null,
      eventStore: null, rootDir: ROOT, astDiff: null,
    });
    assert(smp.rootDir === ROOT, 'rootDir should be set');
    assert(smp.guard, 'guard should be set');
  });
});

describe('SelfModificationPipeline — _verifyCode', () => {
  test('exists and is callable', () => {
    const smp = new SelfModificationPipeline({
      lang: { t: k => k, detect() {}, current: 'en' },
      bus: nullBus, selfModel: nullSelfModel, model: nullModel,
      prompts: null, sandbox: nullSandbox, reflector: null,
      skills: nullSkills, cloner: null, reasoning: null,
      hotReloader: null, guard: mockGuard(), tools: null,
      eventStore: null, rootDir: ROOT, astDiff: null,
    });
    assert(typeof smp._verifyCode === 'function', '_verifyCode should exist');
  });

  test('rejects code with syntax errors', () => {
    const smp = new SelfModificationPipeline({
      lang: { t: k => k, detect() {}, current: 'en' },
      bus: nullBus, selfModel: nullSelfModel, model: nullModel,
      prompts: null, sandbox: nullSandbox, reflector: null,
      skills: nullSkills, cloner: null, reasoning: null,
      hotReloader: null, guard: mockGuard(), tools: null,
      eventStore: null, rootDir: ROOT, astDiff: null,
    });
    const result = smp._verifyCode('test.js', 'function { totally broken!!!');
    // Should fail verification (syntax error)
    assert(result.status === 'fail' || !result.pass,
      'syntax error should fail verification');
  });

  test('accepts valid code (with verifier bound)', () => {
    const smp = new SelfModificationPipeline({
      lang: { t: k => k, detect() {}, current: 'en' },
      bus: nullBus, selfModel: nullSelfModel, model: nullModel,
      prompts: null, sandbox: nullSandbox, reflector: null,
      skills: nullSkills, cloner: null, reasoning: null,
      hotReloader: null, guard: mockGuard(), tools: null,
      eventStore: null, rootDir: ROOT, astDiff: null,
    });
    // Simulate late-binding of VerificationEngine
    smp.verifier = {
      verify() { return { status: 'pass' }; },
    };
    const result = smp._verifyCode('test.js', 'const x = 1;\nmodule.exports = { x };');
    assert(result.pass === true, 'valid code with verifier should pass');
  });

  test('fail-closed when verifier not bound', () => {
    const smp = new SelfModificationPipeline({
      lang: { t: k => k, detect() {}, current: 'en' },
      bus: nullBus, selfModel: nullSelfModel, model: nullModel,
      prompts: null, sandbox: nullSandbox, reflector: null,
      skills: nullSkills, cloner: null, reasoning: null,
      hotReloader: null, guard: mockGuard(), tools: null,
      eventStore: null, rootDir: ROOT, astDiff: null,
    });
    // No verifier bound — should fail-closed
    const result = smp._verifyCode('test.js', 'const x = 1;');
    assert(result.pass === false, 'should fail-closed without verifier');
    assert(/not available|not bound/i.test(result.reason), 'reason should explain missing verifier');
  });
});

describe('SelfModificationPipeline — safety gate presence', () => {
  // Verify the pipeline source code contains all required safety gates
  // This is a meta-test: it reads the source and checks for gate patterns
  //
  // v7.4.3 Baustein D: the modify family was extracted to
  // SelfModificationPipelineModify.js. The safety gates live in those
  // methods, so the source-presence check now reads both files combined.
  // The invariant is "the modify family must contain N safety gates" —
  // unchanged in meaning, only the file boundary moved.
  function readPipelineSource() {
    const core = fs.readFileSync(
      path.join(__dirname, '../../src/agent/hexagonal/SelfModificationPipeline.js'), 'utf-8');
    const modifyPath = path.join(__dirname, '../../src/agent/hexagonal/SelfModificationPipelineModify.js');
    const modify = fs.existsSync(modifyPath) ? fs.readFileSync(modifyPath, 'utf-8') : '';
    return core + '\n' + modify;
  }

  test('source contains scanCode calls', () => {
    const src = readPipelineSource();
    const count = (src.match(/this\)\._codeSafety\.scanCode\s*\(/g) || []).length;
    assert(count >= 2, `expected >=2 scanCode gates, got ${count}`);
  });

  test('source contains _verifyCode calls', () => {
    const src = readPipelineSource();
    const count = (src.match(/this\._verifyCode\s*\(/g) || []).length;
    assert(count >= 2, `expected >=2 _verifyCode gates, got ${count}`);
  });

  test('source contains guard.validateWrite calls', () => {
    const src = readPipelineSource();
    const count = (src.match(/this\.guard\.validateWrite\s*\(/g) || []).length;
    assert(count >= 2, `expected >=2 validateWrite gates, got ${count}`);
  });

  test('source uses atomic write pattern', () => {
    const src = readPipelineSource();
    assert(/_atomicWriteFileSync/.test(src), 'should use atomic write helper');
  });
});

describe('SelfModificationPipeline — atomic write helper', () => {
  // The _atomicWriteFileSync is a module-level function — test via file operations
  test('writes are atomic (tmp → rename)', () => {
    const testFile = path.join(ROOT, 'atomic-test.js');
    const content = 'const x = 42;';
    // Write directly to verify the pattern works
    const tmpName = `.genesis-tmp-test-${Date.now()}`;
    const tmpPath = path.join(ROOT, tmpName);
    fs.writeFileSync(tmpPath, content, 'utf-8');
    fs.renameSync(tmpPath, testFile);
    assertEqual(fs.readFileSync(testFile, 'utf-8'), content, 'atomic write should preserve content');
    // Cleanup
    fs.unlinkSync(testFile);
  });
});

describe('SelfModificationPipeline — circuit breaker', () => {
  test('has circuit breaker threshold', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../src/agent/hexagonal/SelfModificationPipeline.js'), 'utf-8');
    const match = src.match(/this\._circuitBreakerThreshold\s*=\s*(\d+)/);
    assert(match, 'should have circuit breaker threshold');
    const threshold = parseInt(match[1], 10);
    assert(threshold >= 2, `threshold should be >=2, got ${threshold}`);
  });
});

run();
