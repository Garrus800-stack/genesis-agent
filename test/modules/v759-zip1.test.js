// ============================================================
// GENESIS — test/modules/v759-zip1.test.js
//
// v7.5.9 ZIP1 — first iterative deliverable. Tests for:
//   Phase 5 — _llmClassify timeout default 0 (disabled)
//   Phase 6 — source-read budget raised to 15/30/100 + cache-hits
//             no longer count against budget
//   Phase 0 — parseToolCalls accepts 3 formats; detectToolIntentWithoutCall
//             helper; ChatOrchestrator re-prompt-on-missing-call
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');

const { describe, test, assert, assertEqual, run } = require('../harness');

const ROOT = path.resolve(__dirname, '..', '..');

// ── Phase 5 ─────────────────────────────────────────────────

describe('v7.5.9 ZIP1 Phase 5 — _llmClassify timeout default 0 (disabled)', () => {

  test('source-presence: default literal is 0', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/intelligence/IntentRouter.js'), 'utf8');
    const idx = src.indexOf('async _llmClassify');
    assert(idx > -1, '_llmClassify missing');
    const slice = src.slice(idx, idx + 4000);
    assert(/_LLM_CLASSIFY_TIMEOUT_MS\s*=\s*\([\s\S]*?\)\s*\?\s*_configured\s*:\s*0\s*;/.test(slice),
      'default branch must yield 0');
    assert(!/:\s*30_?000\s*;/.test(slice), 'old 30s default must be removed');
  });

  test('source-presence: settings key still readable', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/intelligence/IntentRouter.js'), 'utf8');
    assert(/intent\.llmClassifyTimeoutMs/.test(src),
      'must still read configurable timeout from settings');
  });

  test('behavior: classify works with no timeout (settings unset)', async () => {
    const { IntentRouter } = require(path.join(ROOT, 'src/agent/intelligence/IntentRouter.js'));
    const r = new IntentRouter({ bus: { fire: () => {}, emit: () => {} } });
    r.setModel({
      chat: () => Promise.resolve('INTENT: general\nCONFIDENCE: 0.8'),
    });
    const result = await r._llmClassify('test', 'cache-key-zip1-1');
    assert(result, 'should return a result');
    assertEqual(result.type, 'general', 'should classify as general');
  });

  test('behavior: settings.intent.llmClassifyTimeoutMs=50 enables race; null on timeout', async () => {
    const { IntentRouter } = require(path.join(ROOT, 'src/agent/intelligence/IntentRouter.js'));
    const r = new IntentRouter({ bus: { fire: () => {}, emit: () => {} } });
    r.setModel({
      chat: () => new Promise((resolve) => setTimeout(() =>
        resolve('INTENT: general\nCONFIDENCE: 0.5'), 500)),
    });
    r.setSettings({ get: (key) => key === 'intent.llmClassifyTimeoutMs' ? 50 : undefined });
    const result = await r._llmClassify('test', 'cache-key-zip1-2');
    assertEqual(result, null,
      'must return null when 50ms timeout fires before 500ms model');
  });

  test('behavior: settings explicitly 0 also disables', async () => {
    const { IntentRouter } = require(path.join(ROOT, 'src/agent/intelligence/IntentRouter.js'));
    const r = new IntentRouter({ bus: { fire: () => {}, emit: () => {} } });
    r.setModel({
      chat: () => new Promise((resolve) => setTimeout(() =>
        resolve('INTENT: general\nCONFIDENCE: 0.5'), 100)),
    });
    r.setSettings({ get: (key) => key === 'intent.llmClassifyTimeoutMs' ? 0 : undefined });
    const result = await r._llmClassify('test', 'cache-key-zip1-3');
    assert(result, 'must complete successfully (0 = disabled)');
    assertEqual(result.type, 'general');
  });

});

// ── Phase 6 ─────────────────────────────────────────────────

