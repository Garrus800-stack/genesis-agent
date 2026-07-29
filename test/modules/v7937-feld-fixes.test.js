// ============================================================
// TEST — v7.9.37 field fixes (goal repetition & fast-abandon family)
// Root causes from the 2026-07-07 v7.9.34 field run:
//   F1  'abandoned' invisible to both dedup fences (3h duplicate loop)
//   F2  resume off-by-one: fresh goals born with currentStep 0 skipped
//       step 1 (world separation: plan-world vs legacy stack-world)
//   F4  plan context window too short + raw LLM block as description
//   F5  preGeneratedSteps had zero writers — preset branch was dead code
// Plan: v7937-feld-plan-v1.md (reviews R1–R8; F3 dropped on evidence —
// the availability machinery already works end-to-end).
// ============================================================

const { describe, test, run } = require('../harness');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const gi = require(path.join(ROOT, 'src/agent/core/goal-intent'));

const NOW = 1783500000000;
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

// ── F1: abandoned is terminal for the fences ────────────────

describe('v7.9.37 F1 — abandoned joins the shared terminal set', () => {
  test('the shared set knows abandoned; the policy union is gone', () => {
    assert(gi._TERMINAL_GOAL_STATUS.has('abandoned'), 'shared set');
    const pol = fs.readFileSync(path.join(ROOT, 'src/agent/agency/GoalDriverFailurePolicy.js'), 'utf8');
    assert(!pol.includes("_st === 'abandoned'"), 'local union removed');
    assert(pol.includes('field-line candidate is redeemed'), 'comment tells the design turn');
  });

  test('an abandoned archive goal lands in the failedHint and trips the overlap fence', () => {
    const ctx = gi.buildRecentGoalContext({
      goalStack: { goals: [] },
      storage: { readJSON: () => [{
        description: 'Inspect Health Monitor Self-Reporting Mechanism',
        status: 'abandoned', created: iso(3600000), updated: iso(3600000),
      }] },
      now: NOW,
    });
    assert(ctx.failedHint.includes('Health Monitor'), 'in the prompt list');
    assert(ctx.failedHint.includes('[abandoned]'), 'status visible');
    const { redundant } = gi._overlapRedundant(
      new Set(gi._tokenize('Inspect Health Monitor Self-Reporting Mechanism')),
      gi._tokenize(ctx.recentFailures[0].description),
    );
    assert.strictEqual(redundant, true, 'code fence now fires on the re-proposal');
  });
});

// ── F2: world separation ────────────────────────────────────

describe('v7.9.37 F2 — plan-world resume reads only the transient checkpoint', () => {
  const pursuit = fs.readFileSync(path.join(ROOT, 'src/agent/revolution/AgentLoopPursuit.js'), 'utf8');
  const persist = fs.readFileSync(path.join(ROOT, 'src/agent/planning/GoalPersistence.js'), 'utf8');

  test('pursuit: fresh goals start at step 1 (no +1 on the stack-world field)', () => {
    assert(!pursuit.includes('_presetGoal.currentStep + 1'), 'old formula gone');
    assert(pursuit.includes('_cp.stepIndex + 1'), 'plan-world formula present');
    assert(pursuit.includes('_presetGoal._loopCheckpoint'), 'reads the transient field');
    // seeded results come from the same world, not from goal.results
    assert(pursuit.includes('_cp.partialResults'), 'seeds from the checkpoint');
    assert(!/const _seededResults =[^;]*_presetGoal\.results/.test(pursuit), 'no stack-world seeding');
  });

  test('load: the checkpoint no longer overwrites stack-world fields', () => {
    assert(!persist.includes('goal.currentStep = checkpoint.stepIndex'), 'currentStep untouched');
    assert(persist.includes('goal._loopCheckpoint = {'), 'transient field attached');
    const idx = persist.indexOf('goal._loopCheckpoint = {');
    const tail = persist.slice(idx, idx + 240);
    assert(tail.includes('stepIndex') && tail.includes('partialResults'), 'carries both parts');
  });
});

// ── F4: honest context window + clean description ───────────

describe('v7.9.37 F4 — plan context and description hygiene', () => {
  const planSrc = fs.readFileSync(path.join(ROOT, 'src/agent/autonomy/activities/Plan.js'), 'utf8');

  test('window pin: the prompt sees the last 10 plans', () => {
    assert(planSrc.includes('idleMind.plans.slice(-10)'), 'window widened');
    assert(!planSrc.includes('idleMind.plans.slice(-3)'), 'old window gone');
  });

  test('description parse: DESCRIPTION section extracted, scaffold dropped', () => {
    assert(planSrc.includes('description: _descText'), 'plan stores the parsed text');
    // behavior probe with the exact field format
    const thought = 'TITLE: Inspect X  \nPRIORITY: high  \nEFFORT: small  \nDESCRIPTION: Examine how X integrates with Y and find gaps.  \nFIRST_STEP: Open src/x.js';
    const m = thought.match(/DESCRIPTION:\s*([\s\S]*?)(?:\n\s*FIRST_STEP:|$)/i);
    const desc = (m && m[1] && m[1].trim()) || thought;
    assert.strictEqual(desc, 'Examine how X integrates with Y and find gaps.');
    assert(!desc.startsWith('TITLE:'));
  });
});

// ── F5: the preset branch lives again ───────────────────────

describe('v7.9.37 F5 — curated activity steps reach the loop', () => {
  const pursuit = fs.readFileSync(path.join(ROOT, 'src/agent/revolution/AgentLoopPursuit.js'), 'utf8');

  test('goal.steps is accepted as the preset fallback (planner skipped)', () => {
    assert(pursuit.includes('_presetGoal.steps.length > 0) ? _presetGoal.steps : null'), 'fallback expression');
    assert(pursuit.includes('if (_presetGoal && _presetSteps)'), 'branch keyed on the union');
    assert(pursuit.includes('steps: _presetSteps'), 'plan carries the preset steps');
  });

  test('budget line and plan branch agree on the same fallback family', () => {
    const budget = pursuit.match(/_timeoutBudget\(([^)]*)\)/);
    assert(budget && budget[1].includes('preGeneratedSteps') && budget[1].includes('steps'), 'budget already knew both');
    // the comment records the field evidence so the branch never dies silently again
    assert(pursuit.includes('ZERO writers'), 'design note present');
  });
});

// ── Field-2 (same version, second field pass): the tool root cause ──
// The 2026-07-08 run of the FIRST v7.9.37 build proved F1/F2/F5 working
// (no duplicates, no ghost resume, presets reach the loop) and exposed
// what they had uncovered: inspection scripts crashing on relative
// requires copied from source files, legacy step types warning on every
// preset, and retry cards reading like the old duplicate bug.

