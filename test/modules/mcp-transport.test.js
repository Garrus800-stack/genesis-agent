const { describe, test, run } = require('../harness');
const mod = require('../../src/agent/capabilities/McpTransport');
describe('McpTransport', () => {
  test('exports McpServerConnection', () => { if (typeof mod.McpServerConnection !== 'function') throw new Error('Should export'); });
});
if (require.main === module) run();
