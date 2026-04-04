const { describe, test, run } = require('../harness');
const { EmotionalSteering, THRESHOLDS } = require('../../src/agent/organism/EmotionalSteering');
function make() { return new EmotionalSteering({ bus: { emit(){}, on(){} }, emotionalState: { getDimension: () => 0.5 }, storage: null, config: {} }); }
describe('EmotionalSteering', () => {
  test('THRESHOLDS exported', () => { if (typeof THRESHOLDS !== 'object') throw new Error('Missing'); });
  test('getSignals returns object', () => {
    const es = make();
    const signals = es.getSignals();
    if (typeof signals !== 'object') throw new Error('Should return object');
  });
  test('refresh does not crash', () => {
    const es = make();
    es.refresh();
  });
});
if (require.main === module) run();