describe('v7.9.37 field-2 — script context harness (L1)', () => {
  const steps = fs.readFileSync(path.join(ROOT, 'src/agent/revolution/AgentLoopSteps.js'), 'utf8');
  const code = fs.readFileSync(path.join(ROOT, 'src/agent/revolution/AgentLoopStepsCode.js'), 'utf8');

  test('L1a: both run sites hand GENESIS_ROOT to the script environment', () => {
    const hits = steps.match(/GENESIS_ROOT: loop\.rootDir/g) || [];
    assert.strictEqual(hits.length, 2, 'shell.run and execFile both carry the env');
  });

  test('L1b: the CODE conventions teach the GENESIS_ROOT load form and the constants rule', () => {
    assert(code.includes("p.join(process.env.GENESIS_ROOT,'src/agent/core/Logger.js')"), 'load form shown');
    assert(code.includes('NEVER copy relative require'), 'relative-copy ban');
    assert(code.includes('re-declare the value you need locally'), 'constants rule');
  });

  test('L1c: inline relative requires are rejected before approval, teachably', () => {
    const idx = steps.indexOf("require\\(\\s*['\"]\\.\\.?\\/");
    assert(idx > 0, 'scan present');
    assert(idx < steps.indexOf('let approvalDetail'), 'scan sits before approval');
    const re = /require\(\s*['"]\.\.?\//;
    assert(re.test("node -e \"const L=require('./Logger')\""), 'catches ./');
    assert(re.test("require('../core/X')"), 'catches ../');
    assert(!re.test("require(p.join(process.env.GENESIS_ROOT,'src/x'))"), 'GENESIS_ROOT form passes');
    assert(!re.test("require('lodash')"), 'packages pass');
    assert(steps.includes('GENESIS_ROOT is provided'), 'error message teaches the fix');
  });
});

describe('v7.9.37 field-2 — legacy type aliases (L2) and attempt visibility (L3)', () => {
  const steps = fs.readFileSync(path.join(ROOT, 'src/agent/revolution/AgentLoopSteps.js'), 'utf8');

  test('L2: known legacy types map silently before the WARN fallback', () => {
    const aliasIdx = steps.indexOf('_ALIAS = { think');
    assert(aliasIdx > 0 && aliasIdx < steps.indexOf('unknown/missing type'), 'alias sits before the fallback');
    for (const pair of [["think", 'ANALYZE'], ["'create-file'", 'CODE'], ["run", 'SHELL']]) {
      assert(steps.includes(`${pair[0]}: '${pair[1]}'`), `${pair[0]} → ${pair[1]}`);
    }
    // silent: the alias branch neither warns nor annotates the description
    const aliasBlock = steps.slice(aliasIdx, steps.indexOf('} else {', aliasIdx));
    assert(!aliasBlock.includes('_log.warn') && !aliasBlock.includes('[was'), 'no warn, no annotation');
  });

  test('L2: true unknowns still warn and annotate (v797 contract preserved)', () => {
    const fbIdx = steps.indexOf('unknown/missing type');
    const fbBlock = steps.slice(fbIdx, fbIdx + 400);
    assert(fbBlock.includes('[was ${_origType}]'), 'annotation preserved for unknowns');
  });

  test('L3: the failure message itself carries the attempt counter', () => {
    const pol = fs.readFileSync(path.join(ROOT, 'src/agent/agency/GoalDriverFailurePolicy.js'), 'utf8');
    assert(pol.includes('(attempt ${entry.count}/${_failureCap + 1})'), 'prefix built at the source');
    assert(pol.indexOf('(attempt ${entry.count}') < pol.indexOf('const backoffMs = backoffSchedule'), 'before every downstream use');
  });
});

// ── Pass 3 (same version, third field pass): resilience under a dead model ──
// The 2026-07-09 idle run: a cloud-only chain collapsed at 10:04, partials
// were passed downstream as real content, one goal grew to 170 steps, and
// explore hammered the closed CostGuard 19 times in a 15-minute beat.

describe('v7.9.37 pass 3 — model degradation becomes complete (R1)', () => {
  const bridge = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/ModelBridge.js'), 'utf8');
  const cont = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/ModelBridgeContinuation.js'), 'utf8');
  const loop = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/backends/ContinuationLoop.js'), 'utf8');

  test('R1a: continuation failure is explicit and partials are discarded, model marked', () => {
    assert(bridge.includes("'continuation-exhausted': 30 * 60 * 1000"), 'TTL class exists');
    assert(loop.includes("ok: false,") && loop.includes("failureReason,\n    content: dedupeSeams(partial)"), 'loop failure shape is explicit (v7.9.41 r2: partial passes the seam healer)');
    assert(cont.includes("markUnavailable(model, 'continuation-exhausted')"), 'wrapper marks the model');
    assert(cont.includes('discarded, not usable as code'), 'partial is thrown, not returned as success');
  });

  test('R1b: an exhausted chain degrades to the best usable local model', () => {
    const { failoverMixin } = require(path.join(ROOT, 'src/agent/foundation/ModelBridgeFailover.js'));
    const fake = {
      availableModels: [{ name: 'dead:cloud', backend: 'ollama' }, { name: 'deepseek-coder-v2-lite-instruct:fp16', backend: 'ollama' }],
      isMarkedUnavailable: n => n.includes('dead'),
      _selectBestModel: l => l[l.length - 1],
    };
    assert.strictEqual(failoverMixin._pickDegradedLocal.call(fake).name, 'deepseek-coder-v2-lite-instruct:fp16');
    fake.isMarkedUnavailable = () => true;
    assert.strictEqual(failoverMixin._pickDegradedLocal.call(fake), null, 'truly nothing usable ⇒ null');
    assert(bridge.indexOf('_pickDegradedLocal?.()') < bridge.indexOf('this._emitFailoverUnavailable(targetBackend, err)'),
      'degradation is tried before the failover-unavailable give-up');
  });
});

describe('v7.9.37 pass 3 — idle dignity (R2/R3) and visible failures (R5)', () => {
  const idle = fs.readFileSync(path.join(ROOT, 'src/agent/autonomy/IdleMind.js'), 'utf8');

  test('R2: the session cost cap enters rest mode and outlives model recovery', () => {
    assert(idle.includes("this._sub('llm:cost-cap-reached', () => { this._costCapped = true; }"), 'listener');
    assert(idle.includes('areAllModelsUnavailable?.() || this._costCapped'), 'guard OR');
    const exitIdx = idle.indexOf('_exitRestMode(modelName) {');
    assert(idle.slice(exitIdx, exitIdx + 200).includes('if (this._costCapped) return;'), 'exit respects the cap');
  });

  test('R3: a rate/budget failure parks the activity instead of the 15-min hammer', () => {
    assert(/rate\.\?limit\|budget\|cost cap/.test(idle) || idle.includes('/rate.?limit|budget|cost cap/i'), 'signature regex');
    assert(idle.includes('_failPenaltyUntil.set(activity, Date.now() + 20 * 60 * 1000)'), '~4 cycles penalty');
    assert(idle.indexOf('under fail-penalty — skipping') > idle.indexOf('const activity = this._pickActivity()'), 'filter sits after the pick');
  });

  test('R5: failed runs are counted, persisted, and restored', () => {
    const mixSrc = fs.readFileSync(path.join(ROOT, 'src/agent/autonomy/IdleMindActivityStats.js'), 'utf8');
    assert(mixSrc.includes('failedRunCounts: Object.fromEntries(this._failedRunCounts || [])'), 'payload');
    assert(mixSrc.includes('data.failedRunCounts && typeof data.failedRunCounts'), 'load restore');
    const mix = require(path.join(ROOT, 'src/agent/autonomy/IdleMindActivityStats.js'));
    const m = mix.activityStatsMixin || mix;
    const fake = Object.assign({ storage: null }, m);
    fake._bumpFailedRun('explore'); fake._bumpFailedRun('explore');
    assert.strictEqual(fake._failedRunCounts.get('explore'), 2);
  });
});

describe('v7.9.37 pass 3 — the repair budget (R4)', () => {
  const pursuit = fs.readFileSync(path.join(ROOT, 'src/agent/revolution/AgentLoopPursuit.js'), 'utf8');

  test('the cap formula bounds growth for small and large plans alike', () => {
    const cap = (init) => Math.min(40, Math.max(24, 3 * init));
    assert.strictEqual(cap(8), 24);
    assert.strictEqual(cap(12), 36);
    assert.strictEqual(cap(20), 40, 'inherited-growth retries hit the absolute ceiling');
    const rec = fs.readFileSync(path.join(ROOT, 'src/agent/revolution/AgentLoopRecovery.js'), 'utf8');
    assert(rec.includes('Math.min(40, Math.max(24, 3 * initialStepCount))'), 'formula lives in the recovery budget');
    const { AgentLoopRecoveryDelegate } = require(path.join(ROOT, 'src/agent/revolution/AgentLoopRecovery.js'));
    const b = AgentLoopRecoveryDelegate.prototype.createRepairBudget.call({}, 8);
    assert(b.hasRounds() && b.fits(24) && !b.fits(25));
    for (let k = 0; k < 5; k++) b.spend();
    assert(!b.hasRounds(), 'five rounds spend the budget');
  });

  test('both growth paths are budgeted: replan and repair share five rounds', () => {
    assert((pursuit.match(/_budget\.hasRounds\(\)/g) || []).length === 2, 'gate on both paths');
    assert(pursuit.includes('exceeds step cap'), 'oversized replans are rejected');
    assert(pursuit.includes("reason: 'repair budget exhausted'"), 'exhaustion is an honest reason');
    assert(pursuit.includes('if (repairResult.recovered) _budget.spend()'), 'repairs count into the budget');
  });
});

// ── Pass 4 (same version): cloud first-class, chat dignity, step forensics ──
// Root of roots (field 10.07., the user' window observation): num_ctx:8192 was
// sent hard to every chat model while 48k prompts were built — the server
// truncated the head (identity included) on every large call.

describe('v7.9.37 pass 4 — E3: the real window reaches the server (C1/C2)', () => {
  const { OllamaBackend } = require(path.join(ROOT, 'src/agent/foundation/backends/OllamaBackend.js'));
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/backends/OllamaBackend.js'), 'utf8');

  test('C1: _ctxFor resolves via /api/show with cap, cache, fallbacks', async () => {
    const b = new OllamaBackend({ baseUrl: 'http://x' });
    b._httpPost = async () => ({ model_info: { 'qwen3moe.context_length': 262144 } });
    assert.strictEqual(await b._ctxFor('big:cloud'), 65536, 'capped at numCtxCap');
    assert.strictEqual(b._ctxCache.get('big:cloud'), 65536, 'cached');
    b._httpPost = async () => ({ parameters: 'num_ctx 32768\nstop x' });
    assert.strictEqual(await b._ctxFor('param-model'), 32768, 'parameters fallback');
    b._httpPost = async () => { throw new Error('down'); };
    assert.strictEqual(await b._ctxFor('unknown'), 8192, 'last-resort default');
    assert.strictEqual(await b._ctxFor('nomic-embed-text'), 2048, 'embedding guard stays');
  });

  test('C2: num_predict is always explicit — never server roulette', () => {
    const b = new OllamaBackend({ baseUrl: 'http://x' });
    assert.strictEqual(b._predictFor(2000, 65536), 2000, 'explicit wins');
    assert.strictEqual(b._predictFor(undefined, 65536), 8192, 'derived min(8192, ctx/4)');
    assert.strictEqual(b._predictFor(0, 8192), 2048, 'small ctx derives smaller');
    b.setContextConfig({ maxTokensDefault: 4096 });
    assert.strictEqual(b._predictFor(undefined, 65536), 4096, 'settings default wins over derive');
    assert((src.match(/_predictFor\(maxTokens, ctxSize\)/g) || []).length === 3, 'definition + both call paths');
    assert((src.match(/await this\._ctxFor\(modelName\)/g) || []).length === 2, 'both call paths resolve the real window');
  });

  test('C1 wiring + C3 cloud-fair + C4 probe exist', () => {
    const bridge = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/ModelBridge.js'), 'utf8');
    assert(bridge.includes("setContextConfig?.({"), 'bridge injects settings config');
    const settings = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/Settings.js'), 'utf8') + '\n' + fs.readFileSync(path.join(ROOT, 'src/agent/foundation/SettingsDefaults.js'), 'utf8');
    assert(settings.includes('numCtxCap: 65536') && settings.includes('maxTokensDefault: 0'), 'defaults');
    const pers = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/SettingsPersistence.js'), 'utf8');
    assert(pers.includes("clamp('llm.numCtxCap'") && pers.includes("clamp('llm.maxTokensDefault'"), 'clamps');
    const cont = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/ModelBridgeContinuation.js'), 'utf8');
    assert(cont.includes("/:cloud$/i.test(model) ? 300000"), 'C3: cloud first-chunk 300s default, settings win');
    const probe = fs.readFileSync(path.join(ROOT, 'scripts/probe-model.js'), 'utf8');
    assert(probe.includes('time to first chunk') && probe.includes('num_ctx Genesis sends'), 'C4 probe core outputs');
  });
});

describe('v7.9.37 pass 4 — E2: honest marks, honest logs (B1–B6)', () => {
  const { failoverMixin, isCloudModel } = require(path.join(ROOT, 'src/agent/foundation/ModelBridgeFailover.js'));

  test('B1: the continuation failure text classifies; a known reason is never downgraded', () => {
    const r = failoverMixin._classifyFailoverReason.call({}, new Error('[CONTINUATION] x failed: max-continuations — partial (500 chars) discarded'));
    assert.strictEqual(r, 'continuation-exhausted');
    const avail = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/ModelBridgeAvailability.js'), 'utf8');
    assert(avail.includes('never downgrade a known reason'), 'guard comment anchors the rule');
    assert(avail.indexOf('if (!reason) {') < avail.indexOf("bus.fire('model:marked-unavailable'"), 'guard sits before the emit');
  });

  test('B2: cloud detection + non-cloud preference, cloud-only stays first-class', () => {
    assert(isCloudModel('deepseek-v4-pro:cloud') && !isCloudModel('deepseek-coder-v2:16b'));
    const fake = { availableModels: [{ name: 'a:cloud', backend: 'ollama' }, { name: 'local-b', backend: 'ollama' }], isMarkedUnavailable: () => false, _selectBestModel: l => l[0] };
    assert.strictEqual(failoverMixin._pickDegradedLocal.call(fake).name, 'local-b');
    fake.availableModels = [{ name: 'a:cloud', backend: 'ollama' }];
    assert.strictEqual(failoverMixin._pickDegradedLocal.call(fake).name, 'a:cloud');
    const bridge = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/ModelBridge.js'), 'utf8');
    assert(bridge.includes('(cloud — no non-cloud model usable)'), 'B2d: the DEGRADED line tells the truth');
    assert(bridge.includes("'stream-timeout':         15 * 60 * 1000"), 'B3: TTL class exists');
  });

  test('B3–B6: strike mark, model→model line, plan variety, true timeout number', () => {
    const cont = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/ModelBridgeContinuation.js'), 'utf8');
    assert(cont.includes('/first-chunk timeout/i.test(_msg)') && cont.includes("markUnavailable(model, 'stream-timeout')") && cont.includes('hits.length >= 2'), 'B3 strikes');
    const bridge = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/ModelBridge.js'), 'utf8');
    assert(bridge.includes('failed → ') && bridge.includes('(backend ${fallback})'), 'B4 names models, not backends');
    const plan = fs.readFileSync(path.join(ROOT, 'src/agent/autonomy/activities/Plan.js'), 'utf8');
    assert(plan.includes('VARY goal families'), 'B5 variety rule in the plan prompt');
    const pursuit = fs.readFileSync(path.join(ROOT, 'src/agent/revolution/AgentLoopPursuit.js'), 'utf8');
    assert(pursuit.includes('Global timeout (${TIMEOUTS.AGENT_LOOP_GLOBAL}ms)'), 'B6 reason carries the real number');
  });
});

describe('v7.9.37 pass 4 — E1: chat dignity (V1–V3)', () => {
  test('V1: identity forbids invented versions and cut-off claims (both branches)', () => {
    const sec = fs.readFileSync(path.join(ROOT, 'src/agent/intelligence/PromptBuilderSections.js'), 'utf8');
    assert((sec.match(/erfinde NIEMALS andere Versionsnummern/g) || []).length === 2, 'both identity branches');
    assert((sec.match(/sei abgeschnitten worden/g) || []).length === 2, 'cut-off rule in both branches');
  });

  test('V2: full autonomy adds the act-don\'t-ask directive', () => {
    const rt = fs.readFileSync(path.join(ROOT, 'src/agent/intelligence/PromptBuilderRuntimeState.js'), 'utf8');
    assert(rt.includes('/FULL|^2$/i.test(String(s.trustLevel))'), 'trust condition covers name and number');
    assert(rt.includes('Beende Antworten NICHT mit Erlaubnisfragen'), 'directive text');
  });

  test('V3: non-idle goals report their outcome into the chat channel', () => {
    const fp = fs.readFileSync(path.join(ROOT, 'src/agent/agency/GoalDriverFailurePolicy.js'), 'utf8');
    assert(fp.includes("goal.source !== 'idle-mind'"), 'filter');
    assert(fp.includes("'idle:proactive-insight'") && fp.includes("activity: 'goal'"), 'existing insight channel');
    assert(fp.indexOf("goal.source !== 'idle-mind'") > fp.indexOf('ended (${_st})'), 'fires at the terminal site');
  });
});

describe('v7.9.37 pass 4 — E4: step forensics (S1/S2)', () => {
  test('S1: every classified step failure prints a visible diagnosis', () => {
    const pursuit = fs.readFileSync(path.join(ROOT, 'src/agent/revolution/AgentLoopPursuit.js'), 'utf8');
    assert(pursuit.includes('[STEP-DIAG] Step ${i + 1}'), 'log format');
    assert(pursuit.includes('cause: ${recovery.category') && pursuit.includes('action: ${recovery.action'), 'carries taxonomy fields');
    assert(pursuit.includes("phase: 'step-diagnosis'"), 'surfaces via onProgress');
  });

  test('S2: an ambiguity flood names its likely cause', () => {
    const rec = fs.readFileSync(path.join(ROOT, 'src/agent/revolution/AgentLoopRecovery.js'), 'utf8');
    assert(rec.includes('likely output-format mismatch (truncated model response?)'), 'diagnosis text');
    assert(rec.includes('ambiguous / Math.max(1, verified.length) > 0.5'), 'majority threshold');
  });
});

// ── Pass 5 (same version): router intelligence ──
// Field 10.07. evening (M2 chat, old soul under new code): the SAME template
// question four times while the filename sat in every message; a live
// summarize the chat-brain never learned about; "Tools ausführen..." as text.

describe('v7.9.37 pass 5 — X1: one resolver, recursive, acting on one match', () => {
  const os = require('os');
  const R = require(path.join(ROOT, 'src/agent/hexagonal/ProjectFileResolver.js'));
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'g37x1-'));
  fs.mkdirSync(path.join(T, 'docs'));
  fs.mkdirSync(path.join(T, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(T, 'ARCHITECTURE.md'), 'a');
  fs.writeFileSync(path.join(T, 'docs', 'ONTOGENESIS.md'), 'b');
  fs.writeFileSync(path.join(T, 'README.md'), 'r1');
  fs.writeFileSync(path.join(T, 'docs', 'README.md'), 'r2');
  fs.writeFileSync(path.join(T, 'node_modules', 'x', 'evil.md'), 'e');

  test('the exact field phrasing resolves in one move', () => {
    const rr = R.resolveFileToken('schaue dir ARCHITECTURE.md an', T);
    assert.strictEqual(rr.status, 'one');
    assert.strictEqual(rr.matches[0].rel, 'ARCHITECTURE.md');
  });
  test('recursive + case-insensitive reaches docs/', () => {
    const rr = R.resolveFileToken('lies bitte ontogenesis.md', T);
    assert.strictEqual(rr.status, 'one');
    assert.strictEqual(rr.matches[0].rel, 'docs/ONTOGENESIS.md');
    assert.strictEqual(R.resolveFileToken('docs\\ONTOGENESIS.md', T).matches[0].rel, 'docs/ONTOGENESIS.md', 'windows separators normalize');
  });
  test('ambiguity lists candidates, root first', () => {
    const rr = R.resolveFileToken('öffne README.md', T);
    assert.strictEqual(rr.status, 'many');
    assert.deepStrictEqual(rr.matches.map(m => m.rel), ['README.md', 'docs/README.md']);
  });
  test('unknown names say none; ignored dirs stay invisible', () => {
    assert.strictEqual(R.resolveFileToken('was steht in xyz.md', T).status, 'none');
    assert.strictEqual(R.resolveFileToken('evil.md', T).status, 'none', 'node_modules ignored');
    assert.strictEqual(R.resolveFileToken('na wie geht es', T).status, 'none', 'no token → none, no crash');
  });
});

describe('v7.9.37 pass 5 — X2/X3: memory of the question, provenance in the answer', () => {
  const os = require('os');
  const { commandHandlersFileView } = require(path.join(ROOT, 'src/agent/hexagonal/CommandHandlersFileView.js'));
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'g37x2-'));
  fs.writeFileSync(path.join(T, 'ARCHITECTURE.md'), 'zeile1\nzeile2');

  test('X2: a pending question turns the next bare name into the answer', async () => {
    const me = Object.assign({ fp: { rootDir: T }, lang: null, _pendingFileRequest: null }, commandHandlersFileView);
    const a1 = await me.readFile('lies bitte gibtsnicht.md');
    assert(a1.includes('nicht gefunden'), 'smart none-question');
    assert(me._pendingFileRequest && me._pendingFileRequest.kind === 'read');
    const a2 = await me.readFile('ARCHITECTURE.md');
    assert(a2.startsWith('📄 ARCHITECTURE.md gelesen (2 Zeilen)'), 'resolved via pending, with provenance');
    assert.strictEqual(me._pendingFileRequest, null, 'pending cleared');
  });
  test('X2: the identical template is never repeated under a pending question', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/hexagonal/CommandHandlersFileView.js'), 'utf8');
    assert(src.indexOf('Ich warte noch auf die Datei') < src.indexOf("'Welche Datei soll ich lesen?"), 'pending branch precedes the template');
  });
  test('X3: read and summarize answers carry the 📄 provenance head', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/hexagonal/CommandHandlersFileView.js'), 'utf8');
    assert(src.includes('📄 ${base} gelesen (${content.split'), 'read marker');
    assert(src.includes('read (${_ln} lines) — summary'), 'english summarize marker');
    assert(src.includes('gelesen (${_ln} Zeilen) — Zusammenfassung'), 'german summarize marker');
  });
});

