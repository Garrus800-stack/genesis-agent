const { describe, test, run } = require('../harness');
const { ModelRouter } = require('../../src/agent/revolution/ModelRouter');
function mockWS(models) { return { get: () => null, getAvailableModels: () => models }; }
function mockMeta(rankings) { return { recommend: () => ({ promptStyle: 'free-text', temperature: 0.7, confidence: 0.5 }), getModelRankings: (cat) => rankings[cat] || [] }; }
describe('ModelRouter', () => {
  test('fallback when only one model', () => {
    const r = new ModelRouter({ modelBridge: { activeModel: 'qwen:7b', availableModels: [] }, metaLearning: mockMeta({}), worldState: mockWS([]) });
    const result = r.route('code-gen');
    if (!result.reason.includes('Only one model')) throw new Error('Should fallback');
  });
  test('prefers large model for code-gen', () => {
    const r = new ModelRouter({ modelBridge: { activeModel: 'qwen:7b', availableModels: [] }, metaLearning: mockMeta({}), worldState: mockWS(['qwen:7b', 'phi:2b']) });
    const result = r.route('code-gen');
    if (result.model !== 'qwen:7b') throw new Error('Should prefer larger');
  });
  test('prefers small model for classification', () => {
    const r = new ModelRouter({ modelBridge: { activeModel: 'qwen:7b', availableModels: [] }, metaLearning: mockMeta({}), worldState: mockWS(['qwen:7b', 'phi:2b']) });
    const result = r.route('classification');
    if (result.model !== 'phi:2b') throw new Error('Should prefer smaller');
  });
  test('routeWithStrategy returns fields', () => {
    const r = new ModelRouter({ modelBridge: { activeModel: 'x', availableModels: [] }, metaLearning: mockMeta({}), worldState: mockWS(['x']) });
    const result = r.routeWithStrategy('chat');
    if (typeof result.temperature !== 'number') throw new Error('Missing temp');
    if (typeof result.model !== 'string') throw new Error('Missing model');
  });
  test('stats track routed count', () => {
    const r = new ModelRouter({ modelBridge: { activeModel: 'x', availableModels: [] }, metaLearning: mockMeta({}), worldState: mockWS(['x']) });
    r.route('chat');
    r.route('code-gen');
    if (r.getStats().routed < 2) throw new Error('Should track');
  });
  test('unknown category uses chat fallback', () => {
    const r = new ModelRouter({ modelBridge: { activeModel: 'x', availableModels: [] }, metaLearning: mockMeta({}), worldState: mockWS(['x']) });
    const result = r.route('unknown-xyz');
    if (!result.model) throw new Error('Should still return model');
  });
});
if (require.main === module) run();
