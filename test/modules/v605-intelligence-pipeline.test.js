// ============================================================
// Test: v6.0.5 — Intelligence Pipeline Integration
//
// Validates the closed loop:
//   Request → CognitiveBudget.assess()
//           → PromptBuilder._buildWithBudget() (sections pruned)
//           → ExecutionProvenance.beginTrace/recordBudget/recordPrompt/endTrace
//           → AdaptivePromptStrategy._analyze() (effectiveness computed)
//           → PromptBuilder.getSectionAdvice() (next build adapts)
//
// This is NOT a unit test — it wires real instances together
// and verifies end-to-end convergence.
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');

// ── Mock Bus ────────────────────────────────────────────────
function mockBus() {
  const _listeners = new Map();
  const _emitted = [];
  return {
    on(event, fn, opts) {
      if (!_listeners.has(event)) _listeners.set(event, []);
      _listeners.get(event).push({ fn, ...opts });
      return () => {
        const a = _listeners.get(event);
        if (a) { const i = a.findIndex(l => l.fn === fn); if (i >= 0) a.splice(i, 1); }
      };
    },
    emit(event, data, meta) {
      _emitted.push({ event, data, meta });
      const ls = _listeners.get(event);
      if (ls) for (const l of ls) l.fn(data, meta);
    },
    fire(event, data, meta) { this.emit(event, data, meta); },
    _emitted,
    _listeners,
  };
}

// ── Load real modules ───────────────────────────────────────
const { CognitiveBudget, TIERS } = require('../../src/agent/intelligence/CognitiveBudget');
const { ExecutionProvenance } = require('../../src/agent/intelligence/ExecutionProvenance');
const { AdaptivePromptStrategy, PROTECTED_SECTIONS } = require('../../src/agent/intelligence/AdaptivePromptStrategy');

// ═══════════════════════════════════════════════════════════
// 1. Pipeline Wiring
// ═══════════════════════════════════════════════════════════

describe('Intelligence Pipeline — Wiring', () => {

  test('all three services construct independently', () => {
    const bus = mockBus();
    const budget = new CognitiveBudget();
    const provenance = new ExecutionProvenance({ bus });
    const strategy = new AdaptivePromptStrategy({ bus });
    assert(budget, 'CognitiveBudget should construct');
    assert(provenance, 'ExecutionProvenance should construct');
    assert(strategy, 'AdaptivePromptStrategy should construct');
  });

  test('budget assess → provenance record → strategy analyze cycle', () => {
    const bus = mockBus();
    const budget = new CognitiveBudget();
    const provenance = new ExecutionProvenance({ bus });
    const strategy = new AdaptivePromptStrategy({ bus, config: { analyzeEvery: 1 } });

    // Step 1: Budget assessment
    const assessment = budget.assess('Write a function to sort an array');
    assert(assessment.tierName, 'should return tier name');
    assert(['trivial', 'moderate', 'complex', 'extreme'].includes(assessment.tierName),
      `tier should be valid, got: ${assessment.tierName}`);

    // Step 2: Provenance trace
    const traceId = provenance.beginTrace('Write a function to sort an array');
    assert(traceId, 'should return trace ID');

    provenance.recordBudget(traceId, assessment);
    const trace = provenance.getTrace(traceId);
    assert(trace, 'trace should exist');
    assertEqual(trace.budget?.tier, assessment.tierName, 'budget tier recorded');

    // Step 3: Record prompt metadata (simulating PromptBuilder output)
    provenance.recordPrompt(traceId, {
      active: ['identity', 'formatting', 'capabilities', 'session', 'task-performance', 'organism-state'],
      skipped: ['consciousness-state', 'emotional-context'],
      boosted: [],
      totalTokens: 800,
      tier: assessment.tierName,
    });

    // Step 4: Record model selection
    provenance.recordModel(traceId, { name: 'kimi-k2.5', backend: 'ollama' });

    // Step 5: End trace with success
    provenance.endTrace(traceId, {
      tokens: 450,
      latencyMs: 2100,
      outcome: 'success',
    });

    const completed = provenance.getTrace(traceId);
    assert(completed.response, 'trace should be completed');
    assertEqual(completed.response?.outcome, 'success', 'outcome recorded');
  });
});

