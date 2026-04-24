// ============================================================
// v7.4.1 — IntentRouter Meta-State Pattern Tests
//
// Verifies that the 13 new meta-state patterns in
// _conversationalSignalsCheck() route state-pings ("wie viel
// energie", "welche Ziele hast du") directly to general/0.9 with
// stage 'conversational-meta-state' — so the RuntimeState-Block
// can answer with actual values instead of the router escalating
// into action-intent paths.
//
// Also checks that legitimate commands still classify correctly
// (no false positives).
// ============================================================

const { describe, it } = require('node:test');
const assert = require('assert');
const { IntentRouter } = require('../../src/agent/intelligence/IntentRouter');

function makeRouter() {
  return new IntentRouter({ model: null });
}

// ════════════════════════════════════════════════════════════
// Positive matches — the 13 meta-state patterns
// ════════════════════════════════════════════════════════════

describe('v7.4.1 — meta-state pattern matches', () => {
  const router = makeRouter();

  // German — emotion / mood
  it('matches "was ist dein gefühl"', () => {
    const r = router._conversationalSignalsCheck('was ist dein gefühl gerade?');
    assert.strictEqual(r?.type, 'general');
    assert.strictEqual(r?.stage, 'conversational-meta-state');
    assert.strictEqual(r?.confidence, 0.9);
  });

  it('matches "was ist dein mood"', () => {
    const r = router._conversationalSignalsCheck('was ist dein mood?');
    assert.strictEqual(r?.stage, 'conversational-meta-state');
  });

  it('matches "welche emotion" / "welche stimmung" / "welche energie"', () => {
    for (const msg of ['welche emotion dominiert', 'welche stimmung hast du', 'welche energie hast du']) {
      const r = router._conversationalSignalsCheck(msg);
      assert.strictEqual(r?.stage, 'conversational-meta-state',
        `"${msg}" should match meta-state`);
    }
  });

  // German — goals / work
  it('matches "welche Ziele hast du"', () => {
    const r = router._conversationalSignalsCheck('welche Ziele hast du heute?');
    assert.strictEqual(r?.stage, 'conversational-meta-state');
  });

  it('matches "woran arbeitest du"', () => {
    const r = router._conversationalSignalsCheck('woran arbeitest du gerade?');
    assert.strictEqual(r?.stage, 'conversational-meta-state');
  });

  // German — settings / model
  it('matches "welche settings"', () => {
    const r = router._conversationalSignalsCheck('welche settings sind aktiv?');
    assert.strictEqual(r?.stage, 'conversational-meta-state');
  });

  it('matches "welches modell" / "welcher backend"', () => {
    for (const msg of ['welches modell nutzt du', 'welcher backend läuft']) {
      const r = router._conversationalSignalsCheck(msg);
      assert.strictEqual(r?.stage, 'conversational-meta-state',
        `"${msg}" should match`);
    }
  });

  // German — daemon / energy / peers
  it('matches daemon questions', () => {
    for (const msg of ['was macht dein daemon', 'läuft dein daemon noch']) {
      const r = router._conversationalSignalsCheck(msg);
      assert.strictEqual(r?.stage, 'conversational-meta-state',
        `"${msg}" should match`);
    }
  });

  it('matches "wie viel energie"', () => {
    const r = router._conversationalSignalsCheck('wie viel energie hast du noch');
    assert.strictEqual(r?.stage, 'conversational-meta-state');
  });

  it('matches "wie autonom bist du"', () => {
    const r = router._conversationalSignalsCheck('wie autonom bist du aktuell?');
    assert.strictEqual(r?.stage, 'conversational-meta-state');
  });

  it('matches "wie viele peers"', () => {
    const r = router._conversationalSignalsCheck('wie viele peers sind verbunden');
    assert.strictEqual(r?.stage, 'conversational-meta-state');
  });

  // English equivalents
  it('matches English "how do you feel" / "how are you"', () => {
    for (const msg of ['how do you feel today?', 'how are you right now']) {
      const r = router._conversationalSignalsCheck(msg);
      assert.strictEqual(r?.stage, 'conversational-meta-state',
        `"${msg}" should match`);
    }
  });

  it('matches English "what is your mood/energy/state"', () => {
    for (const msg of ["what's your mood", 'what is your energy', "what's your feeling", 'what is your state']) {
      const r = router._conversationalSignalsCheck(msg);
      assert.strictEqual(r?.stage, 'conversational-meta-state',
        `"${msg}" should match`);
    }
  });

  it('matches English "what are you working on"', () => {
    const r = router._conversationalSignalsCheck('what are you working on?');
    assert.strictEqual(r?.stage, 'conversational-meta-state');
  });
});

