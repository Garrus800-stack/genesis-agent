const { describe, test, run } = require('../harness');
const mod = require('../../src/agent/organism/BiologicalAliases');
describe('BiologicalAliases', () => {
  test('exports ALIAS_MAP', () => { if (!mod.ALIAS_MAP) throw new Error('Missing'); });
  test('exports SERVICE_ALIAS_MAP', () => { if (!mod.SERVICE_ALIAS_MAP) throw new Error('Missing'); });
});
if (require.main === module) run();
