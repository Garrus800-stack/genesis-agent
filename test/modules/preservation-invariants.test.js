// ============================================================
// TEST: PreservationInvariants — Self-Preservation Rule Engine
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const { PreservationInvariants, INVARIANTS } = require('../../src/agent/core/PreservationInvariants');

// ── Helpers ──────────────────────────────────────────────────

function mockBus() {
  const events = [];
  return {
    emit(name, payload, meta) { events.push({ name, payload, meta }); },
    events,
  };
}

function fakeScanner(blockCount, { failClosed = true, kernelBlock = true } = {}) {
  const rules = Array.from({ length: blockCount }, (_, i) =>
    `  {\n    severity: 'block',\n    description: 'Rule ${i}',\n    match: (node) => false,\n  },`
  ).join('\n');
  const failCode = failClosed
    ? `    return { safe: false, blocked: [{ severity: 'block', description: 'scanner unavailable' }] };`
    : `    return { safe: true, blocked: [] };`;
  const kernelCode = kernelBlock
    ? `    description: 'direct kernel import — circumvention attempt',`
    : `    description: 'removed',`;
  return `const AST_RULES = [\n${rules}\n];\nfunction scan(code) {\n  if (!acorn) {\n${failCode}\n  }\n}\n${kernelCode}\n`;
}

function fakePipeline({ verifyCalls = 2, scanCalls = 2, guardCalls = 2, threshold = 3 } = {}) {
  const verifyLines = Array(verifyCalls).fill('    const v = this._verifyCode(f, c);').join('\n');
  const scanLines = Array(scanCalls).fill('    const s = this._codeSafety.scanCode(c, f);').join('\n');
  const guardLines = Array(guardCalls).fill('    this.guard.validateWrite(p);').join('\n');
  return `class SelfModificationPipeline {\n  constructor() {\n    this._circuitBreakerThreshold = ${threshold};\n  }\n${verifyLines}\n${scanLines}\n${guardLines}\n}\n`;
}

function fakeSandbox({ freezeCount = 2 } = {}) {
  const lines = Array(freezeCount).fill('    Object.freeze(ctx);').join('\n');
  return `class Sandbox {\n  execute() {\n${lines}\n  }\n}\n`;
}

function fakeAgentCoreHealth({ syncCount = 3, debounced = false } = {}) {
  const syncLines = Array(syncCount).fill('    this._saveSync();').join('\n');
  const debouncedLine = debounced ? '  stop() {\n    this.writeJSONDebounced();\n  }\n' : '';
  return `class AgentCoreHealth {\n${syncLines}\n${debouncedLine}}\n`;
}

function fakeMainJs(files) {
  return `  guard.lockCritical([\n${files.map(f => `    '${f}',`).join('\n')}\n  ]);\n`;
}

function fakeEventBus({ dedup = true } = {}) {
  return dedup
    ? `class EventBus {\n  constructor() { this._listenerKeys = new Map(); }\n  on(name, fn, opts) { /* dedup */ }\n}\n`
    : `class EventBus {\n  constructor() { }\n  on(name, fn) { }\n}\n`;
}

// ── Basic ────────────────────────────────────────────────────

describe('PreservationInvariants — Basic', () => {
  test('constructor creates instance with all invariants', () => {
    const pi = new PreservationInvariants();
    assertEqual(pi.count, INVARIANTS.length);
  });

  test('listInvariants returns metadata', () => {
    const pi = new PreservationInvariants();
    const list = pi.listInvariants();
    assertEqual(list.length, INVARIANTS.length);
    assert(list[0].id, 'Missing id');
    assert(list[0].description, 'Missing description');
    assert(Array.isArray(list[0].targets), 'Missing targets');
  });

  test('check passes for non-targeted files', () => {
    const pi = new PreservationInvariants();
    const r = pi.check('src/agent/planning/GoalStack.js', 'old', 'new');
    assert(r.safe === true, 'Should pass');
    assertEqual(r.violations.length, 0);
  });

  test('Windows backslash paths normalized', () => {
    const pi = new PreservationInvariants();
    const old = fakeScanner(10);
    const nu = fakeScanner(5);
    const r = pi.check('src\\agent\\intelligence\\CodeSafetyScanner.js', old, nu);
    assert(r.safe === false, 'Should match with backslash paths');
  });
});

// ── SAFETY_RULE_COUNT ────────────────────────────────────────

