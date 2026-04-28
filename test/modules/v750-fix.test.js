// ============================================================
// Test: v7.5.0 — Goals Slash-Discipline + Negotiate-before-Add
//
// v7.5.0 fixes the live-bug from v7.4.9 where conversational
// messages containing "goal" + "cancel" silently triggered
// cancel-all, and where free-text messages routed via LLM
// classification to 'agent-goal' silently became persistent
// stack goals via AgentLoop.js:358.
//
// Three coordinated changes:
//   1. SLASH-DISCIPLINE: 'goals' joins the SLASH_COMMANDS list.
//      Free-text mentions of "goal/ziel" no longer route to the
//      goals handler; they fall through to 'general'.
//   2. AGENT-LOOP TRANSIENT: legacy string-input pursue() no
//      longer silently calls goalStack.addGoal. Pursuit still
//      runs (so explicit /agent <task> works), but creates a
//      transient ephemeral goal object — no stack persistence.
//   3. NEGOTIATE-BEFORE-ADD: when agency.negotiateBeforeAdd is
//      true (opt-in), /goal add proposes a pending goal first,
//      Genesis clarifies, user confirms via /goal confirm <id>.
//
// Plus: ColonyOrchestrator.llm.generate → llm.chat (the original
// call to a non-existent method failed silently and Colony fell
// back to single-task mode every time).
// ============================================================

'use strict';

