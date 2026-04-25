// ============================================================
// GENESIS — SelfModificationPipelineModify.js (v7.4.3 "Aufräumen II")
//
// Extracted from SelfModificationPipeline.js as part of the v7.4.3
// cleanup pass. Holds the modify family — the four methods that
// actually write code to disk:
//
//   - modify             — entry point, frozen-check, intent split
//   - _modifyWithDiff    — surgical patches via reflector.proposeDiff
//   - _modifyFullFile    — full-file regeneration via reasoning.solve
//   - _extractPatches    — multi-file patch parser
//
// Together ~250 LOC of one cohesive responsibility (Code-Schreiben),
// separated from the inspect/reflect/repair/skill/clone/greeting
// methods that stay in the pipeline core.
//
// Prototype-Delegation from the bottom of SelfModificationPipeline.js
// via Object.assign. Same pattern as SelfModelParsing (v7.4.1),
// CommandHandlersCode (v7.4.2), ContainerDiagnostics (v7.4.3 B).
// External API unchanged: pipeline.modify(message) keeps working.
// ============================================================

'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createLogger } = require('../core/Logger');
const _log = createLogger('SelfModificationPipeline');

// v7.4.3 Baustein D: mirrored from SelfModificationPipeline.js because
// the modify methods extracted here call _atomicWriteFileSync directly.
// Keeping a duplicate is preferable to exporting/re-importing across
// the split — both files belong to the same domain (Code-Schreiben)
// and the helper is small (12 LOC). If it ever changes, both copies
// must be updated; a structure test in v743-structure pins the parity.
function _atomicWriteFileSync(filePath, content, encoding = 'utf-8') {
  const dir = path.dirname(filePath);
  const tmpName = `.genesis-tmp-${crypto.randomBytes(6).toString('hex')}`;
  const tmpPath = path.join(dir, tmpName);
  try {
    fs.writeFileSync(tmpPath, content, encoding);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // Clean up temp file on failure
    try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
    throw err;
  }
}

