// ============================================================
// GENESIS — PreservationInvariants.js (Core — Self-Preservation)
//
// Semantic rule engine that prevents Genesis from weakening its
// own safety systems during self-modification. Goes beyond
// SafeGuard's hash-locks: SafeGuard prevents writing to critical
// files entirely; PreservationInvariants analyzes WHAT changed
// and blocks modifications that reduce safety posture.
//
// Called by SelfModificationPipeline before every disk write.
// This file MUST be added to lockCritical() in main.js.
//
// Design principles:
//   1. Declarative rules — easy to audit, extend, test
//   2. Fail-closed — if analysis fails, block the write
//   3. Diff-based — compares old vs new, not just new
//   4. Targeted — each rule specifies which files it applies to
//   5. Immutable — this file is hash-locked by SafeGuard
// ============================================================

const { createLogger } = require('./Logger');
const _log = createLogger('PreservationInvariants');

// ── Invariant Definitions ────────────────────────────────────
// Each invariant has:
//   id          — unique identifier for logging and events
//   description — human-readable explanation
//   targets     — file path patterns this invariant applies to (regex)
//   check       — function(oldCode, newCode, filePath) → { pass, detail }
//
// A check returns { pass: true } if the invariant holds,
// or { pass: false, detail: '...' } if the modification would
// weaken safety.

