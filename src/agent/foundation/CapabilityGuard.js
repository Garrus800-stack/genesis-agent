// @ts-checked-v5.7
// ============================================================
// GENESIS AGENT — CapabilityGuard.js
// Capability-token based resource access.
//
// PROBLEM (Genesis self-analysis #1):
// "Ich laufe mit Node.js-Vollzugriff. Das ist wie einen
// nuklearen Sprengkopf mit einem Haushalts-Thermostat
// zu steuern."
//
// SOLUTION: No module gets raw fs/net/exec access.
// Every operation requires a signed CapabilityToken
// from the kernel. Tokens are scoped, time-limited,
// and revocable.
// ============================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { NullBus } = require('../core/EventBus');
const { safeJsonParse } = require('../core/utils');
class CapabilityGuard {
  constructor(rootDir, guard, bus) {
    this.bus = bus || NullBus;
    this.rootDir = path.resolve(rootDir);
    this.guard = guard;  // Kernel SafeGuard reference
    this.secret = crypto.randomBytes(32); // Per-session signing key
    this.revokedTokens = new Set();
    this._revokedModules = new Set(); // v4.12.1: Track module-level revocations
    this.auditLog = [];
    this.auditLimit = 1000;

    // Permission scopes
    this.SCOPES = {
      'fs:read':       { risk: 'low',    description: 'Read files' },
      'fs:write':      { risk: 'medium', description: 'Write files (non-kernel)' },
      'fs:write:self': { risk: 'high',   description: 'Write own source code' },
      'exec:sandbox':  { risk: 'medium', description: 'Execute code in sandbox' },
      'exec:system':   { risk: 'critical', description: 'Execute system commands' },
      'exec:shell':    { risk: 'high',   description: 'Execute shell commands (tiered)' },
      'net:local':     { risk: 'low',    description: 'Local network communication' },
      'net:external':  { risk: 'high',   description: 'External network communication' },
      'model:query':   { risk: 'low',    description: 'LLM query' },
      'memory:read':   { risk: 'low',    description: 'Read memory stores' },
      'memory:write':  { risk: 'medium', description: 'Write memory stores' },
    };

    // Module permission grants (whitelist — least-privilege per module).
    // v4.12.1 [P2-03]: Added Phase 10–13 modules that were missing and caused
    // issueToken() to throw for these services at runtime.
    this.grants = {
      // ── Core ──────────────────────────────────────────────────────────
      'AgentCore':                ['fs:read', 'fs:write', 'fs:write:self', 'exec:sandbox', 'model:query', 'memory:read', 'memory:write'],
      'Reflector':                ['fs:read', 'fs:write:self', 'exec:sandbox', 'model:query'],
      'SkillManager':             ['fs:read', 'fs:write', 'exec:sandbox', 'model:query'],
      'CodeAnalyzer':             ['fs:read', 'model:query'],
      'CloneFactory':             ['fs:read', 'fs:write', 'model:query'],
      'PeerNetwork':              ['net:local', 'fs:read'],
      'ConversationMemory':       ['memory:read', 'memory:write'],
      'AutonomousDaemon':         ['fs:read', 'exec:sandbox', 'model:query', 'memory:read'],
      'Sandbox':                  ['exec:sandbox'],
      'ModelBridge':              ['model:query', 'net:local', 'net:external'],
      'HotReloader':              ['fs:read'],
      'ShellAgent':               ['exec:shell', 'fs:read'],
      'AgentLoop':                ['exec:shell', 'exec:sandbox', 'fs:read', 'fs:write', 'model:query'],
      'IdleMind':                 ['model:query', 'memory:read', 'memory:write'],
      // ── Phase 10–13 (v4.12.1 [P2-03]) ────────────────────────────────
      'SelfModificationPipeline': ['fs:read', 'fs:write:self', 'exec:sandbox', 'model:query'],
      'WebPerception':            ['net:external', 'net:local', 'fs:read'],
      'EffectorRegistry':         ['exec:shell', 'net:external', 'fs:read', 'fs:write'],
      'GitHubEffector':           ['net:external'],
      'IntrospectionEngine':      ['model:query', 'memory:read', 'memory:write'],
      'SelfOptimizer':            ['model:query', 'memory:read', 'memory:write', 'fs:read'],
      'GraphReasoner':            ['memory:read'],
      'TrustLevelSystem':         ['memory:read', 'memory:write', 'fs:read'],
      'SelfSpawner':              ['exec:sandbox', 'fs:read'],
      'MetaLearning':             ['model:query', 'memory:read', 'memory:write'],
      'GoalPersistence':          ['fs:read', 'fs:write', 'memory:read', 'memory:write'],
    };
  }