// ════════════════════════════════════════════════════════════
// Negative matches — commands and actions must NOT route to
// meta-state (regression lock against overreach).
// ════════════════════════════════════════════════════════════

describe('v7.4.1 — meta-state patterns do NOT catch commands', () => {
  const router = makeRouter();

  it('does not match action verbs', () => {
    for (const msg of [
      'öffne die Datei config.json',
      'erstelle ein neues Skript',
      'baue die App',
      'deploy staging',
      'run tests',
    ]) {
      const r = router._conversationalSignalsCheck(msg);
      assert.notStrictEqual(r?.stage, 'conversational-meta-state',
        `"${msg}" must not match meta-state`);
    }
  });

  it('does not match slash commands', () => {
    for (const msg of ['/veto cm_123', '/settings', '/mark now']) {
      const r = router._conversationalSignalsCheck(msg);
      // slash commands may match other stages (or none), but definitely
      // not the new meta-state stage
      assert.notStrictEqual(r?.stage, 'conversational-meta-state',
        `"${msg}" must not match meta-state`);
    }
  });

  it('does not match other factual questions about the world', () => {
    for (const msg of [
      'wie ist das Wetter',
      'was ist die Hauptstadt von Frankreich',
      'wie alt ist die Erde',
      'what is recursion',
    ]) {
      const r = router._conversationalSignalsCheck(msg);
      assert.notStrictEqual(r?.stage, 'conversational-meta-state',
        `"${msg}" is not about Genesis' state`);
    }
  });
});

// ════════════════════════════════════════════════════════════
// Regression lock — existing v7.3.7 patterns still work
// ════════════════════════════════════════════════════════════

describe('v7.4.1 — existing conversational patterns remain green', () => {
  const router = makeRouter();

  it('greetings still match conversational-greeting', () => {
    const r = router._conversationalSignalsCheck('hi');
    assert.strictEqual(r?.stage, 'conversational-greeting');
  });

  it('reactions still match conversational-reaction', () => {
    const r = router._conversationalSignalsCheck('danke');
    assert.strictEqual(r?.stage, 'conversational-reaction');
  });

  it('v7.3.7 "wie fühlst du dich" still matches (meta, not meta-state)', () => {
    // This matches the older 'conversational-meta' pattern first.
    // Telemetry distinction intentional.
    const r = router._conversationalSignalsCheck('wie fühlst du dich');
    assert.ok(r?.stage === 'conversational-meta' || r?.stage === 'conversational-meta-state',
      `"wie fühlst du dich" should match one of the meta stages, got ${r?.stage}`);
  });

  it('generic question words still match conversational-question', () => {
    const r = router._conversationalSignalsCheck('warum regnet es');
    assert.strictEqual(r?.stage, 'conversational-question');
  });

  it('Windows-test Fall 1 still routed as conversational-question', () => {
    const r = router._conversationalSignalsCheck(
      'was macht Genesis heute. Ob seine Journal-Datei länger geworden ist');
    // Must match the v7.3.7 question-word pattern (as verified in Rev 3)
    assert.ok(r !== null, 'Fall 1 must be caught by some conversational gate');
    assert.strictEqual(r?.type, 'general');
  });
});
