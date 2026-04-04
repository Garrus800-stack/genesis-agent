const { describe, test, run } = require('../harness');
const os = require('os');
const { SelfOptimizer } = require('../../src/agent/planning/SelfOptimizer');
function make() { return new SelfOptimizer({ bus: { emit(){}, on(){} }, eventStore: { query: ()=>[] }, memory: null, goalStack: { getAll: ()=>[] }, storageDir: os.tmpdir(), storage: { readJSON: ()=>null, writeJSON: ()=>{} } }); }
describe('SelfOptimizer', () => {
  test('constructs', () => { if (!make()) throw new Error('Fail'); });
  test('getLatestReport returns null initially', () => { if (make().getLatestReport() !== null) throw new Error('Null'); });
  test('buildContext returns string', () => { if (typeof make().buildContext() !== 'string') throw new Error('String'); });
});
if (require.main === module) run();