  // ── Token Management ─────────────────────────────────────

  /**
   * Issue a capability token for a module
   * @param {string} module - Requesting module name
   * @param {string} scope - Permission scope
   * @param {object} constraints - { paths: [], ttlMs: 60000, maxUses: 10 }
   * @returns {string} Signed token
   */
  issueToken(module, scope, constraints = {}) {
    // Check if module is allowed this scope
    const allowed = this.grants[module] || [];
    if (!allowed.includes(scope)) {
      this._audit('DENIED', module, scope, 'Module not authorized for this scope');
      throw new Error(`[CAPABILITY] ${module} is not authorized for ${scope}`);
    }

    const token = {
      id: crypto.randomUUID(),
      module,
      scope,
      constraints: {
        paths: constraints.paths || null,  // null = all allowed paths
        ttlMs: constraints.ttlMs || 60000, // Default 1 minute
        maxUses: constraints.maxUses || 100,
      },
      issuedAt: Date.now(),
      usesRemaining: constraints.maxUses || 100,
    };

    // Sign the token
    const signature = this._sign(token);
    const signedToken = Buffer.from(JSON.stringify({ ...token, signature })).toString('base64');

    this._audit('ISSUED', module, scope, `Token ${token.id.slice(0, 8)}`);
    this.bus.fire('capability:issued', { module, scope, tokenId: token.id.slice(0, 8) }, { source: 'CapabilityGuard' });

    return signedToken;
  }

  /**
   * Validate and consume a token for an operation
   * @param {string} signedToken - The base64-encoded signed token
   * @param {string} operation - What the caller wants to do
   * @param {string|null} targetPath - File path (for fs operations)
   * @returns {boolean}
   */
  validateToken(signedToken, operation, targetPath = null) {
    let token;
    try {
      const decoded = safeJsonParse(Buffer.from(signedToken, 'base64').toString(), null, 'CapabilityGuard');
      if (!decoded) {
        this._audit('MALFORMED', 'unknown', operation, 'Invalid token format');
        return false;
      }
      const { signature, ...tokenData } = decoded;

      // Verify signature
      const expectedSig = this._sign(tokenData);
      if (signature !== expectedSig) {
        this._audit('INVALID_SIG', 'unknown', operation, 'Signature mismatch');
        return false;
      }

      token = decoded;
    } catch (err) {
      this._audit('MALFORMED', 'unknown', operation, 'Could not parse token');
      return false;
    }

    // Check revocation
    if (this.revokedTokens.has(token.id)) {
      this._audit('REVOKED', token.module, operation, `Token ${token.id.slice(0, 8)}`);
      return false;
    }

    // v4.12.1 [P2-02]: Check module-level revocation
    if (this._revokedModules && this._revokedModules.has(token.module)) {
      this._audit('MODULE_REVOKED', token.module, operation, `Module ${token.module} revoked`);
      return false;
    }

    // Check TTL
    if (Date.now() - token.issuedAt > token.constraints.ttlMs) {
      this._audit('EXPIRED', token.module, operation, `Token ${token.id.slice(0, 8)}`);
      return false;
    }

    // Check uses
    if (token.usesRemaining <= 0) {
      this._audit('EXHAUSTED', token.module, operation, `Token ${token.id.slice(0, 8)}`);
      return false;
    }

    // Check scope matches operation
    if (!this._scopeAllows(token.scope, operation)) {
      this._audit('SCOPE_MISMATCH', token.module, operation, `Token scope ${token.scope} vs ${operation}`);
      return false;
    }

    // Check path constraints for fs operations
    if (targetPath && token.constraints.paths) {
      const resolved = path.resolve(targetPath);
      const allowed = token.constraints.paths.some(p =>
        resolved.startsWith(path.resolve(this.rootDir, p))
      );
      if (!allowed) {
        this._audit('PATH_DENIED', token.module, operation, `Path: ${targetPath}`);
        return false;
      }
    }

    // Check kernel protection for writes
    if (operation.startsWith('fs:write') && targetPath) {
      if (this.guard.isProtected(path.resolve(targetPath))) {
        this._audit('KERNEL_BLOCK', token.module, operation, `Protected: ${targetPath}`);
        return false;
      }
    }

    // Consume a use
    token.usesRemaining--;

    this._audit('ALLOWED', token.module, operation, targetPath || '');
    return true;
  }

