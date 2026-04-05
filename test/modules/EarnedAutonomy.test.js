// ============================================================
// TEST — EarnedAutonomy.js (v6.0.7)
// Wilson-score per-action trust tracker
// ============================================================

const { describe, test, run } = require('../harness');
const { EarnedAutonomy, wilsonLower } = require('../../src/agent/foundation/EarnedAutonomy');

// ── Mock Bus ─────────────────────────────────────────────────
function mockBus() {
  const events = [];
  return {
    on: (ev, fn) => { events.push({ ev, fn }); return () => {}; },
    emit: (ev, payload) => events.push({ ev, payload }),
    fire: (ev, payload) => events.push({ ev, payload }),
    events,
    getEmitted: (name) => events.filter(e => e.ev === name && e.payload),
  };
}

// ── Mock Storage ─────────────────────────────────────────────
function mockStorage() {
  const data = {};
  return {
    readJSON: async (k) => data[k] || null,
    writeJSON: async (k, v) => { data[k] = v; },
    data,
  };
}

// ════════════════════════════════════════════════════════════
// 1. WILSON SCORE MATH
// ════════════════════════════════════════════════════════════

describe('wilsonLower — math', () => {
  test('returns 0 for empty sample', () => {
    const r = wilsonLower(0, 0);
    if (r !== 0) throw new Error(`Expected 0, got ${r}`);
  });

  test('small perfect sample gets conservative score', () => {
    // 5/5 = 100% but Wilson should give a low lower bound
    const r = wilsonLower(5, 5);
    if (r > 0.60) throw new Error(`5/5 Wilson lower bound too high: ${r}`);
    if (r < 0.45) throw new Error(`5/5 Wilson lower bound too low: ${r}`);
  });

  test('large perfect sample gets high score', () => {
    // 50/50 should have Wilson lower bound > 0.9
    const r = wilsonLower(50, 50);
    if (r < 0.90) throw new Error(`50/50 Wilson lower bound too low: ${r}`);
  });

  test('90% success at 50 samples gives reasonable score', () => {
    const r = wilsonLower(45, 50);
    if (r < 0.78) throw new Error(`45/50 Wilson too low: ${r}`);
    if (r > 0.95) throw new Error(`45/50 Wilson too high: ${r}`);
  });

  test('50% success stays low', () => {
    const r = wilsonLower(25, 50);
    if (r > 0.40) throw new Error(`25/50 Wilson too high: ${r}`);
  });

  test('monotonically increases with success rate', () => {
    const w1 = wilsonLower(30, 50);
    const w2 = wilsonLower(40, 50);
    const w3 = wilsonLower(50, 50);
    if (w1 >= w2 || w2 >= w3) throw new Error(`Not monotonic: ${w1}, ${w2}, ${w3}`);
  });
});

// ════════════════════════════════════════════════════════════
// 2. RECORDING & PROMOTION
// ════════════════════════════════════════════════════════════

describe('EarnedAutonomy — recording', () => {
  test('constructs with defaults', () => {
    const ea = new EarnedAutonomy({ bus: mockBus() });
    const report = ea.getReport();
    if (report.length !== 0) throw new Error('Should start empty');
  });

  test('records outcomes per action type', () => {
    const ea = new EarnedAutonomy({ bus: mockBus(), config: { evaluateEvery: 1 } });
    ea.record('CODE_GENERATE', true);
    ea.record('CODE_GENERATE', true);
    ea.record('SHELL_EXEC', false);

    const report = ea.getReport();
    const code = report.find(r => r.actionType === 'CODE_GENERATE');
    const shell = report.find(r => r.actionType === 'SHELL_EXEC');

    if (!code) throw new Error('Missing CODE_GENERATE');
    if (code.samples !== 2) throw new Error(`Expected 2 samples, got ${code.samples}`);
    if (code.successes !== 2) throw new Error(`Expected 2 successes`);

    if (!shell) throw new Error('Missing SHELL_EXEC');
    if (shell.samples !== 1) throw new Error(`Expected 1 sample`);
    if (shell.successes !== 0) throw new Error(`Expected 0 successes`);
  });

  test('respects maxOutcomesPerType cap', () => {
    const ea = new EarnedAutonomy({ bus: mockBus(), config: { maxOutcomesPerType: 10, evaluateEvery: 100 } });
    for (let i = 0; i < 25; i++) ea.record('CODE', true);

    const report = ea.getReport();
    const code = report.find(r => r.actionType === 'CODE');
    if (code.samples !== 10) throw new Error(`Expected 10 (capped), got ${code.samples}`);
  });
});

