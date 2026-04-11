const { describe, test, run } = require('../harness');
const { ImmuneSystem } = require('../../src/agent/organism/ImmuneSystem');
function make() { return new ImmuneSystem({ bus: { emit(){}, fire(){}, on(){} }, storage: null, intervals: null }); }
describe('ImmuneSystem', () => {
  test('constructs', () => { if (!make()) throw new Error('Fail'); });
  test('getReport returns object', () => { if (typeof make().getReport() !== 'object') throw new Error('Should return object'); });
  test('buildPromptContext returns string', () => { if (typeof make().buildPromptContext() !== 'string') throw new Error('Should return string'); });
  test('isQuarantined returns boolean', () => { if (typeof make().isQuarantined('test') !== 'boolean') throw new Error('Should return boolean'); });
  test('start and stop lifecycle', () => { const is = make(); is.start(); is.stop(); });
});
// ── v7.1.1: Coverage expansion ────────────────────────────────

const { assert, assertEqual } = require('../harness');


function makeIS() {
  const bus = { emit(){}, fire(){}, on(){ return ()=>{}; } };
  return new ImmuneSystem({ bus });
}

describe('ImmuneSystem — isQuarantined()', () => {
  test('returns false for unknown source', () => {
    assert(!makeIS().isQuarantined('unknown'));
  });

  test('returns true for quarantined source', () => {
    const is = makeIS();
    is._quarantined.set('broken-svc', Date.now() + 60000);
    assert(is.isQuarantined('broken-svc'));
  });

  test('returns false and removes expired quarantine', () => {
    const is = makeIS();
    is._quarantined.set('expired-svc', Date.now() - 1000); // already expired
    assert(!is.isQuarantined('expired-svc'));
    assert(!is._quarantined.has('expired-svc'));
  });
});

describe('ImmuneSystem — getReport()', () => {
  test('returns report with correct structure', () => {
    const is = makeIS();
    const r = is.getReport();
    assert(Array.isArray(r.activeQuarantines));
    assert(Array.isArray(r.recentInterventions));
    assert(typeof r.immuneMemory === 'object');
    assert(typeof r.errorWindowSize === 'number');
  });

  test('report includes active quarantines', () => {
    const is = makeIS();
    is._quarantined.set('svc-a', Date.now() + 60000);
    const r = is.getReport();
    assertEqual(r.activeQuarantines.length, 1);
    assertEqual(r.activeQuarantines[0].source, 'svc-a');
    assert(r.activeQuarantines[0].expiresIn > 0);
  });
});

describe('ImmuneSystem — buildPromptContext()', () => {
  test('returns empty string with no quarantines', () => {
    assertEqual(makeIS().buildPromptContext(), '');
  });

  test('returns warning when services quarantined', () => {
    const is = makeIS();
    is._quarantined.set('bad-svc', Date.now() + 60000);
    const ctx = is.buildPromptContext();
    assert(ctx.includes('bad-svc'));
    assert(ctx.includes('IMMUNE SYSTEM'));
  });
});

if (require.main === module) run();
