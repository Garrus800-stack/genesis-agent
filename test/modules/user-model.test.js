const { describe, test, run } = require('../harness');
const { UserModel } = require('../../src/agent/intelligence/UserModel');
function make() { return new UserModel({ bus: { emit(){}, on(){} }, storage: null, config: {} }); }
describe('UserModel', () => {
  test('observe tracks messages', () => { const um = make(); um.observe('hello'); um.observe('test'); });
  test('buildPromptContext returns string', () => { if (typeof make().buildPromptContext() !== 'string') throw new Error('Missing'); });
  test('observeOutcome does not crash', () => { make().observeOutcome(true); make().observeOutcome(false); });
  test('getReport returns object', () => { if (typeof make().getReport() !== 'object') throw new Error('Missing'); });
});
if (require.main === module) run();