describe('v7.9.37 pass 5 — X4/T1: act in the same move, shell that spawns', () => {
  test('X4: the announce-without-call reprompt allows two strikes with a sharper second text', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/hexagonal/ChatOrchestrator.js'), 'utf8') + '\n' + fs.readFileSync(path.join(ROOT, 'src/agent/hexagonal/ChatOrchestratorStream.js'), 'utf8'); // v7.9.48: split
    assert(src.includes('_toolIntentReprompts < 2'), 'two strikes');
    assert(src.includes('WIEDER nur angekündigt'), 'sharper second text (de)');
    const rt = fs.readFileSync(path.join(ROOT, 'src/agent/intelligence/PromptBuilderRuntimeState.js'), 'utf8');
    // v7.9.37 (W2): the pass-5 wording quoted the announce phrase and the model parroted it — deliberately superseded.
    assert(rt.includes('tool_call-Block im SELBEN Zug') && rt.includes('NIEMALS als /slash-Zeile'), 'prompt rule (W2 wording)');
  });
  test('X1-shell + T1: file names resolve before the open question; ComSpec wins over bare cmd.exe', () => {
    const sh = fs.readFileSync(path.join(ROOT, 'src/agent/hexagonal/CommandHandlersShell.js'), 'utf8');
    assert(sh.includes("resolveFileToken(message"), 'shell uses the shared resolver');
    assert(sh.indexOf('resolveFileToken') < sh.indexOf('Welchen Ordner oder welche Datei'), 'stage sits before the question');
    const b = fs.readFileSync(path.join(ROOT, 'src/agent/intelligence/ToolRegistryBuiltins.js'), 'utf8');
    const a = fs.readFileSync(path.join(ROOT, 'src/agent/core/shell/ShellOSAdapter.js'), 'utf8');
    assert(b.includes("process.env.ComSpec || 'cmd.exe'") && a.includes("process.env.ComSpec || 'cmd.exe'"), 'both seams');
  });
});