describe('EarnedAutonomy — promotion', () => {
  test('promotes after consistent success above threshold', () => {
    const bus = mockBus();
    const ea = new EarnedAutonomy({
      bus,
      config: { minSamples: 10, promotionThreshold: 0.80, evaluateEvery: 1 },
    });

    // Record 30 successes
    for (let i = 0; i < 30; i++) ea.record('ANALYZE', true);

    const report = ea.getReport();
    const analyze = report.find(r => r.actionType === 'ANALYZE');
    if (!analyze.promoted) throw new Error('Should be promoted after 30 successes');

    const earned = bus.getEmitted('autonomy:earned');
    if (earned.length === 0) throw new Error('Should emit autonomy:earned event');
    if (earned[0].payload.actionType !== 'ANALYZE') throw new Error('Wrong action type in event');
  });

  test('does NOT promote with insufficient samples', () => {
    const ea = new EarnedAutonomy({
      bus: mockBus(),
      config: { minSamples: 30, promotionThreshold: 0.85, evaluateEvery: 1 },
    });

    for (let i = 0; i < 10; i++) ea.record('ANALYZE', true);

    const report = ea.getReport();
    const analyze = report.find(r => r.actionType === 'ANALYZE');
    if (analyze.promoted) throw new Error('Should NOT promote with only 10 samples');
  });

  test('does NOT promote with low success rate', () => {
    const ea = new EarnedAutonomy({
      bus: mockBus(),
      config: { minSamples: 10, promotionThreshold: 0.85, evaluateEvery: 1 },
    });

    // 50% success rate
    for (let i = 0; i < 20; i++) {
      ea.record('CODE', i % 2 === 0);
    }

    const report = ea.getReport();
    const code = report.find(r => r.actionType === 'CODE');
    if (code.promoted) throw new Error('Should NOT promote at 50% success');
  });
});

describe('EarnedAutonomy — revocation', () => {
  test('revokes promotion when performance degrades', () => {
    const bus = mockBus();
    const ea = new EarnedAutonomy({
      bus,
      config: { minSamples: 10, promotionThreshold: 0.80, revocationThreshold: 0.50, evaluateEvery: 1, maxOutcomesPerType: 30 },
    });

    // First: earn promotion
    for (let i = 0; i < 20; i++) ea.record('CODE', true);

    let report = ea.getReport();
    if (!report.find(r => r.actionType === 'CODE')?.promoted) throw new Error('Should be promoted');

    // Now: degrade performance by recording many failures
    for (let i = 0; i < 25; i++) ea.record('CODE', false);

    report = ea.getReport();
    const code = report.find(r => r.actionType === 'CODE');
    if (code.promoted) throw new Error('Should be REVOKED after degradation');

    const revoked = bus.getEmitted('autonomy:revoked');
    if (revoked.length === 0) throw new Error('Should emit autonomy:revoked event');
  });
});

// ════════════════════════════════════════════════════════════
// 3. TRUST SYSTEM INTEGRATION
// ════════════════════════════════════════════════════════════

describe('EarnedAutonomy — TrustLevelSystem integration', () => {
  test('writes promotion to TrustLevelSystem overrides', () => {
    const bus = mockBus();
    const trust = {
      getLevel: () => 1,
      _pendingUpgrades: [],
      _actionOverrides: {},
      acceptUpgrade: function(actionType) {
        const idx = this._pendingUpgrades.findIndex(u => u.actionType === actionType);
        if (idx >= 0) {
          this._actionOverrides[actionType] = this.getLevel();
          this._pendingUpgrades.splice(idx, 1);
        }
      },
      _save: async () => {},
    };

    const ea = new EarnedAutonomy({
      bus,
      config: { minSamples: 10, promotionThreshold: 0.80, evaluateEvery: 1 },
    });
    ea.trustLevelSystem = trust;

    for (let i = 0; i < 30; i++) ea.record('ANALYZE', true);

    if (trust._actionOverrides['ANALYZE'] !== 1) {
      throw new Error(`Expected override at level 1, got ${trust._actionOverrides['ANALYZE']}`);
    }
  });

  test('removes override on revocation', () => {
    const bus = mockBus();
    const trust = {
      getLevel: () => 1,
      _pendingUpgrades: [],
      _actionOverrides: { 'CODE': 1 },
      acceptUpgrade: function(actionType) {
        const idx = this._pendingUpgrades.findIndex(u => u.actionType === actionType);
        if (idx >= 0) {
          this._actionOverrides[actionType] = this.getLevel();
          this._pendingUpgrades.splice(idx, 1);
        }
      },
      _save: async () => {},
    };

    const ea = new EarnedAutonomy({
      bus,
      config: { minSamples: 10, promotionThreshold: 0.80, revocationThreshold: 0.50, evaluateEvery: 1, maxOutcomesPerType: 30 },
    });
    ea.trustLevelSystem = trust;

    // Pre-promote by setting internal state
    ea._actions.set('CODE', { outcomes: Array(20).fill(true), promoted: true });
    trust._actionOverrides['CODE'] = 1;

    // Degrade
    for (let i = 0; i < 25; i++) ea.record('CODE', false);

    if (trust._actionOverrides['CODE'] !== undefined) {
      throw new Error('Override should be removed on revocation');
    }
  });
});

