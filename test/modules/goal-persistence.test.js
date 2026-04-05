const { describe, test, run } = require('../harness');
const { GoalPersistence } = require('../../src/agent/planning/GoalPersistence');
function make() { return new GoalPersistence({ bus: { emit(){}, on(){}, fire(){} }, storage: { readJSON: ()=>null, writeJSON: ()=>{} }, goalStack: { getAll: ()=>[], goals: [] }, eventStore: { query: ()=>[] }, config: {} }); }
describe('GoalPersistence', () => {
  test('constructs', () => { if (!make()) throw new Error('Fail'); });
  test('getSummary returns object', () => { if (typeof make().getSummary() !== 'object') throw new Error('Missing'); });
  test('checkpoint does not crash', async () => { await make().checkpoint(); });
});
if (require.main === module) run();