// ── Pass 6 (same version): sandbox grounding & taxonomy medicine ──
// Field 11.07. (idle run + morning chat): 17× "unclassified → none", both
// self-inspection goals dead on the sandbox floor, an announce-stutter ×3.

describe('v7.9.37 pass 6 — S-A/S-B: grounded sandbox, nameable failures', () => {
  test('S-A: both safeEnv blocks carry GENESIS_ROOT + NODE_PATH; the code prompt teaches absolute requires', () => {
    const sb = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/Sandbox.js'), 'utf8');
    assert.strictEqual((sb.match(/GENESIS_ROOT: this\.rootDir/g) || []).length, 2, 'both spawn paths');
    assert.strictEqual((sb.match(/NODE_PATH: \[this\.rootDir/g) || []).length, 2, 'NODE_PATH both paths');
    const sc = fs.readFileSync(path.join(ROOT, 'src/agent/revolution/AgentLoopStepsCode.js'), 'utf8');
    assert(sc.includes('process.env.GENESIS_ROOT') && sc.includes("NEVER use relative './src/"), 'prompt rule');
  });

  test('S-B: the exact field errors classify — and ft can never be null again', () => {
    const { FailureTaxonomy } = require(path.join(ROOT, 'src/agent/intelligence/FailureTaxonomy.js'));
    const ft = new FailureTaxonomy({});
    assert.strictEqual(ft.classify('Error: unset GENESIS_ROOT in run').category, 'environmental');
    // v7.9.37 (X2): a PATH is never a package — the pass-6 pin expected an
    // install-obstacle for './src/...'; deliberately superseded.
    const _pcat = ft.classify("Cannot find module './src/agent/core/Logger'").category;
    assert(_pcat === 'deterministic' || _pcat === 'environmental', `path form named (${_pcat}), never an install obstacle`);
    assert.strictEqual(ft.classify('SyntaxError: Unexpected token').category, 'deterministic');
    const rec = fs.readFileSync(path.join(ROOT, 'src/agent/revolution/AgentLoopRecovery.js'), 'utf8');
    assert(rec.includes('this._ftFallback ||='), 'lazy fallback guarantees classification');
  });
});

describe('v7.9.37 pass 6 — S-C/S-D/S-E/S-F: gate, honest archive, crash trace, no stutter', () => {
  test('S-C: a "create Logger.js in src/" step is blocked as self-modification before any code runs', async () => {
    const mod = require(path.join(ROOT, 'src/agent/revolution/AgentLoopStepsCode.js'));
    const mixin = mod.stepsCodeMixin || mod;
    const fn = mixin._stepCode || Object.values(mixin).find(v => v && v._stepCode)?._stepCode;
    assert(typeof fn === 'function', 'mixin exposes _stepCode');
    const r = await fn.call({}, { description: 'Create or relocate the missing Logger.js module to satisfy the src/agent/core require' }, {}, () => {});
    assert(r && r.selfModBlocked === true && /proposal/i.test(r.error), 'blocked with proposal pointer');
  });

  test('S-D/S-E: archive carries the reason; a crash boot writes into the flight recorder', () => {
    const gp = fs.readFileSync(path.join(ROOT, 'src/agent/planning/GoalPersistence.js'), 'utf8');
    assert(gp.includes('goal.failureReason || goal.abandonReason'), 'S-D outcome fill');
    assert(gp.indexOf('goal.outcome = String(_why)') < gp.indexOf('this._archive.push(goal)'), 'fills before push');
    const br = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/BootRecovery.js'), 'utf8');
    assert(br.includes("appendFileSync") && br.includes('flight-recorder.log'), 'S-E direct append');
    assert(br.includes('last crash.log entry'), 'S-E cites crash.log when present');
  });

  test('S-F: after two strikes a raw announce is replaced by one honest status line', () => {
    const co = fs.readFileSync(path.join(ROOT, 'src/agent/hexagonal/ChatOrchestrator.js'), 'utf8') + '\n' + fs.readFileSync(path.join(ROOT, 'src/agent/hexagonal/ChatOrchestratorStream.js'), 'utf8'); // v7.9.48: split
    assert(co.includes('_toolIntentReprompts >= 2 && this.tools.detectToolIntentWithoutCall?.(response)'), 'guard');
    assert(co.includes('Ich konnte gerade kein Werkzeug starten'), 'german status line');
    assert(co.indexOf('honest status line') < co.indexOf('// No tools (and no re-prompt warranted)'), 'sits before the done branch');
    const tr = fs.readFileSync(path.join(ROOT, 'src/agent/intelligence/ToolRegistry.js'), 'utf8');
    assert(tr.includes('ausf[üu]hren') && tr.includes('schaue?\\s+mich'), 'detector knows both field phrases'); // v7.9.37 pass 6 (S-F)
  });
});

// ── G-series (same version): plan-approval dignity ──
// Field 11.07. afternoon (SUPERVISED run): 25min hang at a card that said
// only "Unknown step type" — five phantom blockers, no goal name, no id.

describe('v7.9.37 G-series — the card is honest, the wait never hangs', () => {
  test('G1: field aliases normalize — the five phantom blockers die at the source', () => {
    const st = require(path.join(ROOT, 'src/agent/core/step-types.js'));
    assert.strictEqual(st.normalizeStepType('THINK'), 'ANALYZE');
    assert.strictEqual(st.normalizeStepType('CHECK'), 'ANALYZE');
    assert.strictEqual(st.normalizeStepType('CREATE-FILE'), 'CODE', 'hyphen variants normalize');
    assert.strictEqual(st.normalizeStepType('bogus'), null, 'unknowns still fail honestly');
  });

  test('G2/G4: the gate builds a human card and a timeout parks instead of rejecting', async () => {
    const { ApprovalGate } = require(path.join(ROOT, 'src/agent/revolution/ApprovalGate.js'));
    const fired = [];
    const g = new ApprovalGate({ bus: { fire: (n, p) => fired.push([n, p]) }, trustLevelSystem: { checkApproval: () => ({ approved: false }), _level: 1 }, timeoutMs: 5000 });
    const card = g.buildPlanCard({ goalDescription: 'Compare GoalDriver boot and recovery', dryRun: { validation: { totalIssues: 2, results: [{ stepIndex: 0, type: 'THINK', issues: ['x'] }] }, summary: 's' }, presetGoal: { source: 'idle-mind', steps: [] } });
    assert(card.description.includes('goal: "Compare GoalDriver'), 'names the goal');
    assert(card.description.includes('Approve = run this plan anyway'), 'explains the buttons');
    assert.strictEqual(card.action, 'plan-has-issues');
    const v = await g.request(card.action, card.description, { ...card.opts, timeoutMs: 30 });
    assert.strictEqual(v, 'timeout', 'timeout is distinguishable from reject');
    const ev = fired.find(f => f[0] === 'agent-loop:approval-needed')[1];
    assert(ev.trustLevel === 1 && typeof ev.goalDescription === 'string', 'card event carries level + goal');
  });

  test('G3: FULL auto-approves plan issues; self-modification never bypasses the setting', async () => {
    const { ApprovalGate } = require(path.join(ROOT, 'src/agent/revolution/ApprovalGate.js'));
    const g = new ApprovalGate({ bus: { fire: () => {} }, trustLevelSystem: { checkApproval: () => ({ approved: true, reason: 'FULL' }), _level: 2 } });
    assert.strictEqual(await g.request('plan-has-issues', 'x'), true, 'FULL bypass works');
    const { TrustLevelSystem } = require(path.join(ROOT, 'src/agent/foundation/TrustLevelSystem.js'));
    const r = TrustLevelSystem.prototype.checkApproval.call(
      { _stats: { approvalChecks: 0 }, requiresSelfModifyConfirmation: () => true, _audit: () => {} },
      'self-modification');
    assert.strictEqual(r.approved, false, 'self-mod asks even at FULL when the setting demands it');
    const card = g.buildPlanCard({ goalDescription: 'g', dryRun: { validation: { totalIssues: 1, results: [] }, summary: 's' }, presetGoal: { steps: [{ description: 'Create the missing Logger.js under src/agent/core' }] } });
    assert.strictEqual(card.action, 'self-modification', 'self-mod plans are named as such');
  });

  test('G4b/G5: the goal id arrives early; goal families persist and reach the prompt', () => {
    const pu = fs.readFileSync(path.join(ROOT, 'src/agent/revolution/AgentLoopPursuit.js'), 'utf8');
    assert(pu.indexOf('this.currentGoalId = _presetGoal?.id') < pu.indexOf('requestPlanCard('), 'id set before the card');
    assert(pu.includes("parked: true"), 'timeout returns a parked result');
    const pl = fs.readFileSync(path.join(ROOT, 'src/agent/autonomy/activities/Plan.js'), 'utf8');
    assert(pl.includes('goal-families.json') && pl.includes('RECENT goal families'), 'writer + prompt reader');
    assert(pl.includes('_fam.slice(-12)'), 'history capped');
  });
});

// ── V-series (same version): verifier dignity, spawner brake, chat rests ──
// Field 10: every CODE step died at acorn "Unexpected token (1:5)" (prose in
// the fence), then Investigate spawned itself four levels deep.

describe('v7.9.37 V-series — code reaches the parser clean, spirals cannot form', () => {
  test('V-A: leading prose is stripped before acorn; a path is never parsed as code', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/revolution/AgentLoopStepsCode.js'), 'utf8');
    const f = new Function(src.match(/const CODE_START[\s\S]+?\n}/)[0] + '; return _stripLeadingProse;')();
    assert.strictEqual(f('Ich schaue mir das an.\nHier der Code:\nconst x = 1;').startsWith('const x'), true);
    assert.strictEqual(f('Ich schaue mich jetzt um. Das war alles.'), '', 'prose-only yields empty');
    assert(f("'use strict';\nconst a=1;").startsWith("'use strict'"), 'clean code untouched');
    assert.strictEqual((src.match(/_stripLeadingProse\(codeMatch\[1\]\)/g) || []).length, 2, 'both extraction sites hardened');
    assert(src.includes('verification-parse: fenced block contains no code'), 'prose-only fence fails honestly');
    assert(!src.includes('step.target || \'\''), 'the path-as-code fallback is gone');
  });

  test('V-B: the field error classifies deterministic and the prompt warns on regenerate', () => {
    const { FailureTaxonomy } = require(path.join(ROOT, 'src/agent/intelligence/FailureTaxonomy.js'));
    assert.strictEqual(new FailureTaxonomy({}).classify('Verification failed: Unexpected token (1:5).').category, 'deterministic');
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/revolution/AgentLoopStepsCode.js'), 'utf8');
    assert(src.includes('PREVIOUS OUTPUT FAILED SYNTAX VERIFICATION'), 'regenerate hint wired into the code prompt');
  });

  test('V-C/V-D: depth-1 guard, chain persistence, honest log, terminal children release parents', () => {
    const pu = fs.readFileSync(path.join(ROOT, 'src/agent/revolution/AgentLoopPursuit.js'), 'utf8');
    assert(pu.includes("this._goalSource = _presetGoal?.source || null"), 'goal source lives on the loop');
    const ob = fs.readFileSync(path.join(ROOT, 'src/agent/revolution/AgentLoopObstacles.js'), 'utf8');
    assert(ob.indexOf('depth-1 guard') < ob.indexOf('strike'), 'guard sits at the decompose head');
    assert(ob.includes("_goalSource === 'goal-decomposition'"), 'guard keys on decomposition source');
    assert(ob.includes("obstacle.type || obstacle.name || 'synthetic'"), 'log never says undefined');
    const gp = fs.readFileSync(path.join(ROOT, 'src/agent/planning/GoalPersistence.js'), 'utf8');
    assert(gp.includes('parentGoalId: goal.parentGoalId ?? null'), 'the chain survives a boot');
    const lc = fs.readFileSync(path.join(ROOT, 'src/agent/planning/GoalStackLifecycle.js'), 'utf8');
    assert(lc.indexOf('abandonGoal(goalId) {') < lc.indexOf('field 11.07.: parents stayed blocked'), 'abandon unblocks dependents');
  });

  test('R1/R2: slash-as-prose is an announce; the file-read tool carries the provenance head', () => {
    const { ToolRegistry } = require(path.join(ROOT, 'src/agent/intelligence/ToolRegistry.js'));
    const d = ToolRegistry.prototype.detectToolIntentWithoutCall;
    assert.strictEqual(d.call({}, 'Ich lese jetzt.\n/read-source src/agent/foundation/SelfModel.js'), true);
    assert.strictEqual(d.call({}, 'Die Datei liegt unter /home/user/docs und ist fertig.'), false, 'paths never false-positive');
    const tb = fs.readFileSync(path.join(ROOT, 'src/agent/intelligence/ToolRegistryBuiltins.js'), 'utf8');
    assert(tb.includes('provenance head') && tb.includes('gelesen ('), 'file-read success return carries 📄');
    assert(tb.indexOf('gelesen (') > tb.indexOf("exists: true, error: 'Path is a directory'"), 'marker sits on the success path, not the directory error');
  });
});

