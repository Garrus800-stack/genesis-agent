const { describe, test, run } = require('../harness');
const { DesktopPerception } = require('../../src/agent/foundation/DesktopPerception');
describe('DesktopPerception', () => {
  test('constructs', () => { const dp = new DesktopPerception({ bus: { emit(){}, fire(...args) { return this.emit ? this.emit(...args) : undefined; }, on(){} }, storage: null, worldState: null }); if (!dp) throw new Error('Fail'); });
});
if (require.main === module) run();
