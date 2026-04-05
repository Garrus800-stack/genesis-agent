// ============================================================
// Test: v6.0.4 — AdaptivePromptStrategy
// Self-optimizing prompt sections based on provenance data.
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const { AdaptivePromptStrategy, PROTECTED_SECTIONS } = require('../../src/agent/intelligence/AdaptivePromptStrategy');

function mockBus() {
  const _listeners = new Map();
  return {
    on(ev, fn, opts) {
      if (!_listeners.has(ev)) _listeners.set(ev, []);
      _listeners.get(ev).push(fn);
      return () => {};
    },
    emit(ev, data) {
      const ls = _listeners.get(ev);
      if (ls) for (const fn of ls) fn(data);
    },
    fire(ev, data) { this.emit(ev, data); },
  };
}

function mockProvenance(traces) {
  return {
    getRecentTraces: (n) => traces.slice(-n),
  };
}

// ═══════════════════════════════════════════════════════════
// Section Advice
// ═══════════════════════════════════════════════════════════

describe('AdaptivePromptStrategy — getSectionAdvice', () => {
  test('returns neutral when disabled', () => {
    const aps = new AdaptivePromptStrategy({ config: { enabled: false } });
    assertEqual(aps.getSectionAdvice('general', 'organism'), 'neutral');
  });

  test('returns neutral for unknown intent', () => {
    const aps = new AdaptivePromptStrategy({});
    assertEqual(aps.getSectionAdvice('unknown-intent', 'organism'), 'neutral');
  });

  test('never skips protected sections', () => {
    const aps = new AdaptivePromptStrategy({});
    // Even if we manually set a skip recommendation
    aps._recommendations = { general: { identity: 'skip', formatting: 'skip', safety: 'skip' } };
    assertEqual(aps.getSectionAdvice('general', 'identity'), 'neutral');
    assertEqual(aps.getSectionAdvice('general', 'formatting'), 'neutral');
    assertEqual(aps.getSectionAdvice('general', 'safety'), 'neutral');
  });

  test('returns boost/skip for non-protected sections', () => {
    const aps = new AdaptivePromptStrategy({});
    aps._recommendations = { general: { organism: 'boost', consciousness: 'skip' } };
    assertEqual(aps.getSectionAdvice('general', 'organism'), 'boost');
    assertEqual(aps.getSectionAdvice('general', 'consciousness'), 'skip');
  });
});

// ═══════════════════════════════════════════════════════════
// Analysis
// ═══════════════════════════════════════════════════════════

describe('AdaptivePromptStrategy — Analysis', () => {
  test('needs minimum samples before recommending', () => {
    const aps = new AdaptivePromptStrategy({ config: { minSamples: 10 } });
    aps._provenance = mockProvenance([
      // Only 3 traces — not enough
      { intent: { type: 'general' }, prompt: { activeList: ['organism'], skippedList: [] }, response: { outcome: 'success' } },
      { intent: { type: 'general' }, prompt: { activeList: ['organism'], skippedList: [] }, response: { outcome: 'success' } },
      { intent: { type: 'general' }, prompt: { activeList: [], skippedList: ['organism'] }, response: { outcome: 'error' } },
    ]);
    aps._analyze();
    // Not enough data — should stay neutral
    assertEqual(aps.getSectionAdvice('general', 'organism'), 'neutral');
  });

  test('detects section that helps (boost)', () => {
    const aps = new AdaptivePromptStrategy({ config: { minSamples: 5 } });
    // 10 traces: organism active → 80% success, organism skipped → 40% success
    const traces = [];
    for (let i = 0; i < 5; i++) {
      traces.push({ intent: { type: 'general' }, prompt: { activeList: ['organism', 'knowledge'], skippedList: [] }, response: { outcome: 'success' } });
    }
    traces.push({ intent: { type: 'general' }, prompt: { activeList: ['organism', 'knowledge'], skippedList: [] }, response: { outcome: 'error' } });
    for (let i = 0; i < 2; i++) {
      traces.push({ intent: { type: 'general' }, prompt: { activeList: ['knowledge'], skippedList: ['organism'] }, response: { outcome: 'success' } });
    }
    for (let i = 0; i < 3; i++) {
      traces.push({ intent: { type: 'general' }, prompt: { activeList: ['knowledge'], skippedList: ['organism'] }, response: { outcome: 'error' } });
    }

    aps._provenance = mockProvenance(traces);
    aps._analyze();

    // organism: 5/6 (83%) with vs 2/5 (40%) without = +43pp → boost
    assertEqual(aps.getSectionAdvice('general', 'organism'), 'boost');
  });

  test('detects section with no impact (skip)', () => {
    const aps = new AdaptivePromptStrategy({ config: { minSamples: 5 } });
    const traces = [];
    // consciousness active: 3/5 success (60%)
    for (let i = 0; i < 3; i++) {
      traces.push({ intent: { type: 'general' }, prompt: { activeList: ['consciousness'], skippedList: [] }, response: { outcome: 'success' } });
    }
    for (let i = 0; i < 2; i++) {
      traces.push({ intent: { type: 'general' }, prompt: { activeList: ['consciousness'], skippedList: [] }, response: { outcome: 'error' } });
    }
    // consciousness skipped: 4/5 success (80%) — actually better without!
    for (let i = 0; i < 4; i++) {
      traces.push({ intent: { type: 'general' }, prompt: { activeList: [], skippedList: ['consciousness'] }, response: { outcome: 'success' } });
    }
    traces.push({ intent: { type: 'general' }, prompt: { activeList: [], skippedList: ['consciousness'] }, response: { outcome: 'error' } });

    aps._provenance = mockProvenance(traces);
    aps._analyze();

    // consciousness: 60% with vs 80% without = -20pp → skip
    assertEqual(aps.getSectionAdvice('general', 'consciousness'), 'skip');
  });

  test('handles multiple intents independently', () => {
    const aps = new AdaptivePromptStrategy({ config: { minSamples: 5 } });
    const traces = [];

    // For "general": organism helps (+40pp)
    for (let i = 0; i < 4; i++) traces.push({ intent: { type: 'general' }, prompt: { activeList: ['organism'], skippedList: [] }, response: { outcome: 'success' } });
    traces.push({ intent: { type: 'general' }, prompt: { activeList: ['organism'], skippedList: [] }, response: { outcome: 'error' } });
    for (let i = 0; i < 2; i++) traces.push({ intent: { type: 'general' }, prompt: { activeList: [], skippedList: ['organism'] }, response: { outcome: 'success' } });
    for (let i = 0; i < 3; i++) traces.push({ intent: { type: 'general' }, prompt: { activeList: [], skippedList: ['organism'] }, response: { outcome: 'error' } });

    // For "self-modify": organism doesn't help (equal)
    for (let i = 0; i < 3; i++) traces.push({ intent: { type: 'self-modify' }, prompt: { activeList: ['organism'], skippedList: [] }, response: { outcome: 'success' } });
    for (let i = 0; i < 2; i++) traces.push({ intent: { type: 'self-modify' }, prompt: { activeList: ['organism'], skippedList: [] }, response: { outcome: 'error' } });
    for (let i = 0; i < 3; i++) traces.push({ intent: { type: 'self-modify' }, prompt: { activeList: [], skippedList: ['organism'] }, response: { outcome: 'success' } });
    for (let i = 0; i < 2; i++) traces.push({ intent: { type: 'self-modify' }, prompt: { activeList: [], skippedList: ['organism'] }, response: { outcome: 'error' } });

    aps._provenance = mockProvenance(traces);
    aps._analyze();

    assertEqual(aps.getSectionAdvice('general', 'organism'), 'boost');
    assertEqual(aps.getSectionAdvice('self-modify', 'organism'), 'neutral');
  });
});

