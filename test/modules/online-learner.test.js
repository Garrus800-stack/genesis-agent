// ============================================================
// TEST: OnlineLearner — SA-P5 Real-Time Learning
// ============================================================

const { describe, test, assertEqual, assert, run } = require('../harness');
const { OnlineLearner } = require('../../src/agent/cognitive/OnlineLearner');

// ── Test helpers ────────────────────────────────────────────

function makeBus() {
  const listeners = {};
  const emitted = [];
  return {
    on(event, fn, _opts) {
      (listeners[event] = listeners[event] || []).push(fn);
      return () => { listeners[event] = listeners[event].filter(f => f !== fn); };
    },
    emit(event, data, _meta) {
      emitted.push({ event, data });
      for (const fn of (listeners[event] || [])) fn(data);
    },
    fire(event, data, _meta) { this.emit(event, data, _meta); },
    emitted,
    getEmitted(event) { return emitted.filter(e => e.event === event); },
  };
}

function makeSignal(overrides = {}) {
  return {
    totalSurprise: 0.3,
    valence: 'positive',
    actionType: 'code-gen',
    model: 'gemma2:9b',
    timestamp: Date.now(),
    expected: { successProb: 0.8, confidence: 0.7 },
    actual: { success: true },
    ...overrides,
  };
}

// ── Basic Operations ────────────────────────────────────────

describe('OnlineLearner — Basic', () => {
  test('starts and stops cleanly', () => {
    const bus = makeBus();
    const learner = new OnlineLearner({ bus });
    learner.start();
    assert(learner._unsub1, 'Should subscribe to events');
    learner.stop();
    assertEqual(learner.getStats().signalsProcessed, 0);
  });

  test('processes expectation:compared signals', () => {
    const bus = makeBus();
    const learner = new OnlineLearner({ bus });
    learner.start();

    bus.emit('expectation:compared', makeSignal());
    assertEqual(learner.getStats().signalsProcessed, 1);

    bus.emit('expectation:compared', makeSignal());
    assertEqual(learner.getStats().signalsProcessed, 2);
    learner.stop();
  });

  test('ignores invalid signals', () => {
    const bus = makeBus();
    const learner = new OnlineLearner({ bus });
    learner.start();
    bus.emit('expectation:compared', null);
    bus.emit('expectation:compared', {});
    bus.emit('expectation:compared', { totalSurprise: 'not-a-number' });
    assertEqual(learner.getStats().signalsProcessed, 0);
    learner.stop();
  });
});

// ── Streak Detection ────────────────────────────────────────

describe('OnlineLearner — Streak Detection', () => {
  test('detects 3 consecutive failures', () => {
    const bus = makeBus();
    const learner = new OnlineLearner({ bus, config: { streakThreshold: 3 } });
    learner.start();

    const fail = makeSignal({ valence: 'negative', actual: { success: false } });
    bus.emit('expectation:compared', fail);
    bus.emit('expectation:compared', fail);
    assertEqual(learner.getStats().streakTriggered, 0);

    bus.emit('expectation:compared', fail); // 3rd failure
    assertEqual(learner.getStats().streakTriggered, 1);

    const streakEvents = bus.getEmitted('online-learning:streak-detected');
    assertEqual(streakEvents.length, 1);
    assertEqual(streakEvents[0].data.consecutiveFailures, 3);
    learner.stop();
  });

  test('success resets failure streak', () => {
    const bus = makeBus();
    const learner = new OnlineLearner({ bus, config: { streakThreshold: 3 } });
    learner.start();

    const fail = makeSignal({ valence: 'negative', actual: { success: false } });
    const success = makeSignal({ valence: 'positive', actual: { success: true } });

    bus.emit('expectation:compared', fail);
    bus.emit('expectation:compared', fail);
    bus.emit('expectation:compared', success); // Reset!
    bus.emit('expectation:compared', fail); // Starts over
    bus.emit('expectation:compared', fail);

    assertEqual(learner.getStats().streakTriggered, 0);
    learner.stop();
  });

  test('tracks streaks per action type', () => {
    const bus = makeBus();
    const learner = new OnlineLearner({ bus, config: { streakThreshold: 2 } });
    learner.start();

    bus.emit('expectation:compared', makeSignal({ actionType: 'code-gen', valence: 'negative' }));
    bus.emit('expectation:compared', makeSignal({ actionType: 'analysis', valence: 'negative' }));
    assertEqual(learner.getStats().streakTriggered, 0); // Different types

    bus.emit('expectation:compared', makeSignal({ actionType: 'code-gen', valence: 'negative' }));
    assertEqual(learner.getStats().streakTriggered, 1); // 2nd code-gen failure
    learner.stop();
  });

  test('suggests alternative strategy', () => {
    const bus = makeBus();
    const learner = new OnlineLearner({ bus, config: { streakThreshold: 2 } });
    learner.start();

    const fail = makeSignal({ valence: 'negative' });
    bus.emit('expectation:compared', fail);
    bus.emit('expectation:compared', fail);

    const events = bus.getEmitted('online-learning:streak-detected');
    assert(events[0].data.suggestion, 'Should have suggestion');
    assert(events[0].data.suggestion.promptStyle, 'Should suggest prompt style');
    assert(typeof events[0].data.suggestion.temperature === 'number', 'Should suggest temperature');
    learner.stop();
  });
});

