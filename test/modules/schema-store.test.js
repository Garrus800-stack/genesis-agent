const { describe, test, run } = require('../harness');
const { SchemaStore } = require('../../src/agent/planning/SchemaStore');
function make() { return new SchemaStore({ bus: { emit(){} }, storage: { readJSON: ()=>null, writeJSON: ()=>{}, writeJSONAsync: ()=>Promise.resolve() }, config: {} }); }
describe('SchemaStore', () => {
  test('store returns id', () => {
    const ss = make();
    const result = ss.store({ name: 'retry-on-fail', trigger: 'error', recommendation: 'retry', confidence: 0.8 });
    if (!result) throw new Error('Should return id or schema');
  });
  test('match returns array', () => {
    const ss = make();
    ss.store({ name: 'error-retry', trigger: 'error', recommendation: 'retry', confidence: 0.8 });
    if (!Array.isArray(ss.match({ type: 'code-gen' }))) throw new Error('Should be array');
  });
  test('get returns null for unknown', () => { if (make().get('nonexistent') !== null) throw new Error('Should be null'); });
});
if (require.main === module) run();