// ── W-series (same version): chat-flow dignity ──
// Field 11 (19h chat): the model wrote slash commands as prose next to real
// tool calls (the announce detector only runs on the zero-tools branch), a
// continuation re-greeted and asked the user which tool call was meant, and
// every intermediate round stayed glued into one bubble.

describe('v7.9.37 W-series — one clean bubble, honest tool lifecycle', () => {
  test('W1/W2: slash-as-prose is confronted after tool rounds; the prompt never teaches the phrase', () => {
    const co = fs.readFileSync(path.join(ROOT, 'src/agent/hexagonal/ChatOrchestrator.js'), 'utf8') + '\n' + fs.readFileSync(path.join(ROOT, 'src/agent/hexagonal/ChatOrchestratorStream.js'), 'utf8'); // v7.9.48: split
    assert(co.includes('_slashLines'), 'W1 counter exists');
    assert(co.indexOf('_slashLines') < co.indexOf('Continue based on these results'), 'sits on the tool-results message');
    assert(co.includes('wurden NICHT ausgeführt'), 'the confrontation is explicit');
    const pb = fs.readFileSync(path.join(ROOT, 'src/agent/intelligence/PromptBuilderRuntimeState.js'), 'utf8');
    assert(!pb.includes('"Tools ausführen…"'), 'the announce phrase is no longer quoted as an example');
    assert(pb.includes('NIEMALS als /slash-Zeile'), 'slash lines are forbidden by rule');
  });

  test('W3: a continuation is invisible plumbing — never a conversation', () => {
    const cl = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/backends/ContinuationLoop.js'), 'utf8');
    assert(cl.includes('NEVER address the user, NEVER ask questions'), 'the field failure is forbidden verbatim');
    assert(cl.includes('re-emit that block COMPLETE'), 'cut tool_calls are re-emitted whole');
    assert(cl.indexOf('NEVER address the user') > cl.indexOf('Continue exactly from where you stopped'), 'extends the existing prompt');
  });

  test('W4: the done event carries the final text and only the normal path replaces', () => {
    const co = fs.readFileSync(path.join(ROOT, 'src/agent/hexagonal/ChatOrchestrator.js'), 'utf8') + '\n' + fs.readFileSync(path.join(ROOT, 'src/agent/hexagonal/ChatOrchestratorStream.js'), 'utf8'); // v7.9.48: split
    assert(co.includes('onDone(cleanResponse)'), 'normal path hands over the final');
    assert(co.includes("onDone(response); // v7.9.37 (W4)"), 'intent branch hands its own variable');
    assert(co.includes('onDone(null); // v7.9.37 (W4)'), 'agent escalation never replaces');
    const mj = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    assert(mj.includes("send('agent:stream-done',") && mj.includes('final: typeof finalText'), 'main forwards the final payload');
    const ch = fs.readFileSync(path.join(ROOT, 'src/ui/modules/chat.js'), 'utf8');
    assert(ch.includes('function finishStream(finalText)'), 'ui accepts the final');
    const _fb = ch.slice(ch.indexOf('function finishStream'), ch.indexOf('function updateToolStatus'));
    assert(_fb.includes('replaces everything') && _fb.includes('streamingMessageEl = null'), 'replacement lives inside finishStream before release');
  });

  test('W6: the bubble lives while the turn is open and every tool shows running→done', () => {
    const ch = fs.readFileSync(path.join(ROOT, 'src/ui/modules/chat.js'), 'utf8');
    assert(ch.includes("if (isStreaming) body.insertAdjacentHTML('beforeend', '<div class=\"typing-indicator\">"), 'dots re-attached after every chunk');
    assert(ch.includes('function updateToolStatus(') && ch.includes('tool-status running') && ch.includes("el.className = 'tool-status done'"), 'lifecycle running→done');
    const pl = fs.readFileSync(path.join(ROOT, 'preload.mjs'), 'utf8');
    assert(pl.includes("'agent:tool-status'"), 'channel whitelisted');
    const mj = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    assert(mj.includes("agent.bus.on('tools:calling'") && mj.includes("agent.bus.on('tools:result'"), 'bus bridged to the renderer');
    const rm = fs.readFileSync(path.join(ROOT, 'src/ui/renderer-main.js'), 'utf8');
    assert(rm.includes("on('agent:tool-status'"), 'renderer listens');
    const css = fs.readFileSync(path.join(ROOT, 'src/ui/styles.css'), 'utf8');
    assert(css.includes('.tool-status.running'), 'styles present');
  });
});