describe('v7.5.9 ZIP1 Phase 6 — budget defaults raised + cache-hits not counted', () => {

  test('source-presence: defaults are 15/30/100', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/SelfModel.js'), 'utf8');
    assert(/softPerTurn:\s*15/.test(src), 'softPerTurn must be 15');
    assert(/hardPerTurn:\s*30/.test(src), 'hardPerTurn must be 30');
    assert(/hardPerSession:\s*100/.test(src), 'hardPerSession must be 100');
  });

  test('source-absence: cache-hit no longer increments turnCount/sessionCount', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/SelfModelSourceRead.js'), 'utf8');
    const idx = src.indexOf('Cache hit');
    assert(idx > -1, 'cache-hit block must exist');
    const slice = src.slice(idx, idx + 800);
    const returnIdx = slice.indexOf('return cached');
    assert(returnIdx > -1, 'must return cached');
    const beforeReturn = slice.slice(0, returnIdx);
    assert(!/turnCount\+\+/.test(beforeReturn),
      'cache-hit block must NOT increment turnCount before return');
    assert(!/sessionCount\+\+/.test(beforeReturn),
      'cache-hit block must NOT increment sessionCount before return');
  });

  test('behavior: cache-hit returns cached without counter change', () => {
    const { selfModelSourceRead } = require(path.join(ROOT, 'src/agent/foundation/SelfModelSourceRead.js'));
    const fakeSelfModel = {
      _readSourceBudget: { softPerTurn: 15, hardPerTurn: 30, hardPerSession: 100, maxFileBytes: 20_000 },
      _readSourceState: {
        turnCount: 0, sessionCount: 0, currentTurnId: null,
        sessionCache: new Map(),
      },
      rootDir: '/tmp',
      guard: { validateRead: () => {} },
    };
    Object.assign(fakeSelfModel, selfModelSourceRead);

    const fakePath = '/tmp/genesis-test-fake-zip1.txt';
    fakeSelfModel._readSourceState.sessionCache.set(fakePath, '<<cached>>');

    const beforeTurn = fakeSelfModel._readSourceState.turnCount;
    const beforeSession = fakeSelfModel._readSourceState.sessionCount;
    const result = fakeSelfModel.readSourceSync(fakePath);
    assertEqual(result, '<<cached>>', 'must return cached');
    assertEqual(fakeSelfModel._readSourceState.turnCount, beforeTurn,
      'turnCount must not change on cache-hit');
    assertEqual(fakeSelfModel._readSourceState.sessionCount, beforeSession,
      'sessionCount must not change on cache-hit');
  });

  test('behavior: hardPerSession=100 cap respected', () => {
    const { selfModelSourceRead } = require(path.join(ROOT, 'src/agent/foundation/SelfModelSourceRead.js'));
    const fakeSelfModel = {
      _readSourceBudget: { softPerTurn: 15, hardPerTurn: 30, hardPerSession: 100, maxFileBytes: 20_000 },
      _readSourceState: {
        turnCount: 0, sessionCount: 100, currentTurnId: null,
        sessionCache: new Map(),
      },
      rootDir: '/tmp',
      guard: { validateRead: () => {} },
    };
    Object.assign(fakeSelfModel, selfModelSourceRead);
    const result = fakeSelfModel.readSourceSync('/tmp/anything.txt');
    assertEqual(result, null, 'must return null when sessionCount==hardPerSession');
  });

});

// ── Phase 0 ─────────────────────────────────────────────────

