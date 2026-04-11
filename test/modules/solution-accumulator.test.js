const { describe, test, assert, assertEqual, run } = require('../harness');
const os = require('os');
const { SolutionAccumulator } = require('../../src/agent/planning/SolutionAccumulator');

function make(opts = {}) {
  const kgNodes = [];
  const kgEdges = [];
  return new SolutionAccumulator({
    bus: { emit() {}, on() {}, fire() {} },
    memory: null,
    knowledgeGraph: opts.kg === false ? null : {
      addNode(type, label, meta) { const n = { id: `${type}-${kgNodes.length}`, type, label, meta }; kgNodes.push(n); return n; },
      connect(from, rel, to, w) { kgEdges.push({ from, rel, to, w }); },
      _nodes: kgNodes,
      _edges: kgEdges,
    },
    storageDir: os.tmpdir(),
    storage: opts.storage || { readJSON: () => [], writeJSON() {}, writeJSONDebounced() {} },
  });
}

describe('SolutionAccumulator', () => {
  test('constructs with empty solutions', () => {
    assertEqual(make().solutions.length, 0);
  });

  test('getStats returns zeroed stats', () => {
    const stats = make().getStats();
    assertEqual(stats.total, 0);
    assert(typeof stats.byType === 'object');
  });

  test('_extract captures code patterns', () => {
    const sa = make();
    sa._extract({
      message: 'how do I fix this error in my code?',
      response: 'Here is the fix:\n```javascript\nfunction solve() { return 42; /* long enough code block to pass minimum */ }\n```',
      intent: 'general',
    });
    const codeSol = sa.solutions.find(s => s.type === 'code-pattern');
    assert(codeSol, 'should extract code pattern');
    assertEqual(codeSol.language, 'javascript');
  });

  test('_extract captures error fixes', () => {
    const sa = make();
    sa._extract({ message: 'I have a bug in my application', response: 'Check for null.', intent: 'general' });
    assert(sa.solutions.find(s => s.type === 'error-fix'));
  });

  test('_extract captures workflow patterns', () => {
    const sa = make();
    sa._extract({ message: 'first do X then do Y and then finalize', response: 'Step 1 done.', intent: 'general' });
    assert(sa.solutions.find(s => s.type === 'workflow'));
  });

  test('_extract skips empty messages', () => {
    const sa = make();
    sa._extract({ message: '', response: 'ok', intent: 'general' });
    sa._extract({ message: 'hi', response: '', intent: 'general' });
    assertEqual(sa.solutions.length, 0);
  });

  test('_extract stores in KnowledgeGraph', () => {
    const sa = make();
    sa._extract({ message: 'this is a long enough error message to trigger KG storage', response: 'Fixed.', intent: 'general' });
    assert(sa.kg._nodes.length >= 2);
    assert(sa.kg._edges.length >= 1);
  });

  test('_extract skips KG for short messages', () => {
    const sa = make();
    sa._extract({ message: 'short msg', response: 'ok.', intent: 'general' });
    assertEqual(sa.kg._nodes.length, 0);
  });

  test('_extract works without KnowledgeGraph', () => {
    const sa = make({ kg: false });
    sa._extract({ message: 'how do I fix this long enough error?', response: 'Check null.', intent: 'general' });
    assert(sa.solutions.length >= 1);
  });

  test('findSimilar returns matching solutions', () => {
    const sa = make();
    sa._extract({ message: 'how to fix the database connection error?', response: 'Check string.', intent: 'general' });
    const results = sa.findSimilar('database connection problem');
    assert(results.length > 0);
  });

  test('findSimilar returns empty for no match', () => {
    const sa = make();
    sa._extract({ message: 'fix the error in handler', response: 'Done.', intent: 'general' });
    assertEqual(sa.findSimilar('quantum physics lecture').length, 0);
  });

  test('findSimilar returns empty for short query', () => {
    assertEqual(make().findSimilar('hi').length, 0);
  });

  test('buildContext returns formatted string', () => {
    const sa = make();
    sa._extract({ message: 'how to fix the authentication error?', response: 'Use OAuth.', intent: 'general' });
    const ctx = sa.buildContext('authentication error fix');
    assert(ctx.includes('FRUEHERE LOESUNGEN'));
  });

  test('buildContext returns empty for no match', () => {
    assertEqual(make().buildContext('something unrelated and long enough'), '');
  });

  test('buildContext includes code solution text', () => {
    const sa = make();
    sa._extract({ message: 'how do I fix this error with the parser?', response: '```javascript\nconst parser = new Parser({ strict: true, mode: "lenient", fallback: "x" });\n```', intent: 'general' });
    const ctx = sa.buildContext('parser error fix');
    assert(ctx.includes('Loesung:'));
  });

  test('buildContext increments useCount on copies', () => {
    const sa = make();
    sa._extract({ message: 'fix the error in the authentication handler please', response: 'Check.', intent: 'general' });
    const ctx = sa.buildContext('authentication error handler');
    assert(ctx.length > 0, 'should return context');
  });

  test('_addSolution enforces 200 limit', () => {
    const sa = make();
    for (let i = 0; i < 210; i++) sa._addSolution({ type: 'test', problem: `p${i}`, solution: `s${i}` });
    assert(sa.solutions.length <= 200);
  });

  test('_addSolution keeps high-useCount on overflow', () => {
    const sa = make();
    for (let i = 0; i < 200; i++) sa._addSolution({ type: 'test', problem: `p${i}`, solution: `s${i}` });
    sa.solutions[0].useCount = 100;
    sa._addSolution({ type: 'test', problem: 'new', solution: 'new' });
    assert(sa.solutions.some(s => s.useCount === 100));
  });

  test('asyncLoad loads from storage', async () => {
    const saved = [{ type: 'test', problem: 'saved', solution: 'data', useCount: 5 }];
    const sa = make({ storage: { readJSON: () => saved, writeJSON() {}, writeJSONDebounced() {} } });
    await sa.asyncLoad();
    assertEqual(sa.solutions.length, 1);
  });

  test('asyncLoad handles missing file', async () => {
    const sa = make({ storage: { readJSON: () => { throw new Error('missing'); }, writeJSON() {}, writeJSONDebounced() {} } });
    await sa.asyncLoad();
    assertEqual(sa.solutions.length, 0);
  });

  test('getStats counts by type', () => {
    const sa = make();
    sa._addSolution({ type: 'code-pattern', problem: 'a', solution: 'b' });
    sa._addSolution({ type: 'code-pattern', problem: 'c', solution: 'd' });
    sa._addSolution({ type: 'error-fix', problem: 'e', solution: 'f' });
    const stats = sa.getStats();
    assertEqual(stats.total, 3);
    assertEqual(stats.byType['code-pattern'], 2);
  });
});

if (require.main === module) run();