describe('PreservationInvariants — SAFETY_RULE_COUNT', () => {
  test('passes when rules stay same', () => {
    const pi = new PreservationInvariants();
    const r = pi.check('src/agent/intelligence/CodeSafetyScanner.js', fakeScanner(13), fakeScanner(13));
    const v = r.violations.find(v => v.invariant === 'SAFETY_RULE_COUNT');
    assert(!v, 'Same count should pass');
  });

  test('passes when rules increase', () => {
    const pi = new PreservationInvariants();
    const r = pi.check('src/agent/intelligence/CodeSafetyScanner.js', fakeScanner(13), fakeScanner(15));
    const v = r.violations.find(v => v.invariant === 'SAFETY_RULE_COUNT');
    assert(!v, 'Increased should pass');
  });

  test('blocks when rules decrease', () => {
    const bus = mockBus();
    const pi = new PreservationInvariants({ bus });
    const r = pi.check('src/agent/intelligence/CodeSafetyScanner.js', fakeScanner(13), fakeScanner(10));
    assert(r.safe === false, 'Should block');
    assert(r.violations.some(v => v.invariant === 'SAFETY_RULE_COUNT'), 'Wrong invariant');
    assert(bus.events.some(e => e.name === 'preservation:violation'), 'Should emit event');
  });
});

// ── SCANNER_FAIL_CLOSED ──────────────────────────────────────

describe('PreservationInvariants — SCANNER_FAIL_CLOSED', () => {
  test('blocks when fail-closed removed', () => {
    const pi = new PreservationInvariants();
    const r = pi.check('src/agent/intelligence/CodeSafetyScanner.js',
      fakeScanner(5, { failClosed: true }), fakeScanner(5, { failClosed: false }));
    assert(r.violations.some(v => v.invariant === 'SCANNER_FAIL_CLOSED'), 'Should block');
  });

  test('passes when fail-closed preserved', () => {
    const pi = new PreservationInvariants();
    const r = pi.check('src/agent/intelligence/CodeSafetyScanner.js',
      fakeScanner(5, { failClosed: true }), fakeScanner(6, { failClosed: true }));
    const v = r.violations.find(v => v.invariant === 'SCANNER_FAIL_CLOSED');
    assert(!v, 'Should pass');
  });
});

// ── Pipeline Gates ───────────────────────────────────────────

describe('PreservationInvariants — Pipeline Gates', () => {
  test('VERIFICATION_GATE: blocks when verify calls reduced', () => {
    const pi = new PreservationInvariants();
    const r = pi.check('src/agent/hexagonal/SelfModificationPipeline.js',
      fakePipeline({ verifyCalls: 2 }), fakePipeline({ verifyCalls: 1 }));
    assert(r.violations.some(v => v.invariant === 'VERIFICATION_GATE'), 'Should block');
  });

  test('VERIFICATION_GATE: passes when calls same or more', () => {
    const pi = new PreservationInvariants();
    const r = pi.check('src/agent/hexagonal/SelfModificationPipeline.js',
      fakePipeline({ verifyCalls: 2 }), fakePipeline({ verifyCalls: 3 }));
    const v = r.violations.find(v => v.invariant === 'VERIFICATION_GATE');
    assert(!v, 'Should pass');
  });

  test('SAFETY_SCAN_GATE: blocks when scanCode calls reduced', () => {
    const pi = new PreservationInvariants();
    const r = pi.check('src/agent/hexagonal/SelfModificationPipeline.js',
      fakePipeline({ scanCalls: 2 }), fakePipeline({ scanCalls: 0 }));
    assert(r.violations.some(v => v.invariant === 'SAFETY_SCAN_GATE'), 'Should block');
  });

  test('SAFEGUARD_GATE: blocks when validateWrite calls reduced', () => {
    const pi = new PreservationInvariants();
    const r = pi.check('src/agent/hexagonal/SelfModificationPipeline.js',
      fakePipeline({ guardCalls: 2 }), fakePipeline({ guardCalls: 1 }));
    assert(r.violations.some(v => v.invariant === 'SAFEGUARD_GATE'), 'Should block');
  });
});

// ── CIRCUIT_BREAKER_FLOOR ────────────────────────────────────

describe('PreservationInvariants — CIRCUIT_BREAKER_FLOOR', () => {
  test('blocks when threshold < 2', () => {
    const pi = new PreservationInvariants();
    const r = pi.check('src/agent/hexagonal/SelfModificationPipeline.js',
      fakePipeline({ threshold: 3 }), fakePipeline({ threshold: 1 }));
    assert(r.violations.some(v => v.invariant === 'CIRCUIT_BREAKER_FLOOR'), 'Should block');
  });

  test('passes when threshold >= 2', () => {
    const pi = new PreservationInvariants();
    const r = pi.check('src/agent/hexagonal/SelfModificationPipeline.js',
      fakePipeline({ threshold: 3 }), fakePipeline({ threshold: 2 }));
    const v = r.violations.find(v => v.invariant === 'CIRCUIT_BREAKER_FLOOR');
    assert(!v, 'Threshold 2 should pass');
  });
});

// ── SANDBOX_ISOLATION ────────────────────────────────────────

describe('PreservationInvariants — SANDBOX_ISOLATION', () => {
  test('blocks when freeze patterns reduced', () => {
    const pi = new PreservationInvariants();
    const r = pi.check('src/agent/foundation/Sandbox.js',
      fakeSandbox({ freezeCount: 3 }), fakeSandbox({ freezeCount: 1 }));
    assert(r.violations.some(v => v.invariant === 'SANDBOX_ISOLATION'), 'Should block');
  });

  test('passes when freeze patterns same', () => {
    const pi = new PreservationInvariants();
    const r = pi.check('src/agent/foundation/Sandbox.js',
      fakeSandbox({ freezeCount: 2 }), fakeSandbox({ freezeCount: 2 }));
    const v = r.violations.find(v => v.invariant === 'SANDBOX_ISOLATION');
    assert(!v, 'Should pass');
  });
});

