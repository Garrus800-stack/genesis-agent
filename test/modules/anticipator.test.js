const { describe, test, run } = require('../harness');
const { Anticipator } = require('../../src/agent/planning/Anticipator');
function make() { return new Anticipator({ bus: { emit(){}, on(){} }, memory: null, knowledgeGraph: null, eventStore: null, model: null }); }
describe('Anticipator', () => {
  test('constructs', () => { if (!make()) throw new Error('Fail'); });
  test('getPredictions returns array', () => { if (!Array.isArray(make().getPredictions())) throw new Error('Should return array'); });
});
if (require.main === module) run();