// ═══════════════════════════════════════════════════════════
// 2. Budget → Prompt Section Filtering
// ═══════════════════════════════════════════════════════════

describe('Intelligence Pipeline — Budget Filtering', () => {

  test('TRIVIAL skips organism and consciousness sections', () => {
    const budget = new CognitiveBudget();
    const trivialBudget = { tier: TIERS.TRIVIAL, tierName: 'trivial' };

    assert(!budget.shouldIncludeSection('organism-state', trivialBudget),
      'TRIVIAL should skip organism');
    assert(!budget.shouldIncludeSection('consciousness-state', trivialBudget),
      'TRIVIAL should skip consciousness');
    assert(!budget.shouldIncludeSection('emotional-context', trivialBudget),
      'TRIVIAL should skip emotional');
    assert(!budget.shouldIncludeSection('homeostasis-vitals', trivialBudget),
      'TRIVIAL should skip homeostasis');
  });

  test('TRIVIAL keeps identity and formatting', () => {
    const budget = new CognitiveBudget();
    const trivialBudget = { tier: TIERS.TRIVIAL, tierName: 'trivial' };

    assert(budget.shouldIncludeSection('identity', trivialBudget),
      'TRIVIAL should keep identity');
    assert(budget.shouldIncludeSection('formatting', trivialBudget),
      'TRIVIAL should keep formatting');
  });

  test('COMPLEX keeps everything', () => {
    const budget = new CognitiveBudget();
    const complexBudget = { tier: TIERS.COMPLEX, tierName: 'complex' };

    assert(budget.shouldIncludeSection('organism-state', complexBudget),
      'COMPLEX should keep organism');
    assert(budget.shouldIncludeSection('consciousness-state', complexBudget),
      'COMPLEX should keep consciousness');
    assert(budget.shouldIncludeSection('identity', complexBudget),
      'COMPLEX should keep identity');
  });

  test('code request is classified as complex', () => {
    const budget = new CognitiveBudget();
    const result = budget.assess('Write a React component for user authentication');
    assertEqual(result.tierName, 'complex', 'code task should be complex');
  });

  test('greeting is classified as trivial', () => {
    const budget = new CognitiveBudget();
    assertEqual(budget.assess('Hallo').tierName, 'trivial');
    assertEqual(budget.assess('hi').tierName, 'trivial');
    assertEqual(budget.assess('Moin').tierName, 'trivial');
  });
});

// ═══════════════════════════════════════════════════════════
// 3. Provenance → Strategy Analysis
// ═══════════════════════════════════════════════════════════

