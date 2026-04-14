// Genesis v7.1.9 — ValueStore.test.js
const { describe, test, assert, run } = require('../harness');
const { ValueStore } = require('../../src/agent/planning/ValueStore');

const mockBus = { on() {}, emit() {}, fire() {} };

function createStore(opts = {}) {
  return new ValueStore({ bus: mockBus, storage: null, ...opts });
}

describe('ValueStore', () => {

test('store: creates a value with required fields', () => {
  const vs = createStore();
  const result = vs.store({ name: 'honesty', description: 'Be truthful', weight: 0.8 });
  assert(result, 'returns stored value');
  assert(result.name === 'honesty', 'name normalized');
  assert(result.weight === 0.8, 'weight preserved');
  assert(result.id, 'id generated');
});

test('store: rejects value without name', () => {
  const vs = createStore();
  const result = vs.store({});
  assert(result === null, 'null for no name');
});

test('store: duplicate name+domain → reinforces', () => {
  const vs = createStore();
  vs.store({ name: 'honesty', weight: 0.5 });
  vs.store({ name: 'honesty', weight: 0.5 });
  const values = vs.getForDomain('all');
  assert(values.length === 1, 'deduplicated');
  assert(values[0].evidence >= 2, 'evidence increased');
  assert(values[0].weight > 0.5, 'weight reinforced');
});

test('store: normalizes name to lowercase', () => {
  const vs = createStore();
  vs.store({ name: 'HONESTY' });
  const values = vs.getForDomain('all');
  assert(values[0].name === 'honesty', 'lowercase');
});

test('store: clamps weight to [0, 1]', () => {
  const vs = createStore();
  const high = vs.store({ name: 'test-high', weight: 5 });
  const low = vs.store({ name: 'test-low', weight: -2 });
  assert(high.weight <= 1, 'clamped to max 1');
  assert(low.weight >= 0, 'clamped to min 0');
});

test('store: different domains are separate values', () => {
  const vs = createStore();
  vs.store({ name: 'honesty', domain: 'ethics', weight: 0.8 });
  vs.store({ name: 'honesty', domain: 'communication', weight: 0.7 });
  // getForDomain('ethics') returns ethics + 'all' domain values
  const ethics = vs.getForDomain('ethics');
  const comm = vs.getForDomain('communication');
  assert(ethics.length >= 1, 'has ethics values');
  assert(comm.length >= 1, 'has communication values');
});

test('getForDomain: filters by domain', () => {
  const vs = createStore();
  vs.store({ name: 'v1', domain: 'ethics', weight: 0.8 });
  vs.store({ name: 'v2', domain: 'performance', weight: 0.7 });
  vs.store({ name: 'v3', domain: 'ethics', weight: 0.6 });
  // getForDomain returns values matching domain OR domain='all'
  const ethics = vs.getForDomain('ethics');
  const perf = vs.getForDomain('performance');
  assert(ethics.length === 2, '2 ethics values');
  assert(perf.length === 1, '1 performance value');
});

test('recordConflict: stores conflict entry', () => {
  const vs = createStore();
  vs.recordConflict(['safety', 'speed']);
  const report = vs.getReport();
  assert(report.stats.conflictsRecorded >= 1, 'conflict counted');
});

test('buildPromptContext: returns string', () => {
  const vs = createStore();
  vs.store({ name: 'honesty', weight: 0.9 });
  vs.store({ name: 'safety', weight: 0.8 });
  const ctx = vs.buildPromptContext();
  assert(typeof ctx === 'string', 'returns string');
  assert(ctx.length > 0, 'non-empty when values exist');
});

test('buildPromptContext: empty when no values', () => {
  const vs = createStore();
  const ctx = vs.buildPromptContext();
  assert(ctx === '' || ctx.length === 0, 'empty when no values');
});

test('getReport: returns valid structure', () => {
  const vs = createStore();
  vs.store({ name: 'test' });
  const report = vs.getReport();
  assert(report.stats, 'has stats');
  assert(report.stats.stored >= 1, 'stored count');
  assert(Array.isArray(report.topValues), 'has topValues');
});

test('_prune: respects maxValues limit', () => {
  const vs = createStore({ config: { maxValues: 3 } });
  vs.store({ name: 'a', weight: 0.9 });
  vs.store({ name: 'b', weight: 0.5 });
  vs.store({ name: 'c', weight: 0.3 });
  vs.store({ name: 'd', weight: 0.1 });
  const values = vs.getForDomain('all');
  assert(values.length <= 3, 'pruned to max');
});
});

run();
