const { describe, test, run } = require('../harness');
const { OllamaBackend } = require('../../src/agent/foundation/backends/OllamaBackend');
describe('OllamaBackend', () => {
  test('constructs with defaults', () => {
    const ob = new OllamaBackend();
    if (!ob) throw new Error('Should construct');
  });
  test('has chat method', () => {
    const ob = new OllamaBackend();
    if (typeof ob.chat !== 'function') throw new Error('Missing chat()');
  });
  test('has listModels method', () => {
    const ob = new OllamaBackend();
    if (typeof ob.listModels !== 'function') throw new Error('Missing listModels()');
  });
});
if (require.main === module) run();
