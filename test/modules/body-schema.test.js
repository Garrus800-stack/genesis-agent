const { describe, test, run } = require('../harness');
const { BodySchema } = require('../../src/agent/organism/BodySchema');
function make() { return new BodySchema({ bus: { emit(){}, on(){} }, storage: null, intervals: null }); }
describe('BodySchema', () => {
  test('constructs', () => { if (!make()) throw new Error('Fail'); });
  test('getCapabilities returns object', () => { if (typeof make().getCapabilities() !== 'object') throw new Error('Should return object'); });
  test('getReport returns object', () => { if (typeof make().getReport() !== 'object') throw new Error('Should return object'); });
  test('buildPromptContext returns string', () => { if (typeof make().buildPromptContext() !== 'string') throw new Error('Should return string'); });
  test('getConstraints returns object', () => { if (typeof make().getConstraints() !== 'object') throw new Error('Should return object'); });
  test('can returns boolean', () => { if (typeof make().can('code-gen') !== 'boolean') throw new Error('Should return boolean'); });
});
if (require.main === module) run();
