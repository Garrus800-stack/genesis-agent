// ============================================================
// TEST: CognitiveSelfModel — V6-11 Cognitive Self-Awareness
// ============================================================

const { describe, test, assertEqual, assert, run } = require('../harness');
const { CognitiveSelfModel, wilsonLower, BIAS_DETECTORS } = require('../../src/agent/cognitive/CognitiveSelfModel');

// ── Helpers ─────────────────────────────────────────────────

function mockBus() {
  const listeners = {};
  return {
    on(event, fn) { (listeners[event] = listeners[event] || []).push(fn); return () => {}; },
    emit(event, data) { (listeners[event] || []).forEach(fn => fn(data)); },
    fire(event, data) { this.emit(event, data); },
    _listeners: listeners,
  };
}

function mockTracker(outcomes = []) {
  return {
    getAggregateStats(opts = {}) {
      const cutoff = opts.windowMs ? Date.now() - opts.windowMs : 0;
      const relevant = cutoff > 0 ? outcomes.filter(o => o.timestamp >= cutoff) : outcomes;

      const byTaskType = {};
      const byBackend = {};
      for (const o of relevant) {
        if (!byTaskType[o.taskType]) byTaskType[o.taskType] = { count: 0, successes: 0, totalTokens: 0, totalDurationMs: 0, errors: {} };
        const tt = byTaskType[o.taskType];
        tt.count++;
        if (o.success) tt.successes++;
        tt.totalTokens += o.tokenCost || 0;
        tt.totalDurationMs += o.durationMs || 0;
        if (o.errorCategory) tt.errors[o.errorCategory] = (tt.errors[o.errorCategory] || 0) + 1;

        if (!byBackend[o.backend]) byBackend[o.backend] = { count: 0, successes: 0, totalTokens: 0 };
        const be = byBackend[o.backend];
        be.count++;
        if (o.success) be.successes++;
        be.totalTokens += o.tokenCost || 0;
      }
      for (const s of Object.values(byTaskType)) {
        s.successRate = s.count > 0 ? s.successes / s.count : 0;
        s.avgTokenCost = s.count > 0 ? Math.round(s.totalTokens / s.count) : 0;
        s.avgDurationMs = s.count > 0 ? Math.round(s.totalDurationMs / s.count) : 0;
      }
      for (const s of Object.values(byBackend)) {
        s.successRate = s.count > 0 ? s.successes / s.count : 0;
        s.avgTokenCost = s.count > 0 ? Math.round(s.totalTokens / s.count) : 0;
      }
      return { byTaskType, byBackend, total: relevant.length };
    },
    getOutcomes(filter = {}) {
      let r = outcomes;
      if (filter.taskType) r = r.filter(o => o.taskType === filter.taskType);
      if (filter.backend) r = r.filter(o => o.backend === filter.backend);
      return r;
    },
  };
}

function outcome(type, success, backend = 'ollama', extras = {}) {
  return {
    taskType: type,
    backend,
    success,
    tokenCost: extras.tokenCost || 500,
    durationMs: extras.durationMs || 5000,
    errorCategory: success ? null : (extras.errorCategory || 'generic'),
    intent: type,
    timestamp: extras.timestamp || Date.now(),
  };
}

// ── Wilson Score ─────────────────────────────────────────────

describe('wilsonLower — conservative confidence', () => {
  test('returns 0 for empty sample', () => {
    assertEqual(wilsonLower(0, 0), 0);
  });

  test('3/3 success is NOT 100% confident', () => {
    const score = wilsonLower(3, 3);
    assert(score < 0.75, `3/3 should be <75% confident, got ${score}`);
    assert(score > 0.3, `3/3 should be >30% confident, got ${score}`);
  });

  test('10/10 is more confident than 3/3', () => {
    assert(wilsonLower(10, 10) > wilsonLower(3, 3), 'More data = more confidence');
  });

  test('50% rate with large sample', () => {
    const score = wilsonLower(50, 100);
    assert(score > 0.35 && score < 0.5, `Should be ~40-49%, got ${score}`);
  });

  test('0 successes gives near-zero', () => {
    const score = wilsonLower(0, 10);
    assert(score < 0.05, `0/10 should be near zero, got ${score}`);
  });
});