// ════════════════════════════════════════════════════════════
// 4. PERSISTENCE
// ════════════════════════════════════════════════════════════

describe('EarnedAutonomy — persistence', () => {
  test('saves and loads state', async () => {
    const storage = mockStorage();
    const ea1 = new EarnedAutonomy({
      bus: mockBus(),
      storage,
      config: { minSamples: 5, promotionThreshold: 0.70, evaluateEvery: 1 },
    });

    for (let i = 0; i < 10; i++) ea1.record('CODE', true);
    await ea1.stop();

    // Create new instance and load
    const ea2 = new EarnedAutonomy({
      bus: mockBus(),
      storage,
      config: { evaluateEvery: 1 },
    });
    await ea2.asyncLoad();

    const report = ea2.getReport();
    const code = report.find(r => r.actionType === 'CODE');
    if (!code) throw new Error('Should load persisted state');
    if (code.samples !== 10) throw new Error(`Expected 10 samples, got ${code.samples}`);
    if (!code.promoted) throw new Error('Should preserve promoted status');
  });
});

// ════════════════════════════════════════════════════════════
// 5. BUS INTEGRATION
// ════════════════════════════════════════════════════════════

describe('EarnedAutonomy — event listening', () => {
  test('start() subscribes to step-complete and step-failed', () => {
    const bus = mockBus();
    const ea = new EarnedAutonomy({ bus });
    ea.start();

    const subscribed = bus.events.filter(e => typeof e.fn === 'function').map(e => e.ev);
    if (!subscribed.includes('agent-loop:step-complete')) throw new Error('Missing step-complete subscription');
    if (!subscribed.includes('agent-loop:step-failed')) throw new Error('Missing step-failed subscription');
  });

  test('stop() cleans up subscriptions', () => {
    const bus = mockBus();
    const ea = new EarnedAutonomy({ bus, storage: mockStorage() });
    ea.start();

    // _unsubs should have 2 entries
    if (ea._unsubs.length !== 2) throw new Error(`Expected 2 unsubs, got ${ea._unsubs.length}`);

    ea.stop();
    if (ea._unsubs.length !== 0) throw new Error('Should clear unsubs on stop');
  });
});

// ════════════════════════════════════════════════════════════
// 6. STATS
// ════════════════════════════════════════════════════════════

describe('EarnedAutonomy — stats', () => {
  test('tracks recorded count', () => {
    const ea = new EarnedAutonomy({ bus: mockBus(), config: { evaluateEvery: 100 } });
    for (let i = 0; i < 15; i++) ea.record('CODE', true);

    const stats = ea.getStats();
    if (stats.recorded !== 15) throw new Error(`Expected 15, got ${stats.recorded}`);
  });

  test('tracks promotion count', () => {
    const ea = new EarnedAutonomy({
      bus: mockBus(),
      config: { minSamples: 5, promotionThreshold: 0.70, evaluateEvery: 1 },
    });
    for (let i = 0; i < 20; i++) ea.record('A', true);
    for (let i = 0; i < 20; i++) ea.record('B', true);

    const stats = ea.getStats();
    if (stats.promotions !== 2) throw new Error(`Expected 2 promotions, got ${stats.promotions}`);
  });

  test('report sorted by wilson score descending', () => {
    const ea = new EarnedAutonomy({ bus: mockBus(), config: { evaluateEvery: 100 } });
    for (let i = 0; i < 20; i++) ea.record('LOW', i < 5);   // 25% success
    for (let i = 0; i < 20; i++) ea.record('HIGH', true);     // 100% success
    for (let i = 0; i < 20; i++) ea.record('MID', i < 15);   // 75% success

    const report = ea.getReport();
    if (report[0].actionType !== 'HIGH') throw new Error(`Expected HIGH first, got ${report[0].actionType}`);
    if (report[report.length - 1].actionType !== 'LOW') throw new Error(`Expected LOW last`);
  });
});

run();
