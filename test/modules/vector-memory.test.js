const { describe, test, run } = require('../harness');
const { VectorMemory } = require('../../src/agent/revolution/VectorMemory');
function make() { return new VectorMemory({ bus: { emit(){}, on(){} }, storage: { readJSON: ()=>null, writeJSONAsync: ()=>Promise.resolve() }, embeddingService: null }); }
describe('VectorMemory', () => {
  test('constructs', () => { if (!make()) throw new Error('Fail'); });
  test('search returns array', async () => { if (!Array.isArray(await make().search('query'))) throw new Error('Should be array'); });
  test('getStats returns object', () => { if (typeof make().getStats() !== 'object') throw new Error('Missing'); });
});
if (require.main === module) run();
