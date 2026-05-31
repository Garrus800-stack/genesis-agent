// ============================================================
// GENESIS — v799-final-capability-gate.contract.test.js
//
// Pins v7.9.9 Fix 1 (capability-gate for IdleMind goals):
//   Stage A: Plan.js applies a closed verb whitelist. Titles whose
//   leading verb is not in {Document, Reflect, Summarise, Research,
//   Test, Verify, List, Compare, Investigate, Map, Index, Explore,
//   Catalog, Inspect} are refused before addGoal. Catches paraphrased
//   non-actionable verbs ("Improve X", "Make X better", "Enhance Y").
//
//   Stage B: GoalStack.addGoal refuses idle-mind goals whose
//   _decompose output contains CODE or SANDBOX step types. Sub-goals
//   (source='goal-decomposition') and user goals (source='user') are
//   exempt — they have explicit responsibility paths.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const { describe, test, assert, run } = require('../harness');

const PLAN_PATH = path.join(ROOT, 'src/agent/autonomy/activities/Plan.js');
const GOALSTACK_PATH = path.join(ROOT, 'src/agent/planning/GoalStack.js');
// v7.9.19 (Strang E): the verb whitelist + leading-verb helper were hoisted
// out of Plan.js into the shared revolution/goal-intent module so the planner
// and the activity share ONE vocabulary. The Stage-A property is unchanged —
// it now lives in goal-intent and Plan.js imports it. These checks follow it
// to its real home and additionally pin that Plan.js still wires it in.
const GOAL_INTENT_PATH = path.join(ROOT, 'src/agent/revolution/goal-intent.js');

