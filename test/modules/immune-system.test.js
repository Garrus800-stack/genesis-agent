const { describe, test, run } = require('../harness');
const { ImmuneSystem } = require('../../src/agent/organism/ImmuneSystem');
function make() { return new ImmuneSystem({ bus: { emit(){}, fire(){}, on(){} }, storage: null, intervals: null }); }
describe('ImmuneSystem', () => {
  test('constructs', () => { if (!make()) throw new Error('Fail'); });
  test('getReport returns object', () => { if (typeof make().getReport() !== 'object') throw new Error('Should return object'); });
  test('buildPromptContext returns string', () => { if (typeof make().buildPromptContext() !== 'string') throw new Error('Should return string'); });
  test('isQuarantined returns boolean', () => { if (typeof make().isQuarantined('test') !== 'boolean') throw new Error('Should return boolean'); });
  test('start and stop lifecycle', () => { const is = make(); is.start(); is.stop(); });
});
if (require.main === module) run();
