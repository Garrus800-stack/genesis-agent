// ============================================================
// Test: v6.0.5 — V6-8 Deterministic Replay + V6-10 KG Flush
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');
const os = require('os');
const fs = require('fs');

function mockBus() {
  const _emitted = [];
  return {
    on: () => () => {},
    emit(e, d, m) { _emitted.push({ event: e, data: d }); },
    fire(e, d, m) { _emitted.push({ event: e, data: d }); },
    _emitted,
    _find(name) { return _emitted.filter(e => e.event === name); },
  };
}

const tmpDir = path.join(os.tmpdir(), 'genesis-replay-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });

// ── Helper: create a TaskRecorder with a fake recording on disk ──
function setupRecorder() {
  const bus = mockBus();
  const { TaskRecorder } = require('../../src/agent/cognitive/TaskRecorder');
  const tr = new TaskRecorder({ bus, dataDir: tmpDir });

  // Write a fake recording to disk
  const recording = {
    id: 'rec_test_001',
    goalId: 'goal_abc',
    goalDescription: 'Fix the login bug',
    startedAt: Date.now() - 5000,
    steps: [
      { ts: Date.now() - 4800, offset: 200, type: 'intent', data: { type: 'code', confidence: 0.9 } },
      { ts: Date.now() - 4000, offset: 1000, type: 'step', data: { description: 'Analyze login.js' } },
      { ts: Date.now() - 2000, offset: 3000, type: 'decision', data: { choice: 'patch', reason: 'minimal change' } },
    ],
    llmCalls: [
      { ts: Date.now() - 4500, offset: 500, model: 'kimi-k2.5', promptPreview: 'Fix the login...', responsePreview: 'The issue is in line 42...', tokens: 350, durationMs: 1200 },
      { ts: Date.now() - 2500, offset: 2500, model: 'kimi-k2.5', promptPreview: 'Generate patch...', responsePreview: 'function login() {...}', tokens: 200, durationMs: 800 },
    ],
    toolCalls: [
      { ts: Date.now() - 1500, offset: 3500, type: 'shell', command: 'node test/login.test.js', success: true, outputPreview: '3 passed' },
    ],
    outcome: { reason: 'goal:completed', success: true, stepsCompleted: 3, llmCalls: 2, toolCalls: 1, durationMs: 5000 },
    metadata: { version: '6.0.5', platform: 'linux' },
  };

  fs.writeFileSync(path.join(tmpDir, 'rec_test_001.json'), JSON.stringify(recording));

  // Second recording for diff
  const recording2 = { ...recording, id: 'rec_test_002', goalDescription: 'Fix the login bug (retry)',
    steps: [
      { ts: Date.now() - 4800, offset: 200, type: 'intent', data: { type: 'code', confidence: 0.85 } },
      { ts: Date.now() - 3000, offset: 2000, type: 'step', data: { description: 'Rewrite login.js' } },
    ],
    outcome: { reason: 'goal:completed', success: false, stepsCompleted: 2, llmCalls: 1, toolCalls: 0, durationMs: 3000 },
  };
  fs.writeFileSync(path.join(tmpDir, 'rec_test_002.json'), JSON.stringify(recording2));

  return { tr, bus, recording };
}

// ═══════════════════════════════════════════════════════════
// buildReplayManifest
// ═══════════════════════════════════════════════════════════

describe('V6-8 Replay — buildReplayManifest', () => {

  test('returns null for unknown recording', () => {
    const { tr } = setupRecorder();
    assertEqual(tr.buildReplayManifest('nonexistent'), null);
  });

  test('builds manifest with merged timeline', () => {
    const { tr } = setupRecorder();
    const m = tr.buildReplayManifest('rec_test_001');
    assert(m, 'manifest exists');
    assertEqual(m.id, 'rec_test_001');
    assertEqual(m.goalDescription, 'Fix the login bug');
    assertEqual(m.summary.steps, 3);
    assertEqual(m.summary.llmCalls, 2);
    assertEqual(m.summary.toolCalls, 1);
  });

  test('timeline is sorted by offset', () => {
    const { tr } = setupRecorder();
    const m = tr.buildReplayManifest('rec_test_001');
    for (let i = 1; i < m.timeline.length; i++) {
      assert(m.timeline[i].offset >= m.timeline[i - 1].offset,
        `offset[${i}]=${m.timeline[i].offset} >= offset[${i-1}]=${m.timeline[i-1].offset}`);
    }
  });

  test('timeline contains all event kinds', () => {
    const { tr } = setupRecorder();
    const m = tr.buildReplayManifest('rec_test_001');
    const kinds = new Set(m.timeline.map(e => e.kind));
    assert(kinds.has('step'), 'has step events');
    assert(kinds.has('llm'), 'has llm events');
    assert(kinds.has('tool'), 'has tool events');
  });

  test('total events = steps + llm + tools', () => {
    const { tr } = setupRecorder();
    const m = tr.buildReplayManifest('rec_test_001');
    assertEqual(m.timeline.length, 3 + 2 + 1, 'total = 6 events');
  });

  test('outcome preserved', () => {
    const { tr } = setupRecorder();
    const m = tr.buildReplayManifest('rec_test_001');
    assert(m.outcome.success === true, 'success preserved');
    assertEqual(m.outcome.durationMs, 5000);
  });
});

// ═══════════════════════════════════════════════════════════
// replay
// ═══════════════════════════════════════════════════════════

describe('V6-8 Replay — replay()', () => {

  test('returns null for unknown recording', async () => {
    const { tr } = setupRecorder();
    assertEqual(await tr.replay('nonexistent'), null);
  });

  test('replays all events and returns report', async () => {
    const { tr, bus } = setupRecorder();
    const report = await tr.replay('rec_test_001', { speed: 0 });

    assert(report, 'report exists');
    assertEqual(report.id, 'rec_test_001');
    assertEqual(report.eventsReplayed, 6);
    assertEqual(report.totalEvents, 6);
    assertEqual(report.originalDurationMs, 5000);
    assert(report.replayDurationMs < 1000, 'instant replay is fast');
  });

  test('emits replay:started, replay:event, replay:completed', async () => {
    const { tr, bus } = setupRecorder();
    await tr.replay('rec_test_001', { speed: 0 });

    const started = bus._find('replay:started');
    assertEqual(started.length, 1, 'one started event');
    assertEqual(started[0].data.totalEvents, 6);

    const events = bus._find('replay:event');
    assertEqual(events.length, 6, '6 replay events');

    const completed = bus._find('replay:completed');
    assertEqual(completed.length, 1, 'one completed event');
    assertEqual(completed[0].data.eventsReplayed, 6);
  });

  test('replay events have correct indices', async () => {
    const { tr, bus } = setupRecorder();
    await tr.replay('rec_test_001', { speed: 0 });

    const events = bus._find('replay:event');
    for (let i = 0; i < events.length; i++) {
      assertEqual(events[i].data.index, i, `event ${i} has correct index`);
    }
  });

  test('emit: false suppresses bus events', async () => {
    const { tr, bus } = setupRecorder();
    await tr.replay('rec_test_001', { speed: 0, emit: false });

    assertEqual(bus._find('replay:started').length, 0);
    assertEqual(bus._find('replay:event').length, 0);
    assertEqual(bus._find('replay:completed').length, 0);
  });
});

// ═══════════════════════════════════════════════════════════
// formatReplay
// ═══════════════════════════════════════════════════════════

describe('V6-8 Replay — formatReplay', () => {

  test('returns placeholder for null', () => {
    const { tr } = setupRecorder();
    assert(tr.formatReplay(null).includes('no recording'), 'null handling');
  });

  test('formats manifest with timeline', () => {
    const { tr } = setupRecorder();
    const m = tr.buildReplayManifest('rec_test_001');
    const text = tr.formatReplay(m);

    assert(text.includes('rec_test_001'), 'has recording ID');
    assert(text.includes('Fix the login bug'), 'has goal');
    assert(text.includes('5000ms'), 'has duration');
    assert(text.includes('✓ success'), 'has outcome');
    assert(text.includes('Timeline'), 'has timeline header');
    assert(text.includes('[LLM]'), 'has LLM entries');
    assert(text.includes('[shell]'), 'has tool entries');
    assert(text.includes('kimi-k2.5'), 'has model name');
  });
});

// ═══════════════════════════════════════════════════════════
// V6-10: KG Flush on Offline
// ═══════════════════════════════════════════════════════════

describe('V6-10 — KG Flush on Offline', () => {
  const { NetworkSentinel } = require('../../src/agent/autonomy/NetworkSentinel');

  test('_flushPersistentData calls KG.flush()', async () => {
    const bus = mockBus();
    const ns = new NetworkSentinel({ bus });
    let kgFlushed = false;
    let lsFlushed = false;
    ns._knowledgeGraph = { flush: async () => { kgFlushed = true; } };
    ns._lessonsStore = { flush: async () => { lsFlushed = true; } };

    await ns._flushPersistentData();
    assert(kgFlushed, 'KG flushed');
    assert(lsFlushed, 'LessonsStore flushed');
  });

  test('_flushPersistentData handles null deps', async () => {
    const bus = mockBus();
    const ns = new NetworkSentinel({ bus });
    // No KG or LS set
    await ns._flushPersistentData();
    assert(true, 'no crash with null deps');
  });

  test('offline transition triggers flush', async () => {
    const bus = mockBus();
    const ns = new NetworkSentinel({ bus, config: { failureThreshold: 1 } });
    ns._running = true;
    let flushed = false;
    ns._knowledgeGraph = { flush: async () => { flushed = true; } };
    ns._ollamaAvailable = false;

    ns._onProbeFailure();
    // Give async flush time to complete
    await new Promise(r => setTimeout(r, 50));
    assert(flushed, 'KG flushed on offline');
  });
});

// Cleanup handled by OS (temp directory)

run();