// ── Capability Profile ──────────────────────────────────────

describe('CognitiveSelfModel — Capability Profile', () => {
  test('returns empty when no tracker', () => {
    const sm = new CognitiveSelfModel({ bus: mockBus() });
    assertEqual(Object.keys(sm.getCapabilityProfile()).length, 0);
  });

  test('computes profile from outcomes', () => {
    const bus = mockBus();
    const sm = new CognitiveSelfModel({ bus });
    sm.taskOutcomeTracker = mockTracker([
      outcome('code-gen', true), outcome('code-gen', true), outcome('code-gen', false),
      outcome('chat', true), outcome('chat', true), outcome('chat', true), outcome('chat', true), outcome('chat', true),
    ]);

    const profile = sm.getCapabilityProfile();
    assert(profile['code-gen'], 'Should have code-gen entry');
    assert(profile['chat'], 'Should have chat entry');
    assertEqual(profile['code-gen'].sampleSize, 3);
    assertEqual(profile['chat'].sampleSize, 5);
    assert(profile['code-gen'].successRate < 1, 'code-gen not 100%');
    assert(profile['chat'].confidenceLower > profile['code-gen'].confidenceLower, 'chat more confident');
  });

  test('marks weak task types', () => {
    const sm = new CognitiveSelfModel({ bus: mockBus() });
    sm.taskOutcomeTracker = mockTracker([
      outcome('refactoring', false), outcome('refactoring', true), outcome('refactoring', false),
      outcome('refactoring', false), outcome('refactoring', false),
    ]);
    const profile = sm.getCapabilityProfile();
    assert(profile['refactoring'].isWeak, 'Should be marked weak');
  });

  test('marks strong task types', () => {
    const sm = new CognitiveSelfModel({ bus: mockBus() });
    const outcomes = [];
    for (let i = 0; i < 20; i++) outcomes.push(outcome('chat', true));
    sm.taskOutcomeTracker = mockTracker(outcomes);
    const profile = sm.getCapabilityProfile();
    assert(profile['chat'].isStrong, 'Should be marked strong');
  });

  test('caches profile and invalidates on new outcome', () => {
    const bus = mockBus();
    const sm = new CognitiveSelfModel({ bus });
    sm.taskOutcomeTracker = mockTracker([outcome('chat', true), outcome('chat', true), outcome('chat', true)]);

    const p1 = sm.getCapabilityProfile();
    const p2 = sm.getCapabilityProfile();
    assert(p1 === p2, 'Should return cached instance');

    sm._invalidateCache();
    const p3 = sm.getCapabilityProfile();
    assert(p1 !== p3, 'Should recompute after invalidation');
  });
});

// ── Backend Strength Map ────────────────────────────────────

describe('CognitiveSelfModel — Backend Strength Map', () => {
  test('recommends best backend per task type', () => {
    const sm = new CognitiveSelfModel({ bus: mockBus() });
    sm.taskOutcomeTracker = mockTracker([
      outcome('code-gen', true, 'claude'), outcome('code-gen', true, 'claude'), outcome('code-gen', true, 'claude'),
      outcome('code-gen', false, 'ollama'), outcome('code-gen', false, 'ollama'), outcome('code-gen', true, 'ollama'),
    ]);

    const map = sm.getBackendStrengthMap();
    assert(map['code-gen'], 'Should have code-gen entry');
    assertEqual(map['code-gen'].recommended, 'claude');
  });

  test('returns empty when no tracker', () => {
    const sm = new CognitiveSelfModel({ bus: mockBus() });
    assertEqual(Object.keys(sm.getBackendStrengthMap()).length, 0);
  });
});

// ── Bias Detection ──────────────────────────────────────────

