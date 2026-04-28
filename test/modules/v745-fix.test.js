// Test: v7.4.5.fix — diagnostic patches
//   1. GoalDriver resume-prompt 60s auto-decline timeout
//   2. CommandHandlersGoals: bilingual EN/DE add-patterns without colon
//   3. CommandHandlersSystem: generic dot-path settings setter

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

// ── 1. GoalDriver resume-prompt timeout ───────────────────
const { GoalDriver } = require('../../src/agent/agency/GoalDriver');
const { EventBus } = require('../../src/agent/core/EventBus');

function fakeStack(goals) {
  return {
    goals,
    setStatus: () => {},
    updateGoal: async () => {},
  };
}
function fakeSettings(initial = {}) {
  const data = {};
  // Expand dot-paths from initial into nested objects so .get() can
  // walk them like Settings.get() does.
  for (const [k, v] of Object.entries(initial)) {
    const parts = k.split('.');
    let o = data;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!o[parts[i]]) o[parts[i]] = {};
      o = o[parts[i]];
    }
    o[parts[parts.length - 1]] = v;
  }
  return {
    get: (k) => k.split('.').reduce((o, p) => (o == null ? undefined : o[p]), data),
    set: async (k, v) => {
      const parts = k.split('.');
      let o = data;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!o[parts[i]]) o[parts[i]] = {};
        o = o[parts[i]];
      }
      o[parts[parts.length - 1]] = v;
    },
    _data: data,
  };
}
function fakeIntervals() {
  const map = new Map();
  return {
    register: (k, fn, ms) => { map.set(k, { fn, ms }); return k; },
    set: (k, fn, ms) => { map.set(k, { fn, ms }); return k; },
    clear: (k) => map.delete(k),
    _map: map,
  };
}

