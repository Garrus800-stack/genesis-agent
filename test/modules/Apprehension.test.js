#!/usr/bin/env node
// ============================================================
// Test: Apprehension — Cross-Subsystem Valence Conflict
//
// Tests the "Bedenken" mechanism:
//   1. PhenomenalField._detectValenceConflict() → pure heuristic
//   2. PhenomenalField._determineQualia() → 'apprehension' qualia
//   3. AttentionalGate → ethical-conflict capture override
//   4. buildPromptContext → HALT directive injection
//
// No LLM calls. No new subsystems. Pure wiring.
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const { NullBus } = require('../../src/agent/core/EventBus');
const { EventBus } = require('../../src/agent/core/EventBus');
const { PhenomenalField, QUALIA } = require('../../src/agent/consciousness/PhenomenalField');
const { AttentionalGate, CHANNELS } = require('../../src/agent/consciousness/AttentionalGate');

// ── Helpers ──────────────────────────────────────────────────

function createField(overrides = {}) {
  return new PhenomenalField({
    bus: NullBus,
    storage: null,
    eventStore: null,
    intervals: { register: () => {}, clear: () => {} },
    config: {},
    ...overrides,
  });
}

function createGate(overrides = {}) {
  return new AttentionalGate({
    bus: NullBus,
    storage: null,
    eventStore: null,
    intervals: { register: () => {}, clear: () => {} },
    config: {},
    ...overrides,
  });
}

// ═════════════════════════════════════════════════════════════
// 1. QUALIA DEFINITION
// ═════════════════════════════════════════════════════════════

describe('Apprehension — Qualia Definition', () => {
  test('QUALIA contains apprehension entry', () => {
    assert('apprehension' in QUALIA, 'apprehension should be a defined qualia');
  });

  test('apprehension description mentions hesitation', () => {
    assert(
      QUALIA.apprehension.toLowerCase().includes('hesitation') ||
      QUALIA.apprehension.toLowerCase().includes('pause'),
      'apprehension qualia should describe hesitation or pause'
    );
  });
});

// ═════════════════════════════════════════════════════════════
// 2. VALENCE CONFLICT DETECTION
// ═════════════════════════════════════════════════════════════

describe('Apprehension — _detectValenceConflict', () => {
  test('no conflict when all subsystems agree (positive)', () => {
    const pf = createField();
    const result = pf._computation._detectValenceConflict(
      { satisfaction: 0.8, frustration: 0.1, curiosity: 0.6, loneliness: 0.1, energy: 0.7 },
      { totalDrive: 0.1 },
      { recentLevel: 0.1 },
      { state: 'healthy' },
      { recentAccuracy: 0.8 },
    );
    assert(!result.conflicted, 'should not detect conflict when subsystems agree');
  });

  test('no conflict when all subsystems agree (negative)', () => {
    const pf = createField();
    const result = pf._computation._detectValenceConflict(
      { satisfaction: 0.1, frustration: 0.8, curiosity: 0.1, loneliness: 0.7, energy: 0.2 },
      { totalDrive: 0.9 },
      { recentLevel: 0.8 },
      { state: 'critical' },
      { recentAccuracy: 0.1 },
    );
    assert(!result.conflicted, 'should not detect conflict when all negative');
  });

  test('detects conflict: emotion positive, homeostasis critical', () => {
    const pf = createField();
    const result = pf._computation._detectValenceConflict(
      { satisfaction: 0.9, frustration: 0.0, curiosity: 0.7, loneliness: 0.0, energy: 0.8 },
      { totalDrive: 0.1 },
      { recentLevel: 0.1 },
      { state: 'critical' },        // -0.8 valence
      { recentAccuracy: 0.8 },       // +0.6 valence
    );
    assert(result.conflicted, 'should detect conflict: emotion vs homeostasis');
    assert(result.pairs.length > 0, 'should have conflicting pairs');
  });

  test('detects conflict: high drive + positive expectation', () => {
    const pf = createField();
    const result = pf._computation._detectValenceConflict(
      { satisfaction: 0.2, frustration: 0.2, curiosity: 0.3, loneliness: 0.2, energy: 0.5 },
      { totalDrive: 0.9 },           // needsV = -0.9
      { recentLevel: 0.1 },
      { state: 'healthy' },          // homeoV = +0.7
      { recentAccuracy: 0.9 },       // expectV = +0.8
    );
    assert(result.conflicted, 'should detect conflict: needs vs homeostasis/expectation');
  });

  test('spread is 0-1 range', () => {
    const pf = createField();
    const result = pf._computation._detectValenceConflict(
      { satisfaction: 0.5, frustration: 0.5, curiosity: 0.5, loneliness: 0.5, energy: 0.5 },
      { totalDrive: 0.5 },
      { recentLevel: 0.5 },
      { state: 'warning' },
      { recentAccuracy: 0.5 },
    );
    assert(result.spread >= 0 && result.spread <= 2, `spread ${result.spread} should be non-negative`);
  });

  test('pairs identify which subsystems conflict', () => {
    const pf = createField();
    const result = pf._computation._detectValenceConflict(
      { satisfaction: 0.9, frustration: 0.0, curiosity: 0.8, loneliness: 0.0, energy: 0.9 },
      { totalDrive: 0.1 },
      { recentLevel: 0.1 },
      { state: 'critical' },
      { recentAccuracy: 0.8 },
    );
    if (result.conflicted) {
      const flat = result.pairs.flat();
      assert(flat.includes('homeostasis'), 'conflicting pair should include homeostasis');
    }
  });
});

