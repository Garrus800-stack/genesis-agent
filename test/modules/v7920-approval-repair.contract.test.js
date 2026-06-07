// ============================================================
// v7.9.20 (D): approval repair — contract tests.
//
// Before v7.9.20 the step-level gates (shell/write/delegate) called
// loop._requestApproval, which is permanently `async () => true`, so
// they never reached the trust matrix and never prompted. This pins
// the repair, exactly per the three-level definition in TrustLevelSystem:
//   SUPERVISED (0)    — every gated action asks
//   AUTONOMOUS (1)    — only `critical` (DEPLOY/EXTERNAL_API/EMAIL_SEND) asks
//   FULL_AUTONOMY (2) — never asks
// Plus: approvalSec=0 means "no timeout — the Dashboard prompt stays
// until approve()/reject()". user-input keeps its own (separate) path.
// ============================================================

'use strict';

const path = require('path');
const fs = require('fs');
const { describe, test, run, assert, assertEqual } = require('../harness');

const ROOT = path.join(__dirname, '../..');
const STEPS_PATH = path.join(ROOT, 'src/agent/revolution/AgentLoopSteps.js');

const { ApprovalGate } = require(path.join(ROOT, 'src/agent/revolution/ApprovalGate'));
const { TrustLevelSystem, TRUST_LEVELS } = require(path.join(ROOT, 'src/agent/foundation/TrustLevelSystem'));

const noBus = { fire() {}, on() {} };
function tls(level) {
  const t = new TrustLevelSystem({ bus: noBus, storage: null, settings: null, config: {} });
  t.setLevel(level);
  return t;
}

describe('v7920-approval-repair', () => {

  // ── Routing: shell/write/delegate go through the real channel ──

  test('ROUTE-01: shell/write/delegate call loop.approval.request (not the dead _requestApproval)', () => {
    const src = fs.readFileSync(STEPS_PATH, 'utf8');
    assert(/loop\.approval\.request\(\s*'shell-command'/.test(src), 'shell must use approval.request');
    assert(/loop\.approval\.request\(\s*\n?\s*'write-file'/.test(src), 'write must use approval.request');
    assert(/loop\.approval\.request\(\s*\n?\s*'delegate-task'/.test(src), 'delegate must use approval.request');
    assert(!/_requestApproval\(\s*'shell-command'/.test(src), 'shell must NOT use _requestApproval');
    assert(!/_requestApproval\(\s*\n?\s*'write-file'/.test(src), 'write must NOT use _requestApproval');
  });

  test('ROUTE-02: user-input stays on _requestApproval (separate needs-input path)', () => {
    const src = fs.readFileSync(STEPS_PATH, 'utf8');
    assert(/_requestApproval\(\s*'user-input'/.test(src),
      'user-input must keep _requestApproval (needs a real answer, would double-fire via approval.request)');
  });

  // ── The three-level matrix decides, exactly per definition ──

  const expect = {
    SUPERVISED:    { lvl: TRUST_LEVELS.SUPERVISED,    rows: { 'shell-command': false, 'write-file': false, 'delegate-task': false, 'DEPLOY': false, 'EMAIL_SEND': false } },
    AUTONOMOUS:    { lvl: TRUST_LEVELS.AUTONOMOUS,    rows: { 'shell-command': true,  'write-file': true,  'delegate-task': true,  'DEPLOY': false, 'EMAIL_SEND': false } },
    FULL_AUTONOMY: { lvl: TRUST_LEVELS.FULL_AUTONOMY, rows: { 'shell-command': true,  'write-file': true,  'delegate-task': true,  'DEPLOY': true,  'EMAIL_SEND': true  } },
  };
  for (const [name, { lvl, rows }] of Object.entries(expect)) {
    test(`MATRIX-${name}: auto-approve exactly per the 3-level definition`, () => {
      const t = tls(lvl);
      for (const [action, autoExpected] of Object.entries(rows)) {
        assertEqual(t.checkApproval(action).approved, autoExpected,
          `${name}: ${action} expected auto-approved=${autoExpected}`);
      }
    });
  }

  test('RISK-01: shell-command/write-file/delegate-task are classified (not defaulted to high)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/TrustLevelSystem.js'), 'utf8');
    assert(/'shell-command':\s*'high'/.test(src), 'shell-command must be classified high');
    assert(/'write-file':\s*'medium'/.test(src), 'write-file must be classified medium');
    assert(/'delegate-task':\s*'medium'/.test(src), 'delegate-task must be classified medium');
  });

  // ── Timeout: approvalSec=0 → no auto-reject (stay until click) ──

  test('TIMEOUT-01: timeoutMs=0 does NOT self-resolve; approve() resolves true', async () => {
    const gate = new ApprovalGate({ bus: noBus, trustLevelSystem: null, timeoutMs: 0 });
    let settled = false;
    const p = gate.request('shell-command', 'rm something').then(v => { settled = true; return v; });
    await new Promise(r => setTimeout(r, 60));
    assert(settled === false, 'timeoutMs=0 must not auto-reject — prompt stays until click');
    assert(gate._pending, 'pending entry must persist');
    gate.approve();
    assertEqual(await p, true, 'approve() must resolve true');
  });

  test('TIMEOUT-02: timeoutMs=0 + reject() resolves false', async () => {
    const gate = new ApprovalGate({ bus: noBus, trustLevelSystem: null, timeoutMs: 0 });
    const p = gate.request('write-file', 'write x');
    gate.reject();
    assertEqual(await p, false, 'reject() must resolve false');
  });

  test('TIMEOUT-03: a positive timeout still auto-rejects (opt-in)', async () => {
    const gate = new ApprovalGate({ bus: noBus, trustLevelSystem: null, timeoutMs: 30 });
    const r = await gate.request('shell-command', 'x');
    assertEqual(r, false, 'positive timeout must still auto-reject when not answered');
  });

  // ── FULL_AUTONOMY auto-approves through request() (never waits) ──

  test('FULL-01: FULL_AUTONOMY auto-approves shell and critical through request()', async () => {
    const gate = new ApprovalGate({ bus: noBus, trustLevelSystem: tls(TRUST_LEVELS.FULL_AUTONOMY), timeoutMs: 0 });
    assertEqual(await gate.request('shell-command', 'x'), true, 'FULL must auto-approve shell');
    assertEqual(await gate.request('DEPLOY', 'x'), true, 'FULL must auto-approve critical');
  });

  // ── Setting wiring: approvalSec=0 survives (no || collapse) ──

  test('WIRE-01: AgentLoop + ApprovalGate use nullish (0 survives, not collapsed to default)', () => {
    const al = fs.readFileSync(path.join(ROOT, 'src/agent/revolution/AgentLoop.js'), 'utf8');
    assert(/approvalTimeoutMs\s*\?\?\s*TIMEOUTS\.APPROVAL_DEFAULT/.test(al),
      'AgentLoop must use ?? so approvalTimeoutMs=0 survives');
    const phase8 = fs.readFileSync(path.join(ROOT, 'src/agent/manifest/phase8-revolution.js'), 'utf8');
    assert(/approvalSec'\)\s*\?\?\s*0/.test(phase8),
      'phase8 wiring must use ?? (0 = no timeout), not || 60');
  });

});

run().catch(err => { console.error(err); process.exit(1); });
