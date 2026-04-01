// ============================================================
// GENESIS — EmbodiedPerception.test.js (v5.6.0 — SA-P4)
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const { EmbodiedPerception } = require('../../src/agent/organism/EmbodiedPerception');

function makeEP(cfg) {
  const events = [];
  const ep = new EmbodiedPerception({
    bus: {
      emit(e, d, m) { events.push({ e, d }); },
      fire(e, d, m) { events.push({ e, d }); },
      on() {},
    },
    config: cfg || {},
  });
  ep._events = events;
  return ep;
}

describe('EmbodiedPerception — processHeartbeat', () => {
  test('updates activePanel', () => {
    const ep = makeEP();
    ep.processHeartbeat({ activePanel: 'editor' });
    assertEqual(ep.getUIState().activePanel, 'editor');
  });

  test('updates windowFocused', () => {
    const ep = makeEP();
    ep.processHeartbeat({ windowFocused: false });
    assertEqual(ep.getUIState().windowFocused, false);
  });

  test('updates typing state', () => {
    const ep = makeEP();
    ep.processHeartbeat({ isTyping: true, chatInputLength: 42 });
    assert(ep.isUserTyping());
    assertEqual(ep.getUIState().chatInputLength, 42);
  });

  test('updates lastHeartbeat timestamp', () => {
    const ep = makeEP();
    const before = Date.now();
    ep.processHeartbeat({ activePanel: 'chat' });
    assert(ep.getUIState().lastHeartbeat >= before);
  });

  test('ignores null/invalid data', () => {
    const ep = makeEP();
    ep.processHeartbeat(null);
    ep.processHeartbeat('garbage');
    assertEqual(ep.getUIState().activePanel, 'chat'); // default unchanged
  });
});

describe('EmbodiedPerception — engagement levels', () => {
  test('active when focused and low idle', () => {
    const ep = makeEP();
    ep.processHeartbeat({ windowFocused: true, userIdleMs: 1000 });
    assertEqual(ep.getEngagement().level, 'active');
  });

  test('idle after threshold', () => {
    const ep = makeEP({ idleThresholdMs: 5000 });
    ep.processHeartbeat({ windowFocused: true, userIdleMs: 10000 });
    assertEqual(ep.getEngagement().level, 'idle');
  });

  test('away after longer threshold', () => {
    const ep = makeEP({ idleThresholdMs: 5000, awayThresholdMs: 20000 });
    ep.processHeartbeat({ windowFocused: true, userIdleMs: 30000 });
    assertEqual(ep.getEngagement().level, 'away');
  });

  test('background when unfocused', () => {
    const ep = makeEP();
    ep.processHeartbeat({ windowFocused: false, userIdleMs: 0 });
    assertEqual(ep.getEngagement().level, 'background');
  });

  test('background on stale heartbeat', () => {
    const ep = makeEP({ heartbeatTimeoutMs: 100 });
    ep.processHeartbeat({ windowFocused: true, userIdleMs: 0 });
    ep._uiState.lastHeartbeat = Date.now() - 200; // simulate stale
    assertEqual(ep.getEngagement().level, 'background');
  });
});

describe('EmbodiedPerception — events', () => {
  test('emits panel-changed on switch', () => {
    const ep = makeEP();
    ep.processHeartbeat({ activePanel: 'editor' });
    assert(ep._events.some(e => e.e === 'embodied:panel-changed' && e.d.to === 'editor'));
  });

  test('emits focus-changed', () => {
    const ep = makeEP();
    ep.processHeartbeat({ windowFocused: false });
    assert(ep._events.some(e => e.e === 'embodied:focus-changed' && e.d.focused === false));
  });

  test('does not emit panel-changed when panel unchanged', () => {
    const ep = makeEP();
    ep.processHeartbeat({ activePanel: 'chat' }); // default is chat
    assert(!ep._events.some(e => e.e === 'embodied:panel-changed'));
  });
});

describe('EmbodiedPerception — isUserActive / isUserTyping', () => {
  test('isUserActive true when active', () => {
    const ep = makeEP();
    ep.processHeartbeat({ windowFocused: true, userIdleMs: 100 });
    assert(ep.isUserActive());
  });

  test('isUserActive false when idle', () => {
    const ep = makeEP({ idleThresholdMs: 5000 });
    ep.processHeartbeat({ windowFocused: true, userIdleMs: 10000 });
    assert(!ep.isUserActive());
  });

  test('isUserTyping false when not typing', () => {
    const ep = makeEP();
    ep.processHeartbeat({ isTyping: false });
    assert(!ep.isUserTyping());
  });

  test('isUserTyping false when empty input', () => {
    const ep = makeEP();
    ep.processHeartbeat({ isTyping: true, chatInputLength: 0 });
    assert(!ep.isUserTyping());
  });
});

describe('EmbodiedPerception — buildPromptContext', () => {
  test('empty string when active and focused', () => {
    const ep = makeEP();
    ep.processHeartbeat({ windowFocused: true, userIdleMs: 100, activePanel: 'chat' });
    assertEqual(ep.buildPromptContext(), '');
  });

  test('includes away state', () => {
    const ep = makeEP({ awayThresholdMs: 5000 });
    ep.processHeartbeat({ windowFocused: true, userIdleMs: 10000 });
    assert(ep.buildPromptContext().includes('Away'));
  });

  test('includes editor context', () => {
    const ep = makeEP();
    ep.processHeartbeat({ windowFocused: true, userIdleMs: 100, activePanel: 'editor' });
    assert(ep.buildPromptContext().includes('editor'));
  });

  test('includes typing state', () => {
    const ep = makeEP();
    ep.processHeartbeat({ windowFocused: true, userIdleMs: 100, isTyping: true, chatInputLength: 10 });
    assert(ep.buildPromptContext().includes('composing'));
  });
});

describe('EmbodiedPerception — interactionRate', () => {
  test('tracks active heartbeats', () => {
    const ep = makeEP();
    for (let i = 0; i < 5; i++) {
      ep.processHeartbeat({ windowFocused: true, userIdleMs: 100 });
    }
    assertEqual(ep.getEngagement().interactionRate, 5);
  });
});

describe('EmbodiedPerception — getReport', () => {
  test('returns complete report', () => {
    const ep = makeEP();
    ep.processHeartbeat({ activePanel: 'dashboard', windowFocused: true, userIdleMs: 0 });
    const report = ep.getReport();
    assert(report.uiState);
    assert(report.engagement);
    assertEqual(report.uiState.activePanel, 'dashboard');
    assertEqual(report.engagement.level, 'active');
  });
});

run();