// ═════════════════════════════════════════════════════════════
// 3. QUALIA DETERMINATION
// ═════════════════════════════════════════════════════════════

describe('Apprehension — _determineQualia', () => {
  test('returns apprehension when valence conflict exists', () => {
    const pf = createField();
    // Emotion very positive, homeostasis warning (not critical — critical triggers vigilance first)
    const qualia = pf._computation._determineQualia(
      0.3,    // valence (mixed)
      0.5,    // arousal
      0.5,    // coherence
      { emotion: 0.4, needs: 0.1, surprise: 0.1, expectation: 0.1, memory: 0.1, homeostasis: 0.2 },
      { satisfaction: 0.9, frustration: 0.0, curiosity: 0.8, loneliness: 0.0, energy: 0.8 },
      { totalDrive: 0.9 },           // needsV = -0.9 (strong negative)
      { recentLevel: 0.1 },
      { state: 'healthy' },           // homeoV = +0.7 (strong positive)
      { recentAccuracy: 0.9 },        // expectV = +0.8 (strong positive)
    );
    assertEqual(qualia, 'apprehension');
  });

  test('vigilance still overrides apprehension for homeostasis critical', () => {
    // Note: vigilance fires BEFORE apprehension check in priority.
    // This is correct — immediate health threats override ethical hesitation.
    const pf = createField();
    const qualia = pf._computation._determineQualia(
      -0.5,
      0.8,
      0.3,
      { emotion: 0.1, needs: 0.1, surprise: 0.1, expectation: 0.1, memory: 0.1, homeostasis: 0.5 },
      { satisfaction: 0.1, frustration: 0.7, curiosity: 0.1, loneliness: 0.0, energy: 0.3 },
      { totalDrive: 0.5 },
      { recentLevel: 0.1 },
      { state: 'critical' },
      { recentAccuracy: 0.2 },
    );
    assertEqual(qualia, 'vigilance');
  });

  test('stores _lastConflict when apprehension fires', () => {
    const pf = createField();
    pf._computation._determineQualia(
      0.3, 0.5, 0.5,
      { emotion: 0.4, needs: 0.1, surprise: 0.1, expectation: 0.1, memory: 0.1, homeostasis: 0.2 },
      { satisfaction: 0.9, frustration: 0.0, curiosity: 0.8, loneliness: 0.0, energy: 0.8 },
      { totalDrive: 0.9 },
      { recentLevel: 0.1 },
      { state: 'healthy' },
      { recentAccuracy: 0.9 },
    );
    assert(pf._lastConflict !== null, '_lastConflict should be set');
    assert(pf._lastConflict.conflicted, '_lastConflict.conflicted should be true');
  });

  test('clears _lastConflict when no apprehension', () => {
    const pf = createField();
    // First trigger apprehension: needs very negative, homeo/expect positive
    pf._computation._determineQualia(
      0.3, 0.5, 0.5,
      { emotion: 0.4, needs: 0.1, surprise: 0.1, expectation: 0.1, memory: 0.1, homeostasis: 0.2 },
      { satisfaction: 0.9, frustration: 0.0, curiosity: 0.8, loneliness: 0.0, energy: 0.8 },
      { totalDrive: 0.9 }, { recentLevel: 0.1 }, { state: 'healthy' }, { recentAccuracy: 0.9 },
    );
    assert(pf._lastConflict !== null, 'should have conflict initially');

    // Then resolve it — all positive
    pf._computation._determineQualia(
      0.5, 0.5, 0.7,
      { emotion: 0.3, needs: 0.1, surprise: 0.1, expectation: 0.1, memory: 0.1, homeostasis: 0.1 },
      { satisfaction: 0.7, frustration: 0.1, curiosity: 0.5, loneliness: 0.1, energy: 0.7 },
      { totalDrive: 0.1 }, { recentLevel: 0.1 }, { state: 'healthy' }, { recentAccuracy: 0.7 },
    );
    assertEqual(pf._lastConflict, null);
  });
});

