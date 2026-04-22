// ============================================================
// v7.3.9 #Structure — File-Split Invariants
//
// Verifies that the v7.3.9 code restructuring preserves all
// external contracts:
//
//   - DreamCyclePhases.js methods are accessible on DreamCycle
//     instances (prototype delegation works)
//   - ChatOrchestratorSourceRead.js methods are accessible on
//     ChatOrchestrator instances (same pattern)
//   - No method renames: all v7.3.7/v7.3.8 methods keep their
//     original names
//   - Baustein C (subscription-helper) already in place from
//     v7.3.6 — verify it is wired to ErrorAggregator and
//     ServiceRecovery as expected
// ============================================================

const { describe, it } = require('node:test');
const assert = require('assert');

const { DreamCycle } = require('../../src/agent/cognitive/DreamCycle');
const { dreamCyclePhases } = require('../../src/agent/cognitive/DreamCyclePhases');
const { ChatOrchestrator } = require('../../src/agent/hexagonal/ChatOrchestrator');
const { sourceRead } = require('../../src/agent/hexagonal/ChatOrchestratorSourceRead');

// ════════════════════════════════════════════════════════════
// Baustein A — DreamCyclePhases prototype delegation
// ════════════════════════════════════════════════════════════

describe('v7.3.9 — DreamCyclePhases prototype delegation', () => {

  it('all v7.3.7 phase methods accessible on DreamCycle instance', () => {
    const methods = [
      '_dreamPhasePendingReview',
      '_dreamPhaseLayerTransition',
      '_dreamPhaseJournalRotation',
      '_dreamPhaseCycleReport',
      '_askPinDecision',
      '_consolidateWithFallback',
      '_consolidateWithLLM',
      '_consolidateExtractive',
      '_buildConsolidated',
      '_computeSizeReduction',
      '_formatCycleReport',
      '_formatAge',
    ];
    for (const m of methods) {
      assert.strictEqual(
        typeof DreamCycle.prototype[m], 'function',
        `DreamCycle.prototype.${m} missing — prototype delegation broken`
      );
    }
  });

  it('dreamCyclePhases module exports an object with methods', () => {
    assert.strictEqual(typeof dreamCyclePhases, 'object');
    assert.ok(dreamCyclePhases !== null);
    assert.ok(Object.keys(dreamCyclePhases).length > 0);
  });

  it('every method in dreamCyclePhases is also on DreamCycle.prototype', () => {
    for (const name of Object.keys(dreamCyclePhases)) {
      assert.strictEqual(
        DreamCycle.prototype[name], dreamCyclePhases[name],
        `${name} in module but not wired to DreamCycle.prototype`
      );
    }
  });

  it('core methods NOT in phases stay on DreamCycle itself', () => {
    // These were never in the phases extraction — verify they remain
    // on the class (not on the mixin).
    const core = ['dream', 'start', 'stop', 'asyncLoad', 'getStats',
                  '_getUnprocessedEpisodes', '_withinTimeLimit',
                  '_save', '_saveSync', '_saveData'];
    for (const m of core) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(DreamCycle.prototype, m) ||
        typeof DreamCycle.prototype[m] === 'function',
        `Core method ${m} not on prototype`
      );
    }
  });

  it('_formatAge remains callable and works as before', () => {
    const instance = Object.create(DreamCycle.prototype);
    instance._clock = { now: () => new Date('2026-04-22T12:00:00Z').getTime() };
    const earlier = new Date('2026-04-22T10:00:00Z').toISOString();
    const result = instance._formatAge(earlier);
    assert.strictEqual(result, '2 Stunden');
  });
});

// ════════════════════════════════════════════════════════════
// Baustein B — ChatOrchestratorSourceRead prototype delegation
// ════════════════════════════════════════════════════════════

