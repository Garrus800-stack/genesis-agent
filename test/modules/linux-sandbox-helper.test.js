const { describe, test, run } = require('../harness');
const mod = require('../../src/agent/foundation/LinuxSandboxHelper');
describe('LinuxSandboxHelper', () => { test('exports functions', () => { if (typeof mod !== 'object' && typeof mod !== 'function') throw new Error('Should export'); }); });
if (require.main === module) run();
