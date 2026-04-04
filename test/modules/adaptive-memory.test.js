const { describe, test, run } = require('../harness');
const { AdaptiveMemory } = require('../../src/agent/hexagonal/AdaptiveMemory');
describe('AdaptiveMemory (@deprecated)', () => {
  test('exports class', () => { if (typeof AdaptiveMemory !== 'function') throw new Error('Should export'); });
  test('constructs', () => {
    const am = new AdaptiveMemory({ bus: { emit(){}, on(){} }, storage: { readJSON: ()=>null, writeJSON: ()=>{} }, eventStore: { query: ()=>[] } });
    if (!am) throw new Error('Should construct');
  });
});
if (require.main === module) run();
