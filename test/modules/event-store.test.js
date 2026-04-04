const { describe, test, run } = require('../harness');
const { EventStore } = require('../../src/agent/foundation/EventStore');
const os = require('os'), path = require('path'), fs = require('fs');
function make() {
  const d = path.join(os.tmpdir(), 'es-test-' + Date.now() + Math.random().toString(36).slice(2,5));
  fs.mkdirSync(d, { recursive: true });
  return new EventStore(d, { emit(){}, on(){} }, null);
}
describe('EventStore', () => {
  test('append returns event with id', () => { const e = make().append('TEST', {}, 't'); if (!e || typeof e.id !== 'number') throw new Error('ID'); });
  test('IDs are sequential', () => { const es = make(); const a = es.append('A', {}, 't'); const b = es.append('B', {}, 't'); if (b.id !== a.id + 1) throw new Error('Seq'); });
  test('query by type after flush', () => {
    const es = make(); es.append('X', {}, 't'); es.append('Y', {}, 't'); es.append('X', {}, 't');
    es._flushBatch();
    if (es.query({ type: 'X' }).length !== 2) throw new Error('Filter');
  });
  test('query respects limit', () => {
    const es = make(); for (let i = 0; i < 20; i++) es.append('E', {}, 't');
    es._flushBatch();
    if (es.query({ limit: 5 }).length !== 5) throw new Error('Limit');
  });
  test('getStats returns eventCount', () => { const es = make(); es.append('A',{},'t'); if (typeof es.getStats().eventCount !== 'number') throw new Error('Missing'); });
  test('registerProjection tracks state', () => {
    const es = make();
    es.registerProjection('c', (s, e) => e.type === 'INC' ? { n: (s.n||0)+1 } : s, { n: 0 });
    es.append('INC', {}, 't'); es.append('INC', {}, 't');
    if (es.getProjection('c').n !== 2) throw new Error('Projection');
  });
  test('verifyIntegrity', () => { const es = make(); es.append('E',{},'t'); es._flushBatch(); const r = es.verifyIntegrity(); if (typeof r.ok !== 'boolean') throw new Error('Missing'); });
});
if (require.main === module) run();