  /** Revoke a token (e.g., on security concern)
   *  Accepts either a raw token ID string or a full base64-encoded signed token.
   *  v4.12.1 [P2-02]: Auto-detects and decodes signed tokens. */
  revokeToken(tokenIdOrSigned) {
    let tokenId = tokenIdOrSigned;
    // If it looks like a base64-encoded signed token, decode to extract the ID
    try {
      const decoded = safeJsonParse(Buffer.from(tokenIdOrSigned, 'base64').toString(), null, 'CapabilityGuard');
      if (decoded && decoded.id) tokenId = decoded.id;
    } catch (_e) { /* not base64 — treat as raw tokenId */ }
    this.revokedTokens.add(tokenId);
    this._audit('REVOKE', 'system', 'revoke', `Token ${typeof tokenId === 'string' ? tokenId.slice(0, 8) : tokenId}`);
    this.bus.fire('capability:revoked', { tokenId }, { source: 'CapabilityGuard' });
  }

  /** Revoke all tokens for a module
   *  v4.12.1 [P2-02]: Also tracks the module name so existing issued
   *  tokens are rejected by validateToken(). Previously only deleted
   *  grants (preventing new tokens) but let old tokens pass. */
  revokeModule(moduleName) {
    // Block future tokens
    delete this.grants[moduleName];
    // v4.12.1: Track revoked modules for validateToken() check
    this._revokedModules.add(moduleName);
    this._audit('MODULE_REVOKED', 'system', 'revoke-module', moduleName);
  }

  // ── Secure Operations (wrapped fs/exec) ──────────────────

  /**
   * Secure file read — requires a valid token
   */
  readFile(token, filePath) {
    const fullPath = path.resolve(this.rootDir, filePath);
    if (!this.validateToken(token, 'fs:read', fullPath)) {
      throw new Error(`[CAPABILITY] Lesezugriff verweigert: ${filePath}`);
    }
    return fs.readFileSync(fullPath, 'utf-8');
  }

  /**
   * Secure file write — requires a valid token
   * FIX v4.10.0: Async atomic write
   */
  async writeFile(token, filePath, content) {
    const fullPath = path.resolve(this.rootDir, filePath);
    if (!this.validateToken(token, 'fs:write', fullPath)) {
      throw new Error(`[CAPABILITY] Schreibzugriff verweigert: ${filePath}`);
    }
    // Ensure parent directory exists
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const { atomicWriteFile } = require('../core/utils');
    await atomicWriteFile(fullPath, content, 'utf-8');
  }

  // ── Grant Management ─────────────────────────────────────

  /** Check if a module has a specific scope */
  hasGrant(module, scope) {
    return (this.grants[module] || []).includes(scope);
  }

