// ============================================================
// GENESIS AGENT — SafeGuard (KERNEL — IMMUTABLE)
// Prevents the agent from modifying kernel files.
// Validates all file operations before they execute.
//
// v3.5.4: lockCritical() — hash-lock safety-critical agent files
// (CodeSafetyScanner, VerificationEngine, Constants) so the agent
// cannot weaken its own safety checks via self-modification.
// ============================================================

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createLogger } = require('../agent/core/Logger');

const _log = createLogger('SafeGuard');

class SafeGuard {
  constructor(protectedPaths, rootDir) {
    this.protectedPaths = protectedPaths.map(p => path.resolve(p));
    this.rootDir = path.resolve(rootDir);
    this.kernelHashes = new Map();
    // v3.5.4: Separate map for critical agent files (hash-locked but not in kernel dir)
    this.criticalHashes = new Map();
    this.locked = false;
  }

  /** Snapshot kernel file hashes — call once at boot */
  lockKernel() {
    for (const p of this.protectedPaths) {
      this._hashRecursive(p);
    }
    this.locked = true;
    _log.info(`[SAFEGUARD] Kernel locked. ${this.kernelHashes.size} files protected.`);
  }

  /**
   * v3.5.4: Hash-lock safety-critical agent files.
   * These files are outside the kernel directory but must not be
   * weakened by self-modification. The agent CAN read them but
   * writes are blocked via validateWrite().
   *
   * Call after lockKernel() with relative paths from rootDir.
   * @param {string[]} relativePaths - Paths relative to rootDir
   * @returns {{ locked: number, missing: string[] }}
   */
  lockCritical(relativePaths) {
    const missing = [];
    for (const rel of relativePaths) {
      const abs = path.resolve(this.rootDir, rel);
      if (!fs.existsSync(abs)) {
        missing.push(rel);
        continue;
      }
      const hash = crypto
        .createHash('sha256')
        .update(fs.readFileSync(abs))
        .digest('hex');
      this.criticalHashes.set(abs, hash);
    }
    if (missing.length > 0) {
      console.warn(`[SAFEGUARD] lockCritical: ${missing.length} file(s) not found:`, missing.join(', '));
    }
    _log.info(`[SAFEGUARD] Critical files locked. ${this.criticalHashes.size} files hash-protected.`);
    return { locked: this.criticalHashes.size, missing };
  }

  _hashRecursive(target) {
    if (!fs.existsSync(target)) return;
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(target)) {
        this._hashRecursive(path.join(target, child));
      }
    } else {
      const hash = crypto
        .createHash('sha256')
        .update(fs.readFileSync(target))
        .digest('hex');
      this.kernelHashes.set(path.resolve(target), hash);
    }
  }

  /** Check if a path is protected (kernel territory) */
  isProtected(filePath) {
    const resolved = path.resolve(filePath);
    return this.protectedPaths.some(
      p => resolved === p || resolved.startsWith(p + path.sep)
    );
  }

  /**
   * v3.5.4: Check if a path is a hash-locked critical file.
   * Unlike kernel files (directory-based), critical files are
   * individual agent files locked by their SHA-256 hash.
   */
  isCritical(filePath) {
    const resolved = path.resolve(filePath);
    return this.criticalHashes.has(resolved);
  }

  /** Validate a write operation — throws if forbidden */
  validateWrite(filePath) {
    const resolved = path.resolve(filePath);

    // Rule 1: Cannot write outside project root
    if (!resolved.startsWith(this.rootDir)) {
      throw new Error(`[SAFEGUARD] Write outside project root blocked: ${filePath}`);
    }

    // Rule 2: Cannot write to kernel files
    if (this.isProtected(resolved)) {
      throw new Error(`[SAFEGUARD] Write to protected kernel file blocked: ${filePath}`);
    }

    // Rule 2b (v3.5.4): Cannot write to hash-locked critical files
    if (this.isCritical(resolved)) {
      throw new Error(`[SAFEGUARD] Write to critical safety file blocked: ${filePath}`);
    }

    // Rule 3: Cannot write to node_modules or .git internals
    if (resolved.includes('node_modules') || resolved.includes('.git' + path.sep)) {
      throw new Error(`[SAFEGUARD] Write to system directory blocked: ${filePath}`);
    }

    return true;
  }

  /** Validate a delete operation */
  validateDelete(filePath) {
    return this.validateWrite(filePath); // Same rules
  }

  /**
   * v7.3.6 #9: Validate a synchronous source read for chat context.
   *
   * Reading is laxer than writing: Genesis MAY read its own .genesis/
   * directory (identity/memory inspection), kernel files (understand
   * its own boundaries), and critical safety files (reason about what
   * it can't modify). But the same Path-Traversal and System-Directory
   * rules apply as for writes.
   *
   * Throws on:
   *   - paths outside the project root (Path-Escape defence)
   *   - .git/ internals (repository metadata exposure)
   *   - node_modules/ (irrelevant to Genesis' own code, noise)
   *
   * @param {string} filePath
   * @returns {true} on success
   * @throws Error when read would escape root or hit blacklisted paths
   */
  validateRead(filePath) {
    const resolved = path.resolve(filePath);

    // Rule 1: Cannot read outside project root (prevents ../ escape
    //         to arbitrary host files — /etc/passwd, ~/.ssh/…).
    if (!resolved.startsWith(this.rootDir)) {
      throw new Error(`[SAFEGUARD] Read outside project root blocked: ${filePath}`);
    }

    // Rule 2: Blacklist — infrastructure paths that should never be
    //         read during chat-context source access, even though
    //         they live inside the project root.
    if (resolved.includes('.git' + path.sep) || resolved.endsWith(path.sep + '.git')) {
      throw new Error(`[SAFEGUARD] Read of .git internals blocked: ${filePath}`);
    }
    if (resolved.includes('node_modules' + path.sep)) {
      throw new Error(`[SAFEGUARD] Read of node_modules blocked: ${filePath}`);
    }

    return true;
  }

  /** Verify kernel + critical file integrity — call periodically */
  verifyIntegrity() {
    const issues = [];
    // Check kernel files
    for (const [file, expectedHash] of this.kernelHashes) {
      this._checkHash(file, expectedHash, 'KERNEL', issues);
    }
    // v3.5.4: Check critical agent files
    for (const [file, expectedHash] of this.criticalHashes) {
      this._checkHash(file, expectedHash, 'CRITICAL', issues);
    }
    return { ok: issues.length === 0, issues };
  }

  _checkHash(file, expectedHash, category, issues) {
    if (!fs.existsSync(file)) {
      issues.push({ file, issue: 'MISSING', category });
      return;
    }
    const currentHash = crypto
      .createHash('sha256')
      .update(fs.readFileSync(file))
      .digest('hex');
    if (currentHash !== expectedHash) {
      issues.push({ file, issue: 'MODIFIED', category, expected: expectedHash, actual: currentHash });
    }
  }

  /** Get list of all protected files */
  getProtectedFiles() {
    return [
      ...Array.from(this.kernelHashes.keys()),
      ...Array.from(this.criticalHashes.keys()),
    ];
  }
}

module.exports = { SafeGuard };
