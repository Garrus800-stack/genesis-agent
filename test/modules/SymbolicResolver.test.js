// ============================================================
// TEST — SymbolicResolver.js (v6.0.8)
// Fast lookup before LLM calls
// ============================================================

const { describe, test, run } = require('../harness');
const { SymbolicResolver, LEVEL } = require('../../src/agent/intelligence/SymbolicResolver');

// ── Mock Bus ─────────────────────────────────────────────────
function mockBus() {
  const events = [];
  return {
    on: () => () => {},
    emit: (ev, payload) => events.push({ ev, payload }),
    fire: (ev, payload) => events.push({ ev, payload }),
    events,
    getEmitted: (name) => events.filter(e => e.ev === name && e.payload),
  };
}

// ── Mock LessonsStore ────────────────────────────────────────
function mockLessonsStore(lessons = []) {
  return {
    recall: (category, context, limit) => lessons.slice(0, limit),
    _lessons: lessons.map(l => ({
      id: l.id || 'l-1',
      insight: l.insight,
      strategy: l.strategy || null,
      evidence: { confidence: l.confidence || 0.5 },
      useCount: l.useCount || 0,
      lastUsed: l.lastUsed || Date.now(),
    })),
    _dirty: false,
  };
}

// ── Mock SchemaStore ─────────────────────────────────────────
function mockSchemaStore(schemas = []) {
  return {
    match: () => schemas,
  };
}

// ════════════════════════════════════════════════════════════
// 1. RESOLUTION LEVELS
// ════════════════════════════════════════════════════════════

describe('SymbolicResolver — resolution levels', () => {
  test('PASS when no stores available', () => {
    const sr = new SymbolicResolver({ bus: mockBus() });
    const result = sr.resolve('ANALYZE', 'check code quality');
    if (result.level !== LEVEL.PASS) throw new Error(`Expected PASS, got ${result.level}`);
  });

  test('PASS when no matching lessons', () => {
    const sr = new SymbolicResolver({
      bus: mockBus(),
      lessonsStore: mockLessonsStore([]),
      schemaStore: mockSchemaStore([]),
    });
    const result = sr.resolve('CODE', 'generate a function');
    if (result.level !== LEVEL.PASS) throw new Error(`Expected PASS, got ${result.level}`);
  });

  test('GUIDED when lesson has medium confidence', () => {
    const sr = new SymbolicResolver({
      bus: mockBus(),
      lessonsStore: mockLessonsStore([{
        id: 'l-1',
        insight: 'Use step-by-step for code tasks',
        confidence: 0.65,
        useCount: 2,
      }]),
    });
    const result = sr.resolve('CODE', 'generate a REST endpoint');
    if (result.level !== LEVEL.GUIDED) throw new Error(`Expected GUIDED, got ${result.level}`);
    if (!result.directive) throw new Error('GUIDED should include a directive');
  });

  test('PASS when confidence below guided threshold', () => {
    const sr = new SymbolicResolver({
      bus: mockBus(),
      lessonsStore: mockLessonsStore([{
        id: 'l-1',
        insight: 'some weak insight',
        confidence: 0.3,
      }]),
    });
    const result = sr.resolve('CODE', 'generate code');
    if (result.level !== LEVEL.PASS) throw new Error(`Expected PASS, got ${result.level}`);
  });
});

// ════════════════════════════════════════════════════════════
// 2. DIRECT RESOLUTION
// ════════════════════════════════════════════════════════════

