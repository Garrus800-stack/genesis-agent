const { describe, test, run } = require('../harness');
const mod = require('../../src/agent/revolution/AgentLoopSteps');
describe('AgentLoopSteps', () => {
  test('exports AgentLoopStepsDelegate', () => { if (typeof mod.AgentLoopStepsDelegate !== 'function') throw new Error('Missing'); });
});
if (require.main === module) run();