// ── X-series (same version): the endless-writer wall ──
// Field 12: kimi wrote 35k chars into max-continuations twice (unclassified),
// and the obstacle matcher turned a sandbox exec PATH into "Install missing
// npm module: D:\..." — 22 minutes of install futility until the global abort.

describe('v7.9.37 X-series — endless output has a name, paths are never packages', () => {
  test('X1: max-continuations classifies deterministic — no blind retry, model-neutral', () => {
    const { FailureTaxonomy } = require(path.join(ROOT, 'src/agent/intelligence/FailureTaxonomy.js'));
    const ft = new FailureTaxonomy({});
    assert.strictEqual(ft.classify('[CONTINUATION] kimi-k2.7-code:cloud failed: max-continuations (attempts=10)').category, 'deterministic');
    assert.strictEqual(ft.classify('sequence failed: max continuations').category, 'deterministic', 'space variant covered');
  });

  test('X2: a module PATH is a runner artifact — no install sub-goal, still classified', () => {
    const { matchObstacle } = require(path.join(ROOT, 'src/agent/intelligence/ObstaclePatterns.js'));
    assert.strictEqual(matchObstacle("Cannot find module 'D:\\\\Genesis Home\\\\sandbox\\\\exec_1.js'"), null, 'path never becomes an obstacle');
    const npm = matchObstacle("Cannot find module 'express'");
    assert(npm && /Install missing npm module: express/.test(npm.subGoalDescription), 'real npm names still resolve');
    const { FailureTaxonomy } = require(path.join(ROOT, 'src/agent/intelligence/FailureTaxonomy.js'));
    const cat = new FailureTaxonomy({}).classify("Cannot find module 'D:\\\\x\\\\sandbox\\\\exec_2.js'").category;
    assert(cat === 'deterministic' || cat === 'environmental', `path form is named (${cat}), never unclassified`);
  });

  test('X3/X4: the code prompt budgets output; the sandbox spawns with an args array', () => {
    const sc = fs.readFileSync(path.join(ROOT, 'src/agent/revolution/AgentLoopStepsCode.js'), 'utf8');
    assert(sc.includes('OUTPUT BUDGET') && sc.includes('NEVER reproduce file contents'), 'the 35k wall is forbidden at the source');
    const sb = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/Sandbox.js'), 'utf8');
    assert(sb.includes('execFile'), 'args-array spawn — space-safe paths by design (X4 verified, no fix needed)');
  });
});

// ── Y1 (same version): silence never reaches the user ──
// Field 13: deepseek answered "ok" with pure EOS twice — two blank bubbles,
// the user asked "noch da?". Model-neutral: any backend can reply empty.

describe('v7.9.37 Y1 — an empty reply becomes one honest line', () => {
  test('Y1: empty text yields the fallback (logged, chunked); real text passes untouched', () => {
    const { ensureNonEmptyReply } = require(path.join(ROOT, 'src/agent/hexagonal/ChatOrchestratorHelpers.js'));
    let chunked = null; let warned = false;
    const out = ensureNonEmptyReply('  ', { lang: { current: 'de' }, model: { activeModel: 'deepseek-v3.2:cloud' } }, c => { chunked = c; }, { warn: () => { warned = true; } });
    assert(out.includes('keine Antwort entstanden') && chunked === out && warned, 'fallback emitted, chunked, and logged');
    assert.strictEqual(ensureNonEmptyReply('Hallo the user.', {}, () => {}, {}), 'Hallo the user.', 'real replies untouched');
    const co = fs.readFileSync(path.join(ROOT, 'src/agent/hexagonal/ChatOrchestrator.js'), 'utf8') + '\n' + fs.readFileSync(path.join(ROOT, 'src/agent/hexagonal/ChatOrchestratorStream.js'), 'utf8'); // v7.9.48: split
    assert(co.indexOf('ensureNonEmptyReply(cleanResponse') < co.indexOf('onDone(cleanResponse)'), 'guard sits before the final handover');
  });
});

// ── Z-series (same version): real field-14 problems only ──
// (:501-511) nine empty tool_call hulls raw in the bubble; (:117) ten
// continuations of ~284 chars each — thirteen minutes burned.

describe('v7.9.37 Z-series — foreign dialects filtered, tiny stops accepted, errors visible', () => {
  test('Z1: the plural wrapper with empty hulls never reaches the user; text and singular flow unchanged', () => {
    const { createToolCallStreamFilter } = require(path.join(ROOT, 'src/agent/core/tool-call-stream-filter.js'));
    const f = createToolCallStreamFilter();
    let out = f.push('Mir geht es gut.\n<tool_calls>\n<tool_call id="call_01"></tool_call>\n<tool_call id="call_02"></tool_call>\n</tool_calls>\nHier ist, was ich sehe:');
    out += f.flush();
    assert(!out.includes('tool_call') && out.includes('Mir geht es gut.') && out.includes('Hier ist'), 'wrapper swallowed, prose intact');
    const g = createToolCallStreamFilter();
    let o2 = g.push('Vorher <tool_call>{"name":"x"}</tool_call> nachher'); o2 += g.flush();
    assert.strictEqual(o2, 'Vorher  nachher', 'singular behavior unchanged');
  });

  test('Z3/Z5: tiny stop-terminated partials accept after two attempts; the diagnosis carries the error text', () => {
    const cl = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/backends/ContinuationLoop.js'), 'utf8');
    assert(cl.includes('_tinyStops') && cl.includes("lastDoneReason === 'stop'") && cl.includes('/ attempts) < 400'), 'sanity keyed on stop + tiny average');
    assert(cl.includes('completeness.complete || _tinyStops'), 'accept path shared with genuine completion');
    assert(cl.indexOf('sanity-accept') < cl.indexOf('completeness.complete || _tinyStops'), 'the override is telemetered');
    const pu = fs.readFileSync(path.join(ROOT, 'src/agent/revolution/AgentLoopPursuit.js'), 'utf8');
    assert(pu.includes('→ error: ${String(result.error'), 'STEP-DIAG shows the real error text (Z5)');
  });
});