describe('v7.3.9 — ChatOrchestratorSourceRead prototype delegation', () => {

  it('all v7.3.8 source-read methods accessible on ChatOrchestrator instance', () => {
    const methods = [
      '_maybeReadSourceSync',
      '_rootDir',
      '_readSourceCached',
      '_readChangelogLatestSection',
      '_readPackageVersion',
    ];
    for (const m of methods) {
      assert.strictEqual(
        typeof ChatOrchestrator.prototype[m], 'function',
        `ChatOrchestrator.prototype.${m} missing — prototype delegation broken`
      );
    }
  });

  it('sourceRead module exports an object with methods', () => {
    assert.strictEqual(typeof sourceRead, 'object');
    assert.ok(sourceRead !== null);
    assert.strictEqual(Object.keys(sourceRead).length, 5);
  });

  it('every method in sourceRead is also on ChatOrchestrator.prototype', () => {
    for (const name of Object.keys(sourceRead)) {
      assert.strictEqual(
        ChatOrchestrator.prototype[name], sourceRead[name],
        `${name} in module but not wired to ChatOrchestrator.prototype`
      );
    }
  });

  it('core methods stay on ChatOrchestrator itself (handleChat, handleStream, _generalChat, _directChat, _maybeAttachSourceHint)', () => {
    const core = ['handleChat', 'handleStream', '_generalChat', '_directChat', '_maybeAttachSourceHint'];
    for (const m of core) {
      assert.strictEqual(
        typeof ChatOrchestrator.prototype[m], 'function',
        `Core method ${m} not on prototype`
      );
    }
  });

  it('helpers from ChatOrchestratorHelpers still attached (regression from v7.3.8)', () => {
    // Previous v7.3.8 additions — must still work after v7.3.9 split
    const helpers = ['_withRetry', '_isRetryable', '_classifyLlmError',
                     '_renderSystemError', '_handleMainResponseError'];
    for (const m of helpers) {
      assert.strictEqual(
        typeof ChatOrchestrator.prototype[m], 'function',
        `Helper ${m} not on prototype — Helpers mixin broken`
      );
    }
  });
});

// ════════════════════════════════════════════════════════════
// Baustein C — subscription-helper already in place (pre-v7.3.9)
// ════════════════════════════════════════════════════════════

describe('v7.3.9 — subscription-helper is wired (pre-existing)', () => {

  it('subscription-helper module exists and exports applySubscriptionHelper', () => {
    const mod = require('../../src/agent/core/subscription-helper');
    assert.strictEqual(typeof mod.applySubscriptionHelper, 'function');
  });

  it('ErrorAggregator has _sub method after applySubscriptionHelper', () => {
    const { ErrorAggregator } = require('../../src/agent/autonomy/ErrorAggregator');
    assert.strictEqual(typeof ErrorAggregator.prototype._sub, 'function');
  });

  it('ServiceRecovery has _sub method after applySubscriptionHelper', () => {
    const { ServiceRecovery } = require('../../src/agent/autonomy/ServiceRecovery');
    assert.strictEqual(typeof ServiceRecovery.prototype._sub, 'function');
  });
});

// ════════════════════════════════════════════════════════════
// File-size invariants (what v7.3.9 achieved)
// ════════════════════════════════════════════════════════════

describe('v7.3.9 — file-size invariants', () => {

  const fs = require('fs');
  const path = require('path');

  function loc(relPath) {
    const abs = path.join(__dirname, '..', '..', relPath);
    return fs.readFileSync(abs, 'utf8').split('\n').length;
  }

  it('DreamCycle.js is under 700 LOC after v7.3.9 split', () => {
    const lines = loc('src/agent/cognitive/DreamCycle.js');
    assert.ok(lines < 700, `DreamCycle.js has ${lines} LOC, expected < 700`);
  });

  it('ChatOrchestrator.js is under 700 LOC after v7.3.9 split', () => {
    const lines = loc('src/agent/hexagonal/ChatOrchestrator.js');
    assert.ok(lines < 700, `ChatOrchestrator.js has ${lines} LOC, expected < 700`);
  });

  it('DreamCyclePhases.js exists and is non-empty', () => {
    const lines = loc('src/agent/cognitive/DreamCyclePhases.js');
    assert.ok(lines > 100 && lines < 700, `DreamCyclePhases.js has ${lines} LOC`);
  });

  it('ChatOrchestratorSourceRead.js exists and is non-empty', () => {
    const lines = loc('src/agent/hexagonal/ChatOrchestratorSourceRead.js');
    assert.ok(lines > 50 && lines < 300, `ChatOrchestratorSourceRead.js has ${lines} LOC`);
  });
});
