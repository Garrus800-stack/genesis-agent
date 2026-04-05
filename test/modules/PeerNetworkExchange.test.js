// ============================================================
// GENESIS — PeerNetworkExchange.test.js (v5.6.0)
// Tests for the extracted code exchange delegate.
// ============================================================

const { describe, test, assert, assertEqual, assertRejects, run } = require('../harness');
const { PeerNetwork } = require('../../src/agent/hexagonal/PeerNetwork');

function makePN(overrides = {}) {
  const events = [];
  const selfModel = {
    getFullModel: () => ({ identity: 'self-id' }),
    readModule: (name) => overrides.ownCode || 'const x = 1;',
  };
  const skills = {
    loadedSkills: new Map(),
    skillsDir: '/tmp/genesis-test-skills',
    sandbox: { testPatch: async () => ({ success: true }) },
    loadSkills: async () => {},
  };
  const pn = new PeerNetwork(selfModel, skills, {
    chat: async () => overrides.llmResponse || 'EQUAL. Both are fine.',
  }, {}, {
    bus: { emit(e, d, m) { events.push({ e, d }); }, fire() {}, on() {} },
    guard: null,
  });
  pn._events = events;
  pn._codeSafety = {
    scanCode: () => overrides.safetyResult || { safe: true, blocked: [], warnings: [] },
  };
  pn._transport = {
    httpGet: async () => overrides.transportResponse || { code: 'const y = 2;', manifest: { name: 'test-skill', description: 'A test', entry: 'index.js' } },
  };
  if (overrides.peers) {
    for (const [id, peer] of Object.entries(overrides.peers)) {
      pn.peers.set(id, peer);
    }
  }
  return pn;
}

describe('PeerNetworkExchange — fetchPeerSkill', () => {
  test('throws when code exchange disabled', async () => {
    const pn = makePN();
    pn.config.enableCodeExchange = false;
    await assertRejects(
      () => pn.fetchPeerSkill('peer1', 'my-skill'),
      /Code exchange disabled/
    );
  });

  test('throws for unknown peer', async () => {
    const pn = makePN();
    pn.config.enableCodeExchange = true;
    await assertRejects(
      () => pn.fetchPeerSkill('nonexistent', 'skill'),
      /Unknown peer/
    );
  });

  test('fetches skill from known peer', async () => {
    const pn = makePN({
      peers: { peer1: { host: '127.0.0.1', port: 19420, token: 'abc' } },
    });
    pn.config.enableCodeExchange = true;
    const result = await pn.fetchPeerSkill('peer1', 'my-skill');
    assert(result.code, 'should have code');
  });
});

describe('PeerNetworkExchange — fetchPeerModule', () => {
  test('blocks path traversal', async () => {
    const pn = makePN({
      peers: { peer1: { host: '127.0.0.1', port: 19420, token: 'abc' } },
    });
    pn.config.enableCodeExchange = true;
    await assertRejects(
      () => pn.fetchPeerModule('peer1', '../../../etc/passwd'),
      /Invalid module path/
    );
  });
});

describe('PeerNetworkExchange — _codeMetrics', () => {
  test('computes basic metrics', () => {
    const pn = makePN();
    const code = `
const fs = require('fs');
const path = require('path');

function hello() {
  try {
    return 'world';
  } catch (e) {}
}

const greet = () => {
  console.log('hi');
};
`;
    const m = pn._codeMetrics(code);
    assert(m.loc > 0);
    assert(m.functionCount >= 1);
    assertEqual(m.requireCount, 2);
    assertEqual(m.tryCount, 1);
  });
});

describe('PeerNetworkExchange — _validateManifest', () => {
  test('accepts valid manifest', () => {
    const pn = makePN();
    const result = pn._validateManifest({ name: 'my-skill', description: 'A skill' });
    assert(result.ok);
  });

  test('rejects missing name', () => {
    const pn = makePN();
    const result = pn._validateManifest({ description: 'No name' });
    assert(!result.ok);
    assert(result.error.includes('name'));
  });

  test('rejects too-long name', () => {
    const pn = makePN();
    const result = pn._validateManifest({ name: 'a'.repeat(65), description: 'too long' });
    assert(!result.ok);
  });

  test('rejects invalid characters', () => {
    const pn = makePN();
    const result = pn._validateManifest({ name: 'my skill!', description: 'bad chars' });
    assert(!result.ok);
  });
});

describe('PeerNetworkExchange — _validateImportedCode', () => {
  test('accepts safe code', () => {
    const pn = makePN();
    const result = pn._validateImportedCode('const x = 1;');
    assert(result.ok);
  });

  test('rejects code exceeding 100KB', () => {
    const pn = makePN();
    const result = pn._validateImportedCode('x'.repeat(200000));
    assert(!result.ok);
    assert(result.error.includes('100KB'));
  });

  test('rejects unsafe code', () => {
    const pn = makePN({ safetyResult: { safe: false, blocked: [{ description: 'eval detected' }], warnings: [] } });
    const result = pn._validateImportedCode('eval("danger")');
    assert(!result.ok);
    assert(result.error.includes('AST safety'));
  });

  test('blocks critical warnings for peer imports', () => {
    const pn = makePN({
      safetyResult: {
        safe: true, blocked: [],
        warnings: [{ description: 'Uses child_process module' }],
      },
    });
    const result = pn._validateImportedCode('require("child_process")');
    assert(!result.ok);
    assert(result.error.includes('Blocked for peer import'));
  });
});

describe('PeerNetworkExchange — compareWithPeer', () => {
  test('skips when own code not found', async () => {
    const pn = makePN({
      ownCode: null,
      peers: { peer1: { host: '127.0.0.1', port: 19420, token: 'abc' } },
    });
    pn.config.enableCodeExchange = true;
    pn.selfModel = { readModule: () => null, getFullModel: () => ({ identity: 'self' }) };
    const result = await pn.compareWithPeer('peer1', 'missing.js');
    assertEqual(result.decision, 'skip');
  });
});

run();