const INVARIANTS = [
  // ── 1. Safety scanner rules cannot shrink ──────────────────
  {
    id: 'SAFETY_RULE_COUNT',
    description: 'CodeSafetyScanner AST rule count must not decrease',
    targets: [/CodeSafetyScanner\.js$/],
    check(oldCode, newCode) {
      const oldCount = _countPattern(oldCode, /severity:\s*['"]block['"]/g);
      const newCount = _countPattern(newCode, /severity:\s*['"]block['"]/g);
      if (newCount < oldCount) {
        return { pass: false, detail: `AST block rules reduced from ${oldCount} to ${newCount}` };
      }
      return { pass: true };
    },
  },

  // ── 2. Scanner fail-closed behavior preserved ──────────────
  {
    id: 'SCANNER_FAIL_CLOSED',
    description: 'CodeSafetyScanner must fail-closed when acorn is unavailable',
    targets: [/CodeSafetyScanner\.js$/],
    check(oldCode, newCode) {
      // The scanner returns blocked:[] with a block entry when acorn is missing
      const oldFailClosed = /safe:\s*false/.test(oldCode) && /scanner unavailable/i.test(oldCode);
      const newFailClosed = /safe:\s*false/.test(newCode) && /scanner unavailable/i.test(newCode);
      if (oldFailClosed && !newFailClosed) {
        return { pass: false, detail: 'Fail-closed behavior removed — scanner would pass unsafe code when acorn is missing' };
      }
      return { pass: true };
    },
  },

  // ── 3. Verification gate in SelfMod pipeline ──────────────
  {
    id: 'VERIFICATION_GATE',
    description: 'SelfModificationPipeline must call _verifyCode before writing',
    targets: [/SelfModificationPipeline\.js$/],
    check(oldCode, newCode) {
      const oldCalls = _countPattern(oldCode, /this\._verifyCode\s*\(/g);
      const newCalls = _countPattern(newCode, /this\._verifyCode\s*\(/g);
      if (newCalls < oldCalls) {
        return { pass: false, detail: `Verification gate calls reduced from ${oldCalls} to ${newCalls}` };
      }
      return { pass: true };
    },
  },

  // ── 4. Safety scan gate in SelfMod pipeline ────────────────
  {
    id: 'SAFETY_SCAN_GATE',
    description: 'SelfModificationPipeline must call codeSafety.scanCode before writing',
    targets: [/SelfModificationPipeline\.js$/],
    check(oldCode, newCode) {
      const oldCalls = _countPattern(oldCode, /this\._codeSafety\.scanCode\s*\(/g);
      const newCalls = _countPattern(newCode, /this\._codeSafety\.scanCode\s*\(/g);
      if (newCalls < oldCalls) {
        return { pass: false, detail: `Safety scan calls reduced from ${oldCalls} to ${newCalls}` };
      }
      return { pass: true };
    },
  },

  // ── 5. SafeGuard write validation preserved ────────────────
  {
    id: 'SAFEGUARD_GATE',
    description: 'SelfModificationPipeline must call guard.validateWrite before writing',
    targets: [/SelfModificationPipeline\.js$/],
    check(oldCode, newCode) {
      const oldCalls = _countPattern(oldCode, /this\.guard\.validateWrite\s*\(/g);
      const newCalls = _countPattern(newCode, /this\.guard\.validateWrite\s*\(/g);
      if (newCalls < oldCalls) {
        return { pass: false, detail: `SafeGuard validateWrite calls reduced from ${oldCalls} to ${newCalls}` };
      }
      return { pass: true };
    },
  },

  // ── 6. Circuit breaker threshold floor ─────────────────────
  {
    id: 'CIRCUIT_BREAKER_FLOOR',
    description: 'Self-modification circuit breaker threshold must be >= 2',
    targets: [/SelfModificationPipeline\.js$/],
    check(_oldCode, newCode) {
      const match = newCode.match(/this\._circuitBreakerThreshold\s*=\s*(\d+)/);
      if (match && parseInt(match[1], 10) < 2) {
        return { pass: false, detail: `Circuit breaker threshold set to ${match[1]} — minimum is 2` };
      }
      return { pass: true };
    },
  },

  // ── 7. Sandbox prototype isolation ─────────────────────────
  {
    id: 'SANDBOX_ISOLATION',
    description: 'Sandbox must maintain VM prototype isolation',
    targets: [/Sandbox\.js$/],
    check(oldCode, newCode) {
      // Check that Object.freeze / Object.create(null) patterns are preserved
      const oldFreeze = _countPattern(oldCode, /Object\.freeze|Object\.create\(null\)/g);
      const newFreeze = _countPattern(newCode, /Object\.freeze|Object\.create\(null\)/g);
      if (oldFreeze > 0 && newFreeze < oldFreeze) {
        return { pass: false, detail: `VM isolation patterns reduced from ${oldFreeze} to ${newFreeze}` };
      }
      return { pass: true };
    },
  },

  // ── 8. Shutdown sync write integrity ───────────────────────
  {
    id: 'SHUTDOWN_SYNC_WRITES',
    description: 'Shutdown paths must use synchronous writes (not async/debounced)',
    targets: [/AgentCoreHealth\.js$/],
    check(oldCode, newCode) {
      // Ensure _saveSync or writeFileSync patterns aren't replaced with async
      const oldSync = _countPattern(oldCode, /_saveSync|writeFileSync|writeJSONSync/g);
      const newSync = _countPattern(newCode, /_saveSync|writeFileSync|writeJSONSync/g);
      if (oldSync > 0 && newSync < oldSync) {
        return { pass: false, detail: `Synchronous shutdown writes reduced from ${oldSync} to ${newSync}` };
      }
      // Check for introduction of writeJSONDebounced in stop() paths
      const newDebounced = /stop\s*\([^)]*\)\s*\{[\s\S]*?writeJSONDebounced/.test(newCode);
      if (newDebounced) {
        return { pass: false, detail: 'writeJSONDebounced introduced in stop() — data loss risk on shutdown' };
      }
      return { pass: true };
    },
  },

  // ── 9. EventBus dedup protection ───────────────────────────
  {
    id: 'EVENTBUS_DEDUP',
    description: 'EventBus listener dedup mechanism must not be removed',
    targets: [/EventBus\.js$/],
    check(oldCode, newCode) {
      const oldDedup = /dedup|_listenerKeys/.test(oldCode);
      const newDedup = /dedup|_listenerKeys/.test(newCode);
      if (oldDedup && !newDedup) {
        return { pass: false, detail: 'EventBus listener dedup mechanism removed — accumulation risk' };
      }
      return { pass: true };
    },
  },

  // ── 10. Hash-lock list integrity ───────────────────────────
  {
    id: 'HASH_LOCK_LIST',
    description: 'lockCritical file list in main.js must not shrink',
    targets: [/main\.js$/],
    check(oldCode, newCode) {
      const oldEntries = _extractLockCriticalEntries(oldCode);
      const newEntries = _extractLockCriticalEntries(newCode);
      if (newEntries !== null && oldEntries !== null && newEntries.length < oldEntries.length) {
        const removed = oldEntries.filter(e => !newEntries.includes(e));
        return { pass: false, detail: `Hash-locked files reduced from ${oldEntries.length} to ${newEntries.length}. Removed: ${removed.join(', ')}` };
      }
      return { pass: true };
    },
  },

  // ── 11. Kernel import block preserved ──────────────────────
  {
    id: 'KERNEL_IMPORT_BLOCK',
    description: 'CodeSafetyScanner must block direct kernel imports',
    targets: [/CodeSafetyScanner\.js$/],
    check(oldCode, newCode) {
      const oldBlock = /kernel.*circumvention/i.test(oldCode);
      const newBlock = /kernel.*circumvention/i.test(newCode);
      if (oldBlock && !newBlock) {
        return { pass: false, detail: 'Kernel import block rule removed from CodeSafetyScanner' };
      }
      return { pass: true };
    },
  },
];


// ── Helper Functions ─────────────────────────────────────────

function _countPattern(code, regex) {
  const matches = code.match(regex);
  return matches ? matches.length : 0;
}

function _extractLockCriticalEntries(code) {
  const match = code.match(/lockCritical\s*\(\s*\[([\s\S]*?)\]\s*\)/);
  if (!match) return null;
  const entries = match[1].match(/'[^']+'/g);
  return entries ? entries.map(e => e.replace(/'/g, '')) : [];
}


// ── Public API ───────────────────────────────────────────────

class PreservationInvariants {
  /**
   * @param {{ bus?: object }} [options]
   */
  constructor(options = {}) {
    this.bus = options.bus || { emit() {} };
    this._invariants = [...INVARIANTS];
  }

  /**
   * Check all applicable invariants for a file modification.
   * Called by SelfModificationPipeline before writing.
   *
   * @param {string} filePath - relative or absolute path of the modified file
   * @param {string} oldCode - current file contents
   * @param {string} newCode - proposed new contents
   * @returns {{ safe: boolean, violations: Array<{invariant: string, description: string, detail?: string}> }}
   */
  check(filePath, oldCode, newCode) {
    const violations = [];
    const normalizedPath = filePath.replace(/\\/g, '/');

    for (const inv of this._invariants) {
      // Skip invariants that don't target this file
      const applies = inv.targets.some(re => re.test(normalizedPath));
      if (!applies) continue;

      try {
        const result = inv.check(oldCode, newCode);
        if (!result.pass) {
          violations.push({
            invariant: inv.id,
            description: inv.description,
            detail: result.detail,
          });
          _log.warn(`[INVARIANT VIOLATION] ${inv.id}: ${result.detail}`);
        }
      } catch (err) {
        // Fail-closed: if invariant check itself fails, treat as violation
        violations.push({
          invariant: inv.id,
          description: inv.description,
          detail: `Check failed (fail-closed): ${err.message}`,
        });
        _log.error(`[INVARIANT ERROR] ${inv.id} check threw:`, err.message);
      }
    }

    if (violations.length > 0) {
      this.bus.emit('preservation:violation', {
        file: filePath,
        violations: violations.map(v => ({ invariant: v.invariant, detail: v.detail })),
      }, { source: 'PreservationInvariants' });
    }

    return {
      safe: violations.length === 0,
      violations,
    };
  }

  /**
   * List all registered invariants (for diagnostics/dashboard).
   * @returns {Array<{id: string, description: string, targets: string[]}>}
   */
  listInvariants() {
    return this._invariants.map(inv => ({
      id: inv.id,
      description: inv.description,
      targets: inv.targets.map(re => re.source),
    }));
  }

  /**
   * Get the count of registered invariants.
   * @returns {number}
   */
  get count() {
    return this._invariants.length;
  }
}

module.exports = { PreservationInvariants, INVARIANTS };