// ═══════════════════════════════════════════════════════════
// Strategy + Report
// ═══════════════════════════════════════════════════════════

describe('AdaptivePromptStrategy — getStrategy + getReport', () => {
  test('getStrategy returns categorized sections', () => {
    const aps = new AdaptivePromptStrategy({});
    aps._recommendations = {
      general: { organism: 'boost', consciousness: 'skip', knowledge: 'neutral' },
    };
    const strategy = aps.getStrategy('general');
    assert(strategy.boosts.includes('organism'));
    assert(strategy.skips.includes('consciousness'));
    assert(strategy.neutral.includes('knowledge'));
  });

  test('getReport includes effectiveness details', () => {
    const aps = new AdaptivePromptStrategy({});
    aps._recommendations = { general: { organism: 'boost' } };
    aps._effectiveness = {
      general: {
        organism: { withSuccess: 8, withTotal: 10, withoutSuccess: 4, withoutTotal: 10 },
      },
    };
    const report = aps.getReport();
    assert(report.strategies.general, 'should have general strategy');
    assert(report.strategies.general.details.organism, 'should have organism details');
    assert(report.strategies.general.details.organism.delta.includes('+'), 'should show positive delta');
  });

  test('getReport for empty strategy', () => {
    const aps = new AdaptivePromptStrategy({});
    const report = aps.getReport();
    assertEqual(Object.keys(report.strategies).length, 0);
    assert(report.enabled);
  });
});

// ═══════════════════════════════════════════════════════════
// Protected Sections
// ═══════════════════════════════════════════════════════════

describe('AdaptivePromptStrategy — Protected Sections', () => {
  test('PROTECTED_SECTIONS includes essentials', () => {
    assert(PROTECTED_SECTIONS.has('identity'));
    assert(PROTECTED_SECTIONS.has('formatting'));
    assert(PROTECTED_SECTIONS.has('safety'));
    assert(PROTECTED_SECTIONS.has('capabilities'));
    assert(PROTECTED_SECTIONS.has('session'));
  });

  test('organism is NOT protected', () => {
    assert(!PROTECTED_SECTIONS.has('organism'));
    assert(!PROTECTED_SECTIONS.has('consciousness'));
    assert(!PROTECTED_SECTIONS.has('bodySchema'));
  });
});

// ═══════════════════════════════════════════════════════════
// Lifecycle
// ═══════════════════════════════════════════════════════════

describe('AdaptivePromptStrategy — Lifecycle', () => {
  test('start/stop without crash', () => {
    const bus = mockBus();
    const aps = new AdaptivePromptStrategy({ bus });
    aps.start();
    aps.stop();
    assert(true, 'should not crash');
  });

  test('persistence save/load roundtrip', () => {
    const stored = {};
    const mockStorage = {
      writeJSON(f, d) { stored[f] = JSON.parse(JSON.stringify(d)); },
      readJSON(f, fb) { return stored[f] || fb; },
    };
    const aps1 = new AdaptivePromptStrategy({});
    aps1._storage = mockStorage;
    aps1._recommendations = { general: { organism: 'boost' } };
    aps1._effectiveness = { general: { organism: { withSuccess: 8, withTotal: 10, withoutSuccess: 4, withoutTotal: 10 } } };
    aps1._save();

    const aps2 = new AdaptivePromptStrategy({});
    aps2._storage = mockStorage;
    aps2._load();
    assertEqual(aps2._recommendations.general.organism, 'boost');
    assertEqual(aps2._effectiveness.general.organism.withSuccess, 8);
  });
});

if (require.main === module) run();
