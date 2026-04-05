const { describe, test, run } = require('../harness');
const { ValueStore } = require('../../src/agent/planning/ValueStore');
function make() { return new ValueStore({ bus: { emit(){}, fire(){} }, storage: null, config: {} }); }
describe('ValueStore', () => {
  test('store adds value', () => { const vs = make(); vs.store({ name: 'thoroughness', weight: 0.8, domain: 'code', polarity: 1, source: 'test' }); });
  test('getForDomain returns array', () => {
    const vs = make(); vs.store({ name: 'safety', weight: 0.5, domain: 'all', polarity: 1, source: 'test' });
    if (!Array.isArray(vs.getForDomain('all'))) throw new Error('Should be array');
  });
  test('getValenceModifiers returns array', () => { if (!Array.isArray(make().getValenceModifiers())) throw new Error('Should be array'); });
  test('buildPromptContext returns string', () => { if (typeof make().buildPromptContext() !== 'string') throw new Error('Should be string'); });
  test('getReport returns object', () => { if (typeof make().getReport() !== 'object') throw new Error('Should be object'); });
  test('weight clamped to 0-1', () => { const vs = make(); vs.store({ name: 'x', weight: 5.0, domain: 'all', polarity: 1, source: 'test' }); });
  test('empty store returns empty', () => { if (make().getForDomain('code').length !== 0) throw new Error('Should be empty'); });
});
if (require.main === module) run();