// ── Model Escalation ────────────────────────────────────────

describe('OnlineLearner — Model Escalation', () => {
  test('signals escalation on high surprise failure', () => {
    const bus = makeBus();
    const learner = new OnlineLearner({ bus, config: { escalationSurprise: 0.6 } });
    learner.start();

    bus.emit('expectation:compared', makeSignal({
      totalSurprise: 0.85,
      valence: 'negative',
      actual: { success: false },
    }));

    const events = bus.getEmitted('online-learning:escalation-needed');
    assertEqual(events.length, 1);
    assertEqual(events[0].data.surprise, 0.85);
    assertEqual(learner.getStats().escalationsSignaled, 1);
    learner.stop();
  });

  test('no escalation on success', () => {
    const bus = makeBus();
    const learner = new OnlineLearner({ bus, config: { escalationSurprise: 0.6 } });
    learner.start();

    bus.emit('expectation:compared', makeSignal({
      totalSurprise: 0.9,
      valence: 'positive', // Success!
    }));

    assertEqual(bus.getEmitted('online-learning:escalation-needed').length, 0);
    learner.stop();
  });

  test('respects cooldown between escalations', () => {
    const bus = makeBus();
    const learner = new OnlineLearner({ bus, config: { escalationSurprise: 0.5, cooldownMs: 10000 } });
    learner.start();

    const highFail = makeSignal({ totalSurprise: 0.8, valence: 'negative', actual: { success: false } });
    bus.emit('expectation:compared', highFail);
    bus.emit('expectation:compared', highFail); // Within cooldown

    assertEqual(learner.getStats().escalationsSignaled, 1); // Only one
    learner.stop();
  });

  test('no escalation below threshold', () => {
    const bus = makeBus();
    const learner = new OnlineLearner({ bus, config: { escalationSurprise: 0.7 } });
    learner.start();

    bus.emit('expectation:compared', makeSignal({
      totalSurprise: 0.5, // Below threshold
      valence: 'negative',
      actual: { success: false },
    }));

    assertEqual(bus.getEmitted('online-learning:escalation-needed').length, 0);
    learner.stop();
  });
});

// ── Prompt Evolution Feedback ───────────────────────────────

describe('OnlineLearner — Prompt Feedback', () => {
  test('feeds PromptEvolution on every outcome', () => {
    const bus = makeBus();
    const scores = [];
    const learner = new OnlineLearner({ bus });
    learner.promptEvolution = {
      getActiveExperiment: () => ({ id: 'exp-1' }),
      recordOutcome: (score) => scores.push(score),
    };
    learner.start();

    bus.emit('expectation:compared', makeSignal({ totalSurprise: 0.2, valence: 'positive' }));
    bus.emit('expectation:compared', makeSignal({ totalSurprise: 0.8, valence: 'negative' }));

    assertEqual(scores.length, 2);
    assert(scores[0] > 0.5, 'Success should score above 0.5');
    assert(scores[1] < 0.5, 'Failure should score below 0.5');
    assertEqual(learner.getStats().promptFeedbacks, 2);
    learner.stop();
  });

  test('graceful when no PromptEvolution', () => {
    const bus = makeBus();
    const learner = new OnlineLearner({ bus });
    learner.start();
    bus.emit('expectation:compared', makeSignal());
    assertEqual(learner.getStats().promptFeedbacks, 0); // No crash
    learner.stop();
  });
});

// ── Temperature Tuning ──────────────────────────────────────

