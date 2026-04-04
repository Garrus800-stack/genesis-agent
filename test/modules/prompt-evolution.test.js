const { describe, test, run } = require('../harness');
const { PromptEvolution, EVOLVABLE_SECTIONS, MIN_TRIALS_PER_ARM } = require('../../src/agent/intelligence/PromptEvolution');
function make() { return new PromptEvolution({ bus: { emit(){} }, storage: null, metaLearning: null }); }
describe('PromptEvolution', () => {
  test('getSection returns object with text', () => { const r = make().getSection('system', 'X'); if (r.text !== 'X') throw new Error('Default text'); });
  test('EVOLVABLE_SECTIONS is Set', () => { if (!(EVOLVABLE_SECTIONS instanceof Set)) throw new Error('Should be Set'); if (EVOLVABLE_SECTIONS.size < 5) throw new Error('Too few'); });
  test('MIN_TRIALS_PER_ARM is number', () => { if (typeof MIN_TRIALS_PER_ARM !== 'number') throw new Error('Number'); });
  test('getStatus returns object', () => { if (typeof make().getStatus().enabled !== 'boolean') throw new Error('Missing'); });
  test('setEnabled toggles', () => { const e = make(); e.setEnabled(false); if (e.getStatus().enabled !== false) throw new Error('Disable'); e.setEnabled(true); });
  test('buildPromptContext returns string', () => { if (typeof make().buildPromptContext() !== 'string') throw new Error('String'); });
  test('cancelExperiment handles missing', () => { make().cancelExperiment('nonexistent'); });
  test('rollback handles missing', () => { make().rollback('nonexistent'); });
  test('stop does not crash', () => { make().stop(); });
});
if (require.main === module) run();
