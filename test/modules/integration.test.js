// ============================================================
// GENESIS v3.5.0 — Integration Test Suite
// Run: node test/modules/integration-v4.test.js
// ============================================================

const path = require('path');
const fs = require('fs');

let passed = 0, failed = 0;
const failures = [];

function assert(condition, message) {
  if (condition) { passed++; process.stdout.write('    \x1b[32m✅ ' + message + '\x1b[0m\n'); }
  else { failed++; failures.push(message); process.stdout.write('    \x1b[31m❌ ' + message + '\x1b[0m\n'); }
}
function section(name) { console.log(`\n  \x1b[36m🧪 ${name}\x1b[0m`); }

const { NullBus, EventBus } = require('../../src/agent/core/EventBus');
const { Container } = require('../../src/agent/core/Container');

class MockStorage {
  constructor() { this._data = {}; }
  readJSON(key, def) { return this._data[key] || def; }
  writeJSON(key, val) { this._data[key] = val; }
  writeJSONDebounced(key, val) { this._data[key] = val; }
  readText(key, def) { return this._data[key] || def; }
  appendText(key, val) { this._data[key] = (this._data[key] || '') + val; }
  flush() {}
  getStats() { return { keys: Object.keys(this._data).length }; }
}

const rootDir = path.resolve(__dirname, '..', '..');

