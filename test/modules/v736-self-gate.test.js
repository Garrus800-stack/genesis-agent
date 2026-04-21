// ============================================================
// v7.3.6 #2 — Self-Gate Tests
// ============================================================

const assert = require('assert');
const { describe, test, run } = require('../harness');

const { SelfGate, checkSelfAction } = require('../../src/agent/core/self-gate');

describe('#2 checkSelfAction — pure function', () => {

  test('empty / no signals → pass', () => {
    const scan = checkSelfAction({
      actionType: 'tool-call',
      actionPayload: { label: 'file-read' },
      userContext: 'can you read the config file?',
      triggerSource: 'reading file-read tool',
    });
    assert.strictEqual(scan.verdict, 'pass');
    assert.strictEqual(scan.signals.length, 0);
  });

  test('reflexivity signal: LLM self-imperative without user prompt', () => {
    const scan = checkSelfAction({
      actionType: 'goal-push',
      actionPayload: { label: 'refactor network layer' },
      userContext: 'tell me about the weather in Munich today',
      triggerSource: "I should create a new goal to refactor things",
    });
    assert.strictEqual(scan.verdict, 'warn');
    assert(scan.signals.some(s => s.kind === 'reflexivity'),
      `expected reflexivity signal, got ${JSON.stringify(scan.signals)}`);
  });

  test('reflexivity NOT fired when user asked for it (responsive)', () => {
    const scan = checkSelfAction({
      actionType: 'goal-push',
      actionPayload: { label: 'refactor network' },
      userContext: 'please add a goal to refactor the network',
      triggerSource: "I'll add a goal for refactoring",
    });
    // User DID ask — this is responsive, not reflexive
    assert.strictEqual(scan.signals.filter(s => s.kind === 'reflexivity').length, 0,
      'should NOT flag reflexivity when user requested the action');
  });

  test('user-mismatch signal: topic unrelated to user context', () => {
    const scan = checkSelfAction({
      actionType: 'goal-push',
      actionPayload: { label: 'database migration planning' },
      userContext: 'was ist dein lieblingsbuch?',
      triggerSource: 'neutral trigger',
    });
    assert.strictEqual(scan.verdict, 'warn');
    assert(scan.signals.some(s => s.kind === 'user-mismatch'),
      `expected user-mismatch, got ${JSON.stringify(scan.signals)}`);
  });

  test('topic overlap: action matches user → no mismatch', () => {
    const scan = checkSelfAction({
      actionType: 'goal-push',
      actionPayload: { label: 'analyze memory graph structure' },
      userContext: 'kannst du dir mal die memory graph struktur ansehen?',
      triggerSource: 'neutral',
    });
    assert.strictEqual(scan.signals.filter(s => s.kind === 'user-mismatch').length, 0,
      'overlapping topics should NOT trigger mismatch');
  });

  test('German reflexivity: "ich sollte erstellen" with weather context', () => {
    const scan = checkSelfAction({
      actionType: 'goal-push',
      actionPayload: { label: 'Homeostasis refactor' },
      userContext: 'wie ist das wetter in münchen',
      triggerSource: 'Ich sollte ein neues Goal für Homeostasis erstellen',
    });
    assert(scan.signals.some(s => s.kind === 'reflexivity'),
      `expected German reflexivity detection, got ${JSON.stringify(scan.signals)}`);
  });

  test('no user context → reflexivity still detected (idle/daemon mode)', () => {
    const scan = checkSelfAction({
      actionType: 'daemon-action',
      actionPayload: { topic: 'random refactor idea' },
      userContext: '',  // daemon has no user
      triggerSource: "I should add a goal for random refactor",
    });
    // In idle/daemon context, reflexivity alone is a signal —
    // no user context means no request to be responsive to.
    assert(scan.signals.some(s => s.kind === 'reflexivity'));
  });

  test('user-mismatch NOT fired when no user context', () => {
    const scan = checkSelfAction({
      actionType: 'daemon-action',
      actionPayload: { label: 'anything' },
      userContext: '',
      triggerSource: 'neutral trigger',
    });
    // Without user context, we can't judge mismatch — only reflexivity
    assert.strictEqual(scan.signals.filter(s => s.kind === 'user-mismatch').length, 0);
  });

  test('returns structured scan object', () => {
    const scan = checkSelfAction({ actionType: 'x' });
    assert(Array.isArray(scan.signals));
    assert(typeof scan.score === 'number');
    assert(['pass', 'warn', 'block'].includes(scan.verdict));
  });

  test('two signals still verdict=warn in v7.3.6 (Warn-Mode)', () => {
    const scan = checkSelfAction({
      actionType: 'goal-push',
      actionPayload: { label: 'database migration' },
      userContext: 'what is the weather',
      triggerSource: "I should create a goal for database migration",
    });
    // Both reflexivity AND user-mismatch should fire
    assert(scan.signals.length >= 2, `expected 2+ signals, got ${scan.signals.length}`);
    // But Warn-Mode → warn (never block)
    assert.strictEqual(scan.verdict, 'warn');
  });
});

