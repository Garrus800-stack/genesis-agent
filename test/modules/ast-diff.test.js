const { describe, test, run } = require('../harness');
const { ASTDiff } = require('../../src/agent/foundation/ASTDiff');
describe('ASTDiff', () => {
  test('constructs', () => { if (!new ASTDiff()) throw new Error('Fail'); });
  test('apply with empty diffs returns source in result', () => {
    const result = new ASTDiff().apply('const x=1;', []);
    if (result.code !== 'const x=1;') throw new Error('Should return source in code field');
    if (result.applied !== 0) throw new Error('Should apply 0');
  });
  test('parseDiffs handles empty', () => { if (!Array.isArray(new ASTDiff().parseDiffs(''))) throw new Error('Array'); });
  test('describe returns string', () => { if (typeof new ASTDiff().describe([]) !== 'string') throw new Error('String'); });
  test('buildDiffPrompt returns string', () => { if (typeof new ASTDiff().buildDiffPrompt('f.js', 'code', 'change') !== 'string') throw new Error('String'); });
});
if (require.main === module) run();
