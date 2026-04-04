const { describe, test, run } = require('../harness');
const { PeerTransport } = require('../../src/agent/hexagonal/PeerTransport');
describe('PeerTransport', () => {
  test('exports class', () => { if (typeof PeerTransport !== 'function') throw new Error('Should export'); });
});
if (require.main === module) run();
