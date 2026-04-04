const { describe, test, run } = require('../harness');
const { Reflector } = require('../../src/agent/planning/Reflector');
describe('Reflector', () => {
  test('constructs', () => { const r = new Reflector({ llm: null, prompts: null, sandbox: null, model: null, guard: null }); if (!r) throw new Error('Fail'); });
});
if (require.main === module) run();
