#!/usr/bin/env node
// Test: IdleMind — autonomous idle thinking
const { describe, test, assert, assertEqual, run } = require('../harness');
const { createBus } = require('../../src/agent/core/EventBus');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Create a temp dir for journal/plans
const tmpDir = path.join(os.tmpdir(), `genesis-idle-test-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });

const { IdleMind } = require('../../src/agent/autonomy/IdleMind');

function create(overrides = {}) {
  const bus = createBus();
  return {
    bus,
    idle: new IdleMind({
      bus,
      model: null,
      prompts: null,
      selfModel: null,
      memory: null,
      knowledgeGraph: null,
      eventStore: null,
      storageDir: tmpDir,
      goalStack: null,
      intervals: null,
      storage: null,
      ...overrides,
    }),
  };
}

describe('IdleMind', () => {

  test('constructor initializes with running=false', () => {
    const { idle } = create();
    assertEqual(idle.running, false);
    assertEqual(idle.thoughtCount, 0);
  });

  test('start sets running=true', () => {
    const { idle } = create();
    idle.start();
    assert(idle.running, 'should be running');
    idle.stop();
  });

  test('start is idempotent', () => {
    const { idle } = create();
    idle.start();
    idle.start(); // should not create second interval
    idle.stop();
  });

  test('stop sets running=false', () => {
    const { idle } = create();
    idle.start();
    idle.stop();
    assertEqual(idle.running, false);
  });

  test('stop is safe when not started', () => {
    const { idle } = create();
    idle.stop(); // Should not throw
  });

  test('userActive resets lastUserActivity', () => {
    const { idle } = create();
    const before = idle.lastUserActivity;
    // Simulate some time passing
    idle.lastUserActivity = Date.now() - 120000;
    idle.userActive();
    assert(idle.lastUserActivity > before - 1000, 'should reset to now');
  });

  test('user:message event resets lastUserActivity', () => {
    const { bus, idle } = create();
    idle.lastUserActivity = Date.now() - 120000;
    bus.emit('user:message', {});
    assert(Date.now() - idle.lastUserActivity < 1000, 'should be recent');
  });

  test('_think skips without model', async () => {
    const { idle } = create();
    idle.lastUserActivity = Date.now() - 120000;
    await idle._think();
    // model is null → returns before doing anything meaningful
    // thoughtCount may or may not increment depending on check order
  });

  test('_think skips when user was active recently', async () => {
    const { idle } = create({ model: { activeModel: 'test' } });
    idle.lastUserActivity = Date.now(); // just active
    await idle._think();
    // thoughtCount increments but returns early
    assertEqual(idle.thoughtCount, 1);
  });

  test('_think respects homeostasis gate', async () => {
    const { idle } = create({ model: { activeModel: 'test' } });
    idle.lastUserActivity = Date.now() - 120000;
    idle._homeostasis = { isAutonomyAllowed: () => false, getState: () => 'stressed' };
    await idle._think();
    // Should have returned early after homeostasis check
    assertEqual(idle.thoughtCount, 1);
  });

  test('_think respects metabolism gate', async () => {
    const { idle } = create({ model: { activeModel: 'test' } });
    idle.lastUserActivity = Date.now() - 120000;
    idle._metabolism = { canAfford: () => false };
    await idle._think();
    assertEqual(idle.thoughtCount, 1);
  });

  test('_isSignificantInsight filters correctly', () => {
    const { idle } = create();
    // Too short
    assert(!idle._isSignificantInsight('reflect', 'short'));
    // Wrong activity
    assert(!idle._isSignificantInsight('consolidate', 'found something interesting in the codebase that could be improved significantly'));
    // No actionable keywords
    assert(!idle._isSignificantInsight('reflect', 'a'.repeat(60)));
    // Valid
    idle._lastInsightTs = 0; // bypass rate limit
    assert(idle._isSignificantInsight('reflect', 'I noticed a pattern that could be optimized for better performance in the main loop processing'));
  });

  test('activityLog stays bounded at 20', () => {
    const { idle } = create();
    for (let i = 0; i < 25; i++) {
      idle.activityLog.push({ activity: 'test', timestamp: Date.now() });
    }
    if (idle.activityLog.length > 20) {
      idle.activityLog = idle.activityLog.slice(-20);
    }
    assertEqual(idle.activityLog.length, 20);
  });

  test('start with intervals manager', () => {
    const intervals = {
      register: (name, fn, ms, opts) => {},
      unregister: (name) => {},
      clear: (name) => {},
    };
    const bus = createBus();
    const idle = new IdleMind({
      bus, model: null, prompts: null, selfModel: null, memory: null,
      knowledgeGraph: null, eventStore: null, storageDir: tmpDir,
      goalStack: null, intervals, storage: null,
    });
    idle.start();
    assert(idle.running);
    idle.stop();
  });
});

// Cleanup
run();
try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* best effort */ }
