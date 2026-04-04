const { describe, test, run } = require('../harness');
const os = require('os');
const { SolutionAccumulator } = require('../../src/agent/planning/SolutionAccumulator');
function make() { return new SolutionAccumulator({ bus: { emit(){}, on(){} }, memory: null, knowledgeGraph: null, storageDir: os.tmpdir(), storage: { readJSON: ()=>null, writeJSON: ()=>{} } }); }
describe('SolutionAccumulator', () => {
  test('constructs', () => { if (!make()) throw new Error('Fail'); });
  test('getStats returns object', () => { if (typeof make().getStats() !== 'object') throw new Error('Object'); });
});
if (require.main === module) run();