describe('Intelligence Pipeline — Provenance → Strategy', () => {

  test('strategy analyzes traces and produces section advice', () => {
    const bus = mockBus();
    const provenance = new ExecutionProvenance({ bus });
    const strategy = new AdaptivePromptStrategy({
      bus,
      config: { analyzeEvery: 999, minSamples: 2 },
    });

    // Wire strategy to read from provenance
    strategy._provenance = provenance;

    // Simulate 5 successful code traces WITH organism-state active
    for (let i = 0; i < 5; i++) {
      const tid = provenance.beginTrace(`code task ${i}`);
      provenance.recordBudget(tid, { tierName: 'complex', tier: TIERS.COMPLEX });
      provenance.recordIntent(tid, { type: 'code', confidence: 0.9 });
      provenance.recordPrompt(tid, {
        active: ['identity', 'formatting', 'capabilities', 'task-performance', 'organism-state'],
        skipped: ['consciousness-state'],
        boosted: [],
        tier: 'complex',
      });
      provenance.recordModel(tid, { name: 'test-model', backend: 'ollama' });
      provenance.endTrace(tid, { tokens: 400, latencyMs: 2000, outcome: 'success' });
    }

    // Simulate 5 FAILED code traces WITH consciousness-state active
    for (let i = 0; i < 5; i++) {
      const tid = provenance.beginTrace(`code task fail ${i}`);
      provenance.recordBudget(tid, { tierName: 'complex', tier: TIERS.COMPLEX });
      provenance.recordIntent(tid, { type: 'code', confidence: 0.9 });
      provenance.recordPrompt(tid, {
        active: ['identity', 'formatting', 'capabilities', 'task-performance', 'consciousness-state'],
        skipped: ['organism-state'],
        boosted: [],
        tier: 'complex',
      });
      provenance.recordModel(tid, { name: 'test-model', backend: 'ollama' });
      provenance.endTrace(tid, { tokens: 400, latencyMs: 2000, outcome: 'error' });
    }

    // Trigger analysis
    strategy.analyze();

    // Check that analysis produced results
    const report = strategy.getReport();
    assert(report, 'report should exist');
  });

  test('protected sections are never skipped by strategy', () => {
    assert(PROTECTED_SECTIONS, 'PROTECTED_SECTIONS should be exported');
    assert(PROTECTED_SECTIONS.size > 0, 'should have protected sections');

    const bus = mockBus();
    const strategy = new AdaptivePromptStrategy({ bus, config: { analyzeEvery: 999 } });

    for (const section of PROTECTED_SECTIONS) {
      const advice = strategy.getSectionAdvice('code', section);
      assert(advice !== 'skip', `protected section "${section}" should never be skipped`);
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 4. End-to-End: Full Cycle Convergence
// ═══════════════════════════════════════════════════════════

describe('Intelligence Pipeline — Full Cycle', () => {

  test('10 iterations produce stable advice (no oscillation)', () => {
    const bus = mockBus();
    const budget = new CognitiveBudget();
    const provenance = new ExecutionProvenance({ bus });
    const strategy = new AdaptivePromptStrategy({
      bus,
      config: { analyzeEvery: 999, minSamples: 3 },
    });
    strategy._provenance = provenance;

    const sections = ['identity', 'formatting', 'capabilities', 'session', 'task-performance', 'organism-state', 'consciousness-state'];

    // Run 10 simulated requests through the full pipeline
    for (let i = 0; i < 10; i++) {
      const msg = `Implement feature ${i} with error handling`;
      const assessment = budget.assess(msg);
      const tid = provenance.beginTrace(msg);

      provenance.recordBudget(tid, assessment);
      provenance.recordIntent(tid, { type: 'code', confidence: 0.85 });

      // Simulate section filtering
      const activeSections = sections.filter(s => {
        if (!budget.shouldIncludeSection(s, assessment)) return false;
        const advice = strategy.getSectionAdvice('code', s);
        return advice !== 'skip';
      });

      provenance.recordPrompt(tid, {
        active: activeSections,
        skipped: sections.filter(s => !activeSections.includes(s)),
        boosted: [],
        tier: assessment.tierName,
      });

      provenance.recordModel(tid, { name: 'test-model', backend: 'ollama' });
      provenance.endTrace(tid, {
        tokens: 300 + Math.floor(Math.random() * 200),
        latencyMs: 1500 + Math.floor(Math.random() * 1000),
        outcome: 'success',
      });
    }

    // Analyze after all traces
    strategy.analyze();

    // Verify: advice should be stable (same call twice = same result)
    const advice1 = strategy.getSectionAdvice('code', 'task-performance');
    const advice2 = strategy.getSectionAdvice('code', 'task-performance');
    assertEqual(advice1, advice2, 'advice should be deterministic (no oscillation)');

    // Verify: traces were actually recorded
    const traces = provenance.getRecentTraces(10);
    assertEqual(traces.length, 10, 'should have 10 traces');

    // Verify: all traces have budget + prompt metadata
    for (const t of traces) {
      assert(t.budget, `trace ${t.id} should have budget`);
      assert(t.prompt, `trace ${t.id} should have prompt metadata`);
      assert(t.response, `trace ${t.id} should have response`);
    }
  });

  test('mixed intents produce per-intent advice', () => {
    const bus = mockBus();
    const provenance = new ExecutionProvenance({ bus });
    const strategy = new AdaptivePromptStrategy({
      bus,
      config: { analyzeEvery: 999, minSamples: 2 },
    });
    strategy._provenance = provenance;

    // 5 code traces — all succeed
    for (let i = 0; i < 5; i++) {
      const tid = provenance.beginTrace(`code ${i}`);
      provenance.recordIntent(tid, { type: 'code', confidence: 0.9 });
      provenance.recordPrompt(tid, {
        active: ['identity', 'capabilities', 'task-performance'],
        skipped: [],
        boosted: [],
        tier: 'complex',
      });
      provenance.endTrace(tid, { tokens: 400, latencyMs: 2000, outcome: 'success' });
    }

    // 5 chat traces — all succeed
    for (let i = 0; i < 5; i++) {
      const tid = provenance.beginTrace(`chat ${i}`);
      provenance.recordIntent(tid, { type: 'chat', confidence: 0.9 });
      provenance.recordPrompt(tid, {
        active: ['identity', 'session', 'organism-state'],
        skipped: ['capabilities'],
        boosted: [],
        tier: 'moderate',
      });
      provenance.endTrace(tid, { tokens: 200, latencyMs: 1000, outcome: 'success' });
    }

    strategy.analyze();

    // Code and chat should potentially have different advice
    // (at minimum they should not error)
    const codeAdvice = strategy.getSectionAdvice('code', 'capabilities');
    const chatAdvice = strategy.getSectionAdvice('chat', 'capabilities');
    assert(typeof codeAdvice === 'string', 'code advice should be a string');
    assert(typeof chatAdvice === 'string', 'chat advice should be a string');
  });

  test('provenance ring buffer respects capacity', () => {
    const bus = mockBus();
    const provenance = new ExecutionProvenance({ bus, config: { maxTraces: 5 } });

    // Create 8 traces — should evict oldest
    for (let i = 0; i < 8; i++) {
      const tid = provenance.beginTrace(`msg ${i}`);
      provenance.endTrace(tid, { outcome: 'success' });
    }

    const recent = provenance.getRecentTraces(10);
    assert(recent.length <= 5, `should have max 5 traces, got ${recent.length}`);
  });
});

// ═══════════════════════════════════════════════════════════
// 5. Edge Cases & Safety
// ═══════════════════════════════════════════════════════════

describe('Intelligence Pipeline — Edge Cases', () => {

  test('provenance handles endTrace before recordBudget', () => {
    const bus = mockBus();
    const provenance = new ExecutionProvenance({ bus });
    const tid = provenance.beginTrace('quick');
    // Skip budget/intent/prompt — go straight to end
    provenance.endTrace(tid, { outcome: 'success' });
    const trace = provenance.getTrace(tid);
    assert(trace.response, 'trace should complete without budget');
    assertEqual(trace.response.outcome, 'success', 'outcome should be recorded');
  });

  test('strategy handles empty provenance gracefully', () => {
    const bus = mockBus();
    const strategy = new AdaptivePromptStrategy({ bus, config: { analyzeEvery: 999 } });
    // Analyze with no traces — should not throw
    strategy.analyze();
    const advice = strategy.getSectionAdvice('code', 'identity');
    assertEqual(advice, 'neutral', 'empty data → neutral advice');
  });

  test('budget disabled mode bypasses all filtering', () => {
    const budget = new CognitiveBudget({ config: { enabled: false } });
    const result = budget.assess('hi');
    assertEqual(result.tierName, 'complex', 'disabled → always complex');
    assert(budget.shouldIncludeSection('consciousness-state', result),
      'disabled → include everything');
  });

  test('provenance getLastTrace returns most recent', () => {
    const bus = mockBus();
    const provenance = new ExecutionProvenance({ bus });
    const t1 = provenance.beginTrace('first');
    provenance.endTrace(t1, { outcome: 'success' });
    const t2 = provenance.beginTrace('second');
    provenance.endTrace(t2, { outcome: 'success' });

    const last = provenance.getLastTrace();
    assert(last, 'should return last trace');
    assertEqual(last.id, t2, 'should be the most recent trace');
  });
});

run();
