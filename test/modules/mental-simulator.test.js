const { describe, test, run } = require('../harness');
const { MentalSimulator, STEP_VALUES, RETRYABLE } = require('../../src/agent/cognitive/MentalSimulator');
function make() { return new MentalSimulator({ bus: { emit(){} }, worldState: { get: () => null, snapshot: () => ({}) }, expectationEngine: null, storage: null, config: {} }); }
describe('MentalSimulator', () => {
  test('STEP_VALUES exported', () => { if (typeof STEP_VALUES !== 'object') throw new Error('Missing'); });
  test('simulate returns result for empty plan', () => {
    const result = make().simulate([]);
    if (typeof result !== 'object') throw new Error('Should return object');
  });
  test('simulate returns result for simple plan', () => {
    const result = make().simulate([{ type: 'ANALYZE', description: 'check' }]);
    if (typeof result !== 'object') throw new Error('Should return object');
  });
  test('comparePlans returns object', () => {
    if (typeof make().comparePlans([{ type: 'ANALYZE' }], [{ type: 'CODE' }]) !== 'object') throw new Error('Should return object');
  });
  test('getStats returns object', () => { if (typeof make().getStats() !== 'object') throw new Error('Missing'); });
});
if (require.main === module) run();