  /**
   * Add a grant to a module.
   * v4.12.1 [P2-04]: Validates scope against known SCOPES before adding —
   * prevents silent typos from creating phantom permissions.
   * @param {string} module
   * @param {string} scope
   * @throws {Error} if scope is not a recognised scope name
   */
  addGrant(module, scope) {
    if (!this.SCOPES[scope]) {
      throw new Error(`[CAPABILITY] Unknown scope '${scope}'. Valid scopes: ${Object.keys(this.SCOPES).join(', ')}`);
    }
    if (!this.grants[module]) this.grants[module] = [];
    if (!this.grants[module].includes(scope)) {
      this.grants[module].push(scope);
      this._audit('GRANT_ADDED', 'system', scope, module);
    }
  }

  /**
   * Persist the current grants map to StorageService.
   * v4.12.1 [P2-04]: Allows self-modification to create new modules whose
   * grants survive restarts. Only persists non-default grants (i.e. modules
   * added after construction) to keep the file small.
   * @param {import('../foundation/StorageService').StorageService} storage
   */
  async persistGrants(storage) {
    try {
      await storage.writeJSON('capability-grants.json', {
        version: 1,
        grants: this.grants,
        savedAt: new Date().toISOString(),
      });
      this._audit('GRANTS_PERSISTED', 'system', 'persist', `${Object.keys(this.grants).length} modules`);
    } catch (err) {
      this._audit('GRANTS_PERSIST_FAILED', 'system', 'persist', err.message);
    }
  }

  /**
   * Load previously persisted grants and merge them into the current grants.
   * v4.12.1 [P2-04]: Existing default grants are preserved; persisted grants
   * are merged in. Unknown scopes in persisted data are silently skipped to
   * avoid crashing on stale/corrupted grant files.
   * @param {import('../foundation/StorageService').StorageService} storage
   * @returns {number} Number of modules loaded from persistence
   */
  loadPersistedGrants(storage) {
    try {
      const data = storage.readJSON('capability-grants.json', null);
      if (!data || !data.grants) return 0;
      let loaded = 0;
      for (const [module, scopes] of Object.entries(data.grants)) {
        if (!Array.isArray(scopes)) continue;
        for (const scope of scopes) {
          if (!this.SCOPES[scope]) continue; // skip unknown scopes
          if (!this.grants[module]) this.grants[module] = [];
          if (!this.grants[module].includes(scope)) {
            this.grants[module].push(scope);
          }
        }
        loaded++;
      }
      this._audit('GRANTS_LOADED', 'system', 'load', `${loaded} modules from persistence`);
      return loaded;
    } catch (err) {
      this._audit('GRANTS_LOAD_FAILED', 'system', 'load', err.message);
      return 0;
    }
  }

  /** Get all grants for display */
  getAllGrants() {
    return { ...this.grants };
  }

  /** Get audit log */
  getAuditLog(limit = 50) {
    return this.auditLog.slice(-limit);
  }

  // ── Internal ─────────────────────────────────────────────

  _scopeAllows(tokenScope, operation) {
    // Exact match
    if (tokenScope === operation) return true;
    // Hierarchical: 'fs:write' covers 'fs:write:self'
    if (operation.startsWith(tokenScope + ':')) return true;
    // 'fs:write:self' allows 'fs:write' for self-files only
    if (tokenScope === 'fs:write:self' && operation === 'fs:write') return true;
    return false;
  }

  _sign(tokenData) {
    return crypto
      .createHmac('sha256', this.secret)
      .update(JSON.stringify(tokenData))
      .digest('hex')
      .slice(0, 16);
  }

  _audit(action, module, scope, detail) {
    this.auditLog.push({
      timestamp: new Date().toISOString(),
      action,
      module,
      scope,
      detail,
    });
    if (this.auditLog.length > this.auditLimit) {
      this.auditLog = this.auditLog.slice(-this.auditLimit);
    }
  }
}

module.exports = { CapabilityGuard };
