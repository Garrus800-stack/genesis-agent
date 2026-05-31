#!/usr/bin/env node
// ============================================================
// GENESIS — test/modules/v7919-capability-aware-planning.test.js
//
// v7.9.19 Strang C — the planner must not commit a step whose
// resource the executor would block on. Field bug (2026-05-31):
// FormalPlanner offered DELEGATE for an idle-mind goal on a node
// with no reachable peers; the goal pursued ~6.5 min and then
// failed at AgentLoopSteps "missing resources: peer".
//
// Three coordinated layers, all reusing existing mechanisms:
//   1. AgentLoopPlanner._computeCanDelegate() — plannable only when
//      taskDelegation is wired AND ResourceRegistry.isAvailable('peer')
//      is true (the same gate the executor checks). One source for
//      both the primary (FormalPlanner) and the LLM-fallback planner.
//   2. FormalPlanner steering note — appended to the decompose prompt
//      when canDelegate === false (best-effort). The static
//      "CANONICAL STEP TYPES" block is left intact (G3a contract).
//   3. FormalPlanner._typifyStep guard — converts a DELEGATE step to
//      ANALYZE when canDelegate === false (the deterministic
//      guarantee). Mirrors the executor's own DELEGATE→ANALYZE
//      fallback, but at plan time. Undefined capabilities leave
//      behaviour unchanged (backward-compatible).
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const { FormalPlanner } = require(path.join(ROOT, 'src/agent/revolution/FormalPlanner'));
const { AgentLoopPlannerDelegate } = require(path.join(ROOT, 'src/agent/revolution/AgentLoopPlanner'));

// ── Mocks (modelled on formalplanner.test.js) ─────────────
const mockBus = { emit: () => [], fire(...a) { return this.emit ? this.emit(...a) : undefined; } };
const mockGuard = {
  isProtected: (p) => p.includes('kernel'),
  validateWrite: (p) => { if (p.includes('kernel')) throw new Error('blocked'); return true; },
};
const mockSelfModel = { getCapabilities: () => ['code-gen', 'shell', 'file-io'], getModuleSummary: () => [] };

function createMockWorldState() {
  const modified = new Set();
  return {
    canWriteFile: (p) => p && !p.includes('kernel'),
    canRunShell: (cmd) => cmd && !cmd.includes('rm -rf /'),
    canRunTests: () => true,
    canUseModel: () => true,
    isKernelFile: (p) => p && p.includes('kernel'),
    markFileModified: (p) => modified.add(p),
    getRecentlyModified: () => [],
    getSimulatedChanges: () => [...modified],
    clone: () => createMockWorldState(),
  };
}

// Model mock that records the prompt it was handed and returns a
// fixed plan that DOES contain a DELEGATE step (so we can prove the
// guard rewrites it).
function createCapturingModel(planResponse) {
  const captured = { prompt: null };
  const model = {
    activeModel: 'gemma2',
    chatStructured: async (prompt) => { captured.prompt = prompt; return planResponse; },
    chat: async (prompt) => { captured.prompt = prompt; return JSON.stringify(planResponse); },
  };
  return { model, captured };
}

const PLAN_WITH_DELEGATE = {
  title: 'Inspect cognitive health trends',
  steps: [
    { type: 'ANALYZE', description: 'read the health snapshots' },
    { type: 'DELEGATE', description: 'hand the analysis to a peer' },
  ],
  successCriteria: 'a trend summary exists',
};

function makePlanner(model) {
  return new FormalPlanner({
    bus: mockBus, worldState: createMockWorldState(), guard: mockGuard,
    model, selfModel: mockSelfModel, rootDir: '/tmp',
  });
}

// Build a minimal AgentLoopPlanner delegate over a fake loop, to test
// the canDelegate signal in isolation.
function plannerOverLoop(loop) { return new AgentLoopPlannerDelegate(loop); }
function peerRegistry(available) { return { isAvailable: (tok) => tok === 'peer' ? available : true }; }

// ── 1. The capability signal ──────────────────────────────
describe('v7.9.19 Strang C — _computeCanDelegate (plan-gate == execute-gate)', () => {
  test('true only when taskDelegation wired AND a peer is reachable', () => {
    const p = plannerOverLoop({ taskDelegation: {}, resourceRegistry: peerRegistry(true) });
    assertEqual(p._computeCanDelegate(), true, 'service + reachable peer → true');
  });

  test('false when taskDelegation wired but no reachable peer (the field case)', () => {
    const p = plannerOverLoop({ taskDelegation: {}, resourceRegistry: peerRegistry(false) });
    assertEqual(p._computeCanDelegate(), false, 'service present, peer unreachable → false');
  });

  test('false when taskDelegation absent, even if a peer were reachable', () => {
    const p = plannerOverLoop({ taskDelegation: null, resourceRegistry: peerRegistry(true) });
    assertEqual(p._computeCanDelegate(), false, 'no delegation machinery → false');
  });

  test('false when no ResourceRegistry is wired (cannot confirm a peer)', () => {
    const p = plannerOverLoop({ taskDelegation: {} });
    assertEqual(p._computeCanDelegate(), false, 'no registry → false (conservative)');
  });

  test('reads the legacy _resourceRegistry slot too', () => {
    const p = plannerOverLoop({ taskDelegation: {}, _resourceRegistry: peerRegistry(true) });
    assertEqual(p._computeCanDelegate(), true, 'fallback registry slot honoured');
  });
});

