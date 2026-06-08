'use strict';
// v7.9.21 (Point A) — the self-model scan must not descend into the root
// snapshots/ tree. SnapshotManager writes <rootDir>/snapshots/_last_good_boot/
// as a habitat copy of the whole source tree; descending it modelled every
// source module twice and produced duplicate Reflector suggestions keyed
// "snapshots/_last_good_boot/...". Root-scoped: a directory literally named
// 'snapshots' nested inside the source tree is still modelled.
const { describe, test, run, assert } = require('../harness');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { selfModelParsing } = require('../../src/agent/foundation/SelfModelParsing');

function makeModel() {
  return Object.assign({ manifest: { files: {}, modules: {} }, guard: null }, selfModelParsing);
}
function modelledKeys(m) {
  return Object.keys(m.manifest.modules).map(k => k.split(path.sep).join('/'));
}

describe('v7921 self-model scan excludes snapshots', () => {
  test('async walker: root snapshots/ not modelled, real + nested src are', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v7921-scan-async-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'x.js'), 'module.exports = {};\n');
    fs.mkdirSync(path.join(root, 'snapshots', '_last_good_boot', 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'snapshots', '_last_good_boot', 'src', 'x.js'), 'module.exports = {};\n');
    // a directory literally named 'snapshots' nested in source must NOT be skipped
    fs.mkdirSync(path.join(root, 'src', 'snapshots'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'snapshots', 'y.js'), 'module.exports = {};\n');

    const m = makeModel();
    await m._scanDirAsync(root, '');
    const keys = modelledKeys(m);

    assert(keys.includes('src/x.js'), 'real src/x.js must be modelled — got: ' + keys.join(', '));
    assert(keys.includes('src/snapshots/y.js'), 'nested src/snapshots/y.js must be modelled (root-scoped) — got: ' + keys.join(', '));
    assert(!keys.some(k => k.startsWith('snapshots/')), 'root snapshots/ must NOT be modelled — got: ' + keys.join(', '));
  });

  test('legacy sync walker: root snapshots/ excluded too', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v7921-scan-sync-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = {};\n');
    fs.mkdirSync(path.join(root, 'snapshots', 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'snapshots', 'src', 'a.js'), 'module.exports = {};\n');

    const m = makeModel();
    m._scanDir(root, '');
    const keys = modelledKeys(m);

    assert(keys.includes('src/a.js'), 'src/a.js must be modelled — got: ' + keys.join(', '));
    assert(!keys.some(k => k.startsWith('snapshots/')), 'root snapshots/ must NOT be modelled in sync walker — got: ' + keys.join(', '));
  });
});

if (require.main === module) run();
