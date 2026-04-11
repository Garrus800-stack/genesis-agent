#!/usr/bin/env node
// Test: AutonomousDaemon — lifecycle, config, cycle management
const { describe, test, assert, assertEqual, run } = require('../harness');
const { createBus } = require('../../src/agent/core/EventBus');
const { AutonomousDaemon } = require('../../src/agent/autonomy/AutonomousDaemon');

function create(overrides = {}) {
  const bus = createBus();
  return {
    bus,
    daemon: new AutonomousDaemon({
      bus,
      reflector: null,
      selfModel: null,
      memory: null,
      model: null,
      prompts: null,
      skills: null,
      sandbox: null,
      guard: null,
      intervals: null,
      ...overrides,
    }),
  };
}

describe('AutonomousDaemon', () => {

  test('constructor initializes with running=false', () => {
    const { daemon } = create();
    assertEqual(daemon.running, false);
    assertEqual(daemon.cycleCount, 0);
  });

  test('config has sensible defaults', () => {
    const { daemon } = create();
    assertEqual(daemon.config.cycleInterval, 5 * 60 * 1000);
    assertEqual(daemon.config.healthInterval, 3);
    assertEqual(daemon.config.autoRepair, true);
    assertEqual(daemon.config.autoOptimize, false);
  });

  test('start sets running=true', () => {
    const { daemon } = create();
    daemon.start();
    assert(daemon.running, 'should be running');
    daemon.stop();
  });

  test('start is idempotent', () => {
    const { daemon } = create();
    daemon.start();
    daemon.start();
    assert(daemon.running);
    daemon.stop();
  });

  test('stop sets running=false', () => {
    const { daemon } = create();
    daemon.start();
    daemon.stop();
    assertEqual(daemon.running, false);
  });

  test('stop is safe when not started', () => {
    const { daemon } = create();
    daemon.stop(); // Should not throw
  });

  test('_runCycle skips when not running', async () => {
    const { daemon } = create();
    await daemon._runCycle();
    assertEqual(daemon.cycleCount, 0);
  });

  test('_runCycle increments cycleCount', async () => {
    const { daemon } = create();
    daemon.running = true;
    await daemon._runCycle();
    assertEqual(daemon.cycleCount, 1);
  });

  test('knownGaps and gapAttempts initialize empty', () => {
    const { daemon } = create();
    assertEqual(daemon.knownGaps.length, 0);
    assertEqual(daemon.gapAttempts.size, 0);
  });

  test('dynamic gap collection from bus events', () => {
    const { bus, daemon } = create();
    daemon.start();
    // Simulate skill:learned event with a topic
    bus.emit('skill:learned', { topic: 'REST API design patterns' });
    // _dynamicGaps should have been populated (if the listener is set up)
    daemon.stop();
  });

  test('start with intervals manager', () => {
    const intervals = {
      register: (name, fn, ms, opts) => {},
      unregister: (name) => {},
      clear: (name) => {},
    };
    const { daemon } = create({ intervals });
    daemon.start();
    assert(daemon.running);
    daemon.stop();
  });
});

// ── v7.1.2: Coverage expansion ───────────────────────────────

describe('AutonomousDaemon — getStatus()', () => {
  test('returns correct shape', () => {
    const { daemon } = create();
    const s = daemon.getStatus();
    assert(typeof s.running === 'boolean');
    assert(typeof s.cycleCount === 'number');
    assert(Array.isArray(s.knownGaps));
    assert(typeof s.config === 'object');
  });

  test('reflects running state after start/stop', () => {
    const { daemon } = create();
    daemon.start();
    assertEqual(daemon.getStatus().running, true);
    daemon.stop();
    assertEqual(daemon.getStatus().running, false);
  });
});

describe('AutonomousDaemon — runCheck()', () => {
  test('throws for unknown check type', () => {
    const { daemon } = create();
    let threw = false;
    try { daemon.runCheck('nonexistent'); }
    catch (e) { threw = true; assert(e.message.includes('Unknown')); }
    assert(threw);
  });

  test('consolidate: returns result when memory is null', async () => {
    const { daemon } = create();
    const r = await daemon.runCheck('consolidate');
    assertEqual(r.consolidated, 0);
  });

  test('learn: returns result when memory is null', async () => {
    const { daemon } = create();
    const r = await daemon.runCheck('learn');
    assertEqual(r.patterns, 0);
  });
});