const path = require('path');
const fs = require('fs');

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(() => { passed++; console.log(`    ✅ ${name}`); })
              .catch(err => { failed++; failures.push({ name, error: err.message }); console.log(`    ❌ ${name}: ${err.message}`); });
    }
    passed++; console.log(`    ✅ ${name}`);
  } catch (err) { failed++; failures.push({ name, error: err.message }); console.log(`    ❌ ${name}: ${err.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }

const ROOT = path.join(__dirname, '..', '..');

(async () => {
  console.log('  v750-fix tests:');

  // ──────────────────────────────────────────────────────────────
  // A) Slash-Discipline source-presence
  // ──────────────────────────────────────────────────────────────

  await test('A1: goals is in SLASH_COMMANDS list', () => {
    const slash = require(path.join(ROOT, 'src/agent/intelligence/slash-commands.js'));
    const names = slash.allCommandNames();
    assert(names.includes('goals'), `'goals' must be in allCommandNames(); got: ${JSON.stringify(names)}`);
  });

  await test('A2: goals slash-aliases include goal/ziel/ziele', () => {
    const slash = require(path.join(ROOT, 'src/agent/intelligence/slash-commands.js'));
    const goalsEntry = slash.SLASH_COMMANDS.find(s => s.name === 'goals');
    assert(goalsEntry, 'goals entry missing');
    assert(goalsEntry.aliases.includes('goal'), `aliases should include 'goal', got: ${JSON.stringify(goalsEntry.aliases)}`);
    assert(goalsEntry.aliases.includes('ziel'), `aliases should include 'ziel'`);
    assert(goalsEntry.aliases.includes('ziele'), `aliases should include 'ziele'`);
  });

  await test('A3: IntentPatterns goals route is slash-only (no fuzzy keywords)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/intelligence/IntentPatterns.js'), 'utf-8');
    // Find the goals route block: ['goals', [...], 16, [keywords]]
    const m = src.match(/\['goals',\s*\[([\s\S]*?)\]\s*,\s*16\s*,\s*\[([\s\S]*?)\]\]/);
    assert(m, 'goals route not found in IntentPatterns');
    // Keywords must be empty (else fuzzy match still leaks)
    assert(m[2].trim() === '', `goals keywords must be empty, got: '${m[2].trim()}'`);
  });

  await test('A4: free-text "lösche alle ziele" no longer routes to goals', () => {
    const { IntentRouter } = require(path.join(ROOT, 'src/agent/intelligence/IntentRouter.js'));
    const router = new IntentRouter();
    const r = router.classify('lösche alle ziele');
    assert(r.type !== 'goals', `expected non-goals, got: ${r.type}`);
  });

  await test('A5: slash form "/goal clear" routes to goals', () => {
    const { IntentRouter } = require(path.join(ROOT, 'src/agent/intelligence/IntentRouter.js'));
    const router = new IntentRouter();
    const r = router.classify('/goal clear');
    assert(r.type === 'goals', `expected goals, got: ${r.type}`);
  });

  // ──────────────────────────────────────────────────────────────
  // B) Slash-routing functional (DE+EN aliases)
  // ──────────────────────────────────────────────────────────────

  await test('B1: /goals routes to goals', () => {
    const { IntentRouter } = require(path.join(ROOT, 'src/agent/intelligence/IntentRouter.js'));
    const router = new IntentRouter();
    assert(router.classify('/goals').type === 'goals');
  });

  await test('B2: /ziel add ... routes to goals (German alias)', () => {
    const { IntentRouter } = require(path.join(ROOT, 'src/agent/intelligence/IntentRouter.js'));
    const router = new IntentRouter();
    assert(router.classify('/ziel add Bessere Fehlerbehandlung').type === 'goals');
  });

  await test('B3: live-bug message routes to general (not agent-goal/goals)', () => {
    // Exact text from v7.4.9 live-bug log.
    const { IntentRouter } = require(path.join(ROOT, 'src/agent/intelligence/IntentRouter.js'));
    const router = new IntentRouter();
    const r = router.classify('Bitte beantworte die Frage von vorhin: Welcher der drei Punkte (Dashboard-Sektion, Prioritäts-UI, Aushandeln vor Anlegen) ist dir wichtig?');
    assert(r.type === 'general', `expected general, got: ${r.type} (conf=${r.confidence})`);
  });

  await test('B4: explanation containing /goal /goal still routes (slash present)', () => {
    // This is the v7.4.9 case where Garrus wrote "Du hast /goal add/list/cancel/clear"
    // explaining slash-commands. With slash-discipline the routing IS to goals
    // (slash present), but the new subcommand parser handles the malformed
    // form gracefully without destructive action.
    const { IntentRouter } = require(path.join(ROOT, 'src/agent/intelligence/IntentRouter.js'));
    const router = new IntentRouter();
    const r = router.classify('Du hast /goal add/list/cancel/clear Slash-Commands');
    assert(r.type === 'goals', `slash present, expected goals, got: ${r.type}`);
  });

  // ──────────────────────────────────────────────────────────────
  // C) ColonyOrchestrator llm.chat fix
  // ──────────────────────────────────────────────────────────────

  await test('C1: ColonyOrchestrator no longer calls llm.generate', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/revolution/ColonyOrchestrator.js'), 'utf-8');
    // The actual call must be llm.chat not llm.generate.
    // (The historical comment block mentions .generate as documentation.)
    const lines = src.split('\n');
    let foundGenerate = 0, foundChat = 0;
    for (const l of lines) {
      if (l.includes('//')) continue;  // skip comments
      if (/this\.llm\.generate\s*\(/.test(l)) foundGenerate++;
      if (/this\.llm\.chat\s*\(/.test(l)) foundChat++;
    }
    assert(foundGenerate === 0, `must not call this.llm.generate(); found ${foundGenerate}× in non-comment lines`);
    assert(foundChat >= 1, `must call this.llm.chat() at least once; found ${foundChat}×`);
  });

  await test('C2: ColonyOrchestrator decomposeWithLLM uses positional chat API', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/revolution/ColonyOrchestrator.js'), 'utf-8');
    // Match: this.llm.chat( <something not opening with "{"> ...
    // (positional first arg = systemPrompt string, NOT object form)
    const callMatch = src.match(/await\s+this\.llm\.chat\s*\(\s*([^,)]+)/);
    assert(callMatch, 'llm.chat call not found');
    const firstArg = callMatch[1].trim();
    assert(!firstArg.startsWith('{'),
      `first arg to llm.chat must be string systemPrompt (positional API), got object form: ${firstArg.slice(0, 40)}`);
  });

  // ──────────────────────────────────────────────────────────────
  // D) AgentLoop transient legacy-string path
  // ──────────────────────────────────────────────────────────────

  await test('D1: AgentLoop legacy-string path no longer calls goalStack.addGoal', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/revolution/AgentLoop.js'), 'utf-8');
    // The OLD pattern was:
    //   _registeredGoal = await this.goalStack.addGoal(
    //     goalDescription.slice(0, 200), 'user', 'high',
    //   );
    // We assert this exact awaited addGoal call site is gone (it was
    // the silent persistence bug). Other addGoal call sites elsewhere
    // are fine (TaskDelegation, SelfOptimizer, etc.).
    const sliceAddGoal = src.match(/await\s+this\.goalStack\.addGoal\s*\(\s*goalDescription\.slice/);
    assert(!sliceAddGoal,
      'AgentLoop legacy-string path still calls goalStack.addGoal directly with goalDescription.slice — should be transient');
  });

  await test('D2: AgentLoop legacy-string path creates transient goal object', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/revolution/AgentLoop.js'), 'utf-8');
    // Verify the new transient block exists with _transient marker.
    assert(/_transient:\s*true/.test(src),
      'AgentLoop must mark legacy-string goals with _transient: true');
  });

  // ──────────────────────────────────────────────────────────────
  // E) Pending Goals API (negotiate-before-add)
  // ──────────────────────────────────────────────────────────────

  function makeStack() {
    const { GoalStack } = require(path.join(ROOT, 'src/agent/planning/GoalStack.js'));
    const events = [];
    const bus = {
      emit: (name, data) => events.push({ name, data }),
      fire: (name, data) => events.push({ name, data }),
    };
    // GoalStack._decompose calls model.chat — return JSON-shaped steps.
    const model = {
      chat: async () => JSON.stringify([
        { type: 'think', action: 'Analyse the goal', expected: 'Understanding' },
      ]),
    };
    const prompts = {
      decompose: () => 'mock prompt',
    };
    const stack = new GoalStack({ bus, model, prompts });
    return { stack, events };
  }

  await test('E1: proposePending creates pending entry and returns id', () => {
    const { stack, events } = makeStack();
    const id = stack.proposePending('Refactor X', 'user', 'high');
    assert(typeof id === 'string' && id.startsWith('pending_'), `expected pending_ id, got: ${id}`);
    const pending = stack.getPending();
    assert(pending.length === 1 && pending[0].description === 'Refactor X',
      `pending list mismatch: ${JSON.stringify(pending)}`);
    assert(events.some(e => e.name === 'goal:proposed'),
      `expected goal:proposed event, got: ${events.map(e => e.name).join(',')}`);
  });

  await test('E2: confirmPending moves to active stack and returns Goal', async () => {
    const { stack, events } = makeStack();
    const id = stack.proposePending('Refactor X', 'user', 'high');
    const goal = await stack.confirmPending(id);
    assert(goal != null, 'confirmPending must return a Goal');
    assert(goal.description === 'Refactor X', `goal.description mismatch: ${goal.description}`);
    assert(stack.getPending().length === 0, 'pending should be empty after confirm');
    assert(events.some(e => e.name === 'goal:negotiation-confirmed'),
      `expected goal:negotiation-confirmed event`);
  });

  await test('E3: revisePending updates description but keeps pending', () => {
    const { stack, events } = makeStack();
    const id = stack.proposePending('Old text', 'user', 'high');
    const ok = stack.revisePending(id, 'Better text');
    assert(ok === true, 'revisePending should return true on success');
    const pending = stack.getPending();
    assert(pending.length === 1 && pending[0].description === 'Better text',
      `expected revised description, got: ${pending[0]?.description}`);
    assert(events.some(e => e.name === 'goal:negotiation-revised'),
      'expected goal:negotiation-revised event');
  });

  await test('E4: dismissPending removes entry and returns description', () => {
    const { stack, events } = makeStack();
    const id = stack.proposePending('Drop me', 'user', 'high');
    const dropped = stack.dismissPending(id);
    assert(dropped === 'Drop me', `expected returned description, got: ${dropped}`);
    assert(stack.getPending().length === 0, 'pending should be empty after dismiss');
    assert(events.some(e => e.name === 'goal:negotiation-dismissed'),
      'expected goal:negotiation-dismissed event');
  });

  await test('E5: pending entries expire after TTL via _sweepExpiredPending', () => {
    const { stack, events } = makeStack();
    const id = stack.proposePending('Old proposal', 'user', 'high');
    // Fast-forward by mutating createdAt directly (transient internal map)
    const entry = stack.pendingGoals.get(id);
    entry.createdAt = Date.now() - (stack._pendingTTL + 1000);
    stack._sweepExpiredPending();
    assert(stack.pendingGoals.size === 0, 'expired entry should be swept');
    assert(events.some(e => e.name === 'goal:negotiation-expired'),
      'expected goal:negotiation-expired event');
  });

  await test('E6: confirmPending returns null on unknown/expired id', async () => {
    const { stack } = makeStack();
    const r = await stack.confirmPending('pending_nonexistent');
    assert(r === null, `expected null for unknown id, got: ${r}`);
  });

  await test('E7: revisePending returns false on unknown id', () => {
    const { stack } = makeStack();
    const r = stack.revisePending('pending_nonexistent', 'New');
    assert(r === false, `expected false for unknown id, got: ${r}`);
  });

  await test('E8: dismissPending returns null on unknown id', () => {
    const { stack } = makeStack();
    const r = stack.dismissPending('pending_nonexistent');
    assert(r === null, `expected null for unknown id, got: ${r}`);
  });

  // ──────────────────────────────────────────────────────────────
  // F) Settings — agency.negotiateBeforeAdd defaults to false
  // ──────────────────────────────────────────────────────────────

  await test('F1: agency.negotiateBeforeAdd defaults to false (opt-in)', () => {
    const settingsSrc = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/Settings.js'), 'utf-8');
    assert(/negotiateBeforeAdd:\s*false/.test(settingsSrc),
      'Settings default for agency.negotiateBeforeAdd must be false (opt-in)');
  });

  // ──────────────────────────────────────────────────────────────
  // G) i18n keys present EN+DE
  // ──────────────────────────────────────────────────────────────

  await test('G1: new goal i18n keys exist in EN+DE', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/core/Language.js'), 'utf-8');
    const requiredKeys = [
      'goals.proposed', 'goals.confirmed', 'goals.revised', 'goals.dismissed',
      'goals.cancel_all_confirm', 'goals.cancel_all_done', 'goals.none_active',
      'goals.help', 'goals.unknown_subcommand', 'goals.add_empty',
      'goals.cancel_one_done', 'goals.cancel_one_not_found',
      'goals.pending_id_missing', 'goals.pending_not_found', 'goals.pending_title',
      'goals.confirm_failed', 'goals.revise_format', 'goals.negotiation_unavailable',
      'goals.cancel_needs_number', 'goals.add_failed',
    ];
    // Each key must appear at least twice (EN block + DE block).
    for (const key of requiredKeys) {
      const count = (src.match(new RegExp(`'${key.replace(/\./g, '\\.')}'`, 'g')) || []).length;
      assert(count >= 2, `i18n key '${key}' must exist in both EN and DE; found ${count} occurrences`);
    }
  });

  // ──────────────────────────────────────────────────────────────
  // H) EventTypes + Schemas for negotiation events
  // ──────────────────────────────────────────────────────────────

  await test('H1: GOAL.NEGOTIATION_* events registered in EventTypes', () => {
    const { EVENTS } = require(path.join(ROOT, 'src/agent/core/EventTypes.js'));
    const required = ['PROPOSED', 'NEGOTIATION_START', 'NEGOTIATION_CONFIRMED',
                      'NEGOTIATION_REVISED', 'NEGOTIATION_DISMISSED', 'NEGOTIATION_EXPIRED'];
    for (const k of required) {
      assert(EVENTS.GOAL[k], `EVENTS.GOAL.${k} must be registered`);
    }
  });

  await test('H2: schemas registered for new negotiation events', () => {
    const schemas = require(path.join(ROOT, 'src/agent/core/EventPayloadSchemas.js'));
    const dict = schemas.SCHEMAS || schemas;
    const required = ['goal:proposed', 'goal:negotiation-start', 'goal:negotiation-confirmed',
                      'goal:negotiation-revised', 'goal:negotiation-dismissed', 'goal:negotiation-expired'];
    for (const k of required) {
      assert(dict[k], `schema for '${k}' must be registered`);
    }
  });

  // ──────────────────────────────────────────────────────────────
  // I) CommandHandlersGoals subcommand parser end-to-end
  // ──────────────────────────────────────────────────────────────

  function makeCH({ negotiate = false, activeGoals = [] } = {}) {
    const { commandHandlersGoals } = require(path.join(ROOT, 'src/agent/hexagonal/CommandHandlersGoals.js'));
    let abandoned = [];
    let added = [];
    const events = [];
    const lang = {
      current: 'en',
      t: (key, vars = {}) => {
        // Echo key for assertion testing
        let s = key;
        for (const [k, v] of Object.entries(vars)) s += `|${k}=${v}`;
        return s;
      },
    };
    const goalStack = {
      getActiveGoals: () => activeGoals,
      getAll: () => activeGoals,
      abandonGoal: (id) => abandoned.push(id),
      addGoal: async (desc, source, priority) => {
        const g = { id: `g_${added.length}`, description: desc, source, priority, status: 'active', steps: [], currentStep: 0 };
        added.push(g);
        return g;
      },
      proposePending: (desc) => {
        const id = `pending_test_${Date.now()}`;
        events.push({ name: 'proposePending', desc, id });
        return id;
      },
      getPending: () => [],
    };
    const settings = {
      get: (key) => key === 'agency.negotiateBeforeAdd' ? negotiate : undefined,
    };
    const bus = {
      emit: (name, data) => events.push({ kind: 'emit', name, data }),
      fire: (name, data) => events.push({ kind: 'fire', name, data }),
    };
    const ch = Object.create(commandHandlersGoals);
    ch.goalStack = goalStack;
    ch.lang = lang;
    ch.bus = bus;
    ch.settings = settings;
    return { ch, abandoned, added, events };
  }

  await test('I1: /goal add <text> directly creates goal when negotiate=false', async () => {
    const { ch, added } = makeCH({ negotiate: false });
    const r = await ch.goals('/goal add Refactor module X');
    assert(added.length === 1, `expected 1 goal added, got ${added.length}`);
    assert(added[0].description === 'Refactor module X', `description mismatch: ${added[0].description}`);
    assert(r.includes('goals.created'), `expected goals.created lang key, got: ${r.slice(0, 80)}`);
  });

  await test('I2: /goal add proposes pending when negotiate=true', async () => {
    const { ch, added, events } = makeCH({ negotiate: true });
    const r = await ch.goals('/goal add Refactor X');
    assert(added.length === 0, `must NOT directly add when negotiate=true, got ${added.length}`);
    assert(events.some(e => e.name === 'proposePending'),
      `expected proposePending call, got: ${events.map(e => e.name || e.kind).join(',')}`);
    assert(events.some(e => e.kind === 'fire' && e.name === 'goal:negotiation-start'),
      `expected goal:negotiation-start fire`);
    assert(r.includes('goals.proposed'), `expected goals.proposed lang key, got: ${r.slice(0, 80)}`);
  });

  await test('I3: /goal add with empty arg returns goals.add_empty', async () => {
    const { ch, added } = makeCH();
    const r = await ch.goals('/goal add');
    assert(added.length === 0, 'must not add empty goal');
    assert(r.includes('goals.add_empty'), `expected goals.add_empty, got: ${r.slice(0, 80)}`);
  });

  await test('I4: /goal cancel <n> abandons indexed goal', async () => {
    const { ch, abandoned } = makeCH({ activeGoals: [{ id: 'g1', description: 'A' }, { id: 'g2', description: 'B' }] });
    const r = await ch.goals('/goal cancel 2');
    assert(abandoned.includes('g2'), `expected g2 abandoned, got: ${abandoned.join(',')}`);
    assert(r.includes('goals.cancel_one_done'), `expected goals.cancel_one_done, got: ${r.slice(0, 80)}`);
  });

  await test('I5: /goal cancel <n> out-of-range returns not-found', async () => {
    const { ch, abandoned } = makeCH({ activeGoals: [{ id: 'g1', description: 'A' }] });
    const r = await ch.goals('/goal cancel 9');
    assert(abandoned.length === 0, 'must not abandon when out of range');
    assert(r.includes('goals.cancel_one_not_found'), `expected goals.cancel_one_not_found, got: ${r.slice(0, 80)}`);
  });

  await test('I6: /goal cancel without number asks for number', async () => {
    const { ch, abandoned } = makeCH({ activeGoals: [{ id: 'g1', description: 'A' }] });
    const r = await ch.goals('/goal cancel');
    assert(abandoned.length === 0, 'must not abandon when no number given');
    assert(r.includes('goals.cancel_needs_number'), `expected goals.cancel_needs_number, got: ${r.slice(0, 80)}`);
  });

  await test('I7: /goal clear with active goals asks confirmation first', async () => {
    const { ch, abandoned } = makeCH({ activeGoals: [{ id: 'g1', description: 'A' }, { id: 'g2', description: 'B' }] });
    const r = await ch.goals('/goal clear');
    assert(abandoned.length === 0, 'must NOT abandon on first call');
    assert(r.includes('goals.cancel_all_confirm'), `expected goals.cancel_all_confirm, got: ${r.slice(0, 80)}`);
  });

  await test('I8: /goal clear second call within 30s executes', async () => {
    const { ch, abandoned } = makeCH({ activeGoals: [{ id: 'g1', description: 'A' }, { id: 'g2', description: 'B' }] });
    await ch.goals('/goal clear');
    const r = await ch.goals('/goal clear');
    assert(abandoned.length === 2, `expected 2 abandoned, got ${abandoned.length}`);
    assert(r.includes('goals.cancel_all_done'), `expected goals.cancel_all_done, got: ${r.slice(0, 80)}`);
  });

  await test('I9: /goal clear with no active goals returns none_active', async () => {
    const { ch, abandoned } = makeCH({ activeGoals: [] });
    const r = await ch.goals('/goal clear');
    assert(abandoned.length === 0);
    assert(r.includes('goals.none_active'), `expected goals.none_active, got: ${r.slice(0, 80)}`);
  });

  await test('I10: unknown subcommand returns goals.unknown_subcommand', async () => {
    const { ch } = makeCH();
    const r = await ch.goals('/goal whoknows arg');
    assert(r.includes('goals.unknown_subcommand'), `expected goals.unknown_subcommand, got: ${r.slice(0, 80)}`);
  });

  await test('I11: /goal help returns help text', async () => {
    const { ch } = makeCH();
    const r = await ch.goals('/goal help');
    assert(r.includes('goals.help'), `expected goals.help, got: ${r.slice(0, 80)}`);
  });

  // ──────────────────────────────────────────────────────────────
  // Summary
  // ──────────────────────────────────────────────────────────────

  console.log(`\n  v750-fix: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('  Failures:');
    for (const f of failures) console.log(`    - ${f.name}: ${f.error}`);
    process.exitCode = 1;
  }
})();
