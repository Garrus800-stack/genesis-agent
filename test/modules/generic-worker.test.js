const { describe, test, run } = require('../harness');
describe('GenericWorker', () => {
  test('throws when not in worker thread', () => {
    try { require('../../src/agent/intelligence/GenericWorker'); throw new Error('Should throw'); }
    catch (e) { if (!e.message.includes('worker thread')) throw new Error('Wrong error: ' + e.message); }
  });
});
if (require.main === module) run();
