const { describe, test, run } = require('../harness');
const mod = require('../../src/agent/capabilities/McpCodeExec');
describe('McpCodeExec', () => {
  test('exports McpCodeExecDelegate', () => { if (typeof mod.McpCodeExecDelegate !== 'function') throw new Error('Should export'); });
});
if (require.main === module) run();