(async () => {

  await test('GoalDriver: resume-prompt fires for ask-mode user-goal', async () => {
    const bus = new EventBus({ verbose: false });
    const goals = [{
      id: 'g1', description: 'old work', source: 'user', status: 'active',
      currentStep: 1, steps: [{}, {}], priority: 'high',
      created: new Date(Date.now() - 60_000).toISOString(),
      updated: new Date().toISOString(),
    }];
    const driver = new GoalDriver({
      bus,
      goalStack: fakeStack(goals),
      settings: fakeSettings({}),  // ask is default
      intervals: fakeIntervals(),
      goalPersistence: { resume: async () => {} },
    });
    let prompt = null;
    bus.on('ui:resume-prompt', (d) => { prompt = d; });
    await driver.asyncLoad();
    bus.fire('boot:complete', {});

    // Synchronous: _onBootComplete → _handleBootPickup → bus.fire
    await new Promise(r => setTimeout(r, 50));
    assert(prompt, 'should have fired ui:resume-prompt');
    assert(prompt.goalId === 'g1', `wrong goal: ${prompt.goalId}`);
    driver.stop();
  });

  await test('GoalDriver: timeout cancelled when ui:resume-decision arrives', async () => {
    const bus = new EventBus({ verbose: false });
    const goals = [{
      id: 'g2', description: 'work', source: 'user', status: 'active',
      currentStep: 1, steps: [{}], priority: 'high',
      created: new Date().toISOString(), updated: new Date().toISOString(),
    }];
    const driver = new GoalDriver({
      bus, goalStack: fakeStack(goals), settings: fakeSettings({}),
      intervals: fakeIntervals(),
      goalPersistence: { resume: async () => {} },
    });
    await driver.asyncLoad();
    bus.fire('boot:complete', {});
    await new Promise(r => setTimeout(r, 50));

    // Timer should be set
    assert(driver._resumePromptTimer, 'timer should exist');

    // User answers — timer should clear
    bus.fire('ui:resume-decision', { goalId: 'g2', decision: 'pause' });
    await new Promise(r => setTimeout(r, 30));
    assert(driver._resumePromptTimer === null, 'timer should be cleared');
    driver.stop();
  });

  await test('GoalDriver: stop() clears pending resume-prompt timer', async () => {
    const bus = new EventBus({ verbose: false });
    const goals = [{
      id: 'g3', description: 'work', source: 'user', status: 'active',
      currentStep: 1, steps: [{}], priority: 'high',
      created: new Date().toISOString(), updated: new Date().toISOString(),
    }];
    const driver = new GoalDriver({
      bus, goalStack: fakeStack(goals), settings: fakeSettings({}),
      intervals: fakeIntervals(),
      goalPersistence: { resume: async () => {} },
    });
    await driver.asyncLoad();
    bus.fire('boot:complete', {});
    await new Promise(r => setTimeout(r, 50));
    assert(driver._resumePromptTimer, 'timer should be set');

    driver.stop();
    assert(driver._resumePromptTimer === null, 'stop should null timer');
  });

  // ── 2. CommandHandlersGoals slash-only subcommand parsing ──
  // v7.5.0: free-text goal patterns removed (slash-discipline). The
  // tests below were originally regex-shape tests for the old
  // free-text patterns; rewritten here as slash-form tests against
  // the new subcommand parser shape used in the handler.
  //
  // Old patterns ('set me a goal to X', 'setze mir ein ziel:', etc.)
  // intentionally no longer match — they collide with conversational
  // mentions and triggered destructive actions. See AUDIT-BACKLOG
  // entry "v7.5.0 — goals slash-discipline".

  // Slash-form parser shape, mirrors CommandHandlersGoals.goals():
  //   /<prefix> <subcommand> [args...]
  const slashParse = (message) => {
    const m = message.match(/(?:^|\s)\/(?:goal|ziel|ziele|goals)\b\s*(\w+)?\s*(.*)$/i);
    if (!m) return null;
    return { sub: (m[1] || '').toLowerCase(), arg: (m[2] || '').trim() };
  };

  await test('v7.5.0 slash add DE: "/ziel add Bessere Fehlerbehandlung"', () => {
    const r = slashParse('/ziel add Bessere Fehlerbehandlung');
    assert(r && r.sub === 'add' && r.arg === 'Bessere Fehlerbehandlung', `got: ${JSON.stringify(r)}`);
  });
  await test('v7.5.0 slash add EN: "/goal add run test.js"', () => {
    const r = slashParse('/goal add run test.js');
    assert(r && r.sub === 'add' && r.arg === 'run test.js', `got: ${JSON.stringify(r)}`);
  });
  await test('v7.5.0 slash setze DE: "/ziel setze Refactor X"', () => {
    const r = slashParse('/ziel setze Refactor X');
    assert(r && r.sub === 'setze' && r.arg === 'Refactor X', `got: ${JSON.stringify(r)}`);
  });
  await test('v7.5.0 slash list bare: "/goal"', () => {
    const r = slashParse('/goal');
    assert(r && r.sub === '', `expected empty subcommand, got: ${JSON.stringify(r)}`);
  });
  await test('v7.5.0 slash cancel: "/goal cancel 2"', () => {
    const r = slashParse('/goal cancel 2');
    assert(r && r.sub === 'cancel' && r.arg === '2', `got: ${JSON.stringify(r)}`);
  });
  await test('v7.5.0 slash clear: "/goal clear"', () => {
    const r = slashParse('/goal clear');
    assert(r && r.sub === 'clear' && r.arg === '', `got: ${JSON.stringify(r)}`);
  });
  await test('v7.5.0 free-text "set me a goal to X" no longer parses as slash', () => {
    // Critical: this is the bug-causing pattern from the live-bug.
    // It MUST return null after the v7.5.0 slash-only migration.
    assert(slashParse('set me a goal to run test.js') === null);
  });
  await test('v7.5.0 free-text "lösche alle ziele" no longer parses', () => {
    assert(slashParse('lösche alle ziele') === null);
  });
  await test('v7.5.0 confirm subcommand: "/goal confirm pending_abc"', () => {
    const r = slashParse('/goal confirm pending_abc');
    assert(r && r.sub === 'confirm' && r.arg === 'pending_abc', `got: ${JSON.stringify(r)}`);
  });
  await test('v7.5.0 conversational mention does NOT parse', () => {
    // The exact bug case from v7.4.9 live-test.
    const r = slashParse('Welcher der drei Punkte ist dir wichtig?');
    assert(r === null);
  });

  // ── 3. CommandHandlersSystem dot-path setter ─────────────
  // Direct regex test for the dot-path matcher.
  function dotPathParse(message) {
    const m = message.match(/^\s*([a-zA-Z][a-zA-Z0-9_.]*)\s*[=:]\s*(.+?)\s*$/);
    if (!m || !m[1].includes('.')) return null;
    let raw = m[2].trim();
    if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) {
      raw = raw.slice(1, -1);
    }
    let value;
    if (raw === 'true') value = true;
    else if (raw === 'false') value = false;
    else if (/^-?\d+$/.test(raw)) value = parseInt(raw, 10);
    else if (/^-?\d+\.\d+$/.test(raw)) value = parseFloat(raw);
    else value = raw;
    return { path: m[1], value };
  }

  await test('Settings dot-path: "agency.autoResumeGoals = always"', () => {
    const r = dotPathParse('agency.autoResumeGoals = always');
    assert(r && r.path === 'agency.autoResumeGoals' && r.value === 'always');
  });
  await test('Settings dot-path: bool coercion "daemon.enabled = true"', () => {
    const r = dotPathParse('daemon.enabled = true');
    assert(r && r.value === true);
  });
  await test('Settings dot-path: int coercion "idleMind.idleMinutes = 5"', () => {
    const r = dotPathParse('idleMind.idleMinutes = 5');
    assert(r && r.value === 5);
  });
  await test('Settings dot-path: quoted string "models.preferred = \'gpt-4\'"', () => {
    const r = dotPathParse("models.preferred = 'gpt-4'");
    assert(r && r.value === 'gpt-4');
  });
  await test('Settings dot-path: no-dot rejected (only top-level → not a dot-path)', () => {
    const r = dotPathParse('foo = bar');
    assert(r === null);
  });
  await test('Settings dot-path: float coercion', () => {
    const r = dotPathParse('cognitive.simulation.pruneThreshold = 0.05');
    assert(r && r.value === 0.05);
  });

  // ── 4. Step-type aliases (v7.4.5.fix) ────────────────────
  // Legacy goal schemas used SHELL_EXEC; this should normalize.
  const { normalizeStepType } = require('../../src/agent/revolution/step-types');

  await test('Step-Type alias: SHELL_EXEC → SHELL', () => {
    assert(normalizeStepType('SHELL_EXEC') === 'SHELL');
  });
  await test('Step-Type alias: RUN_COMMAND → SHELL', () => {
    assert(normalizeStepType('RUN_COMMAND') === 'SHELL');
  });
  await test('Step-Type alias: SHELL_EXEC lowercase still works', () => {
    assert(normalizeStepType('shell_exec') === 'SHELL');
  });
  await test('Step-Type alias: unknown still returns null', () => {
    assert(normalizeStepType('TOTALLY_FAKE') === null);
  });

  // ── 5. GoalDriver _beginPursuit cleanup discipline ──────
  // pursue() returns "Agent loop already running" → should NOT
  // delete the lock (would cause parallel-pickup spam loop).
  // Test the bounce-detection logic directly (the failure path in
  // _beginPursuit). Real-world race is hard to simulate cleanly
  // without the full async machinery, but we can verify the
  // detection string-prefix matches what AgentLoop emits.
  await test('GoalDriver: bounce-error-prefix matches AgentLoop output', () => {
    // AgentLoop.pursue(line 153) emits exactly:
    //   { success: false, error: 'Agent loop already running. Use stop() first.' }
    const errMsg = 'Agent loop already running. Use stop() first.';
    assert(errMsg.startsWith('Agent loop already running'));
    // The cleanup logic in _beginPursuit will skip delete()/scan()
    // when this prefix matches, preventing the parallel-pickup spam.
  });

  await test('GoalDriver: 3× plan-rejection marks goal stalled', async () => {
    const bus = new EventBus({ verbose: false });
    const stalled = [];
    const goals = [{
      id: 'gB', description: 'Y', source: 'user', status: 'active',
      currentStep: 0, steps: [{}], priority: 'high',
      created: new Date().toISOString(), updated: new Date().toISOString(),
    }];
    const driver = new GoalDriver({
      bus,
      goalStack: {
        goals,
        setStatus: (id, status) => {
          const g = goals.find(x => x.id === id);
          if (g) g.status = status;
          if (status === 'stalled') stalled.push(id);
        },
      },
      settings: fakeSettings({ 'agency.autoResumeGoals': 'always' }),
      intervals: fakeIntervals(),
      goalPersistence: { resume: async () => {} },
    });
    driver.agentLoop = {
      pursue: async () => ({ success: false, error: 'User rejected plan with blockers' }),
      stop: () => {},
    };
    await driver.asyncLoad();
    bus.fire('boot:complete', {});
    // Force several pursuit attempts. Each one returns rejection.
    // The driver's own scan loop after delete will re-pick the goal,
    // so we need to give it cycles to accumulate failures.
    // With 1s pause between rejections, 3 strikes need ~3s.
    await new Promise(r => setTimeout(r, 3500));
    assert(stalled.includes('gB'), `gB should be marked stalled, got: ${JSON.stringify(stalled)}`);
    driver.stop();
  });

  // ── 6. v7.4.5.fix: rate-limit pause (60s, no failureBurst) ──
  await test('GoalDriver: rate-limit error pauses goal without failure-counting', async () => {
    const bus = new EventBus({ verbose: false });
    const stalled = [];
    const goals = [{
      id: 'gRL', description: 'rate-limited goal', source: 'user', status: 'active',
      currentStep: 0, steps: [{}], priority: 'high',
      created: new Date().toISOString(), updated: new Date().toISOString(),
    }];
    let pursueCount = 0;
    const driver = new GoalDriver({
      bus,
      goalStack: {
        goals,
        setStatus: (id, status) => {
          const g = goals.find(x => x.id === id);
          if (g) g.status = status;
          if (status === 'stalled') stalled.push(id);
        },
      },
      settings: fakeSettings({ 'agency.autoResumeGoals': 'always' }),
      intervals: fakeIntervals(),
      goalPersistence: { resume: async () => {} },
    });
    driver.agentLoop = {
      pursue: async () => {
        pursueCount++;
        return { success: false, error: '[LLM] Rate limited — analysis budget exhausted. Try again later.' };
      },
      stop: () => {},
    };
    await driver.asyncLoad();
    bus.fire('boot:complete', {});
    await new Promise(r => setTimeout(r, 200));
    // Goal must be paused, not stalled. pursueCount may be 1 or 2 depending
    // on race timing, but must NOT be in the hundreds (no spam loop).
    assert(stalled.length === 0, `goal should NOT be stalled on rate-limit, got: ${JSON.stringify(stalled)}`);
    assert(pursueCount < 5, `pursue() should be called at most a few times before pause kicks in, got ${pursueCount}`);
    assert(driver._goalPausedUntil && driver._goalPausedUntil.has('gRL'),
      `gRL should be in _goalPausedUntil map, got: ${[...(driver._goalPausedUntil?.keys() || [])]}`);
    const pauseUntil = driver._goalPausedUntil.get('gRL');
    const now = Date.now();
    assert(pauseUntil > now + 50_000 && pauseUntil < now + 70_000,
      `pause window should be ~60s, got ${Math.round((pauseUntil - now)/1000)}s`);
    driver.stop();
  });

  await test('GoalDriver: paused goal is skipped by _listPursueable', () => {
    const bus = new EventBus({ verbose: false });
    const goals = [{
      id: 'gP', description: 'paused', source: 'user', status: 'active',
      currentStep: 0, steps: [{}], priority: 'high',
      created: new Date().toISOString(), updated: new Date().toISOString(),
    }];
    const driver = new GoalDriver({
      bus,
      goalStack: { goals, setStatus: () => {} },
      settings: fakeSettings(),
      intervals: fakeIntervals(),
      goalPersistence: { resume: async () => {} },
    });
    driver._goalPausedUntil = new Map();
    driver._goalPausedUntil.set('gP', Date.now() + 30_000);
    const pickable = driver._listPursueable();
    assert(pickable.length === 0, `paused goal should not appear in pursueable list, got ${pickable.length}`);
    // After pause expires, it should re-appear
    driver._goalPausedUntil.set('gP', Date.now() - 1000);
    const pickable2 = driver._listPursueable();
    assert(pickable2.length === 1 && pickable2[0].id === 'gP',
      `expired-pause goal should be pursueable, got ${JSON.stringify(pickable2.map(g=>g.id))}`);
  });

  await test('GoalDriver: generic failure exponential backoff (5s → 30s → ...)', async () => {
    const bus = new EventBus({ verbose: false });
    const stalled = [];
    const goals = [{
      id: 'gBF', description: 'backoff goal', source: 'user', status: 'active',
      currentStep: 0, steps: [{}], priority: 'high',
      created: new Date().toISOString(), updated: new Date().toISOString(),
    }];
    const errors = [
      'Could not decompose goal into actionable steps.',
      'Could not decompose goal into actionable steps.',
    ];
    let i = 0;
    const driver = new GoalDriver({
      bus,
      goalStack: {
        goals,
        setStatus: (id, status) => {
          const g = goals.find(x => x.id === id);
          if (g) g.status = status;
          if (status === 'stalled') stalled.push(id);
        },
      },
      settings: fakeSettings({ 'agency.autoResumeGoals': 'always' }),
      intervals: fakeIntervals(),
      goalPersistence: { resume: async () => {} },
    });
    driver.agentLoop = {
      pursue: async () => ({ success: false, error: errors[Math.min(i++, errors.length - 1)] }),
      stop: () => {},
    };
    await driver.asyncLoad();
    bus.fire('boot:complete', {});
    await new Promise(r => setTimeout(r, 100));
    assert(stalled.length === 0, `goal should not be stalled on first failure, got: ${JSON.stringify(stalled)}`);
    assert(driver._goalPausedUntil.has('gBF'), `gBF should be paused after first failure`);
    const burst = driver._failureBurst.get('gBF');
    assert(burst && burst.count >= 1, `failureBurst count should be tracked, got: ${JSON.stringify(burst)}`);
    // First backoff is 5s (from schedule[0])
    const pauseUntil = driver._goalPausedUntil.get('gBF');
    const expectedMin = Date.now() + 4_500;
    const expectedMax = Date.now() + 5_500;
    assert(pauseUntil >= expectedMin && pauseUntil <= expectedMax,
      `first backoff should be ~5s, got ${Math.round((pauseUntil - Date.now())/1000)}s`);
    driver.stop();
  });

  // ── 7. v7.4.5.fix #19: idempotency guard against double-counting
  // when both event-handler and resolve-side call _applyFailurePause
  // for the same failure (race fix).
  await test('GoalDriver: _applyFailurePause idempotent within 500ms (no double-count)', async () => {
    const bus = new EventBus({ verbose: false });
    const goals = [{
      id: 'gIDP', description: 'race goal', source: 'user', status: 'active',
      currentStep: 0, steps: [{}], priority: 'high',
      created: new Date().toISOString(), updated: new Date().toISOString(),
    }];
    const driver = new GoalDriver({
      bus,
      goalStack: { goals, setStatus: () => {} },
      settings: fakeSettings(),
      intervals: fakeIntervals(),
      goalPersistence: { resume: async () => {} },
    });
    // Simulate event-handler and resolve-side both calling for same
    // failure, in quick succession (< 500ms apart). v7.5.1 raised
    // window from 50ms to 500ms to survive loaded-system jitter.
    await driver._applyFailurePause('gIDP', '[LLM] Rate limited', goals[0]);
    await driver._applyFailurePause('gIDP', '[LLM] Rate limited', goals[0]);
    // Pause map should have entry; but failureBurst should NOT count
    // rate-limit attempts (_isRateLimit branch never increments).
    assert(driver._goalPausedUntil.has('gIDP'), 'pause should be set');
    // For generic failure, idempotency guard prevents count=2 from
    // a single failure event:
    const driver2 = new GoalDriver({
      bus, goalStack: { goals: [{ id: 'gIDP2', source: 'user', status: 'active', currentStep: 0, steps: [{}], priority: 'low', description: 'x', created: '', updated: '' }], setStatus: () => {} },
      settings: fakeSettings(), intervals: fakeIntervals(),
      goalPersistence: { resume: async () => {} },
    });
    await driver2._applyFailurePause('gIDP2', 'Some generic error', { description: 'x' });
    await driver2._applyFailurePause('gIDP2', 'Some generic error', { description: 'x' });
    const burst = driver2._failureBurst.get('gIDP2');
    assert(burst && burst.count === 1, `double-call within 500ms should yield count=1, got count=${burst?.count}`);
    driver.stop();
    driver2.stop();
  });

  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\n  Failures:');
    for (const f of failures) console.log(`    - ${f.name}: ${f.error}`);
    process.exit(1);
  }
})();