describe('v7.5.9 ZIP1 Phase 0 — parseToolCalls accepts 3 formats', () => {

  test('format 1: <tool_call>{...}</tool_call> (canonical)', () => {
    const { ToolRegistry } = require(path.join(ROOT, 'src/agent/intelligence/ToolRegistry.js'));
    const r = new ToolRegistry({ bus: { fire: () => {}, emit: () => {} } });
    const result = r.parseToolCalls('Reading: <tool_call>{"name":"file-read","input":{"path":"a.md"}}</tool_call> done');
    assertEqual(result.toolCalls.length, 1, 'must find one call');
    assertEqual(result.toolCalls[0].name, 'file-read');
  });

  test('format 2: ```tool_call ... ``` (markdown-fence)', () => {
    const { ToolRegistry } = require(path.join(ROOT, 'src/agent/intelligence/ToolRegistry.js'));
    const r = new ToolRegistry({ bus: { fire: () => {}, emit: () => {} } });
    const response = 'Let me check:\n```tool_call\n{"name":"file-list","input":{"path":"."}}\n```\nDone.';
    const result = r.parseToolCalls(response);
    assertEqual(result.toolCalls.length, 1, 'fence-format must be parsed');
    assertEqual(result.toolCalls[0].name, 'file-list');
  });

  test('format 3: ```json with REGISTERED tool name', () => {
    const { ToolRegistry } = require(path.join(ROOT, 'src/agent/intelligence/ToolRegistry.js'));
    const r = new ToolRegistry({ bus: { fire: () => {}, emit: () => {} } });
    r.register('test-tool-zip1', { description: 'test', input: { x: 'string' }, output: { y: 'string' } },
      () => ({ y: 'ok' }), 'builtin');
    const response = 'I will call:\n```json\n{"name":"test-tool-zip1","input":{"x":"hello"}}\n```';
    const result = r.parseToolCalls(response);
    assertEqual(result.toolCalls.length, 1, 'json-fence with registered name must be parsed');
    assertEqual(result.toolCalls[0].name, 'test-tool-zip1');
  });

  test('format 3 IGNORED: ```json with NON-registered name', () => {
    const { ToolRegistry } = require(path.join(ROOT, 'src/agent/intelligence/ToolRegistry.js'));
    const r = new ToolRegistry({ bus: { fire: () => {}, emit: () => {} } });
    const response = 'Example response:\n```json\n{"name":"unknown-tool-xyz","input":{"x":"y"}}\n```';
    const result = r.parseToolCalls(response);
    assertEqual(result.toolCalls.length, 0, 'json-fence with unknown name must be ignored');
  });

  test('format 3 IGNORED if format 1 already produced calls', () => {
    const { ToolRegistry } = require(path.join(ROOT, 'src/agent/intelligence/ToolRegistry.js'));
    const r = new ToolRegistry({ bus: { fire: () => {}, emit: () => {} } });
    r.register('real-tool-zip1', { description: 't', input: {}, output: {} }, () => ({}), 'builtin');
    const response = '<tool_call>{"name":"real-tool-zip1","input":{}}</tool_call>\nAlso example:\n```json\n{"name":"real-tool-zip1","input":{"x":1}}\n```';
    const result = r.parseToolCalls(response);
    assertEqual(result.toolCalls.length, 1, 'when format 1 succeeded, format 3 must not double-add');
  });

});

describe('v7.5.9 ZIP1 Phase 0 — detectToolIntentWithoutCall', () => {

  test('detects German "Tools ausführen..."', () => {
    const { ToolRegistry } = require(path.join(ROOT, 'src/agent/intelligence/ToolRegistry.js'));
    const r = new ToolRegistry({ bus: { fire: () => {}, emit: () => {} } });
    assertEqual(r.detectToolIntentWithoutCall('Tools ausführen...'), true);
    assertEqual(r.detectToolIntentWithoutCall('Ich führe das Tool jetzt aus.'), true);
  });

  test('detects English "let me use file-read"', () => {
    const { ToolRegistry } = require(path.join(ROOT, 'src/agent/intelligence/ToolRegistry.js'));
    const r = new ToolRegistry({ bus: { fire: () => {}, emit: () => {} } });
    assertEqual(r.detectToolIntentWithoutCall('Let me use file-read to check'), true);
    assertEqual(r.detectToolIntentWithoutCall('I will call the file-list tool'), true);
  });

  test('does NOT detect on normal answer', () => {
    const { ToolRegistry } = require(path.join(ROOT, 'src/agent/intelligence/ToolRegistry.js'));
    const r = new ToolRegistry({ bus: { fire: () => {}, emit: () => {} } });
    assertEqual(r.detectToolIntentWithoutCall('The README explains the boot sequence.'), false);
    assertEqual(r.detectToolIntentWithoutCall('Genesis hat 168 Services.'), false);
    assertEqual(r.detectToolIntentWithoutCall(''), false);
    assertEqual(r.detectToolIntentWithoutCall(null), false);
  });

  test('source-presence: ChatOrchestrator integrates re-prompt', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/hexagonal/ChatOrchestrator.js'), 'utf8');
    assert(/_toolIntentReprompted/.test(src),
      'ChatOrchestrator must track re-prompt state');
    assert(/detectToolIntentWithoutCall/.test(src),
      'ChatOrchestrator must call the detector');
    assert(/tool-use:reprompt-needed/.test(src),
      'ChatOrchestrator must emit reprompt event');
  });

  test('source-presence: tool-use:reprompt-needed in EventTypes', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/core/EventTypes.js'), 'utf8');
    assert(/tool-use:reprompt-needed/.test(src),
      'event must be in EventTypes');
  });

  test('source-presence: payload schema for reprompt event', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/core/EventPayloadSchemas.js'), 'utf8');
    assert(/'tool-use:reprompt-needed'/.test(src),
      'payload schema must exist');
  });

});

run();