// ── 2. The deterministic guard in _typifyStep ─────────────
describe('v7.9.19 Strang C — _typifyStep DELEGATE→ANALYZE guard', () => {
  test('canDelegate === false rewrites DELEGATE to ANALYZE, keeping the description', () => {
    const fp = makePlanner(null);
    fp._planCapabilities = { canDelegate: false };
    const s = fp._typifyStep({ type: 'DELEGATE', description: 'hand off X' }, 0);
    assertEqual(s.type, 'ANALYZE', 'type rewritten');
    assertEqual(s.description, 'hand off X', 'description preserved');
  });

  test('canDelegate === true leaves DELEGATE untouched', () => {
    const fp = makePlanner(null);
    fp._planCapabilities = { canDelegate: true };
    const s = fp._typifyStep({ type: 'DELEGATE', description: 'hand off X' }, 0);
    assertEqual(s.type, 'DELEGATE', 'DELEGATE kept when a peer is reachable');
  });

  test('absent capabilities leave DELEGATE untouched (backward-compatible)', () => {
    const fp = makePlanner(null);
    fp._planCapabilities = null;
    const s = fp._typifyStep({ type: 'DELEGATE', description: 'hand off X' }, 0);
    assertEqual(s.type, 'DELEGATE', 'no capabilities → no conversion');
  });

  test('non-DELEGATE steps are never touched by the guard', () => {
    const fp = makePlanner(null);
    fp._planCapabilities = { canDelegate: false };
    const s = fp._typifyStep({ type: 'ANALYZE', description: 'just read' }, 0);
    assertEqual(s.type, 'ANALYZE', 'ANALYZE stays ANALYZE');
  });
});

// ── 3. End-to-end through plan(): prompt steering + guard ──
describe('v7.9.19 Strang C — plan() is capability-aware end-to-end', () => {
  test('canDelegate=false: prompt steers away from DELEGATE AND the emitted DELEGATE step is rewritten', async () => {
    const { model, captured } = createCapturingModel(PLAN_WITH_DELEGATE);
    const fp = makePlanner(model);
    const result = await fp.plan('Inspect cognitive health trends', { capabilities: { canDelegate: false } });

    assert(/Peer delegation is UNAVAILABLE/.test(captured.prompt), 'prompt carries the capability-limit note');
    assert(/do NOT use DELEGATE/i.test(captured.prompt), 'prompt explicitly discourages DELEGATE');

    const steps = result.steps || [];
    assert(steps.length > 0, 'plan returned steps');
    assert(!steps.some(s => s.type === 'DELEGATE'), 'no DELEGATE step survives when no peer is reachable');
  });

  test('canDelegate=true: no steering note, DELEGATE step is preserved', async () => {
    const { model, captured } = createCapturingModel(PLAN_WITH_DELEGATE);
    const fp = makePlanner(model);
    const result = await fp.plan('Inspect cognitive health trends', { capabilities: { canDelegate: true } });

    assert(!/Peer delegation is UNAVAILABLE/.test(captured.prompt), 'no capability-limit note when a peer is reachable');
    const steps = result.steps || [];
    assert(steps.some(s => s.type === 'DELEGATE'), 'DELEGATE preserved when delegation is available');
  });
});

// ── 4. Regression: the G3a static contract stays intact ───
describe('v7.9.19 Strang C — does not break the v778 G3a source contract', () => {
  test('FormalPlanner still declares the static CANONICAL STEP TYPES block incl. DELEGATE:', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/revolution/FormalPlanner.js'), 'utf8');
    assert(/CANONICAL STEP TYPES \(use ONLY these/.test(src), 'canonical-types header present');
    for (const t of ['ANALYZE:', 'CODE:', 'SHELL:', 'SANDBOX:', 'SEARCH:', 'ASK:', 'DELEGATE:']) {
      assert(src.includes(t), `vocabulary still declares ${t}`);
    }
    assert(/DO NOT INVENT step types/.test(src), 'anti-pattern instruction present');
  });
});

if (require.main === module) run();