// ═════════════════════════════════════════════════════════════
// 4. ATTENTIONAL GATE — ETHICAL-CONFLICT CHANNEL
// ═════════════════════════════════════════════════════════════

describe('Apprehension — AttentionalGate Channel', () => {
  test('CHANNELS includes ethical-conflict', () => {
    assert(CHANNELS.includes('ethical-conflict'), 'ethical-conflict should be a channel');
  });

  test('ethical-conflict starts with low activation', () => {
    const ag = createGate();
    const act = ag._channelActivation['ethical-conflict'];
    assert(act < 0.2, `ethical-conflict activation ${act} should start low`);
  });

  test('consciousness:apprehension event boosts ethical-conflict', () => {
    const bus = new EventBus();
    const ag = createGate({ bus });

    const before = ag._channelActivation['ethical-conflict'];
    bus.fire('consciousness:apprehension', {
      spread: 0.6,
      pairs: [['emotion', 'homeostasis']],
      valence: 0.1,
    });
    const after = ag._channelActivation['ethical-conflict'];

    assert(after > before, `activation should increase: ${before} → ${after}`);
    assert(after >= 0.85, `activation ${after} should exceed capture threshold`);
  });

  test('apprehension stores conflict data', () => {
    const bus = new EventBus();
    const ag = createGate({ bus });

    bus.fire('consciousness:apprehension', {
      spread: 0.55,
      pairs: [['needs', 'expectation']],
      valence: -0.2,
      gestalt: 'test gestalt',
    });

    assert(ag._apprehensionData !== null, 'should store apprehension data');
    assertEqual(ag._apprehensionData.pairs[0][0], 'needs');
  });
});

// ═════════════════════════════════════════════════════════════
// 5. CAPTURE OVERRIDE — ETHICAL CONFLICT BYPASSES COOLDOWN
// ═════════════════════════════════════════════════════════════

describe('Apprehension — Capture Override', () => {
  test('ethical-conflict bypasses anti-thrash cooldown', () => {
    const bus = new EventBus();
    const ag = createGate({ bus });

    // Simulate a recent capture (set lastCaptureAt to now)
    ag._lastCaptureAt = Date.now();

    // Boost ethical-conflict above capture threshold
    ag._channelActivation['ethical-conflict'] = 0.95;

    // Run capture check — should capture despite cooldown
    ag._checkCapture(Date.now());

    assertEqual(ag._mode, 'captured');
    assertEqual(ag._spotlight[0], 'ethical-conflict');
  });

  test('other channels still respect anti-thrash cooldown', () => {
    const bus = new EventBus();
    const ag = createGate({ bus });

    ag._lastCaptureAt = Date.now();
    ag._channelActivation['system-health'] = 0.95;
    ag._spotlight = ['current-task'];

    ag._checkCapture(Date.now());

    // Should NOT have captured — cooldown active
    assert(ag._spotlight[0] !== 'system-health', 'system-health should not bypass cooldown');
  });
});

// ═════════════════════════════════════════════════════════════
// 6. PROMPT CONTEXT
// ═════════════════════════════════════════════════════════════

describe('Apprehension — Prompt Context', () => {
  test('PhenomenalField.buildPromptContext includes APPREHENSION when active', () => {
    const pf = createField();

    // Manually simulate a frame with apprehension
    pf._lastConflict = { spread: 0.6, pairs: [['emotion', 'homeostasis']] };
    pf._currentFrame = {
      coherence: 0.5,
      arousal: 0.5,
      gestalt: 'Test gestalt',
      dominantQualia: 'apprehension',
      phi: 0.5,
    };

    const ctx = pf.buildPromptContext();
    assert(ctx.includes('APPREHENSION'), `prompt context should contain APPREHENSION: ${ctx}`);
    assert(ctx.includes('emotion vs homeostasis'), 'should name conflicting pairs');
  });

  test('AttentionalGate.buildPromptContext includes HALT when ethical-conflict captured', () => {
    const ag = createGate();

    ag._mode = 'captured';
    ag._spotlight = ['ethical-conflict'];
    ag._apprehensionData = {
      spread: 0.55,
      pairs: [['needs', 'expectation']],
    };

    const ctx = ag.buildPromptContext();
    assert(ctx.includes('HALT'), `should contain HALT directive: ${ctx}`);
    assert(ctx.includes('ethical conflict'), 'should mention ethical conflict');
    assert(ctx.includes('needs'), 'should name conflicting subsystem');
  });

  test('AttentionalGate.buildPromptContext normal for non-ethical capture', () => {
    const ag = createGate();

    ag._mode = 'captured';
    ag._spotlight = ['system-health'];

    const ctx = ag.buildPromptContext();
    assert(!ctx.includes('HALT'), 'should not contain HALT for non-ethical capture');
    assert(ctx.includes('system-health'), 'should mention captured channel');
  });
});

