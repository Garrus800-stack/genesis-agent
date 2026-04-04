const { describe, test, run } = require('../harness');
const { CodeAnalyzer } = require('../../src/agent/intelligence/CodeAnalyzer');
describe('CodeAnalyzer', () => {
  test('constructs', () => {
    const ca = new CodeAnalyzer(null, null, null);
    if (!ca) throw new Error('Should construct');
  });
  test('analyze returns object for code reference', () => {
    const ca = new CodeAnalyzer({ getModuleSummary: () => [] }, null, null);
    const result = ca.analyze('what does EventBus do?');
    if (typeof result !== 'object') throw new Error('Should return object');
  });
});
if (require.main === module) run();
