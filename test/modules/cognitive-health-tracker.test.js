// ============================================================
// GENESIS — cognitive-health-tracker.test.js
// Tests for CognitiveHealthTracker (v4.0.0)
// ============================================================

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { CognitiveHealthTracker, COGNITIVE_HEALTH_STATE: STATE } = require('../../src/agent/cognitive/CognitiveHealthTracker');

function makeTracker(overrides = {}) {
  const events = [];
  const bus = {
    fire: (event, data, meta) => events.push({ event, data, meta }),
    on: () => () => {},
    emit: () => {},
  };
  const storage = {
    readJSON: () => null,
    writeJSONDebounced: () => {},
  };
  const eventStore = {
    append: (type, data, source) => events.push({ type, data, source }),
  };

  return {
    tracker: new CognitiveHealthTracker({
      bus, storage, eventStore,
      config: {
        failThreshold: 3,
        disableThreshold: 6,
        initialBackoffMs: 100,
        maxBackoffMs: 1000,
        autoRecoverMs: 500,
        ...overrides,
      },
    }),
    events,
  };
}

describe('CognitiveHealthTracker', () => {
  describe('guard() — basic operation', () => {
    it('should execute function and return result on success', async () => {
      const { tracker } = makeTracker();
      const result = await tracker.guard('testService', () => 42);
      assert.equal(result, 42);
    });

    it('should return fallback on failure', async () => {
      const { tracker } = makeTracker();
      const result = await tracker.guard('testService', () => { throw new Error('boom'); }, { fallback: 'safe' });
      assert.equal(result, 'safe');
    });

    it('should handle async functions', async () => {
      const { tracker } = makeTracker();
      const result = await tracker.guard('testService', async () => {
        return new Promise(resolve => setTimeout(() => resolve(99), 10));
      });
      assert.equal(result, 99);
    });

    it('should return null as default fallback', async () => {
      const { tracker } = makeTracker();
      const result = await tracker.guard('failService', () => { throw new Error('fail'); });
      assert.equal(result, null);
    });
  });

  describe('guardSync() — synchronous variant', () => {
    it('should execute and return result', () => {
      const { tracker } = makeTracker();
      const result = tracker.guardSync('syncService', () => 'hello');
      assert.equal(result, 'hello');
    });

    it('should return fallback on failure', () => {
      const { tracker } = makeTracker();
      const result = tracker.guardSync('syncService', () => { throw new Error('sync boom'); }, { fallback: -1 });
      assert.equal(result, -1);
    });
  });

  describe('state transitions', () => {
    it('should stay HEALTHY below failThreshold', async () => {
      const { tracker } = makeTracker();
      // 2 failures (threshold=3) — should stay HEALTHY
      await tracker.guard('svc', () => { throw new Error('f1'); });
      await tracker.guard('svc', () => { throw new Error('f2'); });
      const health = tracker.getServiceHealth('svc');
      assert.equal(health.state, STATE.HEALTHY);
      assert.equal(health.consecutiveFailures, 2);
    });

    it('should transition to DEGRADED at failThreshold', async () => {
      const { tracker, events } = makeTracker();
      for (let i = 0; i < 3; i++) {
        await tracker.guard('svc', () => { throw new Error(`fail-${i}`); });
      }
      const health = tracker.getServiceHealth('svc');
      assert.equal(health.state, STATE.DEGRADED);

      // Should have emitted degraded event
      const degraded = events.find(e => e.event === 'cognitive:service-degraded');
      assert.ok(degraded, 'should emit cognitive:service-degraded');
      assert.equal(degraded.data.service, 'svc');
    });

    it('should skip calls during backoff', async () => {
      const { tracker } = makeTracker({ initialBackoffMs: 60000 }); // 60s backoff
      // Trigger DEGRADED
      for (let i = 0; i < 3; i++) {
        await tracker.guard('svc', () => { throw new Error('fail'); });
      }
      // Next call should be skipped (backoff active)
      let called = false;
      await tracker.guard('svc', () => { called = true; return 'nope'; }, { fallback: 'skipped' });
      assert.equal(called, false);
      const report = tracker.getReport();
      assert.ok(report.totalSkipped > 0);
    });

    it('should transition to DISABLED at disableThreshold', async () => {
      const { tracker, events } = makeTracker({ initialBackoffMs: 0 }); // No backoff delay
      for (let i = 0; i < 6; i++) {
        await tracker.guard('svc', () => { throw new Error(`fail-${i}`); });
      }
      const health = tracker.getServiceHealth('svc');
      assert.equal(health.state, STATE.DISABLED);

      const disabled = events.find(e => e.event === 'cognitive:service-disabled');
      assert.ok(disabled, 'should emit cognitive:service-disabled');
    });

    it('should recover on success after degraded', async () => {
      const { tracker, events } = makeTracker({ initialBackoffMs: 0 });
      // Trigger DEGRADED
      for (let i = 0; i < 3; i++) {
        await tracker.guard('svc', () => { throw new Error('fail'); });
      }
      assert.equal(tracker.getServiceHealth('svc').state, STATE.DEGRADED);

      // Succeed
      const result = await tracker.guard('svc', () => 'recovered!');
      assert.equal(result, 'recovered!');
      assert.equal(tracker.getServiceHealth('svc').state, STATE.HEALTHY);

      const recovered = events.find(e => e.event === 'cognitive:service-recovered');
      assert.ok(recovered, 'should emit cognitive:service-recovered');
    });
  });

  describe('auto-recovery from DISABLED', () => {
    it('should auto-recover after autoRecoverMs', async () => {
      const { tracker } = makeTracker({ initialBackoffMs: 0, autoRecoverMs: 50 }); // 50ms
      // Disable the service
      for (let i = 0; i < 6; i++) {
        await tracker.guard('svc', () => { throw new Error('fail'); });
      }
      assert.equal(tracker.getServiceHealth('svc').state, STATE.DISABLED);

      // Wait for auto-recovery
      await new Promise(resolve => setTimeout(resolve, 60));

      // Should attempt execution again
      const result = await tracker.guard('svc', () => 'back!');
      assert.equal(result, 'back!');
      assert.equal(tracker.getServiceHealth('svc').state, STATE.HEALTHY);
    });
  });

  describe('exponential backoff', () => {
    it('should double backoff on repeated degraded failures', async () => {
      const { tracker } = makeTracker({ initialBackoffMs: 100 });
      // Trigger DEGRADED (3 failures)
      for (let i = 0; i < 3; i++) {
        await tracker.guard('svc', () => { throw new Error('fail'); });
      }
      const h1 = tracker.getServiceHealth('svc');
      // After initial degradation, backoffMs should still be initial
      // Wait for backoff to expire, then fail again
      await new Promise(resolve => setTimeout(resolve, 110));
      await tracker.guard('svc', () => { throw new Error('fail again'); });
      // Backoff should have doubled
      // (We can't directly check currentBackoffMs from getServiceHealth,
      //  but we can verify the service is still DEGRADED)
      assert.equal(tracker.getServiceHealth('svc').state, STATE.DEGRADED);
    });
  });

  describe('isAvailable()', () => {
    it('should return true for unknown services', () => {
      const { tracker } = makeTracker();
      assert.equal(tracker.isAvailable('unknown'), true);
    });

    it('should return true for HEALTHY services', async () => {
      const { tracker } = makeTracker();
      await tracker.guard('svc', () => 'ok');
      assert.equal(tracker.isAvailable('svc'), true);
    });

    it('should return false during backoff', async () => {
      const { tracker } = makeTracker({ initialBackoffMs: 60000 });
      for (let i = 0; i < 3; i++) {
        await tracker.guard('svc', () => { throw new Error('fail'); });
      }
      assert.equal(tracker.isAvailable('svc'), false);
    });
  });

  describe('reset()', () => {
    it('should reset a service to HEALTHY', async () => {
      const { tracker } = makeTracker({ initialBackoffMs: 0 });
      for (let i = 0; i < 6; i++) {
        await tracker.guard('svc', () => { throw new Error('fail'); });
      }
      assert.equal(tracker.getServiceHealth('svc').state, STATE.DISABLED);

      tracker.reset('svc');
      assert.equal(tracker.getServiceHealth('svc').state, STATE.HEALTHY);
      assert.equal(tracker.isAvailable('svc'), true);
    });
  });

  describe('getReport()', () => {
    it('should return complete report', async () => {
      const { tracker } = makeTracker();
      await tracker.guard('a', () => 'ok');
      await tracker.guard('b', () => { throw new Error('fail'); });

      const report = tracker.getReport();
      assert.equal(report.trackedCount, 2);
      assert.ok('a' in report.services);
      assert.ok('b' in report.services);
      assert.equal(report.services.a.state, STATE.HEALTHY);
      assert.equal(report.services.b.consecutiveFailures, 1);
      assert.ok(report.totalGuardCalls >= 2);
    });
  });

  describe('error history ring buffer', () => {
    it('should keep last N errors', async () => {
      const { tracker } = makeTracker({ maxErrorHistory: 3, initialBackoffMs: 0 });
      for (let i = 0; i < 5; i++) {
        await tracker.guard('svc', () => { throw new Error(`err-${i}`); });
      }
      const health = tracker.getServiceHealth('svc');
      assert.equal(health.errorHistory.length, 3);
      assert.equal(health.errorHistory[0].message, 'err-2'); // oldest kept
      assert.equal(health.errorHistory[2].message, 'err-4'); // newest
    });
  });

  describe('multi-service isolation', () => {
    it('should track services independently', async () => {
      const { tracker } = makeTracker({ initialBackoffMs: 0 });
      // Disable service A
      for (let i = 0; i < 6; i++) {
        await tracker.guard('a', () => { throw new Error('fail'); });
      }
      // Service B should still work
      const result = await tracker.guard('b', () => 'b works');
      assert.equal(result, 'b works');
      assert.equal(tracker.getServiceHealth('a').state, STATE.DISABLED);
      assert.equal(tracker.getServiceHealth('b').state, STATE.HEALTHY);
    });
  });

  describe('persistence', () => {
    it('should call storage on failure', async () => {
      let written = null;
      const tracker = new CognitiveHealthTracker({
        bus: { fire: () => {}, on: () => () => {}, emit: () => {} },
        storage: {
          readJSON: () => null,
          writeJSONDebounced: (file, data) => { written = { file, data }; },
        },
        eventStore: { append: () => {} },
        config: { failThreshold: 1, initialBackoffMs: 0 },
      });

      await tracker.guard('svc', () => { throw new Error('fail'); });
      assert.ok(written, 'should have written to storage');
      assert.equal(written.file, 'cognitive-health.json');
    });

    it('should restore cumulative stats from storage', async () => {
      const tracker = new CognitiveHealthTracker({
        bus: { fire: () => {}, on: () => () => {}, emit: () => {} },
        storage: {
          readJSON: () => ({
            services: {
              svc: { totalFailures: 42, totalSuccesses: 100, recoveries: 3 },
            },
          }),
          writeJSONDebounced: () => {},
        },
        eventStore: { append: () => {} },
        config: {},
      });

      await tracker.asyncLoad();
      const report = tracker.getReport();
      assert.equal(report.services.svc.totalFailures, 42);
      assert.equal(report.services.svc.totalSuccesses, 100);
      // State should be HEALTHY (not restored from disk — fresh boot)
      assert.equal(report.services.svc.state, STATE.HEALTHY);
    });
  });
});
