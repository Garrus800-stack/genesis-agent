// ============================================================
// GENESIS — ModuleSigner.js (v4.0.0 — Module Integrity)
//
// Signs and verifies self-modified modules. When the agent
// generates or modifies code via SelfModificationPipeline,
// the output is signed with a HMAC-SHA256 using a per-session
// secret derived from the kernel's SafeGuard hashes.
//
// Purpose:
//   - Detect tampered modules between sessions
//   - Audit trail: every signed module records who/when/why
//   - Verify integrity at boot (optional) and on hot-reload
//
// The signing secret is NOT stored on disk — it's derived from
// the kernel hash state at boot. Different kernel = different
// secret = old signatures invalidate. This is intentional.
//
// Integration:
//   SelfModPipeline.modify() → signer.sign(path, code, meta)
//   HotReloader.reload()     → signer.verify(path, code)
//   SelfModel.scan()         → signer.auditAll()
//   HealthMonitor            → signer.getStats()
// ============================================================

const crypto = require('crypto');
const path = require('path');
const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('ModuleSigner');

class ModuleSigner {
  constructor({ bus, storage, guard, rootDir }) {
    this.bus = bus || NullBus;
    this.storage = storage || null;
    this.guard = guard || null;
    this.rootDir = rootDir;

    // ── Signing Secret ──────────────────────────────────
    // Derived from kernel hashes — changes if kernel changes.
    // Not persisted to disk. Recomputed each boot.
    this._secret = this._deriveSecret();

    // ── Signature Registry ──────────────────────────────
    // Persisted: { relativePath: { hash, signature, meta, timestamp } }
    this._registry = {};

    // ── Stats ───────────────────────────────────────────
    this._stats = { signed: 0, verified: 0, failed: 0, tampered: 0 };
  }

  async asyncLoad() {
    try {
      this._registry = this.storage?.readJSON('module-signatures.json', {}) || {};
    } catch (_e) { _log.debug('[catch] signer registry load:', _e.message); this._registry = { }; }
  }

  // ════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════

  /**
   * Sign a module after self-modification.
   * @param {string} filePath - Absolute or relative path
   * @param {string} code - The signed content
   * @param {object} meta - { reason, planStep, model, timestamp }
   * @returns {{ hash: string, signature: string }}
   */
  sign(filePath, code, meta = {}) {
    const rel = this._relativize(filePath);
    const hash = this._hash(code);
    const signature = this._hmac(hash);

    this._registry[rel] = {
      hash,
      signature,
      meta: {
        reason: meta.reason || 'self-modification',
        planStep: meta.planStep || null,
        model: meta.model || null,
        timestamp: new Date().toISOString(),
      },
    };

    this._stats.signed++;
    this._persist();

    this.bus.fire('module:signed', {
      path: rel, hash: hash.slice(0, 12),
    }, { source: 'ModuleSigner' });

    return { hash, signature };
  }

  /**
   * Verify a module's integrity.
   * @param {string} filePath
   * @param {string} code - Current content
   * @returns {{ valid: boolean, reason?: string, meta?: object }}
   */
  verify(filePath, code) {
    const rel = this._relativize(filePath);
    const entry = this._registry[rel];

    if (!entry) {
      // Not signed = not self-modified = OK (original source)
      return { valid: true, reason: 'unsigned-original' };
    }

    const currentHash = this._hash(code);
    this._stats.verified++;

    if (currentHash !== entry.hash) {
      this._stats.tampered++;
      this.bus.fire('module:tampered', {
        path: rel,
        expected: entry.hash.slice(0, 12),
        actual: currentHash.slice(0, 12),
      }, { source: 'ModuleSigner' });
      return { valid: false, reason: 'hash-mismatch', meta: entry.meta };
    }

    const expectedSig = this._hmac(currentHash);
    if (expectedSig !== entry.signature) {
      this._stats.failed++;
      return { valid: false, reason: 'signature-invalid', meta: entry.meta };
    }

    return { valid: true, reason: 'verified', meta: entry.meta };
  }

  /**
   * Audit all signed modules. Returns summary.
   * @returns {{ total: number, valid: number, tampered: number, missing: number }}
   */
  auditAll() {
    const fs = require('fs');
    let valid = 0, tampered = 0, missing = 0;

    for (const [rel, entry] of Object.entries(this._registry)) {
      const abs = path.resolve(this.rootDir, rel);
      if (!fs.existsSync(abs)) {
        missing++;
        continue;
      }
      const code = fs.readFileSync(abs, 'utf-8');
      const result = this.verify(abs, code);
      if (result.valid) valid++;
      else tampered++;
    }

    return { total: Object.keys(this._registry).length, valid, tampered, missing };
  }

  /**
   * Remove signature for a file (e.g., after manual edit).
   */
  unsign(filePath) {
    const rel = this._relativize(filePath);
    delete this._registry[rel];
    this._persist();
  }

  getStats() {
    return {
      ...this._stats,
      registrySize: Object.keys(this._registry).length,
    };
  }

  getRegistry() {
    return { ...this._registry };
  }

  // ════════════════════════════════════════════════════════
  // INTERNAL
  // ════════════════════════════════════════════════════════

  _deriveSecret() {
    // Derive from kernel hashes if available
    if (this.guard && this.guard.kernelHashes && this.guard.kernelHashes.size > 0) {
      const combined = [...this.guard.kernelHashes.values()].sort().join(':');
      return crypto.createHash('sha256').update('genesis-signer:' + combined).digest('hex');
    }
    // Fallback: random per-session secret (signatures won't persist across restarts)
    return crypto.randomBytes(32).toString('hex');
  }

  _hash(content) {
    return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
  }

  _hmac(data) {
    return crypto.createHmac('sha256', this._secret).update(data).digest('hex');
  }

  _relativize(filePath) {
    const abs = path.resolve(filePath);
    if (abs.startsWith(this.rootDir)) {
      return path.relative(this.rootDir, abs).replace(/\\/g, '/');
    }
    return filePath.replace(/\\/g, '/');
  }

  _persist() {
    try {
      this.storage?.writeJSONDebounced?.('module-signatures.json', this._registry)
        || this.storage?.writeJSON?.('module-signatures.json', this._registry);
    } catch (err) {
      _log.debug('[SIGNER] Persist failed:', err.message);
    }
  }
}

module.exports = { ModuleSigner };