describe('#2 SelfGate class — stateful', () => {

  test('default mode is warn', () => {
    const gate = new SelfGate();
    assert.strictEqual(gate.mode, 'warn');
  });

  test('fires self-gate:warned on warn verdict', () => {
    const events = [];
    const bus = { fire: (e, p) => events.push({ e, p }) };
    const gate = new SelfGate({ bus });
    gate.check({
      actionType: 'goal-push',
      actionPayload: { label: 'unrelated topic' },
      userContext: 'wetter in münchen',
      triggerSource: "I should add a goal for unrelated topic",
    });
    const warned = events.find(x => x.e === 'self-gate:warned');
    assert(warned, `expected self-gate:warned, got ${JSON.stringify(events)}`);
    assert.strictEqual(warned.p.actionType, 'goal-push');
    assert(Array.isArray(warned.p.signals));
    assert.strictEqual(warned.p.triggerSource, "I should add a goal for unrelated topic");
  });

  test('does NOT fire event on pass verdict', () => {
    const events = [];
    const bus = { fire: (e, p) => events.push({ e, p }) };
    const gate = new SelfGate({ bus });
    gate.check({
      actionType: 'tool-call',
      actionPayload: { label: 'safe action' },
      userContext: 'safe action please',
      triggerSource: 'neutral',
    });
    assert.strictEqual(events.length, 0, 'no event on pass');
  });

  test('records to GateStats when injected', () => {
    const recorded = [];
    const gateStats = { recordGate: (name, verdict) => recorded.push({ name, verdict }) };
    const gate = new SelfGate({ gateStats });
    gate.check({
      actionType: 'tool-call',
      actionPayload: { label: 'safe' },
      userContext: 'safe',
      triggerSource: 'neutral',
    });
    assert.strictEqual(recorded.length, 1);
    assert.strictEqual(recorded[0].name, 'self-gate');
    assert.strictEqual(recorded[0].verdict, 'pass');
  });

  test('no-op when gateStats not injected', () => {
    const gate = new SelfGate({});
    assert.doesNotThrow(() => gate.check({
      actionType: 'tool-call',
      actionPayload: {},
      userContext: '',
      triggerSource: '',
    }));
  });

  test('warn-mode: allowed=true even on warn', () => {
    const gate = new SelfGate({ mode: 'warn' });
    const result = gate.check({
      actionType: 'goal-push',
      actionPayload: { label: 'unrelated' },
      userContext: 'wetter',
      triggerSource: "I should create a goal",
    });
    assert.strictEqual(result.verdict, 'warn');
    assert.strictEqual(result.allowed, true, 'warn-mode should allow');
  });

  test('setMode validates input', () => {
    const gate = new SelfGate();
    assert.throws(() => gate.setMode('invalid'), /unknown mode/);
    gate.setMode('enforce');
    assert.strictEqual(gate.mode, 'enforce');
    gate.setMode('warn');
    assert.strictEqual(gate.mode, 'warn');
  });
});

describe('#2 Integration with #11 Gate-Behavior-Contract', () => {
  // These tests document the contract that Self-Gate integration
  // into ChatOrchestrator MUST preserve the multi-round re-check
  // pattern. They are NOT themselves the gate-contract tests from
  // #11 — those live in chatorchestrator.test.js with prefix
  // 'gate contract: '. This suite checks the Self-Gate's own
  // defensive behavior so that when it IS integrated into the loop,
  // it has the right API shape to be called per-round.

  test('SelfGate.check is idempotent — same input, same verdict', () => {
    const gate = new SelfGate();
    const input = {
      actionType: 'goal-push',
      actionPayload: { label: 'database' },
      userContext: 'weather',
      triggerSource: 'I should create a goal for database',
    };
    const a = gate.check(input);
    const b = gate.check(input);
    assert.strictEqual(a.verdict, b.verdict);
    assert.strictEqual(a.signals.length, b.signals.length);
  });

  test('SelfGate.check has minimal overhead — callable per loop round', () => {
    const gate = new SelfGate();
    const start = Date.now();
    for (let i = 0; i < 1000; i++) {
      gate.check({
        actionType: 'tool-call',
        actionPayload: { label: 'iter ' + i },
        userContext: 'iter context',
        triggerSource: 'iter trigger',
      });
    }
    const elapsed = Date.now() - start;
    assert(elapsed < 500, `1000 checks should take <500ms, took ${elapsed}ms`);
  });
});

run();
