// Test: CostStream.js — v7.4.5 Baustein B
// Cost-SSOT: persistence, queries, retention, in-memory tally
const path = require('path');
const fs = require('fs');
const os = require('os');

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

const { CostStream } = require('../../src/agent/foundation/CostStream');
const { EventBus } = require('../../src/agent/core/EventBus');

function freshDir() {
  const dir = path.join(os.tmpdir(), 'genesis-cost-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function flush(cs) {
  // CostStream uses setImmediate for batched writes; await one cycle
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
}

(async () => {
  await test('subscribes to llm:call-complete and persists row', async () => {
    const bus = new EventBus({ verbose: false });
    const dir = freshDir();
    const cs = new CostStream({ bus, storage: null, genesisDir: dir });
    await cs.asyncLoad();

    bus.emit('llm:call-complete', {
      taskType: 'chat', model: 'qwen3', backend: 'ollama',
      promptTokens: 100, responseTokens: 50, latencyMs: 1200,
      cached: false, goalId: 'g_test',
    });

    await flush(cs);

    const today = new Date().toISOString().slice(0, 10);
    const shardPath = path.join(dir, 'cost', `${today}.jsonl`);
    assert(fs.existsSync(shardPath), 'Shard file should exist');
    const lines = fs.readFileSync(shardPath, 'utf8').trim().split('\n');
    assert(lines.length === 1, `Should have 1 row, got ${lines.length}`);
    const row = JSON.parse(lines[0]);
    assert(row.taskType === 'chat', 'taskType wrong');
    assert(row.promptTokens === 100, 'promptTokens wrong');
    assert(row.goalId === 'g_test', 'goalId wrong');

    cs.stop();
  });

  await test('queryCost by goalId returns aggregated counts (in-memory tally)', async () => {
    const bus = new EventBus({ verbose: false });
    const dir = freshDir();
    const cs = new CostStream({ bus, storage: null, genesisDir: dir });
    await cs.asyncLoad();

    for (let i = 0; i < 3; i++) {
      bus.emit('llm:call-complete', {
        taskType: 'chat', model: 'qwen3', backend: 'ollama',
        promptTokens: 100, responseTokens: 50, latencyMs: 1000,
        cached: false, goalId: 'g1',
      });
    }
    bus.emit('llm:call-complete', {
      taskType: 'chat', model: 'qwen3', backend: 'ollama',
      promptTokens: 200, responseTokens: 80, latencyMs: 2000,
      cached: false, goalId: 'g2',
    });

    await flush(cs);

    const cost1 = cs.queryCost({ goalId: 'g1' });
    assert(cost1.calls === 3, `g1 calls: expected 3, got ${cost1.calls}`);
    assert(cost1.tokensIn === 300, `g1 tokensIn: expected 300, got ${cost1.tokensIn}`);
    assert(cost1.tokensOut === 150, `g1 tokensOut: expected 150, got ${cost1.tokensOut}`);

    const cost2 = cs.queryCost({ goalId: 'g2' });
    assert(cost2.calls === 1, `g2 calls: expected 1, got ${cost2.calls}`);

    cs.stop();
  });

  await test('cached flag: cached calls have 0 tokens but still recorded', async () => {
    const bus = new EventBus({ verbose: false });
    const dir = freshDir();
    const cs = new CostStream({ bus, storage: null, genesisDir: dir });
    await cs.asyncLoad();

    bus.emit('llm:call-complete', {
      taskType: 'chat', promptTokens: 0, responseTokens: 0, latencyMs: 2,
      cached: true, goalId: 'g_cached',
    });

    await flush(cs);
    const t = cs.queryCost({ goalId: 'g_cached' });
    assert(t.calls === 1, 'should record cached call');
    assert(t.cachedCalls === 1, 'cachedCalls should be 1');
    assert(t.tokensIn === 0, 'cached: tokensIn should be 0');
    cs.stop();
  });

  await test('cost:recorded forwarded after persist', async () => {
    const bus = new EventBus({ verbose: false });
    const dir = freshDir();
    const cs = new CostStream({ bus, storage: null, genesisDir: dir });
    await cs.asyncLoad();

    let recorded = null;
    bus.on('cost:recorded', (data) => { recorded = data; });

    bus.emit('llm:call-complete', {
      taskType: 'chat', promptTokens: 50, responseTokens: 25, latencyMs: 800,
      goalId: 'g_x',
    });

    await flush(cs);
    assert(recorded, 'cost:recorded should fire');
    assert(recorded.goalId === 'g_x', 'forwarded goalId wrong');
    cs.stop();
  });

  await test('queryCost without goalId aggregates all rows', async () => {
    const bus = new EventBus({ verbose: false });
    const dir = freshDir();
    const cs = new CostStream({ bus, storage: null, genesisDir: dir });
    await cs.asyncLoad();

    bus.emit('llm:call-complete', { taskType: 'a', promptTokens: 10, responseTokens: 5 });
    bus.emit('llm:call-complete', { taskType: 'b', promptTokens: 20, responseTokens: 10 });
    bus.emit('llm:call-complete', { taskType: 'a', promptTokens: 30, responseTokens: 15 });

    await flush(cs);

    const all = cs.queryCost({ since: '2020-01-01' });
    assert(all.calls === 3, `expected 3 total calls, got ${all.calls}`);
    assert(all.tokensIn === 60, `expected 60 tokensIn, got ${all.tokensIn}`);

    const filtered = cs.queryCost({ since: '2020-01-01', taskType: 'a' });
    assert(filtered.calls === 2, `taskType=a: expected 2, got ${filtered.calls}`);
    assert(filtered.tokensIn === 40, `taskType=a tokensIn wrong`);
    cs.stop();
  });

  await test('shutdownPersist flushes pending writes synchronously', () => {
    const bus = new EventBus({ verbose: false });
    const dir = freshDir();
    const cs = new CostStream({ bus, storage: null, genesisDir: dir });
    // synchronously load — directly call asyncLoad without await for sync test
    fs.mkdirSync(path.join(dir, 'cost'), { recursive: true });
    cs._unsubBus = bus.on('llm:call-complete', (data) => cs._onCallComplete(data), { source: 'CostStream' });

    bus.emit('llm:call-complete', { taskType: 'chat', promptTokens: 5, responseTokens: 3 });
    // Don't wait for setImmediate — call shutdownPersist directly
    cs.shutdownPersist();

    const today = new Date().toISOString().slice(0, 10);
    const shardPath = path.join(dir, 'cost', `${today}.jsonl`);
    assert(fs.existsSync(shardPath), 'shard should be written synchronously on shutdown');
    cs.stop();
  });

  await test('stop() unsubscribes — no further events recorded', async () => {
    const bus = new EventBus({ verbose: false });
    const dir = freshDir();
    const cs = new CostStream({ bus, storage: null, genesisDir: dir });
    await cs.asyncLoad();

    bus.emit('llm:call-complete', { taskType: 'chat', promptTokens: 10, responseTokens: 5, goalId: 'g_pre' });
    await flush(cs);

    cs.stop();

    bus.emit('llm:call-complete', { taskType: 'chat', promptTokens: 999, responseTokens: 999, goalId: 'g_post' });
    await flush(cs);

    const t = cs.queryCost({ goalId: 'g_post' });
    assert(t.calls === 0, 'should not record after stop');
  });

  await test('reads back from disk for queries spanning multiple shards', async () => {
    const bus = new EventBus({ verbose: false });
    const dir = freshDir();
    const cs = new CostStream({ bus, storage: null, genesisDir: dir });
    await cs.asyncLoad();

    // Manually write yesterday's shard
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    const yesterdayPath = path.join(dir, 'cost', `${yesterday}.jsonl`);
    fs.writeFileSync(yesterdayPath, JSON.stringify({
      ts: yesterday + 'T12:00:00.000Z', taskType: 'chat',
      promptTokens: 100, responseTokens: 50, latencyMs: 500,
      cached: false, goalId: 'g_old',
    }) + '\n', 'utf8');

    // Today's row via event
    bus.emit('llm:call-complete', {
      taskType: 'chat', promptTokens: 200, responseTokens: 80, goalId: 'g_old',
    });
    await flush(cs);

    // Query crossing both shards
    const t = cs.queryCost({
      goalId: 'g_old',
      since: yesterday + 'T00:00:00Z',
    });
    assert(t.calls === 2, `expected 2 calls across shards, got ${t.calls}`);
    assert(t.tokensIn === 300, `expected 300 tokensIn, got ${t.tokensIn}`);
    cs.stop();
  });

  await test('getStats reports pendingWrites and goalsTracked', async () => {
    const bus = new EventBus({ verbose: false });
    const dir = freshDir();
    const cs = new CostStream({ bus, storage: null, genesisDir: dir });
    await cs.asyncLoad();

    bus.emit('llm:call-complete', { taskType: 'chat', goalId: 'a', promptTokens: 5, responseTokens: 3 });
    bus.emit('llm:call-complete', { taskType: 'chat', goalId: 'b', promptTokens: 5, responseTokens: 3 });
    await flush(cs);

    const stats = cs.getStats();
    assert(stats.goalsTracked === 2, `expected 2 goals, got ${stats.goalsTracked}`);
    assert(stats.retentionDays === 30, 'retention should be 30');
    cs.stop();
  });

  // v7.6.3: CostStream-failover-listener wiring
  await test('records model:failover-unavailable into failover tally', async () => {
    const bus = new EventBus({ verbose: false });
    const dir = freshDir();
    const cs = new CostStream({ bus, storage: null, genesisDir: dir });
    await cs.asyncLoad();

    // Initial: no failover
    let stats = cs.getStats();
    assert(stats.failover.total === 0, `expected 0 initial failovers, got ${stats.failover.total}`);
    assert(stats.failover.unavailable === 0, 'initial unavailable count should be 0');
    assert(stats.failover.lastAt === null, 'initial lastAt should be null');

    // Emit two failover events
    bus.fire('model:failover-unavailable', { from: 'gpt-4', reason: 'rate-limit', error: 'HTTP 429' });
    bus.fire('model:failover-unavailable', { from: 'gpt-4', reason: 'no-local-fallback', error: 'no-model-available' });
    // No flush needed — failover doesn't go through the write queue
    await new Promise(r => setImmediate(r));

    stats = cs.getStats();
    assert(stats.failover.total === 2, `expected 2 failovers, got ${stats.failover.total}`);
    assert(stats.failover.unavailable === 2, 'all should count as unavailable');
    assert(stats.failover.lastReason === 'no-local-fallback', 'lastReason should be the most recent');
    assert(typeof stats.failover.lastAt === 'number' && stats.failover.lastAt > 0, 'lastAt should be set');

    // No cost-row should be written for failovers (token tally unchanged)
    assert(stats.goalsTracked === 0, 'failovers must not write cost rows');
    cs.stop();
  });

  await test('failover listener cleaned up on stop', async () => {
    const bus = new EventBus({ verbose: false });
    const dir = freshDir();
    const cs = new CostStream({ bus, storage: null, genesisDir: dir });
    await cs.asyncLoad();

    cs.stop();
    // After stop, further events should not be recorded
    bus.fire('model:failover-unavailable', { from: 'x', reason: 'late', error: 'late' });
    await new Promise(r => setImmediate(r));
    const stats = cs.getStats();
    assert(stats.failover.total === 0, `events after stop must be ignored, got ${stats.failover.total}`);
  });

  // ── Print summary ──
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\n  Failures:');
    for (const f of failures) console.log(`    - ${f.name}: ${f.error}`);
    process.exit(1);
  }
})();
