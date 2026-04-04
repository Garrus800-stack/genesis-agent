const { describe, test, run } = require('../harness');
const { AgentCoreWire } = require('../../src/agent/AgentCoreWire');
describe('AgentCoreWire', () => {
  test('exports class', () => { if (typeof AgentCoreWire !== 'function') throw new Error('Should export'); });
});
if (require.main === module) run();
