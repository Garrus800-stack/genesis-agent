const { describe, test, run } = require('../harness');
const { ExpectationEngine, BASE_RATES } = require('../../src/agent/cognitive/ExpectationEngine');
function make() { return new ExpectationEngine({ bus: { emit(){} }, metaLearning: null, schemaStore: null, worldState: null, storage: null, config: {} }); }
describe('ExpectationEngine', () => {
  test('BASE_RATES defined', () => { if (typeof BASE_RATES !== 'object') throw new Error('Missing'); });
  test('expect returns expectation', () => { const exp = make().expect({ type: 'code-gen' }); if (!exp || typeof exp !== 'object') throw new Error('Object'); });
  test('compare returns object', () => { const ee = make(); const exp = ee.expect({ type: 'code-gen' }); if (typeof ee.compare(exp, { success: false }) !== 'object') throw new Error('Object'); });
  test('getCalibration returns number', () => { if (typeof make().getCalibration() !== 'number') throw new Error('Should be number'); });
  test('getStats returns object', () => { if (typeof make().getStats() !== 'object') throw new Error('Object'); });
});
if (require.main === module) run();
