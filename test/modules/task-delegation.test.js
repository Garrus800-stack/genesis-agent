const { describe, test, run } = require('../harness');
const { TaskDelegation } = require('../../src/agent/hexagonal/TaskDelegation');
describe('TaskDelegation', () => {
  test('constructs', () => {
    const td = new TaskDelegation({ bus: { emit(){}, on(){} }, network: null, goalStack: null, eventStore: null, lang: { t: k => k } });
    if (!td) throw new Error('Fail');
  });
});
if (require.main === module) run();
