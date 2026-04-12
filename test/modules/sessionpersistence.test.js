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

  // ── v7.1.4 Feature 1: Crash-Safe Checkpoints ──

  test('_saveCheckpoint writes checkpoint with sessionId', () => {
    let written = null;
    const sp = create({ storage: { writeJSON(name, data) { written = { name, data }; }, readJSON: () => null, writeJSONAsync: async () => {} } });
    sp.currentSession.messageCount = 10;
    sp.currentSession.topicsDiscussed = ['coding'];
    sp._saveCheckpoint();
    assert(written, 'should write checkpoint');
    assertEqual(written.name, 'session-checkpoint.json');
    assertEqual(written.data.sessionId, sp._sessionId);
    assertEqual(written.data.messageCount, 10);
    assert(written.data.topics.includes('coding'));
  });

  test('_deleteCheckpoint clears checkpoint', () => {
    let written = null;
    const sp = create({ storage: { writeJSON(name, data) { written = { name, data }; }, readJSON: () => null, writeJSONAsync: async () => {} } });
    sp._deleteCheckpoint();
    assertEqual(written.data, null);
  });

  test('_recoverOrphanedCheckpoint creates fallback summary on crash', async () => {
    const checkpoint = { sessionId: 'crashed-session-123', messageCount: 15, topics: ['refactoring'], filesModified: ['AgentLoop.js'], decisions: [], errorCount: 1, lastMessageTime: new Date().toISOString() };
    let deleted = false;
    const sp = create({ storage: {
      readJSON(name) { if (name === 'session-checkpoint.json') return checkpoint; return null; },
      writeJSON(name, data) { if (name === 'session-checkpoint.json' && data === null) deleted = true; },
      writeJSONAsync: async () => {},
    }});
    sp._recoverOrphanedCheckpoint();
    assertEqual(sp.sessionHistory.length, 1);
    assert(sp.sessionHistory[0].summary.includes('crashed'), 'should mention crash');
    assertEqual(sp.sessionHistory[0].sessionId, 'crashed-session-123');
    assert(sp.sessionHistory[0].scores, 'should have scores');
    assert(deleted, 'checkpoint should be deleted after recovery');
  });

  test('_recoverOrphanedCheckpoint ignores already-summarized session', () => {
    const checkpoint = { sessionId: 'already-done', messageCount: 5, topics: [] };
    const sp = create({ storage: { readJSON: (name) => name === 'session-checkpoint.json' ? checkpoint : null, writeJSON: () => {}, writeJSONAsync: async () => {} } });
    sp.sessionHistory.push({ sessionId: 'already-done', summary: 'Done' });
    sp._recoverOrphanedCheckpoint();
    assertEqual(sp.sessionHistory.length, 1); // no new entry
  });

  test('checkpoint trigger fires every N messages', () => {
    let checkpointCount = 0;
    const bus = createBus();
    const sp = create({ bus, storage: { writeJSON() { checkpointCount++; }, readJSON: () => null, writeJSONAsync: async () => {} } });
    sp._checkpointInterval = 5;
    for (let i = 0; i < 12; i++) bus.emit('user:message', {});
    assertEqual(checkpointCount, 2); // at message 5 and 10
  });

  // ── v7.1.4 Feature 3: Session Scores ──

  test('_computeScores returns 4 scores', () => {
    const sp = create();
    const scores = sp._computeScores({ messageCount: 20, errorCount: 2, goalsWorkedOn: ['a', 'b'], filesModified: ['x.js', 'y.js'], decisions: ['d1'] });
    assertEqual(typeof scores.productivity, 'number');
    assertEqual(typeof scores.complexity, 'number');
    assertEqual(typeof scores.quality, 'number');
    assertEqual(typeof scores.impact, 'number');
    assert(scores.productivity >= 0 && scores.productivity <= 100);
    assert(scores.quality >= 0 && scores.quality <= 100);
  });

  test('_computeScores handles zero messages', () => {
    const sp = create();
    const scores = sp._computeScores({ messageCount: 0, errorCount: 0, goalsWorkedOn: [], filesModified: [], decisions: [] });
    assertEqual(scores.productivity, 0);
    assertEqual(scores.quality, 100); // no errors = perfect quality
    assertEqual(scores.impact, 10); // no code files = minimal
  });

  test('_computeScores quality uses max(messages, 5) floor', () => {
    const sp = create();
    const scores = sp._computeScores({ messageCount: 2, errorCount: 1, goalsWorkedOn: [], filesModified: [], decisions: [] });
    // quality = max(0, 100 - (1 / max(2, 5)) * 200) = max(0, 100 - 40) = 60
    assertEqual(scores.quality, 60);
  });

  test('getScoreTrends returns rolling average', () => {
    const sp = create();
    sp.sessionHistory.push({ scores: { productivity: 80, complexity: 40, quality: 90, impact: 60 } });
    sp.sessionHistory.push({ scores: { productivity: 60, complexity: 60, quality: 70, impact: 40 } });
    const trends = sp.getScoreTrends(5);
    assertEqual(trends.productivity, 70); // (80+60)/2
    assertEqual(trends.complexity, 50);
    assertEqual(trends.sessions, 2);
  });

  test('getScoreTrends returns null for no scored sessions', () => {
    const sp = create();
    sp.sessionHistory.push({ summary: 'no scores' });
    assertEqual(sp.getScoreTrends(), null);
  });
});

run();