describe('CognitiveSelfModel — Bias Patterns', () => {
  test('detects error-repetition bias', () => {
    const sm = new CognitiveSelfModel({ bus: mockBus() });
    const outcomes = [];
    for (let i = 0; i < 5; i++) outcomes.push(outcome('code-gen', false, 'ollama', { errorCategory: 'timeout' }));
    sm.taskOutcomeTracker = mockTracker(outcomes);

    const biases = sm.getBiasPatterns();
    const errorBias = biases.find(b => b.name === 'error-repetition');
    assert(errorBias, 'Should detect error-repetition');
    assert(errorBias.evidence.includes('timeout'), 'Should mention timeout');
  });

  test('detects backend-mismatch bias', () => {
    const sm = new CognitiveSelfModel({ bus: mockBus() });
    const outcomes = [];
    for (let i = 0; i < 5; i++) outcomes.push(outcome('code-gen', true, 'claude'));
    for (let i = 0; i < 5; i++) outcomes.push(outcome('code-gen', false, 'ollama'));
    sm.taskOutcomeTracker = mockTracker(outcomes);

    const biases = sm.getBiasPatterns();
    const mismatch = biases.find(b => b.name === 'backend-mismatch');
    assert(mismatch, 'Should detect backend-mismatch');
  });

  test('returns empty for no biases', () => {
    const sm = new CognitiveSelfModel({ bus: mockBus() });
    const outcomes = [];
    for (let i = 0; i < 10; i++) outcomes.push(outcome('chat', true));
    sm.taskOutcomeTracker = mockTracker(outcomes);
    assertEqual(sm.getBiasPatterns().length, 0);
  });
});

// ── Confidence Report ───────────────────────────────────────

describe('CognitiveSelfModel — Confidence', () => {
  test('returns unknown for insufficient data', () => {
    const sm = new CognitiveSelfModel({ bus: mockBus() });
    sm.taskOutcomeTracker = mockTracker([outcome('chat', true)]);
    const conf = sm.getConfidence('chat');
    assertEqual(conf.confidence, 'unknown');
    assert(conf.risks.length > 0);
  });

  test('returns high confidence for strong task type', () => {
    const sm = new CognitiveSelfModel({ bus: mockBus() });
    const outcomes = [];
    for (let i = 0; i < 20; i++) outcomes.push(outcome('chat', true));
    sm.taskOutcomeTracker = mockTracker(outcomes);
    const conf = sm.getConfidence('chat');
    assertEqual(conf.confidence, 'high');
    assertEqual(conf.risks.length, 0);
  });

  test('returns low confidence for weak task type', () => {
    const sm = new CognitiveSelfModel({ bus: mockBus() });
    sm.taskOutcomeTracker = mockTracker([
      outcome('refactoring', false), outcome('refactoring', false),
      outcome('refactoring', false), outcome('refactoring', true),
    ]);
    const conf = sm.getConfidence('refactoring');
    assertEqual(conf.confidence, 'low');
    assert(conf.risks.length > 0, 'Should have risks');
    assert(conf.recommendation.includes('verification') || conf.recommendation.includes('care'));
  });

  test('flags suboptimal backend', () => {
    const sm = new CognitiveSelfModel({ bus: mockBus() });
    const outcomes = [];
    for (let i = 0; i < 8; i++) outcomes.push(outcome('code-gen', true, 'claude'));
    for (let i = 0; i < 8; i++) outcomes.push(outcome('code-gen', false, 'ollama'));
    sm.taskOutcomeTracker = mockTracker(outcomes);

    const conf = sm.getConfidence('code-gen', 'ollama');
    const backendRisk = conf.risks.find(r => r.includes('Suboptimal backend'));
    assert(backendRisk, 'Should flag suboptimal backend');
  });
});

// ── Prompt Context ──────────────────────────────────────────

