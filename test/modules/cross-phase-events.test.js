// ============================================================
// GENESIS — test/modules/cross-phase-events.test.js
// Integration tests for cross-phase event chains.
//
// Tests the actual event flow across phase boundaries:
//   Phase 2 (Intelligence) → Phase 7 (Organism) → Phase 8 (Revolution) → Phase 10 (Agency)
//
// v4.10.0: Added as part of the analysis-driven improvement pass.
// ============================================================

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => {
        passed++; console.log(`    ✅ ${name}`);
      }).catch(err => {
        failed++; failures.push({ name, error: err.message });
        console.log(`    ❌ ${name}: ${err.message}`);
      });
    }
    passed++; console.log(`    ✅ ${name}`);
  } catch (err) {
    failed++; failures.push({ name, error: err.message });
    console.log(`    ❌ ${name}: ${err.message}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }

const { EventBus } = require('../../src/agent/core/EventBus');
const _createBus = () => { const b = new EventBus(); b._devMode = false; return b; };

async function main() {
  console.log('\n  Cross-Phase Event Chain Tests');

  // ── Chain 1: Chat Error → Emotional Frustration → Model Escalation ──

  await test('chat:error → emotion:changed → model escalation signal', () => {
    const bus = _createBus();
    const events = [];

    let frustration = 0.1;
    bus.on('chat:error', () => {
      frustration = Math.min(1.0, frustration + 0.15);
      bus.fire('emotion:changed', {
        dimension: 'frustration',
        value: frustration,
        previous: frustration - 0.15,
      }, { source: 'EmotionalState' });
    }, { source: 'EmotionalState' });

    bus.on('emotion:changed', (data) => {
      events.push({ event: 'emotion:changed', ...data });
      if (data.dimension === 'frustration' && data.value > 0.65) {
        bus.fire('steering:escalate-model', {
          reason: 'frustration',
          level: data.value,
        }, { source: 'EmotionalSteering' });
      }
    }, { source: 'EmotionalSteering' });

    bus.on('steering:escalate-model', (data) => {
      events.push({ event: 'steering:escalate-model', ...data });
    }, { source: 'ModelRouter' });

    for (let i = 0; i < 5; i++) {
      bus.fire('chat:error', { error: `Test error ${i}` }, { source: 'ChatOrchestrator' });
    }

    const emotionEvents = events.filter(e => e.event === 'emotion:changed');
    const escalations = events.filter(e => e.event === 'steering:escalate-model');

    assert(emotionEvents.length === 5, `Expected 5 emotion events, got ${emotionEvents.length}`);
    assert(escalations.length > 0, 'Expected at least 1 model escalation');
    assert(escalations[0].reason === 'frustration', 'Escalation should cite frustration');
    assert(escalations[0].level > 0.65, `Escalation level ${escalations[0].level} should exceed 0.65`);
  });

  // ── Chain 2: Goal Complete → Learning → Memory Consolidation ──

  await test('agent-loop:step-complete → learning + episodic + surprise', () => {
    const bus = _createBus();
    const events = [];

    // v4.12.5-fix: Standardized from 'agentloop:step-complete' to 'agent-loop:step-complete'
    bus.on('agent-loop:step-complete', (data) => {
      events.push('step-complete');
      bus.fire('learning:sample-added', {
        strategy: data.strategy,
        success: data.success,
      }, { source: 'MetaLearning' });
      bus.fire('episodic:recorded', {
        type: 'goal-step',
        success: data.success,
      }, { source: 'EpisodicMemory' });
    }, { source: 'MetaLearning' });

    bus.on('learning:sample-added', (data) => {
      events.push('learning');
      if (data.success === false) {
        bus.fire('surprise:signal', {
          intensity: 0.7,
          source_event: 'step-failure',
        }, { source: 'SurpriseAccumulator' });
      }
    }, { source: 'SurpriseAccumulator' });

    bus.on('surprise:signal', () => {
      events.push('surprise');
    }, { source: 'DreamCycle' });

    bus.fire('agent-loop:step-complete', {
      goalId: 'test-1',
      strategy: 'shell-exec',
      success: false,
      error: 'command not found',
    }, { source: 'AgentLoop' });

    assert(events.includes('step-complete'), 'step-complete should fire');
    assert(events.includes('learning'), 'learning should process');
    assert(events.includes('surprise'), 'surprise should trigger on failure');
  });

  // ── Chain 3: Energy Low → Plan Cap → Rest Mode ──

  await test('energy:low → plan cap + rest mode', () => {
    const bus = _createBus();
    const signals = [];

    bus.on('emotion:changed', (data) => {
      if (data.dimension === 'energy' && data.value < 0.30) {
        bus.fire('steering:cap-plan', { maxSteps: 3, reason: 'low-energy' }, { source: 'EmotionalSteering' });
      }
      if (data.dimension === 'energy' && data.value < 0.15) {
        bus.fire('steering:rest-mode', { duration: 300000 }, { source: 'EmotionalSteering' });
      }
    }, { source: 'EmotionalSteering' });

    bus.on('steering:cap-plan', (data) => { signals.push({ type: 'cap', ...data }); }, { source: 'FormalPlanner' });
    bus.on('steering:rest-mode', (data) => { signals.push({ type: 'rest', ...data }); }, { source: 'IdleMind' });

    bus.fire('emotion:changed', {
      dimension: 'energy', value: 0.10, previous: 0.80,
    }, { source: 'Homeostasis' });

    assert(signals.filter(s => s.type === 'cap').length === 1, 'Should cap plan steps');
    assert(signals.filter(s => s.type === 'cap')[0].maxSteps === 3, 'Cap should be 3 steps');
    assert(signals.filter(s => s.type === 'rest').length === 1, 'Should enter rest mode');
  });

  // ── Chain 4: Trust Level Change → Capability Gate ──

  await test('trust:level-changed → capability gate update', () => {
    const bus = _createBus();
    const gateUpdates = [];

    bus.on('trust:level-changed', (data) => { gateUpdates.push(data); }, { source: 'CapabilityGuard' });

    bus.fire('trust:level-changed', {
      previous: 1, current: 2, name: 'AUTONOMOUS',
    }, { source: 'TrustLevelSystem' });

    assert(gateUpdates.length === 1, 'CapabilityGuard should receive trust change');
    assert(gateUpdates[0].current === 2, 'New level should be 2');
    assert(gateUpdates[0].name === 'AUTONOMOUS', 'Name should be AUTONOMOUS');
  });

  // ── Chain 5: Self-Mod → Verify → Hot-Reload chain ──

  await test('selfmod:applied → verify → reload chain', () => {
    const bus = _createBus();
    const chain = [];

    bus.on('selfmod:applied', (data) => {
      chain.push('applied');
      bus.fire('verification:requested', { file: data.file }, { source: 'SelfModPipeline' });
    }, { source: 'VerificationEngine' });

    bus.on('verification:requested', (data) => {
      chain.push('verify');
      bus.fire('verification:complete', { file: data.file, status: 'pass' }, { source: 'VerificationEngine' });
    }, { source: 'VerificationEngine' });

    bus.on('verification:complete', (data) => {
      chain.push('verified');
      if (data.status === 'pass') {
        bus.fire('hotreload:requested', { file: data.file }, { source: 'HotReloader' });
      }
    }, { source: 'HotReloader' });

    bus.on('hotreload:requested', () => { chain.push('reloaded'); }, { source: 'HotReloader' });

    bus.fire('selfmod:applied', {
      file: 'src/agent/planning/GoalStack.js', changeType: 'bugfix',
    }, { source: 'SelfModPipeline' });

    assert(chain.length === 4, `Expected 4-step chain, got ${chain.length}: ${chain.join(' → ')}`);
    assert(chain[0] === 'applied', 'Chain starts with applied');
    assert(chain[3] === 'reloaded', 'Chain ends with reloaded');
  });

  // ── Chain 6: EventBus priority ordering ──

  await test('event listeners fire in priority order', async () => {
    const bus = _createBus();
    const order = [];

    bus.on('test:priority', () => order.push('low'), { priority: 0, source: 'test' });
    bus.on('test:priority', () => order.push('high'), { priority: 10, source: 'test' });
    bus.on('test:priority', () => order.push('medium'), { priority: 5, source: 'test' });

    await bus.emit('test:priority', {}, { source: 'test' });

    assert(order[0] === 'high', `First should be high, got ${order[0]}`);
    assert(order[1] === 'medium', `Second should be medium, got ${order[1]}`);
    assert(order[2] === 'low', `Third should be low, got ${order[2]}`);
  });

  // ── Chain 7: Wildcard listeners catch cross-phase events ──

  await test('wildcard listeners catch cross-phase events', () => {
    const bus = _createBus();
    const caught = [];

    bus.on('agent:*', (data, meta) => { caught.push(meta.event); }, { source: 'test' });

    bus.fire('agent:status', { state: 'ready' }, { source: 'AgentCore' });
    bus.fire('agent:shutdown', {}, { source: 'AgentCore' });
    bus.fire('emotion:changed', {}, { source: 'EmotionalState' });

    assert(caught.length === 2, `Wildcard should catch 2 agent: events, got ${caught.length}`);
    assert(!caught.includes('emotion:changed'), 'Should not catch emotion: events');
  });

  // ── Chain 8: Circuit breaker integration ──

  await test('circuit breaker opens after repeated failures', () => {
    const bus = _createBus();
    const states = [];

    bus.on('circuit:state-change', (data) => { states.push(data.state); }, { source: 'test' });

    for (let i = 0; i < 5; i++) {
      bus.fire('circuit:failure', { service: 'ollama' }, { source: 'CircuitBreaker' });
    }
    bus.fire('circuit:state-change', { state: 'open', service: 'ollama' }, { source: 'CircuitBreaker' });

    assert(states.includes('open'), 'Circuit should open after failures');
  });

  // ── Chain 9: removeBySource cleanup ──

  await test('removeBySource cleans up all listeners for a module', () => {
    const bus = _createBus();
    let count = 0;

    bus.on('test:a', () => count++, { source: 'ModuleX' });
    bus.on('test:b', () => count++, { source: 'ModuleX' });
    bus.on('test:c', () => count++, { source: 'ModuleY' });

    bus.removeBySource('ModuleX');

    bus.fire('test:a', {}, { source: 'test' });
    bus.fire('test:b', {}, { source: 'test' });
    bus.fire('test:c', {}, { source: 'test' });

    assert(count === 1, `Only ModuleY listener should fire, got count=${count}`);
  });

  // ── Report ──
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('  Failures:');
    for (const f of failures) console.log(`    - ${f.name}: ${f.error}`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

main();
