const { describe, test, run } = require('../harness');
const { WebPerception } = require('../../src/agent/capabilities/WebPerception');
describe('WebPerception', () => {
  test('constructs', () => { const wp = new WebPerception({ bus: { emit(){} , fire(...args) { return this.emit ? this.emit(...args) : undefined; }}, storage: null, worldState: null, sandbox: null }); if (!wp) throw new Error('Fail'); });
});
if (require.main === module) run();
