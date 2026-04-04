const { describe, test, run } = require('../harness');
const { GitHubEffector } = require('../../src/agent/capabilities/GitHubEffector');
describe('GitHubEffector', () => {
  test('constructs', () => { const ge = new GitHubEffector({ bus: { emit(){} } }); if (!ge) throw new Error('Fail'); });
});
if (require.main === module) run();
