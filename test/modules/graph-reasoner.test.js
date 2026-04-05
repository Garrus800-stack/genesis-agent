const { describe, test, run } = require('../harness');
const { GraphReasoner } = require('../../src/agent/intelligence/GraphReasoner');
const mockKG = { search: () => [], findNodeByLabel: () => null, getEdgesFrom: () => [], getEdgesTo: () => [], getAllNodes: () => [] };
function make() { return new GraphReasoner({ bus: { emit(){} }, knowledgeGraph: mockKG, selfModel: null, config: {} }); }
describe('GraphReasoner', () => {
  test('constructs', () => { if (!make()) throw new Error('Should construct'); });
  test('impactAnalysis handles unknown node', () => {
    const gr = make();
    const result = gr.impactAnalysis('nonexistent');
    if (typeof result !== 'object') throw new Error('Should return object');
  });
  test('shortestPath handles missing nodes', () => {
    const gr = make();
    const result = gr.shortestPath('A', 'B');
    if (result !== null && !result.path) throw new Error('Should return null or path');
  });
});
if (require.main === module) run();
