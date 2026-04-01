// @ts-checked-v5.7 — unbound `this` in prototype-delegation object
// ============================================================
// GENESIS — PeerNetworkExchange.js (v5.6.0)
//
// Extracted from PeerNetwork.js — peer code exchange: fetch,
// compare, import, and validation of skills/modules.
// Attached via prototype delegation.
//
// Each method accesses PeerNetwork instance state via `this`.
// ============================================================

const fs = require('fs');
const path = require('path');
const { atomicWriteFileSync } = require('../core/utils');
const { createLogger } = require('../core/Logger');
const _log = createLogger('PeerNetwork');

const exchange = {

  fetchPeerSkill(peerId, skillName) {
    // FIX v4.13.1 (Audit F-01): Code exchange must be explicitly enabled
    if (!this.config.enableCodeExchange) throw new Error('Code exchange disabled — enable via settings');
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error(`Unknown peer: ${peerId}`);
    return this._transport.httpGet(
      `http://${peer.host}:${peer.port}/skill-code?name=${encodeURIComponent(skillName)}`,
      peer.token || this._token
    );
  },

  fetchPeerModule(peerId, moduleName) {
    // FIX v4.13.1 (Audit F-01): Code exchange must be explicitly enabled
    if (!this.config.enableCodeExchange) throw new Error('Code exchange disabled — enable via settings');
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error(`Unknown peer: ${peerId}`);
    if (moduleName.includes('..') || path.isAbsolute(moduleName)) throw new Error('Invalid module path');
    return this._transport.httpGet(
      `http://${peer.host}:${peer.port}/module-code?name=${encodeURIComponent(moduleName)}`,
      peer.token || this._token
    );
  },

  async compareWithPeer(peerId, moduleName) {
    const peerModule = await this.fetchPeerModule(peerId, moduleName);
    const ownCode = this.selfModel.readModule(moduleName);
    if (!ownCode) return { decision: 'skip', reason: 'Own module not found' };
    if (!peerModule?.code) return { decision: 'skip', reason: 'Peer module not found' };

    const metrics = {
      own: this._codeMetrics(ownCode),
      peer: this._codeMetrics(peerModule.code),
    };

    const peerSafety = this._codeSafety.scanCode(peerModule.code, `peer:${moduleName}`);
    if (!peerSafety.safe) {
      return {
        decision: 'skip',
        reason: `Peer code failed safety scan: ${peerSafety.issues.map(i => i.description).join(', ')}`,
        metrics,
      };
    }

    const truncate = (code, maxLen = 4000) => {
      if (code.length <= maxLen) return code;
      const lines = code.split('\n');
      const kept = [];
      let len = 0;
      for (const line of lines) {
        if (len + line.length > maxLen) { kept.push(`... (${lines.length - kept.length} more lines)`); break; }
        kept.push(line); len += line.length;
      }
      return kept.join('\n');
    };

    const prompt = `You are a code comparison expert.\n\nOWN CODE (${moduleName}):\n${truncate(ownCode)}\n\nPEER CODE (${moduleName} from ${peerId}):\n${truncate(peerModule.code)}\n\nCompare: Robustness, performance, maintainability.\nRespond with EXACTLY ONE verdict: OWN_BETTER / PEER_BETTER / MERGE / EQUAL\nThen a brief justification (max 3 sentences).`;

    const response = await this.model.chat(prompt, [], 'analysis');
    const llmDecision = response.match(/\b(OWN_BETTER|PEER_BETTER|MERGE|EQUAL)\b/)?.[1] || 'EQUAL';

    let finalDecision = llmDecision;
    if (llmDecision === 'PEER_BETTER' && metrics.peer.loc > metrics.own.loc * 2) {
      finalDecision = 'MERGE';
    }

    return {
      decision: finalDecision.toLowerCase().replace('_', '-'),
      llmDecision: llmDecision.toLowerCase().replace('_', '-'),
      analysis: response,
      peerCode: peerModule.code,
      metrics,
    };
  },

  _codeMetrics(code) {
    const lines = code.split('\n');
    const loc = lines.filter(l => l.trim() && !l.trim().startsWith('//')).length;
    const functionCount = (code.match(/\bfunction\b|\b=>\s*[{(]/g) || []).length;
    const requireCount = (code.match(/require\s*\(/g) || []).length;
    const tryCount = (code.match(/\btry\s*{/g) || []).length;
    return { loc, totalLines: lines.length, functionCount, requireCount, tryCount };
  },

  async importPeerSkill(peerId, skillName) {
    const peer = this.peers.get(peerId);
    if (!peer?.trusted) return { success: false, reason: 'Peer not trusted. Use trustPeer() first.' };
    if ((peer.protocol || 2) < this.minCompatVersion) {
      return { success: false, reason: `Peer protocol v${peer.protocol} incompatible (need >= v${this.minCompatVersion})` };
    }

    const peerSkill = await this.fetchPeerSkill(peerId, skillName);
    if (!peerSkill?.manifest || !peerSkill?.code) return { success: false, reason: 'Skill data incomplete' };
    if (this.skills.loadedSkills.has(skillName)) return { success: false, reason: 'Skill already exists locally' };

    if (!this._importLock) this._importLock = new Map();
    if (this._importLock.has(skillName)) {
      return { success: false, reason: `Import of "${skillName}" already in progress` };
    }
    this._importLock.set(skillName, Date.now());
    try {
      return await this._importPeerSkillInner(peerSkill, skillName, peerId);
    } finally {
      this._importLock.delete(skillName);
    }
  },

  async _importPeerSkillInner(peerSkill, skillName, peerId) {
    const manifestValid = this._validateManifest(peerSkill.manifest);
    if (!manifestValid.ok) return { success: false, reason: `Invalid manifest: ${manifestValid.error}` };

    const codeValid = this._validateImportedCode(peerSkill.code);
    if (!codeValid.ok) return { success: false, reason: `Code validation failed: ${codeValid.error}` };

    const testResult = await this.skills.sandbox.testPatch(`skills/${skillName}/index.js`, peerSkill.code);
    if (!testResult.success) return { success: false, reason: `Sandbox test failed: ${testResult.error}` };

    const skillDir = path.join(this.skills.skillsDir, skillName);
    const entryFilename = path.basename(peerSkill.manifest.entry || 'index.js');
    const manifestPath = path.join(skillDir, 'skill-manifest.json');
    const codePath = path.join(skillDir, entryFilename);

    const skillsDirResolved = path.resolve(this.skills.skillsDir);
    if (!path.resolve(manifestPath).startsWith(skillsDirResolved + path.sep)) {
      return { success: false, reason: `Path traversal blocked: manifest → ${manifestPath}` };
    }
    if (!path.resolve(codePath).startsWith(skillsDirResolved + path.sep)) {
      return { success: false, reason: `Path traversal blocked: code → ${codePath}` };
    }

    if (this.guard) {
      try {
        this.guard.validateWrite(manifestPath);
        this.guard.validateWrite(codePath);
      } catch (err) {
        return { success: false, reason: `SafeGuard blocked: ${err.message}` };
      }
    }

    if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });
    atomicWriteFileSync(manifestPath, JSON.stringify(peerSkill.manifest, null, 2), 'utf-8');
    atomicWriteFileSync(codePath, peerSkill.code, 'utf-8');
    await this.skills.loadSkills();

    this.bus.emit('peer:skill-imported', { peerId, skillName }, { source: 'PeerNetwork' });
    return { success: true, reason: `Skill "${skillName}" imported from peer "${peerId}"` };
  },

  _validateManifest(manifest) {
    if (!manifest.name || typeof manifest.name !== 'string') return { ok: false, error: 'missing name' };
    if (!manifest.description) return { ok: false, error: 'missing description' };
    if (manifest.name.length > 64) return { ok: false, error: 'name too long' };
    if (/[^a-zA-Z0-9_-]/.test(manifest.name)) return { ok: false, error: 'invalid characters in name' };
    return { ok: true };
  },

  _validateImportedCode(code) {
    if (code.length > 100000) return { ok: false, error: 'Code exceeds 100KB limit' };
    const safety = this._codeSafety.scanCode(code, 'peer-imported-skill');
    if (!safety.safe) {
      return { ok: false, error: `AST safety block: ${safety.blocked.map(b => b.description).join(', ')}` };
    }
    const criticalPatterns = ['child_process', 'environment secret', 'process.env'];
    const criticalWarnings = (safety.warnings || []).filter(w =>
      criticalPatterns.some(p => (w.description || '').toLowerCase().includes(p))
    );
    if (criticalWarnings.length > 0) {
      return { ok: false, error: `Blocked for peer import: ${criticalWarnings.map(w => w.description).join(', ')}` };
    }
    if (safety.warnings.length > 0) {
      _log.warn(`[PEER] Safety warnings for imported code:`, safety.warnings.map(w => w.description).join(', '));
    }
    return { ok: true };
  },

};

module.exports = { exchange };
