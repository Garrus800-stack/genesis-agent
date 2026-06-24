// ============================================================
// v7.9.27 — SolutionAccumulator extraction precision.
//
// _extract fired on a single keyword anywhere in the user message and
// stored the whole response as a reusable "solution", which PromptBuilder
// then injected back into later prompts. A runtime snapshot showed one
// philosophical message double-captured: an error-fix (because the word
// "Bug" appeared) and a workflow (because the word "dann" appeared), with
// the model's prose stored as the "fix"/"procedure".
//
// The error-fix path now needs a diagnostic/help cue beside the error
// term; the workflow path now needs at least two ordinal markers. An
// ordinary conversational message no longer pollutes the solution store.
// ============================================================

'use strict';

const os = require('os');
const path = require('path');
const { describe, test, run, assert } = require('../harness');

const ROOT = path.join(__dirname, '../..');
const { SolutionAccumulator } = require(path.join(ROOT, 'src/agent/planning/SolutionAccumulator'));

function make() {
  return new SolutionAccumulator({
    bus: { emit() {}, on() {}, fire() {} },
    memory: null,
    knowledgeGraph: null,
    storageDir: os.tmpdir(),
    storage: { readJSON: () => [], writeJSON() {}, writeJSONDebounced() {} },
  });
}

// The shape of the message from the snapshot: a conceptual remark that
// happens to contain "Bug" and one "dann", with no problem being reported.
const PHILOSOPHICAL =
  'Nicht als Bug verstanden, sondern als konzeptuelle Spannung, und dann ' +
  'als Frage, wie ein System sich seiner eigenen Grenzen bewusst wird.';

describe('v7.9.27 — solution extraction precision', () => {
  test('a conceptual remark with the word "Bug" is not stored as an error-fix', () => {
    const sa = make();
    sa._extract({ message: PHILOSOPHICAL, response: 'Eine interessante Perspektive.', intent: 'general' });
    assert(!sa.solutions.some(s => s.type === 'error-fix'), 'no error-fix from bare "Bug"');
  });

  test('a single "dann" does not make a workflow', () => {
    const sa = make();
    sa._extract({ message: PHILOSOPHICAL, response: 'Eine interessante Perspektive.', intent: 'general' });
    assert(!sa.solutions.some(s => s.type === 'workflow'), 'no workflow from one "dann"');
  });

  test('the conceptual remark is captured as neither (double-capture gone)', () => {
    const sa = make();
    sa._extract({ message: PHILOSOPHICAL, response: 'Eine interessante Perspektive.', intent: 'general' });
    assert(sa.solutions.length === 0, 'conversation does not pollute the solution store');
  });

  test('a genuine error report with a help cue is still captured', () => {
    const sa = make();
    sa._extract({
      message: 'Ich bekomme einen crash beim Start — wie fixe ich das?',
      response: 'Setze die Config auf strict=false.',
      intent: 'general',
    });
    assert(sa.solutions.some(s => s.type === 'error-fix'), 'real error report captured');
  });

  test('a genuine multi-step procedure is still captured', () => {
    const sa = make();
    sa._extract({
      message: 'Erst kompilieren, dann testen, danach deployen.',
      response: 'Verstanden.',
      intent: 'general',
    });
    assert(sa.solutions.some(s => s.type === 'workflow'), 'real workflow captured');
  });
});

if (require.main === module) run();
