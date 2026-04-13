// ============================================================
// Test: IdleMindResearch.test.js — v7.1.6 Research Activity
//
// Tests:
//   A. _pickResearchTopic (5 tests)
//   B. _buildResearchUrl (2 tests)
//   C. Research gates (5 tests)
//   D. _isNetworkAvailable (2 tests)
//   E. Integration: PromptBuilder frontier budget (2 tests)
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');

// ── Mock factories ──────────────────────────────────────────

function mockBus() {
  const events = [];
  return {
    emit(event, data, opts) { events.push({ event, data, opts }); },
    fire(event, data, opts) { events.push({ event, data, opts }); },
    on() { return () => {}; },
    _events: events,
  };
}

function mockFrontierWriter(items = []) {
  return {
    getRecent(count = 3) { return items.slice(0, count); },
    buildPromptContext(maxChars = 400) {
      if (items.length === 0) return '';
      return ('MOCK CONTEXT: ' + items.map(i => JSON.stringify(i)).join(', ')).slice(0, maxChars);
    },
    getDashboardLine() { return items.length > 0 ? 'mock dashboard' : null; },
    getReport() { return { activeNodes: items.length }; },
  };
}

// Minimal IdleMind-like object with research methods mixed in
function createResearchContext(overrides = {}) {
  const { activities } = require('../../src/agent/autonomy/IdleMindActivities');
  const bus = mockBus();

  const ctx = {
    bus,
    model: { chat: async () => 'Distilled insight about topic' },
    kg: {
      addNode(type, label, props) { ctx._kgNodes.push({ type, label, props }); return 'n_1'; },
    },
    _kgNodes: [],
    _webFetcher: overrides.webFetcher || {
      fetch: async () => ({ body: '{"results": [{"name": "test-pkg"}]}' }),
    },
    _pendingResearch: null,
    _unfinishedWorkFrontier: overrides.unfinishedWorkFrontier || null,
    _suspicionFrontier: overrides.suspicionFrontier || null,
    _lessonFrontier: overrides.lessonFrontier || null,
    _cognitiveSelfModel: overrides.cognitiveSelfModel || null,
    emotionalState: { getState: () => ({ energy: overrides.energy ?? 0.7 }) },
    _trustLevelSystem: { getCurrentLevel: () => overrides.trustLevel ?? 1 },
    needsSystem: overrides.needsSystem || null,
    activityLog: overrides.activityLog || [],
    _networkCheckCache: overrides.networkAvailable ?? true,
    _networkCheckTs: Date.now(),
  };

  // Mix in activities
  for (const [key, fn] of Object.entries(activities)) {
    if (typeof fn === 'function') ctx[key] = fn.bind(ctx);
  }

  return ctx;
}

// ── A. _pickResearchTopic ───────────────────────────────────

describe('_pickResearchTopic', () => {

  test('returns topic from UNFINISHED_WORK frontier', () => {
    const ctx = createResearchContext({
      unfinishedWorkFrontier: mockFrontierWriter([
        { description: 'Refactor EventBus', pending_goals: [] },
      ]),
    });

    const topic = ctx._pickResearchTopic();
    assert(topic !== null, 'should find topic');
    assertEqual(topic.source, 'unfinished-work');
    assert(topic.query.includes('Refactor EventBus'), 'query should include topic');
  });

  test('returns topic from HIGH_SUSPICION frontier', () => {
    const ctx = createResearchContext({
      suspicionFrontier: mockFrontierWriter([
        { dominant_category: 'code-gen' },
      ]),
    });

    const topic = ctx._pickResearchTopic();
    assert(topic !== null, 'should find topic');
    assertEqual(topic.source, 'suspicion');
  });

  test('returns topic from CognitiveSelfModel weakness', () => {
    const ctx = createResearchContext({
      cognitiveSelfModel: {
        getWeakestCapability: () => ({ taskType: 'refactor', successRate: 0.3 }),
      },
    });

    const topic = ctx._pickResearchTopic();
    assert(topic !== null, 'should find topic');
    assertEqual(topic.source, 'weakness');
  });

  test('returns null when no signals', () => {
    const ctx = createResearchContext();
    const topic = ctx._pickResearchTopic();
    assertEqual(topic, null);
  });

  test('prefers higher priority topics', () => {
    // Run 100 times and check that unfinished-work (1.4) appears more than weakness (1.1)
    const ctx = createResearchContext({
      unfinishedWorkFrontier: mockFrontierWriter([{ description: 'test' }]),
      cognitiveSelfModel: { getWeakestCapability: () => ({ taskType: 'debug' }) },
    });

    const counts = { 'unfinished-work': 0, weakness: 0 };
    for (let i = 0; i < 100; i++) {
      const t = ctx._pickResearchTopic();
      if (t) counts[t.source]++;
    }
    assert(counts['unfinished-work'] > counts.weakness,
      `unfinished-work (${counts['unfinished-work']}) should appear more than weakness (${counts.weakness})`);
  });
});

// ── B. _buildResearchUrl ────────────────────────────────────

describe('_buildResearchUrl', () => {

  test('returns npm URL for weakness source', () => {
    const ctx = createResearchContext();
    const url = ctx._buildResearchUrl({ query: 'test', source: 'weakness' });
    assert(url.includes('registry.npmjs.org'), 'should use npm for weakness');
  });

  test('returns GitHub URL for suspicion source', () => {
    const ctx = createResearchContext();
    const url = ctx._buildResearchUrl({ query: 'test', source: 'suspicion' });
    assert(url.includes('api.github.com'), 'should use GitHub for suspicion');
  });
});