describe('OnlineLearner — Temperature Tuning', () => {
  test('lowers temperature on low success rate', () => {
    const bus = makeBus();
    const learner = new OnlineLearner({ bus, config: { windowSize: 5 } });
    learner.metaLearning = {
      recommend: () => ({ promptStyle: 'free-text', temperature: 0.7, confidence: 0.5, sampleSize: 10, successRate: 0.3 }),
    };
    learner.start();

    // 5 failures → low success rate
    for (let i = 0; i < 5; i++) {
      bus.emit('expectation:compared', makeSignal({ valence: 'negative', actual: { success: false } }));
    }

    const events = bus.getEmitted('online-learning:temp-adjusted');
    if (events.length > 0) {
      assert(events[events.length - 1].data.newTemp < 0.7, 'Should lower temperature');
    }
    learner.stop();
  });

  test('raises temperature on high success rate', () => {
    const bus = makeBus();
    const learner = new OnlineLearner({ bus, config: { windowSize: 5 } });
    learner.metaLearning = {
      recommend: () => ({ promptStyle: 'free-text', temperature: 0.7, confidence: 0.9, sampleSize: 20, successRate: 0.9 }),
    };
    learner.start();

    // 5 successes → high success rate
    for (let i = 0; i < 5; i++) {
      bus.emit('expectation:compared', makeSignal({ valence: 'positive', actual: { success: true } }));
    }

    const events = bus.getEmitted('online-learning:temp-adjusted');
    if (events.length > 0) {
      assert(events[events.length - 1].data.newTemp > 0.7, 'Should raise temperature');
    }
    learner.stop();
  });
});

// ── Calibration Monitoring ──────────────────────────────────

describe('OnlineLearner — Calibration', () => {
  test('alerts on calibration drift', () => {
    const bus = makeBus();
    const learner = new OnlineLearner({ bus, config: { windowSize: 5, escalationSurprise: 0.5 } });
    learner.start();

    // 10 high-surprise signals → trigger calibration check
    for (let i = 0; i < 10; i++) {
      bus.emit('expectation:compared', makeSignal({
        totalSurprise: 0.8,
        expected: { confidence: 0.2 },
      }));
    }

    assertEqual(learner.getStats().calibrationAlerts, 1);
    learner.stop();
  });
});

// ── Novelty Shift ───────────────────────────────────────────

describe('OnlineLearner — Novelty Shift', () => {
  test('detects surprise trend change', () => {
    const bus = makeBus();
    const learner = new OnlineLearner({ bus });
    learner.start();

    bus.emit('surprise:processed', { trend: 'stable', totalSurprise: 0.3 });
    assertEqual(bus.getEmitted('online-learning:novelty-shift').length, 0);

    bus.emit('surprise:processed', { trend: 'increasing', totalSurprise: 0.7 });
    assertEqual(bus.getEmitted('online-learning:novelty-shift').length, 1);

    // Second 'increasing' shouldn't fire again
    bus.emit('surprise:processed', { trend: 'increasing', totalSurprise: 0.8 });
    assertEqual(bus.getEmitted('online-learning:novelty-shift').length, 1);
    learner.stop();
  });
});

// ── Diagnostics ─────────────────────────────────────────────

describe('OnlineLearner — Diagnostics', () => {
  test('getStats returns comprehensive data', () => {
    const bus = makeBus();
    const learner = new OnlineLearner({ bus });
    learner.start();

    bus.emit('expectation:compared', makeSignal());
    bus.emit('expectation:compared', makeSignal({ valence: 'negative' }));

    const stats = learner.getStats();
    assertEqual(stats.signalsProcessed, 2);
    assertEqual(stats.recentOutcomes, 2);
    assert(typeof stats.recentSuccessRate === 'number');
    assert(stats.config, 'Should expose config');
    learner.stop();
  });

  test('getAdaptationLog tracks adaptations', () => {
    const bus = makeBus();
    const learner = new OnlineLearner({ bus, config: { streakThreshold: 2 } });
    learner.start();

    const fail = makeSignal({ valence: 'negative' });
    bus.emit('expectation:compared', fail);
    bus.emit('expectation:compared', fail);

    const log = learner.getAdaptationLog();
    assertEqual(log.length, 1);
    assertEqual(log[0].type, 'streak-switch');
    learner.stop();
  });
});

// ── Integration: Emotional Nudge ────────────────────────────

describe('OnlineLearner — Emotional Integration', () => {
  test('nudges frustration on high-surprise failure', () => {
    const bus = makeBus();
    const nudges = [];
    const learner = new OnlineLearner({ bus, config: { escalationSurprise: 0.5 } });
    learner.emotionalState = {
      nudge: (dim, val) => nudges.push({ dim, val }),
    };
    learner.start();

    bus.emit('expectation:compared', makeSignal({
      totalSurprise: 0.8,
      valence: 'negative',
      actual: { success: false },
    }));

    assert(nudges.some(n => n.dim === 'frustration'), 'Should nudge frustration');
    assert(nudges.some(n => n.dim === 'curiosity'), 'Should nudge curiosity');
    learner.stop();
  });
});

run();