const selfModificationPipelineModify = {

  async modify(message) {
    this._gateStats.totalAttempts++;

    // FIX v4.12.8: Circuit breaker — refuse if frozen
    if (this._frozen) {
      this._gateStats.circuitBreakerBlocked++;
      return `⛔ **Self-modification is frozen** — ${this._consecutiveFailures} consecutive failures.\n\n` +
        `Reason: ${this._frozenReason}\n\n` +
        `To resume: say "/self-repair-reset" or restart Genesis.`;
    }

    // Awareness gate — don't modify self when fragmented
    if (this._awareness) {
      try {
        const coherence = this._awareness.getCoherence();
        if (typeof coherence === 'number' && coherence < THRESHOLDS.SELFMOD_COHERENCE_MIN) {
          this._gateStats.consciousnessBlocked++;
          this._gateStats.lastBlockedAt = /** @type {*} */ (Date.now());
          this._gateStats.lastCoherence = /** @type {*} */ (coherence);
          _log.warn(`[SELFMOD] Blocked: awareness coherence too low (${coherence.toFixed(2)})`);
          this.bus.emit('selfmod:consciousness-blocked', {
            coherence: Math.round(coherence * 100) / 100,
          }, { source: 'SelfModPipeline' });
          return `⚠ **Self-modification deferred** — internal coherence is low (${(coherence * 100).toFixed(0)}%).\n\nGenesis is in a fragmented state. Self-modification is safer when coherence recovers above ${Math.round(THRESHOLDS.SELFMOD_COHERENCE_MIN * 100)}%. Try again shortly.`;
        }
      } catch (_e) { /* awareness optional — never block on error */ }
    }

    // v5.0.0: Metabolism energy gating — self-mod is expensive
    if (this._metabolism && !this._metabolism.canAfford('selfModification')) {
      this._gateStats.energyBlocked++;
      const level = this._metabolism.getEnergyLevel();
      return `⚡ **Insufficient energy for self-modification** (${level.current}/${level.max} AU).\n\nSelf-modification costs 50 AU. Wait for energy to regenerate or reduce activity.`;
    }
    if (this._metabolism) this._metabolism.consume('selfModification');

    this._gateStats.passed++;
    this.bus.emit('agent:status', { state: 'self-modifying' }, { source: 'SelfModPipeline' });

    // v7.2.3: Pre-self-mod backup. Snapshot .genesis/ before any writes.
    // If backup fails, we continue anyway — self-mod has its own safety gates
    // (PreservationInvariants, SnapshotManager rollback). But the backup
    // provides an additional safety net specifically for .genesis/ data.
    if (this._genesisBackup) {
      try {
        await this._genesisBackup.backup('pre-self-mod');
      } catch (err) {
        _log.debug('[SELFMOD] Pre-self-mod backup failed (non-fatal):', err.message);
      }
    }

    // Detect target file from message
    const fileMatch = message.match(/(?:in|bei|datei)\s+(\S+\.js)/i);
    const targetFile = fileMatch?.[1] || null;

    // Strategy 1: Try ASTDiff for precise changes (less tokens, fewer errors)
    if (this.astDiff && targetFile) {
      const result = await this._modifyWithDiff(message, targetFile);
      if (result) return result;
    }

    // Strategy 2: Fall back to full-file patch generation
    return this._modifyFullFile(message);
  },
  async _modifyWithDiff(message, targetFile) {
    const code = this.selfModel.readModule(targetFile);
    if (!code) return null;

    try {
      // Ask LLM for structured diff operations
      const diffPrompt = this.astDiff.buildDiffPrompt(targetFile, code, message);
      const response = await this.model.chat(diffPrompt, [], 'code');
      const diffs = this.astDiff.parseDiffs(response);

      if (diffs.length === 0) return null; // LLM didn't produce diffs, fall back

      // Apply diffs to code
      const { code: newCode, applied, errors } = this.astDiff.apply(code, diffs);

      if (applied === 0) return null; // Nothing changed, fall back

      // Test the modified code
      const test = await this.sandbox.testPatch(targetFile, newCode);
      if (!test.success) {
        this._recordFailure(`AST test failed: ${targetFile}`);
        this.bus.emit('agent:status', { state: 'ready' }, { source: 'SelfModPipeline' });
        return `ASTDiff test failed: ${test.error}\n\nChanges:\n${this.astDiff.describe(diffs)}`;
      }

      // FIX v3.5.0: Safety scan — reject dangerous patterns before writing
      const safety = /** @type {any} */ (this)._codeSafety.scanCode(newCode, targetFile);
      if (!safety.safe) {
        this.bus.emit('agent:status', { state: 'ready' }, { source: 'SelfModPipeline' });
        this.eventStore?.append('CODE_SAFETY_BLOCK', {
          file: targetFile, method: 'ast-diff',
          blocked: safety.blocked.map(b => b.description),
        }, 'SelfModPipeline');
        this.bus.emit('code:safety-blocked', { file: targetFile, issues: safety.blocked }, { source: 'SelfModPipeline' });
        this._recordFailure(`Safety block: ${targetFile}`);
        return `⛔ **Code Safety Block** — ${targetFile}\n\n${safety.blocked.map(b => `- **${b.description}** (${b.count}x)`).join('\n')}\n\nThe generated code contains patterns that could compromise system integrity. Modification rejected.`;
      }
      if (safety.warnings.length > 0) {
        _log.warn(`[SELF-MOD] Safety warnings for ${targetFile}:`, safety.warnings.map(w => w.description).join(', '));
        this.eventStore?.append('CODE_SAFETY_WARN', {
          file: targetFile, method: 'ast-diff', warnings: safety.warnings.map(w => w.description),
        }, 'SelfModPipeline');
      }

      // Apply — FIX v4.10.0: Atomic write (temp + rename)
      // v4.13.1 (Audit P1): Formal verification before disk write
      const verification = this._verifyCode(targetFile, newCode);
      if (!verification.pass) {
        this._recordFailure(`Verification failed: ${targetFile}: ${verification.reason}`);
        this.bus.emit('agent:status', { state: 'ready' }, { source: 'SelfModPipeline' });
        this.eventStore?.append('CODE_VERIFICATION_BLOCK', {
          file: targetFile, method: 'ast-diff', reason: verification.reason,
        }, 'SelfModPipeline');
        return `⛔ **Verification Failed** — ${targetFile}\n\n${verification.reason}\n\nCode changes rejected by VerificationEngine.`;
      }
      // v5.5.0: Self-Preservation Invariants — block changes that weaken safety
      const preservation = this._checkPreservation(targetFile, code, newCode);
      if (!preservation.pass) {
        this._recordFailure(`Preservation violation: ${targetFile}: ${preservation.reason}`);
        this.bus.emit('agent:status', { state: 'ready' }, { source: 'SelfModPipeline' });
        this.eventStore?.append('PRESERVATION_BLOCK', {
          file: targetFile, method: 'ast-diff', reason: preservation.reason,
        }, 'SelfModPipeline');
        return `⛔ **Self-Preservation Block** — ${targetFile}\n\n${preservation.reason}\n\nThis modification would weaken Genesis's safety systems. Rejected.`;
      }
      await this.selfModel.commitSnapshot('pre-diff: ' + message.slice(0, 40));
      const fullPath = path.join(this.rootDir, targetFile);
      this.guard.validateWrite(fullPath);
      _atomicWriteFileSync(fullPath, newCode, 'utf-8');
      await this.selfModel.commitSnapshot('post-diff: ' + message.slice(0, 40));
      await this.selfModel.scan();
      await this.hotReloader.reload(targetFile);

      this.eventStore?.append('CODE_MODIFIED', {
        file: targetFile, method: 'ast-diff', operations: diffs.length, success: true,
      }, 'SelfModPipeline');
      this._recordSuccess(targetFile);
      this.bus.emit('agent:status', { state: 'ready' }, { source: 'SelfModPipeline' });

      return `${this.lang.t('selfmod.astdiff_applied')}\n\n${this.astDiff.describe(diffs)}${errors.length > 0 ? '\n\n' + this.lang.t('selfmod.warnings') + ': ' + errors.join(', ') : ''}`;
    } catch (err) {
      _log.warn('[SELF-MOD] ASTDiff failed, falling back:', err.message);
      return null; // Fall back to full-file
    }
  },
  async _modifyFullFile(message) {
    // Original approach: generate full file via reasoning engine
    const result = await this.reasoning.solve(message, {
      history: [], memory: null, selfModel: this.selfModel,
    });

    const patches = this._extractPatches(result.answer);
    if (patches.length === 0) {
      this.bus.emit('agent:status', { state: 'ready' }, { source: 'SelfModPipeline' });
      return result.answer;
    }

    // Test each patch
    const tests = [];
    for (const p of patches) {
      tests.push({ file: p.file, ...(await this.sandbox.testPatch(p.file, p.code)) });
    }

    if (!tests.every(t => t.success)) {
      this._recordFailure(`Tests failed: ${tests.filter(t => !t.success).map(t => t.file).join(', ')}`);
      this.bus.emit('agent:status', { state: 'ready' }, { source: 'SelfModPipeline' });
      this.eventStore?.append('CODE_MODIFIED', { files: patches.map(p => p.file), success: false }, 'SelfModPipeline');
      return `${this.lang.t('selfmod.tests_failed')}\n${tests.filter(t => !t.success).map(t => `- ${t.file}: ${t.error}`).join('\n')}`;
    }

    // FIX v3.5.0: Safety scan all patches before writing any of them
    const allBlocked = [];
    const allWarnings = [];
    for (const p of patches) {
      const safety = /** @type {any} */ (this)._codeSafety.scanCode(p.code, p.file);
      if (!safety.safe) allBlocked.push(...safety.blocked);
      allWarnings.push(...safety.warnings);
    }
    if (allBlocked.length > 0) {
      this.bus.emit('agent:status', { state: 'ready' }, { source: 'SelfModPipeline' });
      this.eventStore?.append('CODE_SAFETY_BLOCK', {
        files: patches.map(p => p.file), method: 'full-file',
        blocked: allBlocked.map(b => b.description),
      }, 'SelfModPipeline');
      this.bus.emit('code:safety-blocked', { files: patches.map(p => p.file), issues: allBlocked }, { source: 'SelfModPipeline' });
      this._recordFailure(`Safety block: ${patches.map(p => p.file).join(', ')}`);
      return `⛔ **Code Safety Block**\n\n${allBlocked.map(b => `- **${b.description}** in \`${b.file}\` (${b.count}x)`).join('\n')}\n\nModification rejected.`;
    }
    if (allWarnings.length > 0) {
      _log.warn('[SELF-MOD] Safety warnings:', allWarnings.map(w => `${w.file}: ${w.description}`).join(', '));
      this.eventStore?.append('CODE_SAFETY_WARN', {
        files: patches.map(p => p.file), method: 'full-file',
        warnings: allWarnings.map(w => w.description),
      }, 'SelfModPipeline');
    }

    // v4.13.1 (Audit P1): Formal verification for all patches before writing
    const verifyFailed = [];
    for (const p of patches) {
      const v = this._verifyCode(p.file, p.code);
      if (!v.pass) verifyFailed.push({ file: p.file, reason: v.reason });
    }
    if (verifyFailed.length > 0) {
      this._recordFailure(`Verification failed: ${verifyFailed.map(f => f.file).join(', ')}`);
      this.bus.emit('agent:status', { state: 'ready' }, { source: 'SelfModPipeline' });
      this.eventStore?.append('CODE_VERIFICATION_BLOCK', {
        files: verifyFailed.map(f => f.file), method: 'full-file',
        reasons: verifyFailed.map(f => f.reason),
      }, 'SelfModPipeline');
      return `⛔ **Verification Failed**\n\n${verifyFailed.map(f => `- \`${f.file}\`: ${f.reason}`).join('\n')}\n\nCode changes rejected by VerificationEngine.`;
    }

    // v5.5.0: Self-Preservation Invariants — block changes that weaken safety
    const preservationFailed = [];
    for (const p of patches) {
      const oldCode = this.selfModel.readModule(p.file) || '';
      const pres = this._checkPreservation(p.file, oldCode, p.code);
      if (!pres.pass) preservationFailed.push({ file: p.file, reason: pres.reason });
    }
    if (preservationFailed.length > 0) {
      this._recordFailure(`Preservation violation: ${preservationFailed.map(f => f.file).join(', ')}`);
      this.bus.emit('agent:status', { state: 'ready' }, { source: 'SelfModPipeline' });
      this.eventStore?.append('PRESERVATION_BLOCK', {
        files: preservationFailed.map(f => f.file), method: 'full-file',
        reasons: preservationFailed.map(f => f.reason),
      }, 'SelfModPipeline');
      return `⛔ **Self-Preservation Block**\n\n${preservationFailed.map(f => `- \`${f.file}\`: ${f.reason}`).join('\n')}\n\nThese modifications would weaken Genesis's safety systems. Rejected.`;
    }

    // Snapshot + Apply — FIX v4.10.0: Atomic writes (temp + rename)
    // Validate ALL paths before writing ANY file to fail fast.
    await this.selfModel.commitSnapshot('pre: ' + message.slice(0, 40));
    for (const p of patches) {
      this.guard.validateWrite(path.join(this.rootDir, p.file));
    }
    for (const p of patches) {
      _atomicWriteFileSync(path.join(this.rootDir, p.file), p.code, 'utf-8');
    }
    await this.selfModel.commitSnapshot('post: ' + message.slice(0, 40));
    await this.selfModel.scan();
    for (const p of patches) await this.hotReloader.reload(p.file);

    this.eventStore?.append('CODE_MODIFIED', {
      files: patches.map(p => p.file), method: 'full-file', success: true,
    }, 'SelfModPipeline');
    this._recordSuccess(patches.map(p => p.file).join(', '));
    this.bus.emit('agent:status', { state: 'ready' }, { source: 'SelfModPipeline' });

    return `${this.lang.t('selfmod.applied')}\n\n${result.answer}\n\n**${this.lang.t('selfmod.files')}:** ${patches.map(p => p.file).join(', ')}`;
  },

  _extractPatches(response) {
    const patches = [];
    const rx = /(?:\/\/\s*FILE:\s*(\S+)|---\s*(\S+\.js)\s*---)\n```(?:\w+)?\n([\s\S]+?)```/g;
    let m;
    while ((m = rx.exec(response))) patches.push({ file: m[1] || m[2], code: m[3].trim() });
    return patches;
  },

};

module.exports = { selfModificationPipelineModify };
