const { describe, test, run } = require('../harness');
const { SurpriseAccumulator } = require('../../src/agent/cognitive/SurpriseAccumulator');
function make() { return new SurpriseAccumulator({ bus: { emit(){}, on(){} }, episodicMemory: null, eventStore: null, storage: null, intervals: null, config: {} }); }
describe('SurpriseAccumulator', () => {
  test('constructs', () => { if (!make()) throw new Error('Fail'); });
  test('getCalibration returns number', () => { if (typeof make().getCalibration() !== 'number') throw new Error('Should be number'); });
  test('isHighSurprisePeriod returns boolean', () => { if (typeof make().isHighSurprisePeriod() !== 'boolean') throw new Error('Bool'); });
  test('getCurrentMultiplier returns number', () => { if (typeof make().getCurrentMultiplier() !== 'number') throw new Error('Num'); });
});
if (require.main === module) run();
