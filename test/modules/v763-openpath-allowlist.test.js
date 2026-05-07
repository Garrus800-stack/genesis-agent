// ============================================================
// GENESIS — test/modules/v763-openpath-allowlist.test.js
//
// Regression test for v7.6.3 S2 finding: shell.openPath had no
// path-allowlist, asymmetric to the existing _externalAllowedDomains
// gate on shell.openExternal. The fix introduces _pathAllowedRoots
// covering rootDir + standard user-folders + their German localized
// siblings.
//
// SECURITY CONTRACT: gate contract: agent:open-path must reject
// paths outside the allowlist before reaching shell.openPath.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');

const { describe, test, assert, run } = require('../harness');

const ROOT = path.resolve(__dirname, '..', '..');

describe('v7.6.3 S2 — openPath path-allowlist (gate contract: agent:open-path)', () => {

  test('source-presence: _pathAllowedRoots is wired', () => {
    const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    assert(/_pathAllowedRoots/.test(src),
      '_pathAllowedRoots constant must be present');
    assert(/isUnderAllowed/.test(src),
      'isUnderAllowed check must be present');
    assert(/Path outside allowed roots/.test(src),
      'rejection error must be wired');
  });

  test('source-presence: rootDir is in the allowlist', () => {
    const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    // Find _pathAllowedRoots block
    const block = src.match(/_pathAllowedRoots\s*=\s*\[([\s\S]*?)\]/);
    assert(block, '_pathAllowedRoots block must be findable');
    assert(/agent\.rootDir/.test(block[1]),
      'rootDir must be in allowlist');
  });

  test('source-presence: standard user folders + DE localized siblings', () => {
    const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    const block = src.match(/_pathAllowedRoots\s*=\s*\[([\s\S]*?)\]/)[1];
    // EN folders
    assert(/Documents/.test(block), 'Documents in allowlist');
    assert(/Downloads/.test(block), 'Downloads in allowlist');
    assert(/Desktop/.test(block), 'Desktop in allowlist');
    assert(/Pictures/.test(block), 'Pictures in allowlist');
    assert(/Music/.test(block), 'Music in allowlist');
    assert(/Videos/.test(block), 'Videos in allowlist');
    // DE localized siblings
    assert(/Dokumente/.test(block), 'Dokumente (DE) in allowlist');
    assert(/Schreibtisch/.test(block), 'Schreibtisch (DE) in allowlist');
    assert(/Bilder/.test(block), 'Bilder (DE) in allowlist');
    assert(/Musik/.test(block), 'Musik (DE) in allowlist');
  });

  test('source-presence: sensitive system paths are NOT pre-listed', () => {
    const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    const block = src.match(/_pathAllowedRoots\s*=\s*\[([\s\S]*?)\]/)[1];
    // gate contract: agent:open-path — these MUST NOT be in the allowlist
    assert(!/['"]\/etc/.test(block), '/etc must not be in allowlist');
    assert(!/['"].*\.ssh/.test(block), '.ssh must not be in allowlist');
    assert(!/['"].*\.config/.test(block), '.config must not be pre-listed');
    assert(!/['"].*\.gnupg/.test(block), '.gnupg must not be in allowlist');
  });

  test('logical: allowlist-check rejects /etc/passwd-style paths', () => {
    // Simulate the allowlist check logic against a known sensitive path
    const os = require('os');
    const _pathAllowedRoots = [
      '/some/genesis/root',
      path.join(os.homedir(), 'Documents'),
      path.join(os.homedir(), 'Downloads'),
      path.join(os.homedir(), 'Desktop'),
    ];
    const targets = [
      '/etc/passwd',
      path.join(os.homedir(), '.ssh', 'id_rsa'),
      path.join(os.homedir(), '.config', 'secrets.json'),
      '/root/secret.key',
    ];
    for (const tgt of targets) {
      const resolvedAbs = path.resolve(tgt);
      const isUnderAllowed = _pathAllowedRoots.some(root => {
        const rootAbs = path.resolve(root) + path.sep;
        const rootSelf = path.resolve(root);
        return resolvedAbs.startsWith(rootAbs) || resolvedAbs === rootSelf;
      });
      assert(!isUnderAllowed, `${tgt} must NOT be under allowed roots`);
    }
  });

  test('logical: allowlist-check accepts paths inside allowed roots', () => {
    const os = require('os');
    const _pathAllowedRoots = [
      path.join(os.homedir(), 'Documents'),
      path.join(os.homedir(), 'Desktop'),
    ];
    const accepts = [
      path.join(os.homedir(), 'Documents'),
      path.join(os.homedir(), 'Documents', 'urlaub'),
      path.join(os.homedir(), 'Documents', 'urlaub', 'pic.png'),
      path.join(os.homedir(), 'Desktop', 'genesis'),
    ];
    for (const tgt of accepts) {
      const resolvedAbs = path.resolve(tgt);
      const isUnderAllowed = _pathAllowedRoots.some(root => {
        const rootAbs = path.resolve(root) + path.sep;
        const rootSelf = path.resolve(root);
        return resolvedAbs.startsWith(rootAbs) || resolvedAbs === rootSelf;
      });
      assert(isUnderAllowed, `${tgt} must be under allowed roots`);
    }
  });
});

run();
