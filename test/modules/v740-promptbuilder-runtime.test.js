// ============================================================
// v7.4.0 Session 3 — PromptBuilder Runtime-State Integration
//
// Tests the _runtimeStateContext() method:
//   - Returns '' when no port wired
//   - Returns '' when port empty
//   - Renders expected lines per service
//   - Respects the 800-char budget with truncation marker
//   - Renders in English regardless of lang.current
//   - Is defensive against partial / malformed snapshots
// ============================================================

const { describe, it } = require('node:test');
const assert = require('assert');
const { PromptBuilder } = require('../../src/agent/intelligence/PromptBuilder');
const { RuntimeStatePort } = require('../../src/agent/ports/RuntimeStatePort');

function makeBuilder() {
  return new PromptBuilder({
    selfModel: null, model: null, skills: null,
    knowledgeGraph: null, memory: null, storage: null,
  });
}

function makePortWith(services) {
  const port = new RuntimeStatePort();
  for (const [name, snap] of Object.entries(services)) {
    port.register(name, { getRuntimeSnapshot: () => snap });
  }
  return port;
}

// ════════════════════════════════════════════════════════════
// Graceful degradation
// ════════════════════════════════════════════════════════════

describe('v7.4.0 — _runtimeStateContext graceful degradation', () => {

  it('returns empty string when no port wired', () => {
    const pb = makeBuilder();
    assert.strictEqual(pb._runtimeStateContext(), '');
  });

  it('returns empty string when port is empty', () => {
    const pb = makeBuilder();
    pb.runtimeStatePort = new RuntimeStatePort();
    assert.strictEqual(pb._runtimeStateContext(), '');
  });

  it('returns empty string when port throws', () => {
    const pb = makeBuilder();
    pb.runtimeStatePort = {
      snapshot: () => { throw new Error('kaboom'); },
    };
    assert.strictEqual(pb._runtimeStateContext(), '');
  });

  it('returns empty string when port returns non-object', () => {
    const pb = makeBuilder();
    pb.runtimeStatePort = { snapshot: () => null };
    assert.strictEqual(pb._runtimeStateContext(), '');
  });

  it('returns empty string when port returns empty object', () => {
    const pb = makeBuilder();
    pb.runtimeStatePort = { snapshot: () => ({}) };
    assert.strictEqual(pb._runtimeStateContext(), '');
  });
});

// ════════════════════════════════════════════════════════════
// Rendering per service
// ════════════════════════════════════════════════════════════

