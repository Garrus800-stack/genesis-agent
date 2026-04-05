const { describe, test, run } = require('../harness');
const mod = require('../../src/agent/revolution/AgentLoopDelegate');
describe('AgentLoopDelegate', () => {
  test('exports _stepDelegate function', () => { if (typeof mod._stepDelegate !== 'function') throw new Error('Missing'); });
});
if (require.main === module) run();
