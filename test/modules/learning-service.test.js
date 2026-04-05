const { describe, test, run } = require('../harness');
const { LearningService } = require('../../src/agent/hexagonal/LearningService');
function make() { return new LearningService({ bus: { emit(){}, on(){} }, memory: null, knowledgeGraph: null, eventStore: null, storageDir: require('os').tmpdir(), intervals: null, storage: { readJSON: ()=>null, writeJSON: ()=>{} } }); }
describe('LearningService', () => {
  test('constructs', () => { if (!make()) throw new Error('Fail'); });
  test('getMetrics returns object', () => { if (typeof make().getMetrics() !== 'object') throw new Error('Should return object'); });
});
if (require.main === module) run();