describe('v7.9.9 Fix 1 — Plan.js Capability-Gate', () => {

  // ── Stage A — Plan.js verb whitelist ─────────────────────────

  test('SRC-01: READONLY_VERBS whitelist declared in goal-intent, imported by Plan.js', () => {
    const gi = fs.readFileSync(GOAL_INTENT_PATH, 'utf8');
    assert(/const READONLY_VERBS\s*=\s*new Set\(/.test(gi),
      'READONLY_VERBS Set must be declared in the shared goal-intent module');
    const src = fs.readFileSync(PLAN_PATH, 'utf8');
    assert(/require\(['"][^'"]*goal-intent['"]\)/.test(src) && /READONLY_VERBS/.test(src),
      'Plan.js must import READONLY_VERBS from goal-intent (one shared vocabulary)');
  });

  test('SRC-02: whitelist contains the core 14 verbs', () => {
    const src = fs.readFileSync(GOAL_INTENT_PATH, 'utf8');
    const verbs = [
      'document', 'reflect', 'summarise', 'research', 'test', 'verify',
      'list', 'compare', 'investigate', 'map', 'index', 'explore',
      'catalog', 'inspect',
    ];
    for (const v of verbs) {
      assert(new RegExp(`'${v}'`).test(src),
        `READONLY_VERBS must include '${v}'`);
    }
  });

  test('SRC-03: extractLeadingVerb helper exists in goal-intent', () => {
    const src = fs.readFileSync(GOAL_INTENT_PATH, 'utf8');
    assert(/function extractLeadingVerb\(/.test(src),
      'extractLeadingVerb helper function must be defined in goal-intent');
  });

  test('SRC-04: prompt explicitly lists allowed verbs', () => {
    const src = fs.readFileSync(PLAN_PATH, 'utf8');
    // Prompt must mention the verb constraint inline.
    assert(/TITLE must start with one of these verbs/.test(src) ||
           /must start with.*verb/i.test(src),
      'Prompt must instruct LLM that TITLE must start with a whitelisted verb');
    assert(/Document.*Reflect.*Research/.test(src),
      'Prompt must explicitly list at least Document, Reflect, Research as examples');
  });

  test('SRC-05: prompt no longer uses "improvement" framing', () => {
    const src = fs.readFileSync(PLAN_PATH, 'utf8');
    const promptStr = src.match(/const prompt = `[^`]+`/);
    assert(promptStr, 'prompt template must be a single-line backtick string');
    // The word "improvement" framing produced the "Improve X" goal class
    // the capability-gate is designed to refuse. Switch to "activity".
    assert(/concrete, verifiable activity/.test(promptStr[0]),
      'Prompt must use "activity" framing, not "improvement"');
  });

  test('SRC-06: verb-whitelist check called after SKIP check, before addGoal', () => {
    const src = fs.readFileSync(PLAN_PATH, 'utf8');
    const skipIdx = src.indexOf("LLM returned SKIP");
    const verbIdx = src.indexOf("non-actionable verb");
    const addGoalIdx = src.indexOf("addGoal(title");
    assert(skipIdx > 0 && verbIdx > 0 && addGoalIdx > 0,
      'all three landmarks (SKIP log, non-actionable verb log, addGoal call) must exist');
    assert(skipIdx < verbIdx, 'SKIP check must come BEFORE verb-whitelist check');
    assert(verbIdx < addGoalIdx, 'verb-whitelist check must come BEFORE addGoal call');
  });

  // ── Stage B — GoalStack.addGoal step-type filter ─────────────

  test('SRC-07: GoalStack.addGoal filters idle-mind goals with CODE steps', () => {
    const src = fs.readFileSync(GOALSTACK_PATH, 'utf8');
    assert(/source === 'idle-mind'/.test(src),
      'addGoal must check source === "idle-mind"');
    assert(/s\.type === 'CODE'\s*\|\|\s*s\.type === 'SANDBOX'/.test(src),
      'addGoal must filter for CODE or SANDBOX step types');
    assert(/Refused idle-mind goal/.test(src),
      'addGoal must log a refusal message');
  });

  test('SRC-08: idle-mind filter sits between _decompose and goal-creation', () => {
    const src = fs.readFileSync(GOALSTACK_PATH, 'utf8');
    const decomposeIdx = src.indexOf('await _exe._decompose(description)');
    const filterIdx = src.indexOf("source === 'idle-mind'");
    const goalCreateIdx = src.indexOf("const goal = {");
    assert(decomposeIdx > 0 && filterIdx > 0 && goalCreateIdx > 0,
      'all three landmarks (decompose, filter, goal-creation) must exist');
    assert(decomposeIdx < filterIdx, 'filter must come AFTER _decompose');
    assert(filterIdx < goalCreateIdx, 'filter must come BEFORE goal-creation');
  });

  test('SRC-09: filter exempts non-idle-mind sources implicitly', () => {
    const src = fs.readFileSync(GOALSTACK_PATH, 'utf8');
    // The if-condition checks source === 'idle-mind' so any other source
    // (user, goal-decomposition, daemon, self) bypasses the filter.
    const ifIdx = src.indexOf("if (source === 'idle-mind' && Array.isArray(steps))");
    assert(ifIdx > 0, 'filter must be inside a strict source === idle-mind condition');
  });

  // ── Runtime behavior tests via require ───────────────────────

  test('RUNTIME-01: extractLeadingVerb handles various title formats', () => {
    // v7.9.19 (Strang E): helper now lives in goal-intent and is requireable —
    // prove behaviour directly rather than by source regex.
    const { extractLeadingVerb, isReadOnlyGoal } = require(GOAL_INTENT_PATH);
    assert(extractLeadingVerb('Inspect X') === 'inspect',
      'extractLeadingVerb must lowercase the extracted verb for case-insensitive match');
    assert(extractLeadingVerb('[Investigate] Y') === 'investigate',
      'extractLeadingVerb must strip leading punctuation/brackets');
    assert(isReadOnlyGoal('Implement Z') === false,
      'a write verb is not read-only');
    assert(isReadOnlyGoal('') === null,
      'no leading verb → null (no intervention)');
  });

  test('RUNTIME-02: file sizes stay within reasonable bounds', () => {
    const planSrc = fs.readFileSync(PLAN_PATH, 'utf8');
    const goalSrc = fs.readFileSync(GOALSTACK_PATH, 'utf8');
    assert(planSrc.split('\n').length < 250,
      `Plan.js has ${planSrc.split('\n').length} LOC — should stay compact`);
    assert(goalSrc.split('\n').length < 700,
      `GoalStack.js has ${goalSrc.split('\n').length} LOC — must stay under 700 (architectural guideline)`);
  });

});

run().catch(err => { console.error(err); process.exit(1); });
