#!/usr/bin/env node
// Test: session-summary timeout survivability — P2 (v7.9.25)
// The 8s budget now races model.chat INSIDE generateSessionSummary, so a timeout
// rejects into the existing catch: the deterministic fallback is written AND the
// checkpoint is deleted. Previously the timeout lived in the caller and on a slow
// model neither summary nor fallback was written, stranding the checkpoint.
const { describe, test, assert, assertEqual, run } = require('../harness');
const { SessionPersistence } = require('../../src/agent/revolution/SessionPersistence');

function mockStorage() {
  const calls = [];
  return {
    _calls: calls,
    writeJSON: (key, val) => { calls.push({ key, val }); },
    writeJSONAsync: (key, val) => { calls.push({ key, val, async: true }); return Promise.resolve(); },
    readJSON: () => null,
  };
}

function makeSP(model) {
  const storage = mockStorage();
  const sp = new SessionPersistence({ model, storage });
  sp.currentSession.messageCount = 5;
  sp.currentSession.topicsDiscussed = ['alpha', 'beta'];
  return { sp, storage };
}

function checkpointDeleted(storage) {
  return storage._calls.some(c => c.key === 'session-checkpoint.json' && c.val === null);
}

describe('SessionPersistence P2 — summary timeout survivability', () => {

  test('a slow model times out into the deterministic fallback', async () => {
    let called = false;
    const slowModel = {
      chat: () => new Promise((res) => {
        called = true;
        const t = setTimeout(() => res('SUMMARY: real\nUNFINISHED: none'), 200);
        if (t.unref) t.unref(); // never keep the process alive past the test
      }),
    };
    const { sp, storage } = makeSP(slowModel);
    const out = await sp.generateSessionSummary([], 20); // 20ms budget < 200ms model

    assert(called, 'the model call was actually attempted');
    assert(out && out.summary.startsWith('Session with 5 messages'),
      'fallback summary is returned on timeout');
    assert(checkpointDeleted(storage), 'checkpoint deleted even on timeout');
    assertEqual(sp.sessionHistory[sp.sessionHistory.length - 1].summary, out.summary,
      'fallback appended to session history');
  });

  test('a fast model produces the real parsed summary', async () => {
    const fastModel = { chat: async () => 'SUMMARY: We did real work.\nUNFINISHED: none' };
    const { sp, storage } = makeSP(fastModel);
    const out = await sp.generateSessionSummary([], 5000);

    assertEqual(out.summary, 'We did real work.', 'real summary parsed from model output');
    assert(checkpointDeleted(storage), 'checkpoint deleted after a successful summary');
  });

  test('an empty session with no history still returns null (no spurious summary)', async () => {
    const fastModel = { chat: async () => 'SUMMARY: x\nUNFINISHED: none' };
    const storage = mockStorage();
    const sp = new SessionPersistence({ model: fastModel, storage });
    // messageCount stays 0, history empty
    const out = await sp.generateSessionSummary([], 5000);
    assertEqual(out, null, 'no summary for an empty session');
  });
});

run();
