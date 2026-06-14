'use strict';
// v7.9.22 Item 6 — a try-guarded missing require is informational; an unguarded one stays HIGH.
const { describe, test, assert, run, createTestRoot } = require('../harness');
const fs = require('fs');
const path = require('path');
const { Reflector } = require('../../src/agent/planning/Reflector');
const SRC = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf-8');

function makeReflector(root, modules) {
  const selfModel = { getFullModel: () => ({ modules }), rootDir: root };
  const guard = { verifyIntegrity: () => ({ ok: true, issues: [] }), isProtected: () => false };
  const sandbox = { syntaxCheck: async () => ({ valid: true }) };
  return new Reflector(selfModel, null, null, sandbox, guard);
}

describe('v7.9.22 Item 6 — missing-dependency severity by try-guard', () => {
  test('try-guarded broken require → info; unguarded broken require → high', async () => {
    const root = createTestRoot('item6');
    fs.writeFileSync(path.join(root, 'guarded.js'),   "try { require('./missing-a'); } catch (e) { /* fallback */ }\n");
    fs.writeFileSync(path.join(root, 'unguarded.js'), "const x = require('./missing-b');\nmodule.exports = x;\n");
    const r = makeReflector(root, {
      'guarded.js':   { requires: ['./missing-a'] },
      'unguarded.js': { requires: ['./missing-b'] },
    });
    const { issues } = await r.diagnose();
    const g = issues.find(i => i.type === 'missing-dependency' && i.file === 'guarded.js');
    const u = issues.find(i => i.type === 'missing-dependency' && i.file === 'unguarded.js');
    assert(g, 'guarded.js missing-dependency issue exists');
    assert(u, 'unguarded.js missing-dependency issue exists');
    assert(g.severity === 'info', `guarded require should be info, got ${g && g.severity}`);
    assert(u.severity === 'high', `unguarded require should be high, got ${u && u.severity}`);
  });

  test('conservative default: severity is HIGH unless proven guarded (static)', () => {
    const src = SRC('src/agent/planning/Reflector.js');
    assert(/let severity = 'high';/.test(src), 'severity defaults to high');
    assert(/stay HIGH/.test(src), 'parse/read-failure path keeps HIGH conservatively');
  });

  test('the syntax-only repair filter is unchanged in AutonomousDaemon (static)', () => {
    const src = SRC('src/agent/autonomy/AutonomousDaemon.js');
    assert(/filter\(\s*i\s*=>\s*i\.type\s*===\s*'syntax'\s*\)/.test(src), 'daemon still repairs only syntax issues');
  });
});

run();