describe('SymbolicResolver — DIRECT resolution', () => {
  test('DIRECT for SHELL with high confidence lesson', () => {
    const sr = new SymbolicResolver({
      bus: mockBus(),
      lessonsStore: mockLessonsStore([{
        id: 'l-fix',
        insight: 'npm install fixes missing module',
        confidence: 0.90,
        useCount: 5,
        lastUsed: Date.now() - 1000 * 60 * 60, // 1 hour ago
        strategy: { command: 'npm install' },
      }]),
    });
    const result = sr.resolve('SHELL', 'fix missing dependency');
    if (result.level !== LEVEL.DIRECT) throw new Error(`Expected DIRECT, got ${result.level}`);
    if (result.lesson.id !== 'l-fix') throw new Error('Wrong lesson');
  });

  test('NEVER DIRECT for CODE even with high confidence', () => {
    const sr = new SymbolicResolver({
      bus: mockBus(),
      lessonsStore: mockLessonsStore([{
        id: 'l-1',
        insight: 'Always works',
        confidence: 0.99,
        useCount: 10,
        lastUsed: Date.now(),
        strategy: { promptStyle: 'step-by-step' },
      }]),
    });
    const result = sr.resolve('CODE', 'generate code');
    // Should be GUIDED, not DIRECT — CODE is in neverDirect
    if (result.level === LEVEL.DIRECT) throw new Error('CODE should never be DIRECT');
  });

  test('NEVER DIRECT for SELF_MODIFY', () => {
    const sr = new SymbolicResolver({
      bus: mockBus(),
      lessonsStore: mockLessonsStore([{
        id: 'l-1',
        insight: 'Always works',
        confidence: 0.99,
        useCount: 10,
        lastUsed: Date.now(),
        strategy: {},
      }]),
    });
    const result = sr.resolve('SELF_MODIFY', 'change code');
    if (result.level === LEVEL.DIRECT) throw new Error('SELF_MODIFY should never be DIRECT');
  });

  test('Not DIRECT when useCount too low', () => {
    const sr = new SymbolicResolver({
      bus: mockBus(),
      lessonsStore: mockLessonsStore([{
        id: 'l-1',
        insight: 'new insight',
        confidence: 0.95,
        useCount: 1, // too few
        lastUsed: Date.now(),
        strategy: { command: 'npm test' },
      }]),
    });
    const result = sr.resolve('SHELL', 'run tests');
    if (result.level === LEVEL.DIRECT) throw new Error('Should not be DIRECT with low useCount');
  });

  test('Not DIRECT when lesson is too old', () => {
    const sr = new SymbolicResolver({
      bus: mockBus(),
      lessonsStore: mockLessonsStore([{
        id: 'l-1',
        insight: 'old fix',
        confidence: 0.95,
        useCount: 10,
        lastUsed: Date.now() - 30 * 24 * 60 * 60 * 1000, // 30 days ago
        strategy: { command: 'npm install' },
      }]),
    });
    const result = sr.resolve('SHELL', 'fix dependency');
    if (result.level === LEVEL.DIRECT) throw new Error('Should not be DIRECT for stale lesson');
  });

  test('Not DIRECT without strategy', () => {
    const sr = new SymbolicResolver({
      bus: mockBus(),
      lessonsStore: mockLessonsStore([{
        id: 'l-1',
        insight: 'some insight',
        confidence: 0.95,
        useCount: 10,
        lastUsed: Date.now(),
        strategy: null, // no actionable strategy
      }]),
    });
    const result = sr.resolve('SHELL', 'do something');
    if (result.level === LEVEL.DIRECT) throw new Error('Should not be DIRECT without strategy');
  });
});

// ════════════════════════════════════════════════════════════
// 3. DIRECTIVE BUILDING
// ════════════════════════════════════════════════════════════

describe('SymbolicResolver — directive building', () => {
  test('builds directive from lesson insight', () => {
    const sr = new SymbolicResolver({
      bus: mockBus(),
      lessonsStore: mockLessonsStore([{
        insight: 'Use async/await pattern for error handling',
        confidence: 0.7,
      }]),
    });
    const result = sr.resolve('CODE', 'fix error handling');
    if (!result.directive.includes('async/await')) throw new Error('Directive should include lesson insight');
    if (!result.directive.includes('IMPORTANT')) throw new Error('Directive should be marked important');
  });

  test('builds directive from schema recommendation', () => {
    const sr = new SymbolicResolver({
      bus: mockBus(),
      schemaStore: mockSchemaStore([{
        name: 'error-pattern',
        recommendation: 'Always wrap in try-catch',
        confidence: 0.7,
        successModifier: 0.3,
      }]),
    });
    const result = sr.resolve('CODE', 'handle errors');
    if (!result.directive.includes('try-catch')) throw new Error('Directive should include schema recommendation');
    if (!result.directive.includes('PATTERN')) throw new Error('Directive should be marked as pattern');
  });

  test('includes success modifier warning for negative schemas', () => {
    const sr = new SymbolicResolver({
      bus: mockBus(),
      schemaStore: mockSchemaStore([{
        name: 'bad-pattern',
        recommendation: 'Using eval is risky',
        confidence: 0.6,
        successModifier: -0.5,
      }]),
    });
    const result = sr.resolve('CODE', 'evaluate expression');
    if (!result.directive.includes('WARNING')) throw new Error('Should warn about negative success modifier');
  });
});

