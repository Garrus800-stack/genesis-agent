#!/usr/bin/env node
// ============================================================
// Test: CapabilityGuard.js — v4.10.0 Coverage
//
// Covers:
//   - Token issuance with scopes
//   - Token validation (valid, revoked, wrong scope)
//   - Token revocation (single + by module)
//   - Scope hierarchy (fs:read vs fs:write)
//   - Path-scoped validation
//   - Audit log recording
//   - Signed token integrity
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');
const os = require('os');
const fs = require('fs');

const { createBus } = require('../../src/agent/core/EventBus');

const ROOT = path.join(os.tmpdir(), 'genesis-test-capguard-' + Date.now());
fs.mkdirSync(ROOT, { recursive: true });

function mockGuard() {
  return {
    isProtected: (p) => p.includes('kernel'),
    isCritical: () => false,
    validateWrite: (p) => {
      if (p.includes('kernel')) throw new Error('kernel protected');
      return true;
    },
  };
}

const { CapabilityGuard } = require('../../src/agent/foundation/CapabilityGuard');

// v4.12.1 [P2-02]: Helper — creates a CapabilityGuard with test module grants.
// CapabilityGuard only issues tokens to modules listed in its grants whitelist.
// Tests use arbitrary module names, so we pre-register them via addGrant().
function createTestGuard() {
  const cg = new CapabilityGuard(ROOT, mockGuard(), createBus());
  // Register all test module names with the scopes they'll need
  for (const mod of ['testModule', 'auditModule', 'mod1', 'badMod', 'goodMod', 'reader']) {
    cg.addGrant(mod, 'fs:read');
    cg.addGrant(mod, 'fs:write');
  }
  return cg;
}

// ── Tests ──────────────────────────────────────────────────

describe('CapabilityGuard — Token Issuance', () => {
  test('issueToken returns a signed token string', () => {
    const cg = createTestGuard();
    const token = cg.issueToken('testModule', 'fs:read');
    assert(token, 'should return a token');
    assert(typeof token === 'string', 'token should be a string');
    assert(token.length > 10, 'token should not be trivially short');
  });

  test('issueToken records in audit log', () => {
    const cg = createTestGuard();
    cg.issueToken('auditModule', 'fs:read');
    const log = cg.getAuditLog();
    assert(log.length >= 1, 'should have audit entry');
    assert(log.some(e => e.module === 'auditModule' || (e.detail && e.detail.includes('auditModule'))),
      'audit should reference module name');
  });
});

describe('CapabilityGuard — Token Validation', () => {
  test('valid token passes validation for matching scope', () => {
    const cg = createTestGuard();
    const token = cg.issueToken('mod1', 'fs:read');
    const result = cg.validateToken(token, 'fs:read');
    assert(result === true || result?.valid === true, 'should validate for correct scope');
  });

  test('token for fs:read fails validation for fs:write', () => {
    const cg = createTestGuard();
    const token = cg.issueToken('mod1', 'fs:read');
    const result = cg.validateToken(token, 'fs:write');
    assert(result === false || result?.valid === false || result?.error,
      'read token should not authorize writes');
  });

  test('tampered token fails validation', () => {
    const cg = createTestGuard();
    const token = cg.issueToken('mod1', 'fs:read');
    const tampered = token.slice(0, -4) + 'XXXX';
    const result = cg.validateToken(tampered, 'fs:read');
    assert(result === false || result?.valid === false || result?.error,
      'tampered token should fail');
  });
});

describe('CapabilityGuard — Revocation', () => {
  test('revoked token fails validation', () => {
    const cg = createTestGuard();
    const token = cg.issueToken('mod1', 'fs:read');
    // Extract token ID — implementation dependent
    // Try revokeToken with the full signed token (some impls accept this)
    cg.revokeToken(token);
    const result = cg.validateToken(token, 'fs:read');
    assert(result === false || result?.valid === false || result?.error,
      'revoked token should fail validation');
  });

  test('revokeModule invalidates all tokens from that module', () => {
    const cg = createTestGuard();
    const t1 = cg.issueToken('badMod', 'fs:read');
    const t2 = cg.issueToken('badMod', 'fs:write');
    const t3 = cg.issueToken('goodMod', 'fs:read');
    cg.revokeModule('badMod');
    const r1 = cg.validateToken(t1, 'fs:read');
    const r3 = cg.validateToken(t3, 'fs:read');
    assert(r1 === false || r1?.valid === false || r1?.error, 'badMod token should be revoked');
    assert(r3 === true || r3?.valid === true, 'goodMod token should still work');
  });
});

