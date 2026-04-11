const { describe, test, run } = require('../harness');
const { TaskDelegation } = require('../../src/agent/hexagonal/TaskDelegation');
describe('TaskDelegation', () => {
  test('constructs', () => {
    const td = new TaskDelegation({ bus: { emit(){}, on(){} }, network: null, goalStack: null, eventStore: null, lang: { t: k => k } });
    if (!td) throw new Error('Fail');
  });
});

// ── v7.1.1: Coverage expansion ────────────────────────────────

const { assert, assertEqual } = require('../harness');


function makeTD(overrides = {}) {
  const fired = [];
  const bus = { fire: (n,d) => fired.push({n,d}), emit(){}, on(){ return ()=>{}; } };
  const lang = { t: k => k };
  const td = new TaskDelegation({ bus, lang, ...overrides });
  return { td, bus, fired };
}

describe('TaskDelegation — delegate() without network', () => {
  test('returns error when no network', async () => {
    const { td } = makeTD();
    const r = await td.delegate('do something');
    assert(!r.success, 'should fail');
    assert(r.error.includes('PeerNetwork not available'));
  });

  test('returns error when no matching peer found', async () => {
    const network = { peers: new Map() };
    const { td } = makeTD({ network });
    const r = await td.delegate('do something', ['code']);
    assert(!r.success);
    assert(r.error.includes('Kein Peer'));
  });
});

describe('TaskDelegation — receiveTask()', () => {
  test('accepts a valid task', async () => {
    const { td, fired } = makeTD();
    const r = td.receiveTask({ taskId: 't1', description: 'test task', requiredSkills: [], deadline: Date.now() + 60000 });
    assert(r.accepted, 'should accept');
    assert(typeof r.estimatedMs === 'number');
    await new Promise(res => setTimeout(res, 20));
    assert(fired.some(e => e.n === 'delegation:received'));
  });

  test('rejects when queue is full (>= 3 tasks)', () => {
    const { td } = makeTD();
    td._receivedTasks.set('t1', { description: 'x', status: 'running', result: null, error: null });
    td._receivedTasks.set('t2', { description: 'x', status: 'running', result: null, error: null });
    td._receivedTasks.set('t3', { description: 'x', status: 'running', result: null, error: null });
    const r = td.receiveTask({ taskId: 't4', description: 'overflow', requiredSkills: [] });
    assert(!r.accepted);
    assert(r.reason.includes('full'));
  });

  test('rejects expired deadline', () => {
    const { td } = makeTD();
    const r = td.receiveTask({ taskId: 't1', description: 'late', requiredSkills: [], deadline: Date.now() - 1000 });
    assert(!r.accepted);
    assert(r.reason.includes('expired'));
  });
});

describe('TaskDelegation — getTaskStatus()', () => {
  test('returns unknown for missing task', () => {
    const { td } = makeTD();
    const s = td.getTaskStatus('nope');
    assertEqual(s.status, 'unknown');
  });

  test('returns status for tracked task', () => {
    const { td } = makeTD();
    td._receivedTasks.set('t1', { description: 'x', status: 'running', result: null, error: null });
    const s = td.getTaskStatus('t1');
    assertEqual(s.status, 'running');
  });
});

describe('TaskDelegation — _executeReceivedTask()', () => {
  test('uses taskHandler when set', async () => {
    const { td } = makeTD();
    td._receivedTasks.set('t1', { description: 'x', status: 'pending', result: null, error: null });
    td.setTaskHandler(async (desc) => ({ output: `handled: ${desc}` }));
    await td._executeReceivedTask('t1', 'do work');
    const task = td._receivedTasks.get('t1');
    assertEqual(task.status, 'done');
    assert(task.result.output.includes('do work'));
  });

  test('uses goalStack fallback when no handler', async () => {
    const goalStack = { addGoal: async (d) => ({ id: 'g1', description: d }) };
    const { td } = makeTD({ goalStack });
    td._receivedTasks.set('t1', { description: 'x', status: 'pending', result: null, error: null });
    await td._executeReceivedTask('t1', 'create feature');
    const task = td._receivedTasks.get('t1');
    assertEqual(task.status, 'done');
    assertEqual(task.result.goalId, 'g1');
  });

  test('marks failed when no handler and no goalStack', async () => {
    const { td } = makeTD();
    td._receivedTasks.set('t1', { description: 'x', status: 'pending', result: null, error: null });
    await td._executeReceivedTask('t1', 'impossible');
    assertEqual(td._receivedTasks.get('t1').status, 'failed');
  });

  test('handler exception marks task failed', async () => {
    const { td } = makeTD();
    td._receivedTasks.set('t1', { description: 'x', status: 'pending', result: null, error: null });
    td.setTaskHandler(async () => { throw new Error('boom'); });
    await td._executeReceivedTask('t1', 'crash task');
    assertEqual(td._receivedTasks.get('t1').status, 'failed');
    assert(td._receivedTasks.get('t1').error.includes('boom'));
  });
});

describe('TaskDelegation — getStatus()', () => {
  test('returns status object', () => {
    const { td } = makeTD();
    const s = td.getStatus();
    assert(typeof s.activeDelegations === 'number');
    assert(typeof s.receivedTasks === 'number' || typeof s.received === 'object');
  });
});

describe('TaskDelegation — _findMatchingPeer()', () => {
  test('returns null when no network', () => {
    const { td } = makeTD();
    assert(td._findMatchingPeer(['code']) === null);
  });

  test('skips unhealthy peers', () => {
    const map = new Map([['p1', { skills: ['code'], health: { isHealthy: false } }]]);
    const { td } = makeTD({ network: { peers: map } });
    assert(td._findMatchingPeer(['code']) === null);
  });

  test('returns matching healthy peer', () => {
    const peer = { skills: ['code', 'test'], health: { isHealthy: true } };
    const map = new Map([['p1', peer]]);
    const { td } = makeTD({ network: { peers: map } });
    const found = td._findMatchingPeer(['code']);
    assert(found === peer);
  });

  test('returns any healthy peer when no skills required', () => {
    const peer = { skills: [], health: { isHealthy: true } };
    const map = new Map([['p1', peer]]);
    const { td } = makeTD({ network: { peers: map } });
    assert(td._findMatchingPeer([]) === peer);
  });
});

if (require.main === module) run();