async function main() {

  // ═══ TEST 1: Container late-bindings ═══
  section('Container late-binding integration');
  {
    const c = new Container({ bus: new EventBus() });
    c.register('storage', () => new MockStorage());
    c.register('svcA', (ct) => ({ name: 'A', storage: ct.resolve('storage'), svcB: null }), {
      deps: ['storage'], lateBindings: [
        { prop: 'svcB', service: 'svcB' },
        { prop: 'svcC', service: 'svcC', optional: true },
      ],
    });
    c.register('svcB', (ct) => ({ name: 'B', storage: ct.resolve('storage') }), { deps: ['storage'] });
    c.resolve('svcA'); c.resolve('svcB');
    const r = c.wireLateBindings();
    assert(r.wired === 1, 'serviceA.svcB wired');
    assert(r.skipped === 1, 'optional svcC skipped');
    assert(r.errors.length === 0, 'no binding errors');
    assert(c.resolve('svcA').svcB === c.resolve('svcB'), 'resolved instance matches');
  }

  // ═══ TEST 2: EventTypes ═══
  section('EventTypes registry');
  {
    const { EVENTS } = require('../../src/agent/core/EventTypes');
    assert(typeof EVENTS === 'object' && Object.isFrozen(EVENTS), 'EVENTS frozen');
    let total = 0;
    for (const g of Object.values(EVENTS)) { if (typeof g === 'object') { total += Object.keys(g).length; assert(Object.isFrozen(g), 'group frozen'); } }
    assert(total > 80, `${total} events registered (>80)`);
    assert(EVENTS.AGENT_LOOP.STARTED === 'agent-loop:started', 'AGENT_LOOP.STARTED');
    assert(EVENTS.VERIFICATION.COMPLETE === 'verification:complete', 'VERIFICATION.COMPLETE');
    assert(EVENTS.META.OUTCOME_RECORDED === 'meta:outcome-recorded', 'META.OUTCOME_RECORDED');
  }

  // ═══ TEST 3: WorldState + VerificationEngine ═══
  section('WorldState + VerificationEngine');
  {
    const { WorldState } = require('../../src/agent/foundation/WorldState');
    const { VerificationEngine, PASS, FAIL, AMBIGUOUS } = require('../../src/agent/intelligence/VerificationEngine');
    const ws = new WorldState({ bus: NullBus, storage: new MockStorage(), rootDir, settings: { get: () => null }, guard: { verifyIntegrity: () => ({ ok: true }) } });
    const ve = new VerificationEngine({ bus: NullBus, rootDir });
    ve.worldState = ws;

    const plan = ve.verifyPlan([
      { type: 'WRITE_FILE', target: 'src/agent/New.js', description: 'New module' },
      { type: 'WRITE_FILE', target: 'main.js', description: 'Kernel file' },
    ]);
    assert(plan.issues.length >= 1, 'PlanVerifier detects kernel write');

    const shell0 = await ve.verify('SHELL', {}, { exitCode: 0, output: 'ok', stderr: '' });
    assert(shell0.status === PASS, 'Shell exit 0 → PASS');
    const shell1 = await ve.verify('SHELL', {}, { exitCode: 1, stderr: 'fail' });
    assert(shell1.status === FAIL, 'Shell exit 1 → FAIL');
    const analyze = await ve.verify('ANALYZE', {}, {});
    assert(analyze.status === AMBIGUOUS, 'ANALYZE → AMBIGUOUS');
    const fileOk = await ve.verify('WRITE_FILE', { target: 'package.json' }, {});
    assert(fileOk.status === PASS, 'Existing file → PASS');
    const fileMiss = await ve.verify('WRITE_FILE', { target: 'nonexistent-xyz.js' }, {});
    assert(fileMiss.status === FAIL, 'Missing file → FAIL');
    assert(ve.getStats().total >= 5, `Tracked ${ve.getStats().total} verifications`);
  }

  // ═══ TEST 4: MetaLearning ═══
  section('MetaLearning record/recommend');
  {
    const { MetaLearning } = require('../../src/agent/planning/MetaLearning');
    const ml = new MetaLearning({ bus: NullBus, storage: new MockStorage() });
    for (let i = 0; i < 55; i++) {
      ml.recordOutcome({
        taskCategory: 'code-gen', model: 'gemma2:9b',
        promptStyle: i < 40 ? 'json-schema' : 'free-text',
        temperature: i < 40 ? 0.3 : 0.7, outputFormat: 'json',
        success: i < 40 ? (i % 10 !== 0) : (i % 3 !== 0),
        latencyMs: 500 + i * 20, inputTokens: 100, outputTokens: 200,
        verificationResult: 'pass', retryCount: 0,
      });
    }
    const s = ml.getStats();
    assert(s.totalRecords === 55, `${s.totalRecords} records`);
    assert(s.categories.includes('code-gen'), 'tracks code-gen');
    assert(s.successRate > 0, `success rate: ${s.successRate}%`);
    const t = ml.getTrend('code-gen');
    assert(t && typeof t.trend === 'string', `trend: ${t.trend}`);
  }

  // ═══ TEST 5: EpisodicMemory ═══
  section('EpisodicMemory recall');
  {
    const { EpisodicMemory } = require('../../src/agent/hexagonal/EpisodicMemory');
    const em = new EpisodicMemory({ bus: NullBus, storage: new MockStorage() });
    em.recordEpisode({ topic: 'MCP refactor', summary: 'Fixed reconnection', outcome: 'success', duration: 300, toolsUsed: ['sandbox'], tags: ['mcp', 'refactoring'] });
    em.recordEpisode({ topic: 'Test expansion', summary: 'Added CB tests', outcome: 'success', duration: 120, toolsUsed: ['sandbox'], tags: ['testing'] });
    em.recordEpisode({ topic: 'MCP bug', summary: 'SSE drops', outcome: 'failed', duration: 600, toolsUsed: ['shell'], tags: ['mcp', 'bug'] });
    const st = em.getStats();
    assert(st.totalEpisodes === 3, `${st.totalEpisodes} episodes`);
    assert(em.getRecent(7).length === 3, 'temporal: 3 recent');
    assert(em.getByTag('mcp').length === 2, 'tag "mcp": 2 episodes');
    assert(em.recall('MCP reconnection').length > 0, 'recall finds MCP episodes');
  }

  // ═══ TEST 6: ConversationMemory API ═══
  section('ConversationMemory API');
  {
    const { ConversationMemory } = require('../../src/agent/foundation/ConversationMemory');
    const tmp = path.join(__dirname, '..', '..', '.genesis-test-api');
    if (!fs.existsSync(tmp)) fs.mkdirSync(tmp, { recursive: true });
    const mem = new ConversationMemory(tmp, NullBus, new MockStorage());
    mem.learnFact('user.name', 'Garrus');
    assert(mem.getUserName() === 'Garrus', 'getUserName()');
    assert(mem.getSemantic('user.name') === 'Garrus', 'getSemantic()');
    assert(mem.getSemantic('missing', 'def') === 'def', 'getSemantic() default');
    try { fs.rmSync(tmp, { recursive: true }); } catch {}
  }

  // ═══ TEST 7: FormalPlanner ═══
  section('FormalPlanner action library');
  {
    const { FormalPlanner } = require('../../src/agent/revolution/FormalPlanner');
    const { WorldState } = require('../../src/agent/foundation/WorldState');
    const { VerificationEngine } = require('../../src/agent/intelligence/VerificationEngine');
    const ws = new WorldState({ bus: NullBus, storage: new MockStorage(), rootDir, settings: { get: () => null }, guard: { verifyIntegrity: () => ({ ok: true }) } });
    const fp = new FormalPlanner({
      bus: NullBus, worldState: ws, verifier: new VerificationEngine({ bus: NullBus, rootDir }),
      toolRegistry: { listTools: () => [] }, model: { chat: async () => '[]', activeModel: 'test' },
      selfModel: { getFullModel: () => ({}) }, sandbox: { execute: async () => ({}) },
      guard: { validateWrite: () => true }, eventStore: { append: () => {} },
      storage: new MockStorage(), rootDir,
    });
    assert(fp.actions.size >= 9, `${fp.actions.size} actions`);
    for (const a of ['ANALYZE', 'CODE_GENERATE', 'WRITE_FILE', 'RUN_TESTS', 'SHELL_EXEC', 'SEARCH', 'ASK_USER', 'GIT_SNAPSHOT', 'SELF_MODIFY']) {
      assert(fp.actions.has(a), `action "${a}"`);
    }
    const cl = ws.clone();
    assert(cl.canRunShell('npm test'), 'clone: npm test safe');
    assert(!cl.canRunShell('rm -rf /'), 'clone: rm -rf / blocked');
  }

  // ═══ TEST 8: ModelRouter ═══
  section('ModelRouter routing');
  {
    const { ModelRouter } = require('../../src/agent/revolution/ModelRouter');
    const { MetaLearning } = require('../../src/agent/planning/MetaLearning');
    const { WorldState } = require('../../src/agent/foundation/WorldState');
    const ws = new WorldState({ bus: NullBus, storage: new MockStorage(), rootDir, settings: { get: () => null }, guard: { verifyIntegrity: () => ({ ok: true }) } });
    ws.updateOllamaModels(['gemma2:2b', 'gemma2:9b', 'codellama:34b']);
    ws.updateOllamaStatus('running');
    const router = new ModelRouter({
      bus: NullBus,
      modelBridge: { activeModel: 'gemma2:9b', availableModels: [
        { name: 'gemma2:2b', backend: 'ollama', size: 0 },
        { name: 'gemma2:9b', backend: 'ollama', size: 0 },
        { name: 'codellama:34b', backend: 'ollama', size: 0 },
      ] },
      metaLearning: new MetaLearning({ bus: NullBus, storage: new MockStorage() }),
      worldState: ws,
    });
    const cr = router.route('code-gen');
    assert(cr && cr.model, `code-gen → ${cr?.model}`);
    const cl = router.route('classification');
    assert(cl && cl.model, `classification → ${cl?.model}`);
    assert(router._stats.routed >= 2, 'tracked routing calls');
  }

  // ═══ SUMMARY ═══
  console.log('\n' + '='.repeat(50));
  console.log(`  Integration: \x1b[32m${passed} passed\x1b[0m, \x1b[${failed > 0 ? '31' : '32'}m${failed} failed\x1b[0m`);
  if (failures.length > 0) { console.log('\n  Failures:'); for (const f of failures) console.log(`    - ${f}`); }
  console.log('='.repeat(50));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('Test suite crashed:', err); process.exit(1); });