describe('AutonomousDaemon — _consolidateMemory()', () => {
  test('returns {consolidated:0} when memory is null', () => {
    const { daemon } = create();
    const r = daemon._consolidateMemory();
    assertEqual(r.consolidated, 0);
  });

  test('processes episodes from memory', () => {
    const { daemon } = create({
      memory: {
        getStats: () => ({ episodes: 3 }),
        recallEpisodes: () => [
          { summary: 'nutzer heißt Alice', topics: ['name'] },
          { summary: 'normale sache', topics: ['general'] },
        ],
        learnFact: () => true,
        db: { procedural: [] },
      },
    });
    const r = daemon._consolidateMemory();
    assert(typeof r.episodes === 'number');
    assert(typeof r.newFacts === 'number');
  });

  test('decays low success-rate patterns', () => {
    const lowPattern = { attempts: 10, successRate: 0.1 };
    const { daemon } = create({
      memory: {
        getStats: () => ({ episodes: 0 }),
        recallEpisodes: () => [],
        learnFact: () => false,
        db: { procedural: [lowPattern] },
      },
    });
    const before = lowPattern.successRate;
    daemon._consolidateMemory();
    assert(lowPattern.successRate < before, 'should decay low-success pattern');
  });
});

describe('AutonomousDaemon — _learnFromHistory()', () => {
  test('returns {patterns:0} when memory is null', () => {
    const { daemon } = create();
    const r = daemon._learnFromHistory();
    assertEqual(r.patterns, 0);
  });

  test('processes bus history events', () => {
    const toolEvents = [
      { type: 'tools:result', data: { name: 'file-read', success: true } },
      { type: 'tools:result', data: { name: 'file-read', success: false } },
      { type: 'other:event', data: {} },
    ];
    const { daemon } = create({
      memory: {
        learnPattern: () => {},
        db: {},
      },
    });
    // override bus.getHistory
    daemon.bus.getHistory = () => toolEvents;
    const r = daemon._learnFromHistory();
    assert(typeof r.patterns === 'number');
  });
});

describe('AutonomousDaemon — _analyzeFailurePatterns()', () => {
  test('returns [] when memory is null', () => {
    const { daemon } = create();
    const gaps = daemon._analyzeFailurePatterns();
    assert(Array.isArray(gaps) && gaps.length === 0);
  });

  test('returns [] when no failure episodes', () => {
    const { daemon } = create({
      memory: { db: { episodic: [{ lastExchange: [], topics: ['general'] }] } },
    });
    const gaps = daemon._analyzeFailurePatterns();
    assertEqual(gaps.length, 0);
  });

  test('detects repeated failure topics', () => {
    const failMsg = [{ content: 'I cannot do that' }, { content: 'error occurred' }];
    const { daemon } = create({
      memory: {
        db: {
          episodic: [
            { lastExchange: failMsg, topics: ['calendar'] },
            { lastExchange: failMsg, topics: ['calendar'] },
            { lastExchange: failMsg, topics: ['calendar'] },
          ],
        },
      },
    });
    const gaps = daemon._analyzeFailurePatterns();
    assert(gaps.length > 0);
    assertEqual(gaps[0].topic, 'calendar');
  });
});

describe('AutonomousDaemon — _checkDesiredCapabilities()', () => {
  test('returns missing capabilities when selfModel reports empty caps', () => {
    const { daemon } = create({
      selfModel: { getCapabilities: () => [] },
    });
    daemon.skills = null;
    const gaps = daemon._checkDesiredCapabilities();
    assert(Array.isArray(gaps));
    assert(gaps.length > 0);
    assert(gaps.every(g => g.type === 'missing-capability'));
  });

  test('returns empty array when all desired caps present via skills', () => {
    const { daemon } = create({
      selfModel: { getCapabilities: () => ['web-access', 'file-management'] },
    });
    daemon.skills = {
      loadedSkills: new Map([['scheduler', true], ['chart-gen', true]]),
    };
    const gaps = daemon._checkDesiredCapabilities();
    assertEqual(gaps.length, 0);
  });
});

describe('AutonomousDaemon — _runCycle() interval dispatch', () => {
  test('increments cycleCount and populates lastResults', async () => {
    const { daemon } = create({
      memory: {
        getStats: () => ({ episodes: 0 }),
        recallEpisodes: () => [],
        learnFact: () => false,
        db: { procedural: [], episodic: [] },
        learnPattern: () => {},
      },
      selfModel: { getCapabilities: () => [] },
    });
    daemon.skills = null;
    daemon.running = true;
    // Set intervals so all sub-tasks fire on cycle 1
    daemon.config.healthInterval = 999;   // skip health (needs guard/reflector)
    daemon.config.consolidateInterval = 1;
    daemon.config.learnInterval = 1;
    daemon.config.optimizeInterval = 999; // skip optimize (needs reflector)
    daemon.config.gapInterval = 1;
    await daemon._runCycle();
    assertEqual(daemon.cycleCount, 1);
    assert(daemon.lastResults !== null);
  });
});

run();
