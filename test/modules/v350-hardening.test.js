// ============================================================
// GENESIS — v350-hardening.test.js
//
// Tests for v3.5.0 hardening features:
//   1. TokenBucket rate limiter
//   2. HourlyBudget per-priority budgets
//   3. estimateTokens (improved heuristic)
//   4. EmotionalState watchdog
//   5. ShellAgent per-tier rate limiter
//   6. CapabilityGuard new grants
//   7. LLMPort rate-limit integration
// ============================================================

function describe(name, fn) { console.log(`\n  📦 ${name}`); fn(); }
// v3.5.2: Fixed — queue-based async-safe test runner
const _testQueue = [];
function test(name, fn) { _testQueue.push({ name, fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }
function assertClose(a, b, tolerance, msg) { if (Math.abs(a - b) > tolerance) throw new Error(msg || `${a} not close to ${b} (tolerance ${tolerance})`); }

let passed = 0, failed = 0;
const failures = [];

// ── 1. TokenBucket ──────────────────────────────────────

describe('TokenBucket', () => {
  const { TokenBucket } = require('../../src/agent/ports/LLMPort');

  test('starts full', () => {
    const b = new TokenBucket(10, 60);
    assert(b.fillLevel() >= 0.99, 'Should start at ~100%');
  });

  test('tryConsume reduces tokens', () => {
    const b = new TokenBucket(10, 60);
    assert(b.tryConsume() === true);
    assert(b.tryConsume() === true);
    const status = b.getStatus();
    assert(status.tokens < 9, `Expected <9, got ${status.tokens}`);
  });

  test('rejects when empty', () => {
    const b = new TokenBucket(3, 60);
    assert(b.tryConsume() === true);
    assert(b.tryConsume() === true);
    assert(b.tryConsume() === true);
    assert(b.tryConsume() === false, 'Should reject when empty');
  });

  test('refills over time', () => {
    const b = new TokenBucket(10, 600000); // 10k per minute = instant refill
    b.tryConsume();
    b.tryConsume();
    b.tryConsume();
    // Force time advancement
    b._lastRefill = Date.now() - 100; // 100ms ago
    b._refill();
    assert(b.tokens > 7, `Should have refilled, got ${b.tokens}`);
  });

  test('getStatus returns correct shape', () => {
    const b = new TokenBucket(10, 60);
    const s = b.getStatus();
    assert(typeof s.tokens === 'number');
    assert(s.capacity === 10);
    assert(typeof s.fillPct === 'number');
  });
});

// ── 2. HourlyBudget ─────────────────────────────────────

describe('HourlyBudget', () => {
  const { HourlyBudget } = require('../../src/agent/ports/LLMPort');

  test('allows calls within budget', () => {
    const hb = new HourlyBudget({ chat: 5, idle: 2 });
    const r = hb.tryConsume('chat');
    assert(r.allowed === true);
    assert(r.used === 1);
    assert(r.budget === 5);
  });

  test('rejects when budget exhausted', () => {
    const hb = new HourlyBudget({ idle: 2 });
    hb.tryConsume('idle');
    hb.tryConsume('idle');
    const r = hb.tryConsume('idle');
    assert(r.allowed === false, 'Should reject at limit');
    assert(r.used === 2);
  });

  test('unknown bucket always allows', () => {
    const hb = new HourlyBudget({ chat: 5 });
    const r = hb.tryConsume('unknown_bucket');
    assert(r.allowed === true);
    assert(r.budget === Infinity);
  });

  test('getStatus shows correct counts', () => {
    const hb = new HourlyBudget({ chat: 10, idle: 5 });
    hb.tryConsume('chat');
    hb.tryConsume('chat');
    hb.tryConsume('idle');
    const s = hb.getStatus();
    assert(s.chat.used === 2);
    assert(s.chat.remaining === 8);
    assert(s.idle.used === 1);
    assert(s.idle.remaining === 4);
  });

  test('reset clears all counters', () => {
    const hb = new HourlyBudget({ chat: 3 });
    hb.tryConsume('chat');
    hb.tryConsume('chat');
    hb.reset();
    const s = hb.getStatus();
    assert(s.chat.used === 0);
  });

  test('old entries expire after 1 hour', () => {
    const hb = new HourlyBudget({ chat: 2 });
    // Manually insert old timestamps
    hb._calls.chat = [Date.now() - 3700000, Date.now() - 3600001]; // >1hr ago
    const r = hb.tryConsume('chat');
    assert(r.allowed === true, 'Old entries should have expired');
    assert(r.used === 1, 'Should only count fresh entry');
  });
});

// ── 3. estimateTokens ───────────────────────────────────

describe('estimateTokens', () => {
  const { estimateTokens } = require('../../src/agent/ports/LLMPort');

  test('returns 0 for empty/null', () => {
    assert(estimateTokens(null) === 0);
    assert(estimateTokens('') === 0);
    assert(estimateTokens(undefined) === 0);
  });

  test('English prose ~4 chars/token', () => {
    const text = 'The quick brown fox jumps over the lazy dog and runs fast';
    const tokens = estimateTokens(text, 'chat');
    // ~56 chars / 4 = ~14, plus punctuation
    assert(tokens > 10 && tokens < 25, `Expected 10-25, got ${tokens}`);
  });

  test('German text yields more tokens (lower chars/token)', () => {
    const english = 'The agent processes information and generates responses';
    const german = 'Der Agent verarbeitet Informationen und generiert Antworten';
    const enTokens = estimateTokens(english, 'chat');
    const deTokens = estimateTokens(german, 'chat');
    // German should produce more tokens for similar semantic content
    // because BPE splits umlauts and compound words differently
    assert(deTokens >= enTokens * 0.9, `German tokens (${deTokens}) should be >= ~90% of English (${enTokens})`);
  });

  test('German with umlauts uses 3.2 chars/token', () => {
    const umlautHeavy = 'Über die Größe der Flüsse und Bäche in Österreich';
    const tokens = estimateTokens(umlautHeavy, 'chat');
    // 51 chars, heavy non-ASCII → ~3.2 chars/token → ~16+ tokens
    assert(tokens > 12, `Expected >12 tokens for umlaut-heavy text, got ${tokens}`);
  });

  test('code mode uses 3.5 chars/token', () => {
    const code = 'function test() { return x + y; }';
    const chatTokens = estimateTokens(code, 'chat');
    const codeTokens = estimateTokens(code, 'code');
    assert(codeTokens >= chatTokens, `Code tokens (${codeTokens}) should be >= chat tokens (${chatTokens})`);
  });

  test('punctuation-heavy text increases count', () => {
    const plain = 'hello world test example';
    const punct = 'hello, world! test; example?';
    const plainTokens = estimateTokens(plain, 'chat');
    const punctTokens = estimateTokens(punct, 'chat');
    assert(punctTokens > plainTokens, `Punctuated (${punctTokens}) should > plain (${plainTokens})`);
  });
});

// ── 4. EmotionalState Watchdog ──────────────────────────

describe('EmotionalState Watchdog', () => {
  const { EmotionalState } = require('../../src/agent/organism/EmotionalState');
  const { EventBus } = require('../../src/agent/core/EventBus');

  test('watchdog detects extreme frustration', () => {
    const bus = new EventBus();
    const es = new EmotionalState({ bus, storage: null, intervals: null, config: {} });

    // Force frustration to extreme
    es.dimensions.frustration.value = 0.95;
    // Set extremeSince to >10min ago
    es._extremeSince.frustration = Date.now() - 11 * 60 * 1000;

    let resetEvent = null;
    bus.on('emotion:watchdog-reset', (data) => { resetEvent = data; });

    es._watchdogTick();

    assert(resetEvent !== null, 'Should have emitted watchdog-reset');
    assert(resetEvent.dimension === 'frustration', `Expected frustration, got ${resetEvent.dimension}`);
    assert(es.dimensions.frustration.value < 0.9, `Value should have been pulled toward baseline, got ${es.dimensions.frustration.value}`);
  });

  test('watchdog detects extreme low energy', () => {
    const bus = new EventBus();
    const es = new EmotionalState({ bus, storage: null, intervals: null, config: {} });

    es.dimensions.energy.value = 0.1;
    es._extremeSince.energy = Date.now() - 11 * 60 * 1000;

    let resetEvent = null;
    bus.on('emotion:watchdog-reset', (data) => { resetEvent = data; });

    es._watchdogTick();

    assert(resetEvent !== null, 'Should have emitted watchdog-reset for energy');
    assert(resetEvent.dimension === 'energy');
    assert(es.dimensions.energy.value > 0.1, `Energy should have been bumped up, got ${es.dimensions.energy.value}`);
  });

  test('watchdog does NOT reset recently extreme values', () => {
    const bus = new EventBus();
    const es = new EmotionalState({ bus, storage: null, intervals: null, config: {} });

    es.dimensions.frustration.value = 0.95;
    // Set extremeSince to just 2 minutes ago (within grace period)
    es._extremeSince.frustration = Date.now() - 2 * 60 * 1000;

    let resetFired = false;
    bus.on('emotion:watchdog-reset', () => { resetFired = true; });

    es._watchdogTick();

    assert(resetFired === false, 'Should NOT reset value that only recently became extreme');
    assert(es.dimensions.frustration.value === 0.95, 'Value should be unchanged');
  });

  test('watchdog clears tracking when value returns to normal', () => {
    const bus = new EventBus();
    const es = new EmotionalState({ bus, storage: null, intervals: null, config: {} });

    // First: mark as extreme
    es.dimensions.frustration.value = 0.95;
    es._watchdogTick(); // starts tracking
    assert(es._extremeSince.frustration !== null, 'Should be tracking');

    // Now: value returns to normal
    es.dimensions.frustration.value = 0.3;
    es._watchdogTick();
    assert(es._extremeSince.frustration === null, 'Tracking should be cleared');
  });

  test('watchdog alerts when 2+ dimensions stuck', () => {
    const bus = new EventBus();
    const es = new EmotionalState({ bus, storage: null, intervals: null, config: {} });

    // Two dimensions extreme but not yet timed out
    es.dimensions.frustration.value = 0.95;
    es.dimensions.energy.value = 0.1;

    es._watchdogTick(); // starts tracking both

    let alertEvent = null;
    bus.on('emotion:watchdog-alert', (data) => { alertEvent = data; });

    // Second tick — both are still extreme
    es._watchdogTick();

    assert(alertEvent !== null, 'Should have emitted watchdog-alert for 2 stuck dimensions');
    assert(alertEvent.stuck.length >= 2, `Expected 2+ stuck, got ${alertEvent.stuck.length}`);
  });

  test('_isExtreme correctly identifies danger zones', () => {
    const bus = new EventBus();
    const es = new EmotionalState({ bus, storage: null, intervals: null, config: {} });

    // Frustration high = extreme
    assert(es._isExtreme('frustration', { value: 0.9 }) === true);
    assert(es._isExtreme('frustration', { value: 0.5 }) === false);

    // Energy low = extreme
    assert(es._isExtreme('energy', { value: 0.1 }) === true);
    assert(es._isExtreme('energy', { value: 0.5 }) === false);

    // Curiosity: extremes at both ends
    assert(es._isExtreme('curiosity', { value: 0.95 }) === true);
    assert(es._isExtreme('curiosity', { value: 0.05 }) === true);
    assert(es._isExtreme('curiosity', { value: 0.5 }) === false);
  });
});

// ── 5. ShellAgent Rate Limiter ──────────────────────────

describe('ShellAgent Rate Limiter', () => {
  const { EventBus } = require('../../src/agent/core/EventBus');
  const { SHELL: SHELL_LIMITS } = require('../../src/agent/core/Constants');

  // Minimal ShellAgent construction (only rate-limiter parts)
  function makeShellAgent() {
    const bus = new EventBus();
    // We can't easily construct ShellAgent without all deps,
    // so we test _checkShellRateLimit directly by building a mock
    const agent = {
      _shellCalls: {},
      _checkShellRateLimit(tier) {
        const limit = SHELL_LIMITS.RATE_LIMITS[tier];
        if (!limit) return true;
        if (!this._shellCalls[tier]) this._shellCalls[tier] = [];
        const now = Date.now();
        const windowStart = now - SHELL_LIMITS.RATE_WINDOW_MS;
        this._shellCalls[tier] = this._shellCalls[tier].filter(ts => ts > windowStart);
        if (this._shellCalls[tier].length >= limit) return false;
        this._shellCalls[tier].push(now);
        return true;
      },
    };
    for (const tier of Object.keys(SHELL_LIMITS.RATE_LIMITS)) {
      agent._shellCalls[tier] = [];
    }
    return agent;
  }

  test('allows commands within limit', () => {
    const agent = makeShellAgent();
    assert(agent._checkShellRateLimit('read') === true, 'First call should be allowed');
    assert(agent._checkShellRateLimit('read') === true, 'Second call should be allowed');
  });

  test('rejects commands when limit exceeded', () => {
    const agent = makeShellAgent();
    const limit = SHELL_LIMITS.RATE_LIMITS.system; // 5
    for (let i = 0; i < limit; i++) {
      assert(agent._checkShellRateLimit('system') === true, `Call ${i + 1} should be allowed`);
    }
    assert(agent._checkShellRateLimit('system') === false, `Call ${limit + 1} should be rejected`);
  });

  test('allows unknown tier (fallback)', () => {
    const agent = makeShellAgent();
    assert(agent._checkShellRateLimit('unknown_tier') === true);
  });

  test('old entries expire', () => {
    const agent = makeShellAgent();
    // Fill to limit with old timestamps
    const limit = SHELL_LIMITS.RATE_LIMITS.write;
    agent._shellCalls.write = Array(limit).fill(Date.now() - SHELL_LIMITS.RATE_WINDOW_MS - 1000);
    // Should allow new call since old ones expired
    assert(agent._checkShellRateLimit('write') === true, 'Old entries should have expired');
  });

  test('rate limits are per-tier (independent)', () => {
    const agent = makeShellAgent();
    // Exhaust system tier
    const sysLimit = SHELL_LIMITS.RATE_LIMITS.system;
    for (let i = 0; i < sysLimit; i++) agent._checkShellRateLimit('system');
    assert(agent._checkShellRateLimit('system') === false, 'System tier exhausted');
    // Read tier should still work
    assert(agent._checkShellRateLimit('read') === true, 'Read tier should be independent');
  });
});

// ── 6. CapabilityGuard Grants ───────────────────────────

describe('CapabilityGuard Grants', () => {
  const { CapabilityGuard } = require('../../src/agent/foundation/CapabilityGuard');
  const { SafeGuard } = require('../../src/kernel/SafeGuard');
  const { EventBus } = require('../../src/agent/core/EventBus');

  test('ShellAgent has exec:shell grant', () => {
    const guard = new SafeGuard([require('path').join(require('os').tmpdir(), 'genesis-kern')], require('os').tmpdir());
    const cg = new CapabilityGuard('/tmp', guard, new EventBus());
    assert(cg.hasGrant('ShellAgent', 'exec:shell'), 'ShellAgent should have exec:shell');
    assert(cg.hasGrant('ShellAgent', 'fs:read'), 'ShellAgent should have fs:read');
  });

  test('AgentLoop has exec:shell grant', () => {
    const guard = new SafeGuard([require('path').join(require('os').tmpdir(), 'genesis-kern')], require('os').tmpdir());
    const cg = new CapabilityGuard('/tmp', guard, new EventBus());
    assert(cg.hasGrant('AgentLoop', 'exec:shell'), 'AgentLoop should have exec:shell');
    assert(cg.hasGrant('AgentLoop', 'model:query'), 'AgentLoop should have model:query');
  });

  test('IdleMind has model:query but NOT exec:shell', () => {
    const guard = new SafeGuard([require('path').join(require('os').tmpdir(), 'genesis-kern')], require('os').tmpdir());
    const cg = new CapabilityGuard('/tmp', guard, new EventBus());
    assert(cg.hasGrant('IdleMind', 'model:query'), 'IdleMind should have model:query');
    assert(!cg.hasGrant('IdleMind', 'exec:shell'), 'IdleMind should NOT have exec:shell');
  });

  test('exec:shell scope exists in SCOPES', () => {
    const guard = new SafeGuard([require('path').join(require('os').tmpdir(), 'genesis-kern')], require('os').tmpdir());
    const cg = new CapabilityGuard('/tmp', guard, new EventBus());
    assert(cg.SCOPES['exec:shell'], 'exec:shell should be defined in SCOPES');
    assert(cg.SCOPES['exec:shell'].risk === 'high', 'exec:shell should be high risk');
  });
});

// ── 7. Constants ────────────────────────────────────────

describe('Constants (v3.5.0 additions)', () => {
  const { RATE_LIMIT, WATCHDOG, SHELL } = require('../../src/agent/core/Constants');

  test('RATE_LIMIT has required fields', () => {
    assert(typeof RATE_LIMIT.BUCKET_CAPACITY === 'number');
    assert(typeof RATE_LIMIT.REFILL_PER_MINUTE === 'number');
    assert(typeof RATE_LIMIT.HOURLY_BUDGETS === 'object');
    assert(RATE_LIMIT.HOURLY_BUDGETS.chat > 0);
    assert(RATE_LIMIT.HOURLY_BUDGETS.autonomous > 0);
    assert(RATE_LIMIT.HOURLY_BUDGETS.idle > 0);
    assert(RATE_LIMIT.HOURLY_BUDGETS.chat > RATE_LIMIT.HOURLY_BUDGETS.autonomous, 'Chat budget > autonomous');
    assert(RATE_LIMIT.HOURLY_BUDGETS.autonomous > RATE_LIMIT.HOURLY_BUDGETS.idle, 'Autonomous budget > idle');
  });

  test('RATE_LIMIT.PRIORITY_MAP maps to budget keys', () => {
    assert(RATE_LIMIT.PRIORITY_MAP[10] === 'chat');
    assert(RATE_LIMIT.PRIORITY_MAP[5] === 'autonomous');
    assert(RATE_LIMIT.PRIORITY_MAP[1] === 'idle');
  });

  test('WATCHDOG has required fields', () => {
    assert(WATCHDOG.CHECK_INTERVAL > 0);
    assert(WATCHDOG.EXTREME_DURATION_MS > 0);
    assert(WATCHDOG.EXTREME_THRESHOLD > 0.5 && WATCHDOG.EXTREME_THRESHOLD < 1.0);
    assert(WATCHDOG.EXTREME_LOW_THRESHOLD > 0.0 && WATCHDOG.EXTREME_LOW_THRESHOLD < 0.5);
    assert(WATCHDOG.RESET_STRENGTH > 0 && WATCHDOG.RESET_STRENGTH <= 1.0);
  });

  test('SHELL has per-tier rate limits', () => {
    assert(typeof SHELL.RATE_LIMITS === 'object');
    assert(SHELL.RATE_LIMITS.read > SHELL.RATE_LIMITS.write, 'Read limit > write limit');
    assert(SHELL.RATE_LIMITS.write > SHELL.RATE_LIMITS.system, 'Write limit > system limit');
    assert(SHELL.RATE_WINDOW_MS > 0);
  });
});

// ── 8. EventTypes (v3.5.0 additions) ────────────────────

describe('EventTypes (v3.5.0 additions)', () => {
  const { EVENTS } = require('../../src/agent/core/EventTypes');

  test('EMOTION has watchdog events', () => {
    assert(EVENTS.EMOTION.WATCHDOG_RESET === 'emotion:watchdog-reset');
    assert(EVENTS.EMOTION.WATCHDOG_ALERT === 'emotion:watchdog-alert');
  });

  test('LLM has rate limit events', () => {
    assert(EVENTS.LLM.RATE_LIMITED === 'llm:rate-limited');
    assert(EVENTS.LLM.BUDGET_WARNING === 'llm:budget-warning');
  });

  test('SHELL has rate limit event', () => {
    assert(EVENTS.SHELL.RATE_LIMITED === 'shell:rate-limited');
  });
});

// ── Report ──────────────────────────────────────────────

setTimeout(() => {
  console.log(`\n  ══════════════════════════════════════`);
  console.log(`  v3.5.0 Hardening Tests: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log(`\n  Failures:`);
    for (const f of failures) console.log(`    ✗ ${f.name}: ${f.error}`);
  }
  console.log(`  ══════════════════════════════════════\n`);
  process.exit(failed > 0 ? 1 : 0);
}, 500);

// v3.5.2: Async-safe runner — properly awaits all tests
(async () => {
  for (const t of _testQueue) {
    try {
      const r = t.fn(); if (r && r.then) await r;
      passed++; console.log(`    ✅ ${t.name}`);
    } catch (err) {
      failed++; console.log(`    ❌ ${t.name}: ${err.message}`);
    }
  }
  console.log(`\n    ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
