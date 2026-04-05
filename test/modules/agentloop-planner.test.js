const { describe, test, run } = require('../harness');
const mod = require('../../src/agent/revolution/AgentLoopPlanner');
describe('AgentLoopPlanner', () => {
  test('exports AgentLoopPlannerDelegate', () => { if (typeof mod.AgentLoopPlannerDelegate !== 'function') throw new Error('Missing'); });
});
if (require.main === module) run();
