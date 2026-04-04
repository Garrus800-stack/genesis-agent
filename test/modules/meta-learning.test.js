const { describe, test, run } = require('../harness');
const { MetaLearning } = require('../../src/agent/planning/MetaLearning');
function make() { return new MetaLearning({ bus: { emit(){} }, storage: null, intervals: null }); }
function outcome(o) { return { taskCategory: 'code-gen', model: 'x', promptStyle: 'free-text', temperature: 0.7, outputFormat: 'text', success: true, latencyMs: 2000, inputTokens: 500, outputTokens: 300, verificationResult: 'pass', retryCount: 0, ...o }; }
describe('MetaLearning', () => {
  test('recordOutcome stores', () => { make().recordOutcome(outcome()); });
  test('recordOutcome emits event', () => {
    const events = [];
    const ml = new MetaLearning({ bus: { emit: (n) => events.push(n) }, storage: null, intervals: null });
    ml.recordOutcome(outcome());
    if (!events.includes('meta:outcome-recorded')) throw new Error('Missing event');
  });
  test('recommend returns default with few records', () => {
    const ml = make(); ml.recordOutcome(outcome());
    const rec = ml.recommend('code-gen', 'x');
    if (!rec) throw new Error('Should return default recommendation');
    if (!rec.isDefault) throw new Error('Should have isDefault flag');
  });
  test('recommend returns strategy after enough data', () => {
    const ml = make();
    for (let i = 0; i < 55; i++) ml.recordOutcome(outcome({ success: i % 2 === 0 }));
    const rec = ml.recommend('code-gen', 'x');
    if (!rec) throw new Error('Should have recommendation');
  });
  test('getModelRankings returns array', () => {
    const ml = make(); for (let i = 0; i < 55; i++) ml.recordOutcome(outcome());
    if (!Array.isArray(ml.getModelRankings('code-gen'))) throw new Error('Array');
  });
  test('handles missing fields', () => { make().recordOutcome({}); });
});
if (require.main === module) run();
