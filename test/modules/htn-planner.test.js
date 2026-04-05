const { describe, test, run } = require('../harness');
const { HTNPlanner } = require('../../src/agent/revolution/HTNPlanner');
describe('HTNPlanner', () => {
  test('constructs', () => {
    const hp = new HTNPlanner({ bus: { emit(){} }, llm: null, sandbox: null, tools: null, prompts: null, selfModel: null });
    if (!hp) throw new Error('Should construct');
  });
});
if (require.main === module) run();
