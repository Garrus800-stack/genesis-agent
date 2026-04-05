const { describe, test, run } = require('../harness');
const { EmbeddingService } = require('../../src/agent/foundation/EmbeddingService');
describe('EmbeddingService', () => {
  test('constructs', () => {
    const es = new EmbeddingService({ bus: { emit(){} }, storage: null, knowledgeGraph: null });
    if (!es) throw new Error('Should construct');
  });
});
if (require.main === module) run();
