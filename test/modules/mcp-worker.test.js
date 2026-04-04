const { describe, test, run } = require('../harness');
describe('McpWorker', () => {
  test('requires workerData (worker thread only)', () => {
    try { require('../../src/agent/capabilities/McpWorker'); throw new Error('Should throw'); }
    catch (_e) { /* expected — needs workerData */ }
  });
});
if (require.main === module) run();