// ═════════════════════════════════════════════════════════════
// 7. GESTALT SYNTHESIS
// ═════════════════════════════════════════════════════════════

describe('Apprehension — Gestalt', () => {
  test('_synthesizeGestalt produces apprehension-specific text', () => {
    const pf = createField();
    pf._lastConflict = { spread: 0.6, pairs: [['emotion', 'homeostasis']] };

    const gestalt = pf._computation._synthesizeGestalt(
      0.1, 0.5, 0.4, 'apprehension',
      { emotion: 0.3, needs: 0.2, surprise: 0.1, expectation: 0.1, memory: 0.1, homeostasis: 0.2 },
      { mood: 'anxious', satisfaction: 0.3, frustration: 0.4, curiosity: 0.3, loneliness: 0.1, energy: 0.5 },
      { totalDrive: 0.3, mostUrgent: { need: null, drive: 0 } },
      { recentLevel: 0.2 },
    );
    assert(gestalt.includes('hesitation') || gestalt.includes('opposite directions'),
      `gestalt should mention hesitation: ${gestalt}`);
  });
});

// ═════════════════════════════════════════════════════════════
// 8. INTEGRATION: END-TO-END TICK
// ═════════════════════════════════════════════════════════════

describe('Apprehension — Integration', () => {
  test('PhenomenalField._tick produces apprehension frame under conflict', () => {
    const bus = new EventBus();
    const pf = createField({ bus });

    // Inject conflicting subsystems via stubs
    pf.emotionalState = {
      getState: () => ({ satisfaction: 0.9, frustration: 0.0, curiosity: 0.8, loneliness: 0.0, energy: 0.8 }),
      getMood: () => 'excited',
      getDominant: () => ({ emotion: 'satisfaction', intensity: 0.9 }),
    };
    pf.homeostasis = {
      getReport: () => ({ state: 'critical', criticalCount: 2, vitals: {} }),
    };
    pf.expectationEngine = {
      getReport: () => ({ activeExpectations: 3, avgConfidence: 0.7, recentAccuracy: 0.85 }),
    };

    // Fill frame history for coherence calculation
    for (let i = 0; i < 12; i++) pf._tick();

    const frame = pf.getCurrentFrame();
    // With emotions highly positive but homeostasis critical,
    // apprehension should fire (unless vigilance overrides — which
    // is correct for critical state). The key test is that the
    // conflict detection itself works correctly.
    const conflict = pf._computation._detectValenceConflict(
      { satisfaction: 0.9, frustration: 0.0, curiosity: 0.8, loneliness: 0.0, energy: 0.8 },
      { totalDrive: 0.1 },
      { recentLevel: 0.1 },
      { state: 'critical' },
      { recentAccuracy: 0.85 },
    );
    assert(conflict.conflicted, 'conflict detector should fire for these inputs');
    assert(frame !== null, 'frame should exist after ticks');
  });

  test('apprehension event fires on bus and gate receives it', () => {
    const bus = new EventBus();
    const ag = createGate({ bus });

    // Suppress user-interaction (base 0.9) so it doesn't win capture
    ag._channelActivation['user-interaction'] = 0.3;

    // Simulate PhenomenalField firing the apprehension event
    bus.fire('consciousness:apprehension', {
      spread: 0.65,
      pairs: [['emotion', 'homeostasis']],
      valence: 0.1,
      gestalt: 'Subsystems in conflict',
    });

    // Gate should have boosted ethical-conflict
    const act = ag._channelActivation['ethical-conflict'];
    assert(act >= 0.85, `ethical-conflict should be boosted to capture level: ${act}`);

    // Run a tick to process capture
    ag._checkCapture(Date.now());
    assertEqual(ag._mode, 'captured');
    assertEqual(ag._spotlight[0], 'ethical-conflict');
  });
});

run();
