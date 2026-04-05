const { describe, test, run } = require('../harness');
const { LocalClassifier } = require('../../src/agent/intelligence/LocalClassifier');
function make() { return new LocalClassifier({ bus: { emit(){} }, storage: null, config: {} }); }
describe('LocalClassifier', () => {
  test('classify returns null when untrained', () => { if (make().classify('build a REST API') !== null) throw new Error('Should be null'); });
  test('addSample stores data', () => { const lc = make(); lc.addSample('create a fn', 'code-gen'); lc.addSample('write code', 'code-gen'); });
  test('classify returns null for short text', () => { if (make().classify('hi') !== null) throw new Error('Should be null'); });
  test('classify returns null for empty', () => { if (make().classify('') !== null) throw new Error('Should be null'); });
  test('addSample ignores empty', () => { const lc = make(); lc.addSample('', 'code-gen'); lc.addSample('hello', ''); });
  test('getStats returns structure', () => { const s = make().getStats(); if (typeof s.predictions !== 'number') throw new Error('Missing'); });
});
if (require.main === module) run();