describe('CognitiveSelfModel — Prompt Context', () => {
  test('returns empty when no tracker', () => {
    const sm = new CognitiveSelfModel({ bus: mockBus() });
    assertEqual(sm.buildPromptContext(), '');
  });

  test('returns empty for insufficient data', () => {
    const sm = new CognitiveSelfModel({ bus: mockBus() });
    sm.taskOutcomeTracker = mockTracker([outcome('chat', true)]);
    assertEqual(sm.buildPromptContext(), '');
  });

  test('includes Wilson confidence floor', () => {
    const sm = new CognitiveSelfModel({ bus: mockBus() });
    const outcomes = [];
    for (let i = 0; i < 10; i++) outcomes.push(outcome('code-gen', true));
    for (let i = 0; i < 10; i++) outcomes.push(outcome('chat', true));
    sm.taskOutcomeTracker = mockTracker(outcomes);

    const ctx = sm.buildPromptContext();
    assert(ctx.includes('[Cognitive Self-Model]'), 'Has prefix');
    assert(ctx.includes('Capability floor'), 'Has capability section');
    assert(ctx.includes('↑'), 'Has Wilson arrow notation');
  });

  test('includes weakness warning', () => {
    const sm = new CognitiveSelfModel({ bus: mockBus() });
    const outcomes = [];
    for (let i = 0; i < 10; i++) outcomes.push(outcome('chat', true));
    outcomes.push(outcome('refactoring', false), outcome('refactoring', false), outcome('refactoring', false));
    sm.taskOutcomeTracker = mockTracker(outcomes);

    const ctx = sm.buildPromptContext();
    assert(ctx.includes('Weakness'), 'Should flag weakness');
    assert(ctx.includes('refactoring'), 'Should name the weak type');
  });
});

// ── Report ──────────────────────────────────────────────────

describe('CognitiveSelfModel — Report', () => {
  test('getReport returns full diagnostic', () => {
    const sm = new CognitiveSelfModel({ bus: mockBus() });
    const outcomes = [];
    for (let i = 0; i < 5; i++) outcomes.push(outcome('chat', true));
    sm.taskOutcomeTracker = mockTracker(outcomes);

    const report = sm.getReport();
    assert(report.profile, 'Has profile');
    assert(report.backendMap !== undefined, 'Has backendMap');
    assert(Array.isArray(report.biases), 'Has biases');
    assert(report.stats, 'Has stats');
    assert(report.generatedAt > 0, 'Has timestamp');
  });
});

// ── Lifecycle ───────────────────────────────────────────────

describe('CognitiveSelfModel — Lifecycle', () => {
  test('boot subscribes to outcome events', () => {
    const bus = mockBus();
    const sm = new CognitiveSelfModel({ bus });
    sm.boot();
    assert(bus._listeners['task-outcome:recorded'], 'Should listen to recorded');
    assert(bus._listeners['task-outcome:stats-updated'], 'Should listen to stats-updated');
  });

  test('stop cleans up subscriptions', () => {
    const bus = mockBus();
    const sm = new CognitiveSelfModel({ bus });
    sm.boot();
    sm.stop();
    // _unsubs should be cleared
    assertEqual(sm._unsubs.length, 0);
  });

  test('containerConfig is correct', () => {
    const cfg = CognitiveSelfModel.containerConfig;
    assertEqual(cfg.name, 'cognitiveSelfModel');
    assertEqual(cfg.phase, 9);
    assert(cfg.tags.includes('selfmodel'));
    assert(cfg.lateBindings.some(b => b.service === 'taskOutcomeTracker'));
  });
});

// ── BIAS_DETECTORS unit tests ───────────────────────────────

describe('BIAS_DETECTORS — individual', () => {
  test('scope-underestimate needs >=3 long tasks', () => {
    const detector = BIAS_DETECTORS.find(d => d.id === 'scope-underestimate');
    const result = detector.detect([outcome('code-gen', false, 'x', { durationMs: 1000 })]);
    assertEqual(result, null);
  });

  test('token-overuse needs >=5 samples per type', () => {
    const detector = BIAS_DETECTORS.find(d => d.id === 'token-overuse');
    const result = detector.detect([outcome('chat', true, 'x', { tokenCost: 9999 })]);
    assertEqual(result, null);
  });
});

run();