describe('CapabilityGuard — Grants', () => {
  test('hasGrant returns false by default', () => {
    const cg = new CapabilityGuard(ROOT, mockGuard(), createBus());
    assert(!cg.hasGrant('unknownMod', 'exec:system'), 'should not have grant by default');
  });

  test('addGrant then hasGrant returns true', () => {
    const cg = new CapabilityGuard(ROOT, mockGuard(), createBus());
    cg.addGrant('trustedMod', 'fs:read');
    assert(cg.hasGrant('trustedMod', 'fs:read'), 'should have grant after addGrant');
  });

  test('addGrant rejects unknown scope', () => {
    const cg = new CapabilityGuard(ROOT, mockGuard(), createBus());
    let threw = false;
    try { cg.addGrant('mod', 'fs:teleport'); } catch (e) { threw = true; }
    assert(threw, 'addGrant should throw for unknown scope');
  });

  test('addGrant is idempotent — no duplicate scopes', () => {
    const cg = new CapabilityGuard(ROOT, mockGuard(), createBus());
    cg.addGrant('mod', 'fs:read');
    cg.addGrant('mod', 'fs:read');
    assertEqual(cg.grants['mod'].filter(s => s === 'fs:read').length, 1);
  });

  test('getAllGrants returns structured data', () => {
    const cg = new CapabilityGuard(ROOT, mockGuard(), createBus());
    cg.addGrant('mod1', 'fs:read');
    cg.addGrant('mod2', 'exec:sandbox');
    const all = cg.getAllGrants();
    assert(all, 'should return grants');
    assert(typeof all === 'object', 'should be an object');
  });

  test('Phase 10-13 modules have grants by default', () => {
    const cg = new CapabilityGuard(ROOT, mockGuard(), createBus());
    const newModules = [
      'SelfModificationPipeline', 'WebPerception', 'EffectorRegistry',
      'IntrospectionEngine', 'SelfOptimizer', 'GraphReasoner',
    ];
    for (const mod of newModules) {
      assert(cg.grants[mod] && cg.grants[mod].length > 0,
        `${mod} should have default grants`);
    }
  });
});

describe('CapabilityGuard — Path-scoped Validation', () => {
  test('readFile with valid token succeeds for normal path', () => {
    const cg = createTestGuard();
    const token = cg.issueToken('reader', 'fs:read');
    const targetFile = path.join(ROOT, 'test.txt');
    fs.writeFileSync(targetFile, 'hello');
    const content = cg.readFile(token, targetFile);
    assert(content !== null && content !== undefined, 'should read file content');
  });
});

// ── Grant Persistence (v4.12.1 [P2-04]) ────────────────────

describe('CapabilityGuard — Grant Persistence', () => {
  function mockStorage(dir) {
    const store = {};
    return {
      readJSON: (key, def) => store[key] !== undefined ? store[key] : def,
      writeJSON: async (key, val) => { store[key] = val; },
    };
  }

  test('persistGrants writes grants to storage', async () => {
    const cg = new CapabilityGuard(ROOT, mockGuard(), createBus());
    const storage = mockStorage(ROOT);
    await cg.persistGrants(storage);
    const saved = storage.readJSON('capability-grants.json', null);
    assert(saved !== null, 'should write to storage');
    assert(saved.version === 1, 'should include version');
    assert(typeof saved.grants === 'object', 'should include grants');
  });

  test('loadPersistedGrants restores saved grants', async () => {
    const cg1 = new CapabilityGuard(ROOT, mockGuard(), createBus());
    cg1.addGrant('DynamicModule', 'fs:read');
    cg1.addGrant('DynamicModule', 'model:query');
    const storage = mockStorage(ROOT);
    await cg1.persistGrants(storage);

    const cg2 = new CapabilityGuard(ROOT, mockGuard(), createBus());
    const loaded = cg2.loadPersistedGrants(storage);
    assert(loaded > 0, 'should load modules from persistence');
    assert(cg2.hasGrant('DynamicModule', 'fs:read'), 'should restore fs:read');
    assert(cg2.hasGrant('DynamicModule', 'model:query'), 'should restore model:query');
  });

  test('loadPersistedGrants skips unknown scopes silently', async () => {
    const storage = mockStorage(ROOT);
    storage.readJSON = () => ({
      version: 1,
      grants: { 'BadModule': ['fs:read', 'fs:teleport', 'model:query'] },
    });
    const cg = new CapabilityGuard(ROOT, mockGuard(), createBus());
    const loaded = cg.loadPersistedGrants(storage);
    assert(loaded === 1, 'should load the module despite bad scope');
    assert(cg.hasGrant('BadModule', 'fs:read'), 'should load valid scopes');
    assert(!cg.hasGrant('BadModule', 'fs:teleport'), 'should skip unknown scope');
  });

  test('loadPersistedGrants returns 0 on empty storage', () => {
    const storage = mockStorage(ROOT);
    const cg = new CapabilityGuard(ROOT, mockGuard(), createBus());
    const loaded = cg.loadPersistedGrants(storage);
    assertEqual(loaded, 0);
  });

  test('persisted grants do not override existing grants', async () => {
    // AgentCore has 'fs:write:self' by default; persisted should not remove it
    const storage = mockStorage(ROOT);
    storage.readJSON = () => ({
      version: 1,
      grants: { 'AgentCore': ['fs:read'] },  // subset of actual grants
    });
    const cg = new CapabilityGuard(ROOT, mockGuard(), createBus());
    cg.loadPersistedGrants(storage);
    // AgentCore should STILL have fs:write:self from default whitelist
    assert(cg.hasGrant('AgentCore', 'fs:write:self'), 'default grants must be preserved');
  });
});

run();