// ════════════════════════════════════════════════════════════
// 4. OUTCOME RECORDING
// ════════════════════════════════════════════════════════════

describe('SymbolicResolver — outcome recording', () => {
  test('boosts lesson confidence on success', () => {
    const store = mockLessonsStore([{
      id: 'l-1', insight: 'test', confidence: 0.7, useCount: 3,
    }]);
    const sr = new SymbolicResolver({ bus: mockBus(), lessonsStore: store });

    sr.recordOutcome('direct', 'l-1', true);

    const lesson = store._lessons[0];
    if (lesson.evidence.confidence <= 0.7) throw new Error('Confidence should increase on success');
    if (lesson.useCount !== 4) throw new Error(`Expected useCount 4, got ${lesson.useCount}`);
  });

  test('penalizes lesson confidence on failure', () => {
    const store = mockLessonsStore([{
      id: 'l-1', insight: 'test', confidence: 0.7, useCount: 3,
    }]);
    const sr = new SymbolicResolver({ bus: mockBus(), lessonsStore: store });

    sr.recordOutcome('direct', 'l-1', false);

    const lesson = store._lessons[0];
    if (lesson.evidence.confidence >= 0.7) throw new Error('Confidence should decrease on failure');
  });

  test('tracks direct success/failure stats', () => {
    const sr = new SymbolicResolver({ bus: mockBus() });
    sr.recordOutcome('direct', 'l-1', true);
    sr.recordOutcome('direct', 'l-2', false);

    const stats = sr.getStats();
    if (stats.directSuccesses !== 1) throw new Error(`Expected 1 success, got ${stats.directSuccesses}`);
    if (stats.directFailures !== 1) throw new Error(`Expected 1 failure, got ${stats.directFailures}`);
  });
});

// ════════════════════════════════════════════════════════════
// 5. EVENTS
// ════════════════════════════════════════════════════════════

describe('SymbolicResolver — events', () => {
  test('emits symbolic:resolved for GUIDED', () => {
    const bus = mockBus();
    const sr = new SymbolicResolver({
      bus,
      lessonsStore: mockLessonsStore([{ insight: 'works', confidence: 0.7 }]),
    });
    sr.resolve('ANALYZE', 'check code');

    const events = bus.getEmitted('symbolic:resolved');
    if (events.length === 0) throw new Error('Should emit symbolic:resolved');
    if (events[0].payload.level !== 'guided') throw new Error('Should be guided level');
  });

  test('emits symbolic:resolved for DIRECT', () => {
    const bus = mockBus();
    const sr = new SymbolicResolver({
      bus,
      lessonsStore: mockLessonsStore([{
        id: 'l-1',
        insight: 'npm install',
        confidence: 0.95,
        useCount: 5,
        lastUsed: Date.now(),
        strategy: { command: 'npm install' },
      }]),
    });
    sr.resolve('SHELL', 'fix modules');

    const events = bus.getEmitted('symbolic:resolved');
    if (events.length === 0) throw new Error('Should emit symbolic:resolved');
    if (events[0].payload.level !== 'direct') throw new Error('Should be direct level');
  });
});

// ════════════════════════════════════════════════════════════
// 6. STATS
// ════════════════════════════════════════════════════════════

describe('SymbolicResolver — stats', () => {
  test('tracks query counts', () => {
    const sr = new SymbolicResolver({ bus: mockBus() });
    sr.resolve('CODE', 'a');
    sr.resolve('SHELL', 'b');
    sr.resolve('ANALYZE', 'c');

    const stats = sr.getStats();
    if (stats.queries !== 3) throw new Error(`Expected 3 queries, got ${stats.queries}`);
    if (stats.passes !== 3) throw new Error(`Expected 3 passes, got ${stats.passes}`);
  });

  test('tracks guided hits', () => {
    const sr = new SymbolicResolver({
      bus: mockBus(),
      lessonsStore: mockLessonsStore([{ insight: 'tip', confidence: 0.7 }]),
    });
    sr.resolve('CODE', 'generate');
    sr.resolve('ANALYZE', 'check');

    const stats = sr.getStats();
    if (stats.guidedHits !== 2) throw new Error(`Expected 2 guided hits, got ${stats.guidedHits}`);
  });
});

run();
