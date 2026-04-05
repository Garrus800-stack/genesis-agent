const { describe, test, run } = require('../harness');
const { WorldStateSnapshot } = require('../../src/agent/foundation/WorldStateSnapshot');
describe('WorldStateSnapshot', () => {
  test('module exports', () => { if (!WorldStateSnapshot) throw new Error('Should export'); });
});
if (require.main === module) run();