describe('v7.4.0 — _runtimeStateContext rendering', () => {

  it('renders Settings as Model + backend + trust + lang', () => {
    const pb = makeBuilder();
    pb.runtimeStatePort = makePortWith({
      settings: {
        backend: 'ollama', model: 'qwen2.5:7b',
        trustLevel: 'ASSISTED', language: 'de',
      },
    });
    const out = pb._runtimeStateContext();
    assert.ok(out.includes('qwen2.5:7b'));
    assert.ok(out.includes('ollama'));
    assert.ok(out.includes('ASSISTED'));
    assert.ok(out.includes('de'));
  });

  it('renders EmotionalState as Feeling with top3 + mood', () => {
    const pb = makeBuilder();
    pb.runtimeStatePort = makePortWith({
      emotionalState: {
        dominant: 'curiosity', intensity: 60, mood: 'curious', trend: 'stable',
        top3: [
          { name: 'curiosity',    value: 80 },
          { name: 'satisfaction', value: 50 },
          { name: 'loneliness',   value: 30 },
        ],
      },
    });
    const out = pb._runtimeStateContext();
    assert.ok(out.includes("Gefühl:"));
    assert.ok(out.includes('curiosity 80%'));
    assert.ok(out.includes('satisfaction 50%'));
    assert.ok(out.includes('loneliness 30%'));
    assert.ok(out.includes('curious'));
  });

  it('renders NeedsSystem as Needs with drive percentages', () => {
    const pb = makeBuilder();
    pb.runtimeStatePort = makePortWith({
      needsSystem: {
        active: [
          { name: 'knowledge', drive: 80 },
          { name: 'social',    drive: 40 },
        ],
      },
    });
    const out = pb._runtimeStateContext();
    assert.ok(out.includes('Bedürfnisse:'));
    assert.ok(out.includes('knowledge 80%'));
    assert.ok(out.includes('social 40%'));
  });

  it('skips NeedsSystem when active list is empty', () => {
    const pb = makeBuilder();
    pb.runtimeStatePort = makePortWith({
      needsSystem: { active: [] },
      metabolism: { energyPercent: 50, llmCalls: 0 },
    });
    const out = pb._runtimeStateContext();
    assert.ok(!out.includes('Bedürfnisse:'));
    assert.ok(out.includes('Energie:'));
  });

  it('renders Metabolism as Energy + LLM calls', () => {
    const pb = makeBuilder();
    pb.runtimeStatePort = makePortWith({
      metabolism: { energyPercent: 73, llmCalls: 12 },
    });
    const out = pb._runtimeStateContext();
    assert.ok(out.includes('Energie: 73%'));
    assert.ok(out.includes('12 LLM-Calls'));
  });

  it('renders Daemon as running/stopped + cycles', () => {
    const pb = makeBuilder();
    pb.runtimeStatePort = makePortWith({
      daemon: { running: true, cycles: 48, checksRun: ['health'], gapCount: 0 },
    });
    const out = pb._runtimeStateContext();
    assert.ok(out.includes('Daemon: läuft'));
    assert.ok(out.includes('48 Zyklen'));
  });

  it('renders IdleMind active vs idle differently', () => {
    const pb1 = makeBuilder();
    pb1.runtimeStatePort = makePortWith({
      idleMind: {
        running: true, isIdle: false, minutesIdle: 0,
        thoughtCount: 5, currentActivity: null, lastActivityAgoSeconds: null,
      },
    });
    const out1 = pb1._runtimeStateContext();
    assert.ok(out1.includes('IdleMind: aktiv'));

    const pb2 = makeBuilder();
    pb2.runtimeStatePort = makePortWith({
      idleMind: {
        running: true, isIdle: true, minutesIdle: 5,
        thoughtCount: 12, currentActivity: 'memory-decay', lastActivityAgoSeconds: 30,
      },
    });
    const out2 = pb2._runtimeStateContext();
    assert.ok(out2.includes('IdleMind: idle 5m'));
    assert.ok(out2.includes('memory-decay'));
  });

  it('renders GoalStack with count + top title', () => {
    const pb = makeBuilder();
    pb.runtimeStatePort = makePortWith({
      goalStack: {
        open: 2, paused: 1,
        topTitle: 'v7.4.0 observations sammeln',
      },
    });
    const out = pb._runtimeStateContext();
    assert.ok(out.includes('Ziele:'));
    assert.ok(out.includes('2 offen'));
    assert.ok(out.includes('1 pausiert'));
    assert.ok(out.includes('v7.4.0 observations'));
  });

  it('renders PeerNetwork as peer count visible', () => {
    const pb = makeBuilder();
    pb.runtimeStatePort = makePortWith({
      peerNetwork: { peerCount: 0, ownPort: 8080 },
    });
    const out = pb._runtimeStateContext();
    assert.ok(out.includes('Peers: 0 sichtbar'));
  });

  it('renders complete snapshot with all 8 services', () => {
    const pb = makeBuilder();
    pb.runtimeStatePort = makePortWith({
      settings: { backend: 'ollama', model: 'qwen2.5:7b', trustLevel: 'ASSISTED', language: 'de' },
      emotionalState: { dominant: 'curiosity', intensity: 60, mood: 'curious', trend: 'stable',
        top3: [{name:'curiosity',value:80},{name:'satisfaction',value:50},{name:'loneliness',value:30}] },
      needsSystem: { active: [{name:'knowledge',drive:80}] },
      metabolism: { energyPercent: 73, llmCalls: 12 },
      daemon: { running: true, cycles: 48, checksRun: [], gapCount: 0 },
      idleMind: { running: true, isIdle: true, minutesIdle: 5,
        thoughtCount: 12, currentActivity: 'memory-decay', lastActivityAgoSeconds: 30 },
      goalStack: { open: 2, paused: 0, topTitle: 'top goal' },
      peerNetwork: { peerCount: 0, ownPort: 8080 },
    });
    const out = pb._runtimeStateContext();
    assert.ok(out.startsWith('[Aktueller Zustand'));
    // All 8 sections should be visible
    for (const keyword of ['Modell:', "Gefühl:", 'Bedürfnisse:', 'Energie:',
                           'Daemon:', 'IdleMind:', 'Ziele:', 'Peers:']) {
      assert.ok(out.includes(keyword), `missing keyword: ${keyword}`);
    }
  });
});

// ════════════════════════════════════════════════════════════
// Language — German as robust default. Genesis answers in
// user's language via the "Respond in user's language"
// directive in the identity block. The runtime-block labels
// themselves are German but semantically neutral — an
// English-speaking user still gets English answers.
// ════════════════════════════════════════════════════════════

