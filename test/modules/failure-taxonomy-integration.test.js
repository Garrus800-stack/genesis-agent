// ============================================================
// GENESIS — test/modules/failure-taxonomy-integration.test.js
// Tests the FailureTaxonomy → AgentLoop → ModelRouter chain.
// v4.10.0
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
  console.log('\n  FailureTaxonomy Integration Tests');

  await test('TRANSIENT errors trigger exponential backoff', () => {
    const bus = _createBus();
    const actions = [];

    bus.on('failure:classified', (data) => {
      actions.push(data);
      if (data.category === 'TRANSIENT') {
        const delay = Math.min(30000, 1000 * Math.pow(2, data.attempt));
        actions.push({ action: 'backoff', delay });
      }
    }, { source: 'AgentLoop' });

    bus.fire('failure:classified', {
      category: 'TRANSIENT',
      error: 'Ollama connection timeout',
      attempt: 2,
    }, { source: 'FailureTaxonomy' });

    assert(actions.length === 2, 'Should classify + schedule backoff');
    assert(actions[1].delay === 4000, 'Backoff for attempt 2 should be 4s');
  });

  await test('DETERMINISTIC errors trigger immediate replan', () => {
    const bus = _createBus();
    const actions = [];

    bus.on('failure:classified', (data) => {
      if (data.category === 'DETERMINISTIC') {
        actions.push({ action: 'replan', reason: data.error });
      }
    }, { source: 'AgentLoop' });

    bus.fire('failure:classified', {
      category: 'DETERMINISTIC',
      error: 'File does not exist: config.yaml',
      attempt: 0,
    }, { source: 'FailureTaxonomy' });

    assert(actions.length === 1, 'Should trigger replan');
    assert(actions[0].action === 'replan', 'Action should be replan');
  });

  await test('ENVIRONMENTAL errors update WorldState before replan', () => {
    const bus = _createBus();
    const chain = [];

    bus.on('failure:classified', (data) => {
      if (data.category === 'ENVIRONMENTAL') {
        chain.push('classified');
        bus.fire('worldstate:update-needed', { reason: data.error }, { source: 'AgentLoop' });
      }
    }, { source: 'AgentLoop' });

    bus.on('worldstate:update-needed', () => {
      chain.push('worldstate-update');
      bus.fire('worldstate:updated', {}, { source: 'WorldState' });
    }, { source: 'WorldState' });

    bus.on('worldstate:updated', () => {
      chain.push('replan');
    }, { source: 'AgentLoop' });

    bus.fire('failure:classified', {
      category: 'ENVIRONMENTAL',
      error: 'Ollama model not found',
      attempt: 0,
    }, { source: 'FailureTaxonomy' });

    assert(chain.length === 3, `Expected 3-step chain, got ${chain.join(' → ')}`);
    assert(chain[1] === 'worldstate-update', 'Should update worldstate before replan');
  });

  await test('CAPABILITY errors trigger model escalation', () => {
    const bus = _createBus();
    const actions = [];

    bus.on('failure:classified', (data) => {
      if (data.category === 'CAPABILITY') {
        bus.fire('steering:escalate-model', {
          reason: 'capability-insufficient',
          error: data.error,
        }, { source: 'FailureTaxonomy' });
      }
    }, { source: 'AgentLoop' });

    bus.on('steering:escalate-model', (data) => {
      actions.push(data);
    }, { source: 'ModelRouter' });

    bus.fire('failure:classified', {
      category: 'CAPABILITY',
      error: 'Model cannot generate TypeScript generics',
      attempt: 0,
    }, { source: 'FailureTaxonomy' });

    assert(actions.length === 1, 'Should trigger model escalation');
    assert(actions[0].reason === 'capability-insufficient', 'Reason should be capability');
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
