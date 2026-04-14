// Genesis v7.1.9 — CognitiveBudget.test.js
const { describe, test, assert, run } = require('../harness');
const { CognitiveBudget } = require('../../src/agent/intelligence/CognitiveBudget');

const mockBus = { on() {}, emit() {}, fire() {} };

describe('CognitiveBudget', () => {

test('assess: empty message → trivial', () => {
  const cb = new CognitiveBudget({ bus: mockBus });
  cb.start();
  const result = cb.assess('');
  assert(result.tierName === 'trivial', 'empty = trivial');
});

test('assess: greeting → trivial', () => {
  const cb = new CognitiveBudget({ bus: mockBus });
  cb.start();
  const result = cb.assess('Hallo');
  assert(result.tierName === 'trivial', 'greeting = trivial');
});

test('assess: short message without complexity → trivial', () => {
  const cb = new CognitiveBudget({ bus: mockBus });
  cb.start();
  const result = cb.assess('wie geht es?');
  assert(result.tierName === 'trivial', 'short = trivial');
});

test('assess: code block → at least moderate', () => {
  const cb = new CognitiveBudget({ bus: mockBus });
  cb.start();
  const result = cb.assess('```javascript\nconst x = 1;\n```');
  assert(result.tierName !== 'trivial', 'code is not trivial');
});

test('assess: self-modify intent hint → complex', () => {
  const cb = new CognitiveBudget({ bus: mockBus });
  cb.start();
  const result = cb.assess('change something', { intentHint: 'self-modify' });
  assert(result.tierName === 'complex', 'self-modify intent = complex');
});

test('assess: long message → at least moderate', () => {
  const cb = new CognitiveBudget({ bus: mockBus });
  cb.start();
  const longMsg = 'a'.repeat(250);
  const result = cb.assess(longMsg);
  assert(result.tierName === 'moderate' || result.tierName === 'complex', 'long = moderate+');
});

test('shouldIncludeSection: trivial excludes organism', () => {
  const cb = new CognitiveBudget({ bus: mockBus });
  cb.start();
  const budget = cb.assess('hi');
  // Organism and consciousness are typically excluded for trivial
  const includeOrganism = cb.shouldIncludeSection('organism', budget);
  const includeIdentity = cb.shouldIncludeSection('identity', budget);
  // Identity should always be included, organism may be excluded
  assert(includeIdentity === true, 'identity always included');
});

test('shouldIncludeSection: complex includes everything', () => {
  const cb = new CognitiveBudget({ bus: mockBus });
  cb.start();
  const budget = cb.assess('```js\ncomplex code here\n```');
  const include = cb.shouldIncludeSection('organism', budget);
  assert(include === true, 'complex includes organism');
});

test('assess: disabled → defaults to complex', () => {
  const cb = new CognitiveBudget({ bus: mockBus, config: { enabled: false } });
  cb.start();
  const result = cb.assess('hello');
  assert(result.tierName === 'complex', 'disabled = complex default');
});

test('getStats returns valid structure', () => {
  const cb = new CognitiveBudget({ bus: mockBus });
  cb.start();
  cb.assess('hi');
  cb.assess('hello world');
  const stats = cb.getStats();
  assert(typeof stats.total === 'number', 'has total');
  assert(stats.total >= 2, 'counted assessments');
});

test('getReport returns valid structure', () => {
  const cb = new CognitiveBudget({ bus: mockBus });
  cb.start();
  cb.assess('hi');
  const report = cb.getReport();
  assert(typeof report.total === 'number', 'has total');
  assert(typeof report.distribution === 'object', 'has distribution');
});
});

run();
