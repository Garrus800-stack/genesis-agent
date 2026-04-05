const { describe, test, run } = require('../harness');
const { SkillManager } = require('../../src/agent/capabilities/SkillManager');
describe('SkillManager', () => {
  test('constructs', () => { const sm = new SkillManager('/tmp/skills', null, null, null, null); if (!sm) throw new Error('Fail'); });
  test('listSkills returns array', () => { const sm = new SkillManager('/tmp/skills-test', null, null, null, null); const list = sm.listSkills(); if (!Array.isArray(list)) throw new Error('Should return array'); });
});
if (require.main === module) run();
