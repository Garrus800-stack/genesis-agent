#!/usr/bin/env node
// v7.7.9 (post-Phase-3b) — step-type undefined fallback
//
// Live-Befund 2026-05-12 burn-in (Garrus, Win): the goal "Automated Error
// Lesson Generation" produced a plan whose first 3 steps were ANALYZE
// but steps 4–9 had type=undefined. AgentLoopSteps.js:
//
//   1. Pre-switch normalisation guard (Z. 91-95) was truthy-checked:
//      `if (normalizedType && normalizedType !== step.type)`. When the LLM
//      omitted the `type` field entirely, normalizeStepType(undefined)
//      returned null, the guard was falsy, step.type stayed undefined,
//      and the switch fell through to the default branch.
//
//   2. The default branch set `error: null`, marking the step as
//      *successful* with output "Unknown step type: undefined". This
//      inflated the verification summary: in the live run, the goal
//      reported "0 verified, 7 ambiguous, 2 errors. Success rate: 78%"
//      and was marked completed despite no substantive execution.
//
// This fix:
//   - Adds an `else if (!normalizedType)` branch that falls back to
//     ANALYZE (same strategy as AgentLoopPlanner Z. 158) with an
//     annotated description so the fallback is auditable.
//   - Changes the switch default to set `error: <msg>` instead of
//     `error: null`, so even if a step bypasses the normalisation
//     entirely (it shouldn't), the failure is recorded honestly.

'use strict';

const { describe, test, assert, run } = require('../harness');
const fs = require('fs');
const path = require('path');

const STEPS_PATH = path.join(__dirname, '..', '..', 'src/agent/revolution/AgentLoopSteps.js');

describe('Step-type fallback — defensive normalisation guarantees a valid type', () => {
  test('AgentLoopSteps source has the else-if-!normalizedType branch', () => {
    const src = fs.readFileSync(STEPS_PATH, 'utf-8');
    // Must contain the new else-if branch that fires when normalizedType is null
    assert(/else\s+if\s*\(\s*!\s*normalizedType\s*\)/.test(src),
      'AgentLoopSteps must guard for missing/unknown step types after normalizeStepType returns null');
  });

  test('fallback rewrites step.type to ANALYZE', () => {
    const src = fs.readFileSync(STEPS_PATH, 'utf-8');
    // Find the fallback else-if and check it includes step.type = 'ANALYZE'
    // within a reasonable window (the else-if body has the assignment).
    const elseIfIdx = src.search(/else\s+if\s*\(\s*!\s*normalizedType\s*\)/);
    assert(elseIfIdx > -1, 'expected else-if-!normalizedType branch');
    const window = src.slice(elseIfIdx, elseIfIdx + 2000);
    assert(/step\.type\s*=\s*['"]ANALYZE['"]/.test(window),
      'fallback must set step.type to ANALYZE so the executor switch has a real branch');
  });

  test('fallback annotates description so the rewrite is auditable', () => {
    const src = fs.readFileSync(STEPS_PATH, 'utf-8');
    const elseIfIdx = src.search(/else\s+if\s*\(\s*!\s*normalizedType\s*\)/);
    assert(elseIfIdx > -1, 'expected else-if-!normalizedType branch');
    const window = src.slice(elseIfIdx, elseIfIdx + 2000);
    // Description should be prefixed with "[was ${...}]" pattern, same as
    // AgentLoopPlanner Z. 158. This makes the fallback discoverable in
    // logs and self-statements without breaking the executor.
    assert(/\[was \$\{/.test(window),
      'fallback should annotate description with "[was ${...}]" pattern for auditability');
  });

  test('fallback handles undefined step.type without throwing', () => {
    const src = fs.readFileSync(STEPS_PATH, 'utf-8');
    const elseIfIdx = src.search(/else\s+if\s*\(\s*!\s*normalizedType\s*\)/);
    assert(elseIfIdx > -1, 'expected else-if-!normalizedType branch');
    const window = src.slice(elseIfIdx, elseIfIdx + 2000);
    // The fallback must defend against step.type being undefined — string
    // operations or template-string interpolation must not throw. Look for
    // a defensive check or coercion.
    assert(/typeof\s+step\.type\s*===\s*['"]string['"]/.test(window) ||
           /step\.type\s*\|\|\s*['"]/.test(window) ||
           /step\.type\s*\?\s*step\.type\s*:/.test(window),
      'fallback must defend against step.type being non-string (undefined/null)');
  });
});

describe('Switch default branch — unknown types record as errors, not successes', () => {
  test('default branch sets error to a non-null string', () => {
    const src = fs.readFileSync(STEPS_PATH, 'utf-8');
    // Find the default: case of the step.type switch. There is exactly one
    // top-level `default:` followed by stepResult assignment inside the
    // switch.
    const defaultIdx = src.search(/\n\s*default:\s*\n/);
    assert(defaultIdx > -1, 'expected default branch in step.type switch');
    const window = src.slice(defaultIdx, defaultIdx + 1500);
    // Pre-fix shape: `error: null`. New shape: `error: '<msg>'`.
    assert(!/error:\s*null/.test(window),
      'switch default must no longer set error to null (that inflated the success rate)');
    // The new error string can be in backticks or quotes
    assert(/error:\s*[`'"]/.test(window),
      'switch default must set error to a non-null description string');
  });

  test('default branch error mentions the actual offending type', () => {
    const src = fs.readFileSync(STEPS_PATH, 'utf-8');
    const defaultIdx = src.search(/\n\s*default:\s*\n/);
    assert(defaultIdx > -1, 'expected default block locatable');
    const window = src.slice(defaultIdx, defaultIdx + 1500);
    // The error message should include step.type or a similar reference so
    // operators can trace which step failed.
    assert(/step\.type/.test(window),
      'switch default error message must reference step.type so the failure is debuggable');
  });
});

describe('Rationale and traceability', () => {
  test('fallback block carries an explanatory comment referencing Phase 3b', () => {
    const src = fs.readFileSync(STEPS_PATH, 'utf-8');
    const elseIfIdx = src.search(/else\s+if\s*\(\s*!\s*normalizedType\s*\)/);
    assert(elseIfIdx > -1, 'expected else-if branch locatable');
    const window = src.slice(elseIfIdx, elseIfIdx + 2500);
    // We want some Phase-3b / 2026-05-12 / live-Befund / Garrus reference
    // to make the fix self-documenting in source review.
    assert(/Phase[\s-]*3b|2026-05-12|live-Befund|burn-in/i.test(window) ||
           /post-Phase-3b/i.test(window),
      'fallback should carry a rationale comment referencing the burn-in or post-Phase-3b context');
  });

  test('AgentLoopSteps continues to import normalizeStepType', () => {
    const src = fs.readFileSync(STEPS_PATH, 'utf-8');
    assert(/require\(['"][^'"]*step-types['"]\)/.test(src),
      'step-types require must remain — the fix relies on normalizeStepType being available');
  });
});

run();
