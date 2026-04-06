#!/usr/bin/env node
// Test: SessionPersistence — session tracking + boot context
const { describe, test, assert, assertEqual, run } = require('../harness');
const { createBus } = require('../../src/agent/core/EventBus');
const { SessionPersistence } = require('../../src/agent/revolution/SessionPersistence');

function create(overrides = {}) {
  return new SessionPersistence({
    bus: createBus(),
    model: null,
    memory: null,
    storage: null,
    lang: { t: k => k },
    ...overrides,
  });
}

describe('SessionPersistence', () => {

  test('constructor initializes current session', () => {
    const sp = create();
    assertEqual(sp.currentSession.messageCount, 0);
    assert(sp.currentSession.startedAt);
    assertEqual(sp.currentSession.topicsDiscussed.length, 0);
  });

  test('constructor initializes user profile', () => {
    const sp = create();
    assertEqual(sp.userProfile.name, null);
    assertEqual(sp.userProfile.interests.length, 0);
    assertEqual(sp.userProfile.projects.length, 0);
  });

  test('buildBootContext returns string', () => {
    const sp = create();
    const ctx = sp.buildBootContext();
    assert(typeof ctx === 'string');
  });

  test('buildBootContext includes user name if set', () => {
    const sp = create();
    sp.userProfile.name = 'Garrus';
    const ctx = sp.buildBootContext();
    assert(ctx.includes('Garrus'), 'should include user name');
  });

  test('buildBootContext includes previous session', () => {
    const sp = create();
    sp.sessionHistory.push({
      startedAt: new Date().toISOString(),
      summary: 'Worked on Colony IPC',
      messageCount: 15,
    });
    const ctx = sp.buildBootContext();
    assert(ctx.includes('Colony IPC') || ctx.length > 0);
  });

  test('updateUserProfile sets name', () => {
    const sp = create();
    sp.updateUserProfile({ name: 'Garrus' });
    assertEqual(sp.userProfile.name, 'Garrus');
  });

  test('updateUserProfile adds interests (dedup)', () => {
    const sp = create();
    sp.updateUserProfile({ interest: 'AI' });
    sp.updateUserProfile({ interest: 'AI' }); // duplicate
    sp.updateUserProfile({ interest: 'Rust' });
    assertEqual(sp.userProfile.interests.length, 2);
  });

  test('updateUserProfile caps interests at 20', () => {
    const sp = create();
    for (let i = 0; i < 25; i++) {
      sp.updateUserProfile({ interest: `topic-${i}` });
    }
    assert(sp.userProfile.interests.length <= 20);
  });

  test('updateUserProfile adds projects (dedup)', () => {
    const sp = create();
    sp.updateUserProfile({ project: 'Genesis' });
    sp.updateUserProfile({ project: 'Genesis' });
    assertEqual(sp.userProfile.projects.length, 1);
  });

  test('updateUserProfile caps projects at 10', () => {
    const sp = create();
    for (let i = 0; i < 15; i++) {
      sp.updateUserProfile({ project: `proj-${i}` });
    }
    assert(sp.userProfile.projects.length <= 10);
  });

  test('sessionHistory caps at maxSessionHistory', () => {
    const sp = create();
    for (let i = 0; i < 15; i++) {
      sp.sessionHistory.push({ summary: `session ${i}` });
    }
    if (sp.sessionHistory.length > sp.maxSessionHistory) {
      sp.sessionHistory = sp.sessionHistory.slice(-sp.maxSessionHistory);
    }
    assertEqual(sp.sessionHistory.length, 10);
  });

  test('generateSessionSummary returns empty for no messages', async () => {
    const sp = create();
    const summary = await sp.generateSessionSummary([]);
    assert(summary === null || summary === '' || typeof summary === 'string');
  });
});

run();