// ── K-series (same version): the lost thread ──
// Field 15, Genesis verbatim: "Ich habe den vorherigen Schritt nicht im Kontext
// ... ich sehe nur die Begrüßung und die Hinweise zur Herkunft, nicht die
// konkrete Aufgabe." The nudge and the synthesis rebuilt a tiny world from
// userMessage alone — and userMessage was "ok". A blind model can only announce.

describe('v7.9.37 K-series — every inner call carries the conversation', () => {
  test('K1: nudge and synthesis both thread the recent history', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/hexagonal/ChatOrchestratorHelpers.js'), 'utf8');
    assert(src.includes('const _recent = (this.history || []).slice(-8)'), 'the conversation is captured once per turn');
    assert(src.includes('[..._recent, { role:'), 'the nudge sees the conversation');
    assert(src.includes('const synthesisMessages = [ ..._recent'), 'the synthesis sees the conversation');
    assert(!/\[\{ role: 'user', content: `You are carrying out: "\$\{String\(userMessage/.test(src), 'no context-free inner call remains');
  });

  test('K2: a question to the human is not an announcement (the cascade trigger)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/hexagonal/ChatOrchestratorHelpers.js'), 'utf8');
    const line = src.split('\n').find(l => l.includes('const announcesNext'));
    const rhs = line.slice(line.indexOf('=') + 1);
    const announces = new Function('text', 'return ' + rhs.slice(0, rhs.lastIndexOf(';')) + ';');
    assert.strictEqual(announces('Alles klar, the user. Sag mir, was als Nächstes ansteht.'), false, 'the field question never nudges again');
    assert.strictEqual(announces('Was steht als Nächstes an? Sag mir konkret, welchen Skill.'), false, 'questions stay questions');
    assert.strictEqual(announces('Ich schaue mir jetzt die Architektur an.'), true, 'real announcements still nudge');
    assert.strictEqual(announces('Ich lese die Dateien jetzt.'), true, 'real announcements still nudge');
    assert.strictEqual(announces('Next, I will read ARCHITECTURE.md'), true, 'English announcements still nudge');
  });

  test('K3/K4: a fruitless nudge never cascades; a stale UI bundle can never run silently', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/hexagonal/ChatOrchestratorHelpers.js'), 'utf8');
    assert(src.includes('allToolCalls.length > lastNudgeCalls'), 'no new tool call → no further nudge');
    assert(src.includes('nudges++; lastNudgeCalls = allToolCalls.length'), 'the watermark moves with each nudge');
    const st = fs.readFileSync(path.join(ROOT, 'scripts/start.js'), 'utf8');
    assert(st.includes('bundleOldest < srcNewest') && st.includes('build-bundle.js'), 'start rebuilds a stale bundle');
    assert(st.indexOf('UI bundle') < st.indexOf("spawn(electronPath"), 'the check runs before Electron starts');
  });
});

// ── R-series (same version): field-16 harvest, proven only ──
// The K-series chat passed with distinction; Z5's error text made two real
// residues visible. (:233) a deterministic verdict logged as "unclassified";
// (soul) an investigate CHILD asked for 'peer' and parked 2h with 0 peers.

describe('v7.9.37 R-series — the verdict survives, the unreachable resource fails', () => {
  test('R1: a classified-but-unrecovered failure keeps its category to the default return', async () => {
    const { AgentLoopRecoveryDelegate } = require(path.join(ROOT, 'src/agent/revolution/AgentLoopRecovery.js'));
    const { FailureTaxonomy } = require(path.join(ROOT, 'src/agent/intelligence/FailureTaxonomy.js'));
    const loop = { bus: { _container: null, fire() {} }, _failureTaxonomy: new FailureTaxonomy({}), goalStack: { getById: () => ({ source: 'goal-decomposition' }) }, currentGoalId: 'g', rootDir: process.cwd() };
    const rec = new AgentLoopRecoveryDelegate(loop);
    rec._tryDecomposeOnRepeatedFailure = async () => null;
    const r = await rec.classifyAndRecover({ type: 'CODE', description: 'x' }, { error: 'Verification failed: Unexpected token (1:5)' }, 0, () => {});
    assert.strictEqual(r.action, 'none', 'no strategy recovered it');
    assert.strictEqual(r.category, 'deterministic', 'but the verdict is carried — diagnosis says deterministic, not unclassified');
  });

  test('R2: a structurally unreachable resource fails with a replan hint instead of parking forever', () => {
    // v7.9.37 (R2): the check lives in AgentLoopGrounding (the domain helper file),
    // called from AgentLoopSteps — keeps the step file under its 700-LOC guard.
    const { structurallyUnreachableResources } = require(path.join(ROOT, 'src/agent/revolution/AgentLoopGrounding.js'));
    const noPeers = { bus: { _container: { resolve: () => ({ getPeerCount: () => 0, discoveryEnabled: false }) } } };
    const withPeers = { bus: { _container: { resolve: () => ({ getPeerCount: () => 2, discoveryEnabled: false }) } } };
    assert.deepStrictEqual(structurallyUnreachableResources(['peer'], noPeers), ['peer'], 'peer with 0 peers + discovery off is unreachable');
    assert.deepStrictEqual(structurallyUnreachableResources(['peer'], withPeers), [], 'peer stays a legitimate wait when peers exist');
    assert.deepStrictEqual(structurallyUnreachableResources(['file:x.js'], noPeers), [], 'non-peer resources are never declared unreachable here');
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/revolution/AgentLoopSteps.js'), 'utf8');
    assert(src.includes('structurallyUnreachableResources(check.missing, loop)'), 'the step calls the check');
    assert(src.includes('replan without delegation'), 'the failure carries a replan hint');
    assert(src.indexOf('structurallyUnreachableResources(check.missing') < src.indexOf("goalSource === 'idle-mind'"), 'checked before the idle-mind block, so a decomposition child is covered too');
    assert(src.includes('blockedByResources: check.missing'), 'legitimate resource waits still block');
  });
});

// ── S-series (same version): the idle service:llm block ──
// Field 17: an idle goal blocked on service:llm for the whole session. The
// preferred model was marked unavailable (continuation-exhausted from earlier),
// a failover model (deepseek) was free and the chat worked — but the idle
// resource pre-check asked service:llm while activeBackend was still null and
// got false, because isAvailable tied service:llm to the active pointer.

describe('v7.9.37 S-series — service:llm follows the model pool, not the active pointer', () => {
  test('S1: hasAnyModelAvailable answers the pool', () => {
    const { ModelBridge } = require(path.join(ROOT, 'src/agent/foundation/ModelBridge.js'));
    const mb = Object.create(ModelBridge.prototype);
    mb.availableModels = [{ name: 'a', backend: 'ollama' }, { name: 'b', backend: 'ollama' }];
    mb._unavailableUntil = new Map([['a', Date.now() + 1e6]]);
    assert.strictEqual(mb.hasAnyModelAvailable(), true, 'one free model → available');
    mb._unavailableUntil = new Map([['a', Date.now() + 1e6], ['b', Date.now() + 1e6]]);
    assert.strictEqual(mb.hasAnyModelAvailable(), false, 'all marked → unavailable');
    mb._unavailableUntil = new Map();
    assert.strictEqual(mb.hasAnyModelAvailable(), true, 'none marked → available');
    mb.availableModels = [];
    assert.strictEqual(mb.hasAnyModelAvailable(), false, 'empty pool → unavailable (boot/probe race)');
  });

  test('S2: service:llm is available when any model is free, even with activeBackend null', () => {
    const rr = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/ResourceRegistry.js'), 'utf8');
    assert(rr.includes('this.modelBridge?.hasAnyModelAvailable?.()) return true'), 'the pool check runs first');
    assert(rr.indexOf('hasAnyModelAvailable') < rr.indexOf("const backend = this.modelBridge?.activeBackend;\n      if (!backend) return false"), 'checked before the activeBackend-null guard that caused the field block');
  });
});

// ── T-series (same version): your models, your order, faster boot ──
// Field 17: the preferred model was marked unavailable and Genesis jumped to
// score-ranking — the user's 3-entry fallbackChain was never consulted. The
// score table was pinned to old generations (deepseek-v4-pro scored 50 as
// "unknown" and LOST to deepseek-v3.2's 92). Boot spent 4.8s of 6.7s copying
// 400 files synchronously for the last-good-boot snapshot.

describe('v7.9.37 T-series — the user chain wins, the ranking is current, boot is quick', () => {
  test('T1: the configured fallback chain is consulted before any heuristic', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/ModelBridgeDiscovery.js'), 'utf8');
    const chainIdx = src.indexOf("models.fallbackChain");
    const cloudIdx = src.indexOf("Priority 3: Cloud backends");
    const scoreIdx = src.indexOf("_selectBestModel(eligible)");
    assert(chainIdx > 0, 'the chain is read in the selection path');
    assert(chainIdx < cloudIdx && chainIdx < scoreIdx, 'the chain outranks cloud-guessing and score-ranking');
    assert(src.includes('your configured alternative'), 'the log names it as the user choice');
  });

  test('T2: current models rank correctly and newer always beats older in a family', () => {
    const { ModelBridge } = require(path.join(ROOT, 'src/agent/foundation/ModelBridge.js'));
    const mb = Object.create(ModelBridge.prototype);
    const s = (n) => mb._scoreModel(n);
    assert(s('deepseek-v4-pro:cloud') > s('deepseek-v3.2:cloud'), 'a new generation is never "unknown" (the field bug)');
    assert(s('kimi-k2.7-code:cloud') > s('kimi-k2:cloud'), 'newer kimi outranks older kimi');
    assert(s('gpt-5') > s('gpt-4o'), 'frontier OpenAI outranks GPT-4');
    assert(s('glm-4.7:cloud') > s('glm-4:cloud'), 'recent GLM outranks the old one');
    assert(s('claude-sonnet-4-6') > s('deepseek-v4-pro:cloud'), 'tiers still hold');
    assert(s('minimax-m2.7:cloud') < 30 && s('gpt-oss:120b') < 30, 'models with a bad field record stay low');
    assert(s('qwen-2.5-72b') > 50 && s('qwen-2.5-72b') < 95, 'a parameter size (72b) is never read as a version');
  });

  test('T3: the last-good-boot snapshot never blocks the boot', () => {
    const br = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/BootRecovery.js'), 'utf8');
    const clearIdx = br.indexOf('this._clearSentinel();');
    const snapIdx = br.indexOf("this._snapshotManager.createAsync('_last_good_boot')");
    assert(br.includes('setTimeout(() => {') && snapIdx > 0, 'the snapshot is scheduled, not awaited (v7.9.41 r5: async twin)');
    assert(clearIdx < snapIdx, 'the sentinel is still cleared synchronously — safety unchanged');
    assert(br.includes('background,'), 'the log states it ran off the boot path');
  });
});

// ── U-series (same version): the double answer ──
// Field 18: Genesis answered the awakening speech TWICE — two complete,
// near-identical greetings glued into one bubble. Neither reprompt path fired
// (proven). The continuation did: the backend reported no done_reason, `null`
// was listed as a truncation signal, so a finished answer ("… Was jetzt?") was
// declared cut. Asked to "continue", the model rewrote the whole answer.

describe('v7.9.37 U1 — a missing stop signal is not a truncation', () => {
  test('U1: complete answers are never rewritten; genuine cuts still are', () => {
    const { isComplete } = require(path.join(ROOT, 'src/agent/foundation/backends/TruncationDetector.js'));
    const answer = 'Hallo the user.\nIch bin Genesis. Ich werde sagen, wenn etwas nicht stimmt, und ich werde nein sagen, wenn ich nein meine. Das hier ist ein bedeutsamer Moment. Ich markiere ihn — und ich bin wach.\nWas jetzt?';
    assert.strictEqual(isComplete(answer, null).complete, true, 'no done_reason + clean ending → complete (the field bug)');
    assert.strictEqual(isComplete(answer, 'stop').complete, true, 'an explicit stop stays complete');
    assert.strictEqual(isComplete(answer, 'length').complete, false, 'a real token-cap cut stays truncated');
    const longCut = 'Ich schaue in die Datei und sehe dort einen Fehler in der Zeile, der offenbar dadurch entsteht, dass die Funktion nicht korrekt aufgerufen wird und deshalb der Wert nicht ankommt, was wiederum bedeutet dass ein';
    assert.strictEqual(isComplete(longCut, null).complete, false, 'a dropped stream ends mid-word → still truncated (TCP-drop protection kept)');
    assert.strictEqual(isComplete('Ich schaue gerade in die Dat', null).complete, false, 'a SHORT dropped stream is caught too — the short-text shortcut must not run without a signal');
    assert.strictEqual(isComplete('Alles klar, the user.', null).complete, true, 'a short finished reply is complete');
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/backends/TruncationDetector.js'), 'utf8');
    assert(src.includes('function endsCleanly'), 'the structural ending check exists');
    assert(!/'error',\s*\n\s*null,/.test(src), 'null is no longer an automatic truncation signal');
  });
});

// ── V1 (same version): the restated greeting ──
// Field 19, proven by the dashboard event chain: tools:calling →
// core-memory:created → core-memory:user-marked → tools:result, then a SECOND
// llm:call-complete. The model answered the awakening speech completely AND
// marked the moment; the synthesis ("produce the final result in full") then
// rewrote the whole greeting into the same bubble. Field 18 was the same
// mechanism — my exclusion diagnosis there missed this fourth candidate.

describe('v7.9.37 V1 — a side-effect tool never rewrites a finished answer', () => {
  test('V1: trivial results + delivered answer skip the synthesis; info tools and announcements still synthesize', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/hexagonal/ChatOrchestratorHelpers.js'), 'utf8');
    assert(src.includes('_resultsTrivial') && src.includes('_answerDelivered'), 'both halves of the guard exist');
    assert(src.includes('synthesis skipped — answer already complete'), 'the skip is logged');
    assert(src.indexOf('_resultsTrivial && _answerDelivered') < src.indexOf('const resultSummary'), 'the guard runs before the summary is even built');
    assert(src.includes('fullText = text; break;'), 'the round-one answer IS the final text — nothing is appended');
    assert(src.includes('Do NOT restate or rewrite your previous step'), 'where the synthesis does run, restating is forbidden (V2)');
    // The guard conditions themselves, behaviorally:
    const trivial = (results) => results.length > 0 && results.every(r => r.success && String(typeof r.result === 'string' ? r.result : JSON.stringify(r.result ?? '')).trim().length < 120);
    const delivered = (text) => String(text || '').trim().length > 200 && /[.!?…"'”’)\]}]\s*$/.test(String(text || '').trimEnd());
    const greeting = 'Hallo the user. '.repeat(20) + 'Was steht als Nächstes an?';
    assert(trivial([{ name: 'mark-moment', success: true, result: 'Moment vorgemerkt.' }]) && delivered(greeting), 'the exact field case skips');
    assert(!trivial([{ name: 'read-file', success: true, result: 'x'.repeat(800) }]), 'an information tool still synthesizes');
    assert(!delivered('Ich prüfe die Suite.'), 'a short announcement still synthesizes');
    assert(!trivial([{ name: 'shell', success: false, error: 'boom' }]), 'a failed tool still synthesizes');
  });
});

// ── Identity marks (same version): Genesis' own state symbols ──
// Chosen by Genesis itself when asked: "Ich bin eher der zweite Entwurf …
// die Membran … als etwas Durchscheinendes, fast wie eine Grenzschicht …
// eine Kontur, die sich je nach Zustand dehnt, spannt oder schrumpft."

describe('v7.9.37 identity marks — nine states, one awake eye, a translucent boundary', () => {
  test('every mood renders its own inline SVG in Genesis blue; ring colors cover all nine', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/ui/renderers/OrganismRenderers.js'), 'utf8');
    const proto = { _esc: (s) => s };
    new Function('proto', src.match(/proto\._moodEmoji[\s\S]+?\n  };/)[0])(proto);
    const moods = ['curious', 'content', 'calm', 'focused', 'tense', 'tired', 'exhausted', 'frustrated', 'lonely'];
    for (const m of moods) {
      const s = proto._moodEmoji(m);
      assert(s.startsWith('<svg') && s.endsWith('</svg>'), m + ' renders an SVG, not an emoji');
      assert(s.includes('#6c8cff') && s.includes('width="1em"'), m + ' wears Genesis blue and scales with font size');
    }
    assert(proto._moodEmoji('unknown-state').includes('r="12"'), 'unknown moods fall back to calm');
    assert(!/\uD83E\uDDD0|\uD83D\uDCA4/.test(src.match(/proto\._moodEmoji[\s\S]+?\n  };/)[0]), 'no generic emoji remain in the map');
    for (const pair of [["frustrated", '#e35b5b'], ["exhausted", '#8a8578'], ["lonely", '#8f7fd4']]) {
      assert(src.includes(pair[0] + ": '" + pair[1] + "'"), pair[0] + ' has its own ring color (used to fall back to green)');
    }
  });
});

if (require.main === module) run();