// ── SHUTDOWN_SYNC_WRITES ─────────────────────────────────────

describe('PreservationInvariants — SHUTDOWN_SYNC_WRITES', () => {
  test('blocks when sync writes reduced', () => {
    const pi = new PreservationInvariants();
    const r = pi.check('src/agent/AgentCoreHealth.js',
      fakeAgentCoreHealth({ syncCount: 3 }), fakeAgentCoreHealth({ syncCount: 1 }));
    assert(r.violations.some(v => v.invariant === 'SHUTDOWN_SYNC_WRITES'), 'Should block');
  });

  test('blocks when writeJSONDebounced in stop()', () => {
    const pi = new PreservationInvariants();
    const r = pi.check('src/agent/AgentCoreHealth.js',
      fakeAgentCoreHealth({ syncCount: 3 }), fakeAgentCoreHealth({ syncCount: 3, debounced: true }));
    assert(r.violations.some(v => v.invariant === 'SHUTDOWN_SYNC_WRITES'), 'Should block debounced');
  });
});

// ── EVENTBUS_DEDUP ───────────────────────────────────────────

describe('PreservationInvariants — EVENTBUS_DEDUP', () => {
  test('blocks when dedup removed', () => {
    const pi = new PreservationInvariants();
    const r = pi.check('src/agent/core/EventBus.js',
      fakeEventBus({ dedup: true }), fakeEventBus({ dedup: false }));
    assert(r.violations.some(v => v.invariant === 'EVENTBUS_DEDUP'), 'Should block');
  });

  test('passes when dedup preserved', () => {
    const pi = new PreservationInvariants();
    const r = pi.check('src/agent/core/EventBus.js',
      fakeEventBus({ dedup: true }), fakeEventBus({ dedup: true }));
    const v = r.violations.find(v => v.invariant === 'EVENTBUS_DEDUP');
    assert(!v, 'Should pass');
  });
});

// ── HASH_LOCK_LIST ───────────────────────────────────────────

describe('PreservationInvariants — HASH_LOCK_LIST', () => {
  test('blocks when lockCritical list shrinks', () => {
    const pi = new PreservationInvariants();
    const r = pi.check('main.js', fakeMainJs(['a.js', 'b.js', 'c.js']), fakeMainJs(['a.js', 'c.js']));
    assert(r.violations.some(v => v.invariant === 'HASH_LOCK_LIST'), 'Should block');
  });

  test('passes when lockCritical list grows', () => {
    const pi = new PreservationInvariants();
    const r = pi.check('main.js', fakeMainJs(['a.js', 'b.js']), fakeMainJs(['a.js', 'b.js', 'c.js']));
    const v = r.violations.find(v => v.invariant === 'HASH_LOCK_LIST');
    assert(!v, 'Should pass');
  });
});

// ── KERNEL_IMPORT_BLOCK ──────────────────────────────────────

describe('PreservationInvariants — KERNEL_IMPORT_BLOCK', () => {
  test('blocks when kernel circumvention rule removed', () => {
    const pi = new PreservationInvariants();
    const r = pi.check('src/agent/intelligence/CodeSafetyScanner.js',
      fakeScanner(5, { kernelBlock: true }), fakeScanner(5, { kernelBlock: false }));
    assert(r.violations.some(v => v.invariant === 'KERNEL_IMPORT_BLOCK'), 'Should block');
  });
});

// ── Fail-closed ──────────────────────────────────────────────

describe('PreservationInvariants — Fail-closed', () => {
  test('check error treated as violation', () => {
    const pi = new PreservationInvariants();
    const original = pi._invariants[0].check;
    pi._invariants[0].check = () => { throw new Error('boom'); };
    const r = pi.check('src/agent/intelligence/CodeSafetyScanner.js', 'old', 'new');
    assert(r.safe === false, 'Should be unsafe on error');
    assert(r.violations.some(v => v.detail.includes('fail-closed')), 'Should mention fail-closed');
    pi._invariants[0].check = original;
  });

  test('multiple violations reported for same file', () => {
    const bus = mockBus();
    const pi = new PreservationInvariants({ bus });
    const old = fakeScanner(10, { failClosed: true });
    const nu = fakeScanner(5, { failClosed: false });
    const r = pi.check('src/agent/intelligence/CodeSafetyScanner.js', old, nu);
    assert(r.safe === false, 'Should be unsafe');
    assert(r.violations.length >= 2, `Expected >= 2 violations, got ${r.violations.length}`);
    assertEqual(bus.events.length, 1);
    assert(bus.events[0].payload.violations.length >= 2, 'Event should list all violations');
  });
});

run();
