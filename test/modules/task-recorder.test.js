// ============================================================
// GENESIS — test/modules/task-recorder.test.js (v6.0.0)
//
// Tests TaskRecorder: recording lifecycle, step/llm/tool capture,
// persistence, diff, sanitization, ring buffer, stats.
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');
const { TaskRecorder } = require(path.join(ROOT, 'src/agent/cognitive/TaskRecorder'));

// ── Mock Dependencies ───────────────────────────────────────

function mockBus() {
  const events = [];
  const handlers = {};
  return {
    on: (evt, fn) => { handlers[evt] = fn; return () => { delete handlers[evt]; }; },
    emit: (evt, data) => events.push({ evt, data }),
    _events: events,
    _handlers: handlers,
    _fire: (evt, data) => handlers[evt]?.(data),
  };
}

function tmpDataDir() {
  return path.join(os.tmpdir(), `genesis-recorder-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
}

// ── Tests ────────────────────────────────────────────────────

describe('TaskRecorder', () => {

  test('constructs with minimal deps', () => {
    const bus = mockBus();
    const tr = new TaskRecorder({ bus, dataDir: tmpDataDir() });
    assert(tr.bus === bus, 'bus assigned');
    assertEqual(tr._active.size, 0);
    assertEqual(tr._completed.length, 0);
    assertEqual(tr._enabled, true);
  });

  test('start() subscribes to 6 events', () => {
    const bus = mockBus();
    const tr = new TaskRecorder({ bus, dataDir: tmpDataDir() });
    tr.start();
    assert(bus._handlers['agent-loop:started'], 'subscribes to loop start');
    assert(bus._handlers['agent-loop:complete'], 'subscribes to loop complete');
    assert(bus._handlers['goal:step-complete'], 'subscribes to step complete');
    assert(bus._handlers['chat:completed'], 'subscribes to chat');
    assert(bus._handlers['shell:complete'], 'subscribes to shell');
    assert(bus._handlers['intent:classified'], 'subscribes to intent');
  });

  test('stop() unsubscribes all listeners', () => {
    const bus = mockBus();
    const tr = new TaskRecorder({ bus, dataDir: tmpDataDir() });
    tr.start();
    assert(tr._unsubs.length >= 6, 'has subscriptions');
    tr.stop();
    assertEqual(tr._unsubs.length, 0);
  });

  test('recording lifecycle: start → steps → stop', () => {
    const dir = tmpDataDir();
    const bus = mockBus();
    const tr = new TaskRecorder({ bus, dataDir: dir });
    tr.start();

    // Start recording
    bus._fire('agent-loop:started', { goalId: 'g1', goal: 'Test goal' });
    assertEqual(tr._active.size, 1);

    // Add steps
    bus._fire('goal:step-complete', { goalId: 'g1', action: 'read file', success: true });
    bus._fire('goal:step-complete', { goalId: 'g1', action: 'write code', success: true });

    const recording = tr._active.get('g1');
    assertEqual(recording.steps.length, 2);

    // Complete recording
    bus._fire('agent-loop:complete', { goalId: 'g1', success: true });
    assertEqual(tr._active.size, 0);
    assertEqual(tr._completed.length, 1);
    assertEqual(tr._stats.totalRecordings, 1);
    assertEqual(tr._stats.totalSteps, 2);

    // Verify persisted to disk
    assert(fs.existsSync(dir), 'data dir created');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    assertEqual(files.length, 1);

    // Verify event emitted
    const completeEvt = bus._events.find(e => e.evt === 'replay:recording-complete');
    assert(completeEvt, 'completion event emitted');
    assertEqual(completeEvt.data.steps, 2);

    // Cleanup
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('records LLM calls', () => {
    const bus = mockBus();
    const tr = new TaskRecorder({ bus, dataDir: tmpDataDir() });
    tr.start();

    bus._fire('agent-loop:started', { goalId: 'g1', goal: 'LLM test' });
    bus._fire('chat:completed', {
      model: 'claude-sonnet',
      prompt: 'Write hello world',
      response: 'console.log("Hello World")',
      tokens: 42,
      durationMs: 1500,
    });

    const recording = tr._active.get('g1');
    assertEqual(recording.llmCalls.length, 1);
    assertEqual(recording.llmCalls[0].model, 'claude-sonnet');
    assertEqual(recording.llmCalls[0].tokens, 42);
    assertEqual(tr._stats.totalLLMCalls, 1);
  });

  test('records tool calls', () => {
    const bus = mockBus();
    const tr = new TaskRecorder({ bus, dataDir: tmpDataDir() });
    tr.start();

    bus._fire('agent-loop:started', { goalId: 'g1', goal: 'Tool test' });
    bus._fire('shell:complete', { command: 'npm test', exitCode: 0, output: 'All passed' });
    bus._fire('mcp:tool-call', { tool: 'verify-code', success: true });

    const recording = tr._active.get('g1');
    assertEqual(recording.toolCalls.length, 2);
    assertEqual(tr._stats.totalToolCalls, 2);
  });

  test('sanitizes large data', () => {
    const bus = mockBus();
    const tr = new TaskRecorder({ bus, dataDir: tmpDataDir() });

    const data = {
      longString: 'x'.repeat(1000),
      number: 42,
      bool: true,
      arr: Array(20).fill('item'),
      obj: { nested: true },
      nullVal: null,
    };

    const sanitized = tr._sanitize(data);
    assert(sanitized.longString.length <= 501, 'string truncated');
    assertEqual(sanitized.number, 42);
    assertEqual(sanitized.bool, true);
    assertEqual(sanitized.arr, '[Array(20)]');
    assertEqual(sanitized.obj, '[object]');
    assertEqual(sanitized.nullVal, null);
  });

  test('list() returns completed recordings in reverse order', () => {
    const bus = mockBus();
    const tr = new TaskRecorder({ bus, dataDir: tmpDataDir() });
    tr.start();

    // Create 3 recordings
    for (let i = 1; i <= 3; i++) {
      bus._fire('agent-loop:started', { goalId: `g${i}`, goal: `Goal ${i}` });
      bus._fire('agent-loop:complete', { goalId: `g${i}`, success: true });
    }

    const list = tr.list(10);
    assertEqual(list.length, 3);
    // Most recent first
    assert(list[0].goalDescription.includes('3'), 'most recent first');
    assert(list[2].goalDescription.includes('1'), 'oldest last');
  });

  test('load() reads recording from disk', () => {
    const dir = tmpDataDir();
    const bus = mockBus();
    const tr = new TaskRecorder({ bus, dataDir: dir });
    tr.start();

    bus._fire('agent-loop:started', { goalId: 'g1', goal: 'Load test' });
    bus._fire('goal:step-complete', { goalId: 'g1', action: 'test step', success: true });
    bus._fire('agent-loop:complete', { goalId: 'g1', success: true });

    const id = tr._completed[0].id;
    const loaded = tr.load(id);
    assert(loaded, 'recording loaded');
    assertEqual(loaded.goalDescription, 'Load test');
    assertEqual(loaded.steps.length, 1);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('load() returns null for nonexistent recording', () => {
    const bus = mockBus();
    const tr = new TaskRecorder({ bus, dataDir: tmpDataDir() });
    const result = tr.load('nonexistent');
    assertEqual(result, null);
  });

  test('diff() compares two recordings', () => {
    const dir = tmpDataDir();
    const bus = mockBus();
    const tr = new TaskRecorder({ bus, dataDir: dir });
    tr.start();

    // Recording A: 2 steps, success
    bus._fire('agent-loop:started', { goalId: 'gA', goal: 'Diff A' });
    bus._fire('goal:step-complete', { goalId: 'gA', action: 'step1', success: true });
    bus._fire('goal:step-complete', { goalId: 'gA', action: 'step2', success: true });
    bus._fire('agent-loop:complete', { goalId: 'gA', success: true });
    const idA = tr._completed[0].id;

    // Recording B: 3 steps, failure at step 2
    bus._fire('agent-loop:started', { goalId: 'gB', goal: 'Diff B' });
    bus._fire('goal:step-complete', { goalId: 'gB', action: 'step1', success: true });
    bus._fire('intent:classified', { intent: 'code-gen', message: 'write code' });
    bus._fire('goal:step-complete', { goalId: 'gB', action: 'step3', success: false });
    bus._fire('agent-loop:complete', { goalId: 'gB', success: false });
    const idB = tr._completed[1].id;

    const diff = tr.diff(idA, idB);
    assert(diff, 'diff returned');
    assertEqual(diff.recordingA.id, idA);
    assertEqual(diff.recordingB.id, idB);
    assert(diff.stepComparison.length >= 2, 'has step comparison');
    assertEqual(diff.outcomeDelta.successA, true);
    assertEqual(diff.outcomeDelta.successB, false);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('diff() returns null for missing recordings', () => {
    const bus = mockBus();
    const tr = new TaskRecorder({ bus, dataDir: tmpDataDir() });
    const result = tr.diff('a', 'b');
    assertEqual(result, null);
  });

  test('ring buffer caps completed recordings', () => {
    const bus = mockBus();
    const tr = new TaskRecorder({ bus, dataDir: tmpDataDir() });
    tr.start();

    // Exceed MAX_RECORDINGS (50)
    for (let i = 0; i < 55; i++) {
      bus._fire('agent-loop:started', { goalId: `g${i}`, goal: `Goal ${i}` });
      bus._fire('agent-loop:complete', { goalId: `g${i}`, success: true });
    }

    assert(tr._completed.length <= 50, 'ring buffer enforced');
    assertEqual(tr._stats.totalRecordings, 55);
  });

  test('getStats() returns correct stats', () => {
    const bus = mockBus();
    const tr = new TaskRecorder({ bus, dataDir: tmpDataDir() });
    tr.start();

    bus._fire('agent-loop:started', { goalId: 'g1', goal: 'Stats test' });
    bus._fire('goal:step-complete', { goalId: 'g1', action: 'step', success: true });
    bus._fire('chat:completed', { model: 'test', prompt: 'p', response: 'r' });
    bus._fire('shell:complete', { command: 'ls' });
    bus._fire('agent-loop:complete', { goalId: 'g1', success: true });

    const stats = tr.getStats();
    assertEqual(stats.totalRecordings, 1);
    assertEqual(stats.totalSteps, 1);
    assertEqual(stats.totalLLMCalls, 1);
    assertEqual(stats.totalToolCalls, 1);
    assertEqual(stats.activeRecordings, 0);
    assertEqual(stats.completedRecordings, 1);
  });

  test('getReport() returns stats and recent list', () => {
    const bus = mockBus();
    const tr = new TaskRecorder({ bus, dataDir: tmpDataDir() });

    const report = tr.getReport();
    assert(report.stats, 'has stats');
    assert(Array.isArray(report.recent), 'has recent array');
    assertEqual(report.enabled, true);
  });

  test('stop() finalizes active recordings', () => {
    const dir = tmpDataDir();
    const bus = mockBus();
    const tr = new TaskRecorder({ bus, dataDir: dir });
    tr.start();

    bus._fire('agent-loop:started', { goalId: 'g1', goal: 'Active on shutdown' });
    bus._fire('goal:step-complete', { goalId: 'g1', action: 'step1', success: true });

    assertEqual(tr._active.size, 1);
    tr.stop();
    assertEqual(tr._active.size, 0);
    assertEqual(tr._completed.length, 1);
    assertEqual(tr._completed[0].outcome.reason, 'shutdown');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('ignores events when no active recording', () => {
    const bus = mockBus();
    const tr = new TaskRecorder({ bus, dataDir: tmpDataDir() });
    tr.start();

    // Fire step without starting a recording
    bus._fire('goal:step-complete', { goalId: 'none', action: 'orphan', success: true });
    assertEqual(tr._active.size, 0);
    // Should not throw
  });

  test('goalDescription is truncated', () => {
    const bus = mockBus();
    const tr = new TaskRecorder({ bus, dataDir: tmpDataDir() });
    tr.start();

    const longGoal = 'x'.repeat(500);
    bus._fire('agent-loop:started', { goalId: 'g1', goal: longGoal });

    const recording = tr._active.get('g1');
    assert(recording.goalDescription.length <= 200, 'description truncated');
  });

  test('_stepSummary() formats different step types', () => {
    const bus = mockBus();
    const tr = new TaskRecorder({ bus, dataDir: tmpDataDir() });

    assertEqual(tr._stepSummary({ type: 'intent', data: { intent: 'code-gen', message: 'write fizzbuzz' } }),
      'code-gen: write fizzbuzz');
    assertEqual(tr._stepSummary({ type: 'step', data: { action: 'read file', success: true } }),
      'read file: OK');
    assertEqual(tr._stepSummary({ type: 'step', data: { action: 'compile', success: false } }),
      'compile: FAIL');
  });
});

run();
