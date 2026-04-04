const { describe, test, run } = require('../harness');
const { AnthropicBackend } = require('../../src/agent/foundation/backends/AnthropicBackend');
describe('AnthropicBackend', () => {
  test('constructs', () => { if (!new AnthropicBackend({})) throw new Error('Fail'); });
  test('has chat method', () => { if (typeof new AnthropicBackend({}).chat !== 'function') throw new Error('Missing'); });
});
if (require.main === module) run();
