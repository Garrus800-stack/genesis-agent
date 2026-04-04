const { describe, test, run } = require('../harness');
const { OpenAIBackend } = require('../../src/agent/foundation/backends/OpenAIBackend');
describe('OpenAIBackend', () => {
  test('constructs', () => { if (!new OpenAIBackend({})) throw new Error('Fail'); });
  test('has chat method', () => { if (typeof new OpenAIBackend({}).chat !== 'function') throw new Error('Missing'); });
});
if (require.main === module) run();
