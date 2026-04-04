const { describe, test, run } = require('../harness');
const { SelfSpawner } = require('../../src/agent/capabilities/SelfSpawner');
describe('SelfSpawner', () => {
  test('constructs', () => { const ss = new SelfSpawner({ bus: { emit(){} }, modelBridge: null, rootDir: '/tmp' }); if (!ss) throw new Error('Fail'); });
  test('getStats returns object', () => { const ss = new SelfSpawner({ bus: { emit(){} }, modelBridge: null, rootDir: '/tmp' }); if (typeof ss.getStats() !== 'object') throw new Error('Should return object'); });
});
if (require.main === module) run();
