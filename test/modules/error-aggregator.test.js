const { describe, test, run } = require('../harness');
const { ErrorAggregator } = require('../../src/agent/autonomy/ErrorAggregator');
function make(cfg) {
  const subs = [];
  return new ErrorAggregator({ bus: { emit(){}, fire(){}, on(e,fn) { subs.push(fn); return () => {}; } }, config: { healthIntervalMs: 999999, ...cfg } });
}
describe('ErrorAggregator', () => {
  test('record stores by category', () => { const a = make(); a.record('llm:timeout', { message: 'err1' }); a.record('llm:timeout', { message: 'err2' }); if (a.getReport().summary.totalErrors < 2) throw new Error('Should count'); });
  test('getRate returns number', () => { const a = make(); a.record('t', {}); if (typeof a.getRate('t', 60000) !== 'number') throw new Error('Number'); });
  test('getRate returns 0 for unknown', () => { if (make().getRate('x', 60000) !== 0) throw new Error('Zero'); });
  test('getReport returns categories and summary', () => { const r = make().getReport(); if (!r.summary) throw new Error('Missing summary'); });
  test('getSummary returns object', () => { if (typeof make().getSummary() !== 'object') throw new Error('Object'); });
  test('categories capped', () => { const a = make({ maxCategories: 5 }); for (let i = 0; i < 10; i++) a.record('c'+i, { message: 'u'+i }); if (Object.keys(a.getReport().categories).length > 6) throw new Error('Cap'); });
  test('start and stop lifecycle', () => { const a = make(); a.start(); a.stop(); });
});
if (require.main === module) run();