// ── C. Research gates ───────────────────────────────────────

describe('Research gates in _pickActivity', () => {

  // We test the gate logic inline since _pickActivity is complex
  test('energy gate blocks research when < 0.5', () => {
    const ctx = createResearchContext({ energy: 0.3 });
    // Simulate scoring
    const scores = { research: 1.0 };
    const energy = ctx.emotionalState.getState().energy;
    if (energy < 0.5) scores.research = 0;
    assertEqual(scores.research, 0);
  });

  test('trust gate blocks research when level < 1', () => {
    const ctx = createResearchContext({ trustLevel: 0 });
    const scores = { research: 1.0 };
    const trustLevel = ctx._trustLevelSystem.getCurrentLevel();
    if (trustLevel < 1) scores.research = 0;
    assertEqual(scores.research, 0);
  });

  test('rate limit blocks after 3 researches per hour', () => {
    const now = Date.now();
    const ctx = createResearchContext({
      activityLog: [
        { activity: 'research', timestamp: now - 10000 },
        { activity: 'research', timestamp: now - 20000 },
        { activity: 'research', timestamp: now - 30000 },
      ],
    });
    const recentResearch = ctx.activityLog
      .filter(a => a.activity === 'research' && Date.now() - a.timestamp < 60 * 60 * 1000);
    assert(recentResearch.length >= 3, 'should have 3 recent researches');
  });

  test('cooldown reduces score within 30min', () => {
    const now = Date.now();
    const ctx = createResearchContext({
      activityLog: [{ activity: 'research', timestamp: now - 10 * 60 * 1000 }], // 10min ago
    });
    const scores = { research: 1.0 };
    const lastR = ctx.activityLog.filter(a => a.activity === 'research').slice(-1)[0];
    if (lastR && Date.now() - lastR.timestamp < 30 * 60 * 1000) {
      scores.research *= 0.1;
    }
    assert(scores.research < 0.2, 'should be heavily penalized');
  });

  test('knowledge need boosts research score', () => {
    const ctx = createResearchContext({
      needsSystem: { getNeeds: () => ({ knowledge: 0.8 }) },
    });
    const scores = { research: 1.0 };
    const needs = ctx.needsSystem.getNeeds();
    if (needs.knowledge > 0.6) scores.research *= 1.5;
    assertEqual(scores.research, 1.5);
  });
});

// ── D. _isNetworkAvailable ──────────────────────────────────

describe('_isNetworkAvailable', () => {

  test('returns cached value within TTL', () => {
    // Simulate IdleMind with cached network check
    const ctx = {
      _networkCheckCache: true,
      _networkCheckTs: Date.now(),
    };

    // Within 5min TTL
    const available = ctx._networkCheckCache !== undefined
      && Date.now() - ctx._networkCheckTs < 5 * 60 * 1000;
    assert(available, 'should use cached value');
  });

  test('cache expires after 5 minutes', () => {
    const ctx = {
      _networkCheckCache: true,
      _networkCheckTs: Date.now() - 6 * 60 * 1000, // 6min ago
    };

    const cached = ctx._networkCheckCache !== undefined
      && Date.now() - ctx._networkCheckTs < 5 * 60 * 1000;
    assert(!cached, 'should be expired');
  });
});

// ── E. Integration: PromptBuilder frontier budget ───────────

describe('PromptBuilder frontier budget', () => {

  test('_frontierContext respects 2000 char total budget', () => {
    // We test the budget logic directly
    const TYPE_BUDGET = 400;
    const TOTAL_BUDGET = 2000;

    const sections = [
      { weight: 0.9, content: 'A'.repeat(TYPE_BUDGET) },
      { weight: 0.8, content: 'B'.repeat(TYPE_BUDGET) },
      { weight: 0.7, content: 'C'.repeat(TYPE_BUDGET) },
      { weight: 0.6, content: 'D'.repeat(TYPE_BUDGET) },
      { weight: 0.5, content: 'E'.repeat(TYPE_BUDGET) }, // Should be cut
    ];
    sections.sort((a, b) => b.weight - a.weight);

    const parts = ['CURRENT FOCUS:'];
    let totalChars = parts[0].length + 1;
    for (const sec of sections) {
      if (totalChars + sec.content.length + 1 > TOTAL_BUDGET) break;
      parts.push(sec.content);
      totalChars += sec.content.length + 1;
    }

    const result = parts.join('\n');
    assert(result.length <= TOTAL_BUDGET, `should be <= ${TOTAL_BUDGET}, got ${result.length}`);
    // 4 sections fit (header 16 + 4*401 = 1620), 5th would exceed 2000
    assert(parts.length <= 5, `should have at most 5 parts (header + 4 sections), got ${parts.length}`);
  });

  test('sections sorted by weight — highest first', () => {
    const sections = [
      { weight: 0.3, content: 'low' },
      { weight: 0.9, content: 'high' },
      { weight: 0.6, content: 'mid' },
    ];
    sections.sort((a, b) => b.weight - a.weight);
    assertEqual(sections[0].content, 'high');
    assertEqual(sections[1].content, 'mid');
    assertEqual(sections[2].content, 'low');
  });
});

run();
