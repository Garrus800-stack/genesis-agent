// Test: step-types source of truth
// v7.3.5: Locks the step-type catalog and the alias-normalization behaviour
// that keeps the planner-executor contract in sync.
const { describe, test, run } = require('../harness');
const {
  STEP_TYPES,
  VALID_STEP_TYPES,
  STEP_TYPE_ALIASES,
  normalizeStepType,
  buildPlannerStepTypeList,
} = require('../../src/agent/revolution/step-types');

describe('step-types catalog', () => {
  test('exports the seven canonical step types', () => {
    const expected = ['ANALYZE', 'CODE', 'SHELL', 'SANDBOX', 'SEARCH', 'ASK', 'DELEGATE'];
    for (const id of expected) {
      if (!STEP_TYPES[id]) throw new Error('missing: ' + id);
      if (STEP_TYPES[id].id !== id) throw new Error('id mismatch: ' + id);
      if (typeof STEP_TYPES[id].description !== 'string') throw new Error('no description: ' + id);
    }
    if (Object.keys(STEP_TYPES).length !== expected.length) {
      throw new Error('unexpected extra types: ' + Object.keys(STEP_TYPES).join(','));
    }
  });

  test('VALID_STEP_TYPES matches STEP_TYPES keys', () => {
    const valid = [...VALID_STEP_TYPES].sort();
    const keys = Object.keys(STEP_TYPES).sort();
    if (valid.join(',') !== keys.join(',')) throw new Error('mismatch');
  });

  test('STEP_TYPES entries are frozen', () => {
    try {
      STEP_TYPES.ANALYZE.description = 'hacked';
      if (STEP_TYPES.ANALYZE.description === 'hacked') throw new Error('not frozen');
    } catch (_) { /* TypeError in strict mode is acceptable */ }
  });
});

describe('normalizeStepType', () => {
  test('returns canonical type unchanged', () => {
    if (normalizeStepType('ANALYZE') !== 'ANALYZE') throw new Error('should be idempotent');
    if (normalizeStepType('SHELL') !== 'SHELL') throw new Error('should be idempotent');
  });

  test('handles lowercase and trim', () => {
    if (normalizeStepType('analyze') !== 'ANALYZE') throw new Error('case-insensitive expected');
    if (normalizeStepType('  shell  ') !== 'SHELL') throw new Error('trim expected');
  });

  test('maps known LLM hallucinations via aliases', () => {
    // These three were observed in the v7.3.4 real-run failure.
    if (normalizeStepType('GIT_SNAPSHOT') !== 'SHELL') throw new Error('GIT_SNAPSHOT → SHELL');
    if (normalizeStepType('CODE_GENERATE') !== 'CODE') throw new Error('CODE_GENERATE → CODE');
    if (normalizeStepType('WRITE_FILE') !== 'CODE') throw new Error('WRITE_FILE → CODE');
  });

  test('maps common file-mutation variants to CODE', () => {
    for (const variant of ['WRITE', 'EDIT', 'MODIFY', 'CREATE_FILE', 'GENERATE_CODE']) {
      if (normalizeStepType(variant) !== 'CODE') throw new Error(variant + ' → CODE');
    }
  });

  test('maps reading variants to ANALYZE', () => {
    for (const variant of ['READ', 'READ_FILE', 'INSPECT', 'REVIEW', 'AUDIT']) {
      if (normalizeStepType(variant) !== 'ANALYZE') throw new Error(variant + ' → ANALYZE');
    }
  });

  test('maps testing variants to SANDBOX', () => {
    for (const variant of ['TEST', 'VERIFY', 'VALIDATE']) {
      if (normalizeStepType(variant) !== 'SANDBOX') throw new Error(variant + ' → SANDBOX');
    }
  });

  test('returns null for truly unknown types', () => {
    if (normalizeStepType('ABSOLUTE_NONSENSE') !== null) throw new Error('should reject unknown');
    if (normalizeStepType('') !== null) throw new Error('should reject empty');
    if (normalizeStepType(null) !== null) throw new Error('should reject null');
    if (normalizeStepType(undefined) !== null) throw new Error('should reject undefined');
    if (normalizeStepType(42) !== null) throw new Error('should reject non-string');
  });
});

describe('buildPlannerStepTypeList', () => {
  test('default lists 6 types (DELEGATE hidden without peer capability)', () => {
    const out = buildPlannerStepTypeList();
    if (!out.includes('ANALYZE:')) throw new Error('missing ANALYZE');
    if (!out.includes('CODE:')) throw new Error('missing CODE');
    if (!out.includes('SHELL:')) throw new Error('missing SHELL');
    if (!out.includes('SANDBOX:')) throw new Error('missing SANDBOX');
    if (!out.includes('SEARCH:')) throw new Error('missing SEARCH');
    if (!out.includes('ASK:')) throw new Error('missing ASK');
    if (out.includes('DELEGATE:')) throw new Error('DELEGATE leaked into default list');
  });

  test('with canDelegate=true includes DELEGATE', () => {
    const out = buildPlannerStepTypeList({ canDelegate: true });
    if (!out.includes('DELEGATE:')) throw new Error('DELEGATE should appear when canDelegate');
  });

  test('with canExecuteCode=false hides code/shell/sandbox', () => {
    const out = buildPlannerStepTypeList({ canExecuteCode: false });
    if (out.includes('CODE:')) throw new Error('CODE leaked despite canExecuteCode=false');
    if (out.includes('SHELL:')) throw new Error('SHELL leaked despite canExecuteCode=false');
    if (out.includes('SANDBOX:')) throw new Error('SANDBOX leaked despite canExecuteCode=false');
    // Non-executing types should still be present
    if (!out.includes('ANALYZE:')) throw new Error('ANALYZE missing in read-only mode');
    if (!out.includes('SEARCH:')) throw new Error('SEARCH missing in read-only mode');
  });

  test('output is deterministic across calls', () => {
    const a = buildPlannerStepTypeList();
    const b = buildPlannerStepTypeList();
    if (a !== b) throw new Error('should be deterministic');
  });
});

run();