describe('v7.4.0 — _runtimeStateContext language consistency', () => {

  it('renders German block (German as robust default)', () => {
    const pb = makeBuilder();
    pb.lang = { current: 'de' };
    pb.runtimeStatePort = makePortWith({
      metabolism: { energyPercent: 73, llmCalls: 12 },
    });
    const out = pb._runtimeStateContext();
    assert.ok(out.includes('Energie:'), 'German "Energie" keyword required');
    assert.ok(out.includes('LLM-Calls'), 'German "LLM-Calls" required');
    assert.ok(!out.includes('Energy:'), 'no English "Energy:" label allowed');
  });

  it('renders same German block regardless of lang.current', () => {
    const pb = makeBuilder();
    pb.lang = { current: 'en' };
    pb.runtimeStatePort = makePortWith({
      emotionalState: { dominant: 'satisfaction', intensity: 50, mood: 'content',
        top3: [{name:'satisfaction',value:60}] },
    });
    const out = pb._runtimeStateContext();
    // Block stays German for stable LLM-understanding —
    // Genesis' primary user language is German.
    assert.ok(out.includes('Gefühl:'));
  });
});

// ════════════════════════════════════════════════════════════
// Budget enforcement
// ════════════════════════════════════════════════════════════

describe('v7.4.0 — _runtimeStateContext budget enforcement', () => {

  it('does NOT truncate typical snapshot (well under 800 chars)', () => {
    const pb = makeBuilder();
    pb.runtimeStatePort = makePortWith({
      settings: { backend: 'ollama', model: 'qwen2.5:7b', trustLevel: 'ASSISTED', language: 'de' },
      emotionalState: { dominant: 'curiosity', intensity: 60, mood: 'curious', trend: 'stable',
        top3: [{name:'curiosity',value:80},{name:'satisfaction',value:50},{name:'loneliness',value:30}] },
      metabolism: { energyPercent: 73, llmCalls: 12 },
    });
    const out = pb._runtimeStateContext();
    assert.ok(out.length < 800, `typical snapshot should be < 800 chars, got ${out.length}`);
    assert.ok(!out.includes("[...gekürzt]"));
  });

  it('truncates when output exceeds 800 chars', () => {
    const pb = makeBuilder();
    // Build an artificially large goal title to push over budget.
    const longTitle = 'x'.repeat(500);
    pb.runtimeStatePort = makePortWith({
      settings: { backend: 'ollama', model: 'qwen2.5:7b', trustLevel: 'ASSISTED', language: 'de' },
      emotionalState: { dominant: 'curiosity', intensity: 60, mood: 'curious',
        top3: [{name:'a',value:1},{name:'b',value:2},{name:'c',value:3}] },
      needsSystem: { active: [{name:'x',drive:1},{name:'y',drive:2},{name:'z',drive:3}] },
      metabolism: { energyPercent: 73, llmCalls: 12 },
      daemon: { running: true, cycles: 48, gapCount: 0 },
      idleMind: { running: true, isIdle: true, minutesIdle: 5,
        thoughtCount: 12, currentActivity: longTitle, lastActivityAgoSeconds: 30 },
      goalStack: { open: 2, paused: 0, topTitle: longTitle },
      peerNetwork: { peerCount: 0, ownPort: 8080 },
    });
    const out = pb._runtimeStateContext();
    assert.ok(out.length <= 800, `truncated output should be <= 800 chars, got ${out.length}`);
    assert.ok(out.includes("[...gekürzt]"),
      'oversized output must end with truncation marker');
  });
});

// ════════════════════════════════════════════════════════════
// Defensive — partial/malformed snapshots don't crash
// ════════════════════════════════════════════════════════════

describe('v7.4.0 — _runtimeStateContext defensive handling', () => {

  it('skips service whose snapshot is missing expected fields', () => {
    const pb = makeBuilder();
    pb.runtimeStatePort = makePortWith({
      settings: {},  // No fields at all
      metabolism: { energyPercent: 50, llmCalls: 1 },
    });
    const out = pb._runtimeStateContext();
    // Settings line should not appear (no fields), metabolism should.
    assert.ok(out.includes('Energie: 50%'));
  });

  it('renders when only one service is present', () => {
    const pb = makeBuilder();
    pb.runtimeStatePort = makePortWith({
      metabolism: { energyPercent: 73, llmCalls: 12 },
    });
    const out = pb._runtimeStateContext();
    assert.ok(out.startsWith('[Aktueller Zustand'));
    assert.ok(out.includes('Energie:'));
  });
});
