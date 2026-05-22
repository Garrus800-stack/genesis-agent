// @ts-checked-v5.7
// ============================================================
// GENESIS — SkillCrystallizer.js
// v7.9.0 Phase 2 — Können-Konzept skill crystallization
//
// PURPOSE:
//   Reads the Können candidate log (gate-passed records from
//   v7.8.9 AgentLoop boundaries), clusters semantically similar
//   tasks, asks the LLM to extract a reusable skill per cluster,
//   runs CodeSafetyScanner + sandbox-init gates, persists passing
//   skills to .genesis/koennen/skills-pending/ for later inspection
//   via /skills-pending. Phase 3 (v7.9.1) HabitatOutpost will
//   promote pending skills into the active SkillManager repertoire.
//
// PIPELINE:
//   candidateLog.getCandidatesSince(now - windowMs)
//     → filter gatePass === true
//     → cluster (embedding-similarity; fallback token-overlap)
//     → patterns with ≥ minCandidatesPerPattern
//     → skip patterns in cooldown OR already in skills-pending/
//     → for each: LLM-extract → CodeSafety gate → Sandbox-init gate
//                 → write skills-pending/<name>/ → fire skill-crystallized
//     → fire dream:skills-crystallized summary
//
// EVENTS:
//   • skill-crystallized           — per successful extraction
//   • dream:skills-crystallized    — once per run (summary)
//   • skill:quarantined            — when CodeSafety or sandbox-init rejects
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('SkillCrystallizer');

const MAX_CANDIDATES_PER_RUN = 200;   // cluster O(n²) safety cap
const SIMILARITY_THRESHOLD = 0.75;
const TOKEN_OVERLAP_MIN = 2;

class SkillCrystallizer {
  /**
   * @param {{
   *   bus?: any,
   *   model?: any,
   *   candidateLog?: any,
   *   embeddingService?: any,
   *   codeSafety?: any,
   *   sandbox?: any,
   *   genesisDir?: string,
   *   settings?: any,
   *   clock?: () => number,
   * }} deps
   */
  constructor({
    bus, model, candidateLog, embeddingService,
    codeSafety, sandbox, genesisDir, settings, clock,
  } = {}) {
    this.bus = bus || NullBus;
    this.model = model || null;
    this.candidateLog = candidateLog || null;
    this.embeddingService = embeddingService || null;
    this.codeSafety = codeSafety || null;
    this.sandbox = sandbox || null;
    this._clock = clock || (() => Date.now());
    this.settings = settings || null;

    const root = genesisDir || '.genesis';
    this.pendingDir = path.join(root, 'koennen', 'skills-pending');
    this.cooldownPath = path.join(root, 'koennen', 'crystallization-cooldown.json');

    this._stats = {
      runs: 0, patternsFound: 0, crystallized: 0,
      rejectedParse: 0, rejectedSafety: 0, rejectedSandbox: 0,
      skippedCooldown: 0, skippedExisting: 0,
    };
  }

  // ── Public API ───────────────────────────────────────────

  async run() {
    this._stats.runs++;
    if (!this._isEnabled()) return { skipped: 'disabled' };
    if (!this.candidateLog) return { skipped: 'no-candidate-log' };
    if (!this.model) return { skipped: 'no-model' };

    const windowMs = this._setting('cognitive.koennen.crystallization.windowMs', 7 * 24 * 60 * 60 * 1000);
    const minN = this._setting('cognitive.koennen.crystallization.minCandidatesPerPattern', 3);
    if (!this._setting('cognitive.koennen.crystallization.llm.enabled', true)) {
      return { skipped: 'llm-disabled' };
    }

    let candidates = this.candidateLog.getCandidatesSince(this._clock() - windowMs) || [];
    candidates = candidates.filter(c => c && c.gatePass === true);
    if (candidates.length === 0) return { results: [], reason: 'no-candidates' };
    if (candidates.length > MAX_CANDIDATES_PER_RUN) {
      candidates = candidates.slice(-MAX_CANDIDATES_PER_RUN);
    }

    const clusters = await this._cluster(candidates);
    const patterns = clusters.filter(c => c.items.length >= minN);
    this._stats.patternsFound += patterns.length;

    const cooldown = this._loadCooldown();
    const cooldownMs = this._setting('cognitive.koennen.crystallization.cooldownMs', 6 * 60 * 60 * 1000);

    const results = [];
    for (const pattern of patterns) {
      const sig = this._signature(pattern);

      const cd = cooldown[sig];
      if (cd && (this._clock() - cd.lastAttempt) < cooldownMs) {
        this._stats.skippedCooldown++;
        continue;
      }
      if (this._patternAlreadyPending(sig)) {
        this._stats.skippedExisting++;
        cooldown[sig] = { lastAttempt: this._clock(), reason: 'already-tracked' };
        continue;
      }

      const r = await this._crystallizeOne(pattern, sig);
      cooldown[sig] = { lastAttempt: this._clock(), reason: r.success ? 'success' : (r.reason || 'failure') };
      results.push(r);

      if (r.success) this._stats.crystallized++;
      else if (r.reason === 'parse-failure') this._stats.rejectedParse++;
      else if (r.reason === 'codesafety') this._stats.rejectedSafety++;
      else if (r.reason === 'sandbox-init') this._stats.rejectedSandbox++;
    }

    this._persistCooldown(cooldown);

    if (results.length > 0) {
      const ok = results.filter(r => r.success).length;
      this.bus.fire('dream:skills-crystallized', {
        crystallized: ok,
        rejected: results.length - ok,
      }, { source: 'SkillCrystallizer' });
    }

    return { results };
  }

  getStats() { return { ...this._stats }; }

  /** No-op for shutdown lifecycle compliance. */
  stop() { /* no subscriptions, no intervals */ }

  // ── Pipeline steps ───────────────────────────────────────

  async _crystallizeOne(pattern, sig) {
    // v7.9.0 final: iteration loop with error feedback (Voyager pattern).
    // Configured model stays configured; errors from parser/safety/sandbox
    // flow back into the next LLM prompt so the model can self-correct.
    const maxAttempts = this._setting('cognitive.koennen.crystallization.maxAttempts', 3);
    let lastError = null;
    let lastCode = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      this.bus?.fire?.('skill:forge-attempt', {
        source: 'crystallizer',
        attempt,
        maxAttempts,
      }, { source: 'SkillCrystallizer' });

      let response;
      try {
        response = await this._extract(pattern, { attempt, lastError, lastCode });
      } catch (err) {
        // LLM-level error (timeout, network) — abort the whole forge,
        // ModelBridge fallback layer already handled what it could.
        if (attempt === maxAttempts) {
          this.bus?.fire?.('skill:forge-failed', {
            source: 'crystallizer', attempts: attempt, lastError: err.message,
          }, { source: 'SkillCrystallizer' });
          return { success: false, reason: 'llm-error', detail: err.message };
        }
        lastError = `llm error: ${err.message}`;
        continue;
      }

      const parsed = this._parseSkillResponse(response);
      if (!parsed.success) {
        lastError = `parse-failure: ${parsed.reason}`;
        lastCode = null;
        if (attempt === maxAttempts) {
          this.bus?.fire?.('skill:forge-failed', {
            source: 'crystallizer', attempts: attempt, lastError,
          }, { source: 'SkillCrystallizer' });
          return { success: false, reason: 'parse-failure', detail: parsed.reason };
        }
        continue;
      }

      if (!this.codeSafety) {
        return { success: false, reason: 'codesafety', detail: 'CodeSafetyScanner not wired' };
      }
      let safety;
      try {
        safety = this.codeSafety.scanCode(parsed.code, `skills-pending/${parsed.name}/index.js`);
      } catch (err) {
        safety = { safe: false, reasons: [`scanner-error: ${err.message}`] };
      }
      if (!safety.safe) {
        lastError = `code safety blocked: ${(safety.reasons || []).join('; ')}`;
        lastCode = parsed.code;
        if (attempt === maxAttempts) {
          this.bus.fire('skill:quarantined', {
            skillName: parsed.name, reason: 'codesafety', details: safety.reasons,
          }, { source: 'SkillCrystallizer' });
          this.bus?.fire?.('skill:forge-failed', {
            source: 'crystallizer', attempts: attempt, lastError,
          }, { source: 'SkillCrystallizer' });
          return { success: false, reason: 'codesafety', detail: safety.reasons };
        }
        continue;
      }

      const sandboxResult = await this._sandboxInitTest(parsed.code);
      if (!sandboxResult.ok) {
        lastError = `sandbox-init: ${sandboxResult.error || 'unknown'}`;
        lastCode = parsed.code;
        if (attempt === maxAttempts) {
          this.bus.fire('skill:quarantined', {
            skillName: parsed.name, reason: 'sandbox-init', details: [sandboxResult.error || 'unknown'],
          }, { source: 'SkillCrystallizer' });
          this.bus?.fire?.('skill:forge-failed', {
            source: 'crystallizer', attempts: attempt, lastError,
          }, { source: 'SkillCrystallizer' });
          return { success: false, reason: 'sandbox-init', detail: sandboxResult.error };
        }
        continue;
      }

      // v7.9.4: generate acquisitionContext — a first-person reflection
      // on what would have been the gap without this skill. Best-effort:
      // failure or timeout leaves it null, skill is still persisted.
      const acquisitionContext = await this._generateAcquisitionContext(parsed, pattern);

      const persisted = this._writePending(parsed, pattern, sig, acquisitionContext);
      if (!persisted.ok) {
        return { success: false, reason: 'write-failure', detail: persisted.error };
      }

      this.bus.fire('skill-crystallized', {
        skillName: parsed.name,
        sourceCandidateIds: pattern.items.map(i => i.candidateId).filter(Boolean),
        patternSignature: sig,
      }, { source: 'SkillCrystallizer' });
      this.bus?.fire?.('skill:forge-succeeded', {
        source: 'crystallizer',
        skillName: parsed.name,
        attempts: attempt,
      }, { source: 'SkillCrystallizer' });

      return { success: true, skillName: parsed.name };
    }

    // Should not reach here — the loop always returns or continues.
    return { success: false, reason: 'unreachable', detail: 'loop exited unexpectedly' };
  }

  async _extract(pattern, retryCtx = {}) {
    const sample = pattern.items.slice(0, 8).map((c, i) => {
      const title = (c.taskTitle || '').slice(0, 120);
      return `${i + 1}. ${title} (outcome: ${c.outcome || 'unknown'})`;
    }).join('\n');

    const maxTokens = this._setting('cognitive.koennen.crystallization.llm.maxTokens', 2000);
    const timeoutMs = this._setting('cognitive.koennen.crystallization.llm.timeoutMs', 120000);
    const { attempt = 1, lastError = null, lastCode = null } = retryCtx;
    const isRetry = attempt > 1 && lastError;

    const prompt = isRetry
      ? 'Your previous attempt to extract a reusable skill from these task samples failed. Fix the existing code rather than starting over.\n\n' +
        'Task samples:\n' + sample + '\n\n' +
        'Previous error: ' + lastError + '\n\n' +
        (lastCode ? 'Previous code (fix this):\n```javascript\n' + lastCode + '\n```\n\n' : '') +
        'Return EXACTLY two fenced blocks (manifest JSON + corrected JavaScript). Same rules as before: built-in modules only, single class with async execute(input), no shell/network/eval.'
      : 'You are observing several similar tasks that Genesis has completed.\n' +
        'Extract a reusable JavaScript skill module from the recurring pattern.\n\n' +
        'Recent task samples:\n' + sample + '\n\n' +
        'Return EXACTLY two fenced blocks:\n\n' +
        '1. A JSON manifest:\n' +
        '```json\n' +
        '{\n' +
        '  "name": "kebab-case-name",\n' +
        '  "version": "1.0.0",\n' +
        '  "description": "one-sentence summary of what this skill does",\n' +
        '  "entry": "index.js"\n' +
        '}\n' +
        '```\n\n' +
        '2. The JavaScript implementation:\n' +
        '```javascript\n' +
        'class SkillImplementation {\n' +
        '  async execute(input) {\n' +
        '    return { result: null };\n' +
        '  }\n' +
        '}\n' +
        'module.exports = { SkillImplementation };\n' +
        '```\n\n' +
        'Rules:\n' +
        '- Use ONLY built-in Node modules (fs, path, crypto). No npm dependencies.\n' +
        '- No filesystem writes outside the input/output return value.\n' +
        '- No network calls, no shell, no eval, no Function constructor.\n' +
        '- Single class with an async execute(input) method.\n' +
        '- If the pattern is too vague to crystallize safely, return empty blocks.';

    return this._withTimeout(
      this.model.chat(prompt, [], 'code', { maxTokens }),
      timeoutMs, 'llm-timeout',
    );
  }

  _parseSkillResponse(response) {
    if (!response || typeof response !== 'string') {
      return { success: false, reason: 'empty-response' };
    }
    const manifestMatch = response.match(/```(?:json)?\s*\n(\{[\s\S]*?"name"[\s\S]*?\})\s*\n```/);
    const codeMatch = response.match(/```(?:javascript|js)\s*\n([\s\S]+?)```/)
                   || response.match(/```\w*\s*\n((?:class|function|const|module\.exports)[\s\S]+?)```/);
    if (!manifestMatch || !codeMatch) {
      return { success: false, reason: 'missing-block' };
    }
    let manifest;
    try { manifest = JSON.parse(manifestMatch[1]); }
    catch (err) { return { success: false, reason: `manifest-json: ${err.message}` }; }

    if (!manifest.name || typeof manifest.name !== 'string'
        || !/^[a-z][a-z0-9-]{1,49}$/.test(manifest.name)) {
      return { success: false, reason: 'invalid-name' };
    }
    if (!manifest.description) return { success: false, reason: 'missing-description' };

    return {
      success: true,
      name: manifest.name,
      manifest: {
        name: manifest.name,
        version: manifest.version || '1.0.0',
        description: String(manifest.description).slice(0, 300),
        entry: manifest.entry || 'index.js',
      },
      code: codeMatch[1].trim(),
    };
  }

  async _sandboxInitTest(code) {
    if (!this.sandbox) return { ok: false, error: 'sandbox not wired' };
    const timeout = this._setting('cognitive.koennen.crystallization.sandbox.initTestTimeoutMs', 10000);
    const probe =
      code + '\n' +
      'const exported = module.exports || {};\n' +
      "const SkillClass = Object.values(exported).find(v => typeof v === 'function');\n" +
      "if (!SkillClass) throw new Error('No exported class');\n" +
      'const inst = new SkillClass();\n' +
      "if (typeof inst.execute !== 'function') throw new Error('No execute method');\n" +
      "console.log(JSON.stringify({ probe: 'ok' }));";
    try {
      const result = await this._withTimeout(
        this.sandbox.execute(probe, { allowRequire: false }),
        timeout, 'sandbox-timeout',
      );
      if (result && typeof result === 'object' && result.error) {
        return { ok: false, error: String(result.error).slice(0, 200) };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  _writePending(parsed, pattern, sig, acquisitionContext = null) {
    try {
      const skillDir = path.join(this.pendingDir, parsed.name);
      fs.mkdirSync(skillDir, { recursive: true });
      const enrichedManifest = {
        ...parsed.manifest,
        // v7.9.4: status field is the central lifecycle indicator.
        // 'pending' → not yet rehearsed; 'rehearsing' → first rehearsal ran;
        // 'promoted' → all four promotion criteria met; 'quarantined' →
        // Wilson-LB below threshold; 'discarded' → Genesis or user let go.
        status: 'pending',
        koennen: {
          crystallizedAt: this._clock(),
          sourceCandidateIds: pattern.items.map(i => i.candidateId).filter(Boolean).slice(0, 20),
          patternSignature: sig,
          // v7.9.4: the skill's biography — what would have been the gap
          // without it. Generated once at crystallization, never updated.
          // null if generation was disabled or failed.
          acquisitionContext: acquisitionContext,
          rehearsalCount: 0,
          rehearsedInputHashes: [],
          promotedAt: null,
          discardedAt: null,
          discardedReason: null,
        },
      };
      fs.writeFileSync(
        path.join(skillDir, 'skill-manifest.json'),
        JSON.stringify(enrichedManifest, null, 2),
        'utf8',
      );
      fs.writeFileSync(path.join(skillDir, 'index.js'), parsed.code, 'utf8');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * v7.9.4: Generate a first-person reflection on the gap this skill fills.
   * Single LLM call, ≤60 words, max ~150 tokens. Best-effort: returns null
   * on timeout or LLM error (skill still gets persisted, just without
   * biography — visible in /skill-info as "No biography").
   *
   * @param {object} parsed - { name, manifest, code }
   * @param {object} pattern - { items: [{ taskTitle }] }
   * @returns {Promise<string|null>}
   */
  async _generateAcquisitionContext(parsed, pattern) {
    if (!this._setting('cognitive.koennen.crystallization.acquisitionContext.enabled', true)) {
      return null;
    }
    if (!this.model || typeof this.model.chat !== 'function') {
      return null;
    }

    const timeoutMs = this._setting('cognitive.koennen.crystallization.acquisitionContext.timeoutMs', 30000);
    const maxLength = this._setting('cognitive.koennen.crystallization.acquisitionContext.maxLength', 500);

    const tasks = pattern.items
      .slice(0, 5)
      .map((c, i) => `${i + 1}. ${(c.taskTitle || '').slice(0, 100)}`)
      .join('\n');

    const prompt =
      'You just crystallized a skill from these repeated tasks:\n' +
      tasks + '\n\n' +
      'The skill does: ' + (parsed.manifest.description || '').slice(0, 200) + '\n\n' +
      'Answer in ONE sentence (max 60 words), first-person, as Genesis reflecting:\n' +
      '"If this skill had never existed, what would have been the gap?"\n\n' +
      'Be specific. Not "I could not do X" — but "I would have rebuilt Y from\n' +
      'scratch every time" or "Each request would have cost me Z more steps".\n' +
      'Concrete and honest. Return only the sentence, no quotes, no preamble.';

    try {
      const response = await this._withTimeout(
        this.model.chat(prompt, [], 'analysis'),
        timeoutMs,
        'acquisition-context-timeout',
      );
      if (!response || typeof response !== 'string') return null;
      const cleaned = response.trim().replace(/^["']|["']$/g, '').slice(0, maxLength);
      return cleaned || null;
    } catch (err) {
      _log.debug(`[CRYSTALLIZE] acquisition-context generation failed: ${err.message}`);
      return null;
    }
  }

  // ── Clustering ──────────────────────────────────────────

  async _cluster(candidates) {
    if (candidates.length === 0) return [];
    if (!this.embeddingService || typeof this.embeddingService.embed !== 'function') {
      return this._clusterByTokens(candidates);
    }

    let embeds;
    try {
      embeds = await Promise.all(candidates.map(c =>
        this.embeddingService.embed(String(c.taskTitle || '').slice(0, 200)).catch(() => null),
      ));
    } catch {
      return this._clusterByTokens(candidates);
    }
    if (embeds.some(e => !e)) return this._clusterByTokens(candidates);

    const clusters = [];
    for (let i = 0; i < candidates.length; i++) {
      let placed = false;
      for (const cluster of clusters) {
        const sim = this._cosineSim(embeds[i], cluster.centroid);
        if (sim >= SIMILARITY_THRESHOLD) {
          cluster.items.push(candidates[i]);
          cluster.centroid = this._averageVec(cluster.centroid, embeds[i], cluster.items.length);
          placed = true;
          break;
        }
      }
      if (!placed) clusters.push({ items: [candidates[i]], centroid: embeds[i].slice() });
    }
    return clusters;
  }

  _clusterByTokens(candidates) {
    const clusters = [];
    for (const c of candidates) {
      const tokens = this._tokenize(c.taskTitle || '');
      let placed = false;
      for (const cluster of clusters) {
        if (this._countOverlap(tokens, cluster.tokens) >= TOKEN_OVERLAP_MIN) {
          cluster.items.push(c);
          for (const t of tokens) cluster.tokens.add(t);
          placed = true;
          break;
        }
      }
      if (!placed) clusters.push({ items: [c], tokens: new Set(tokens) });
    }
    return clusters;
  }

  _tokenize(title) {
    return String(title || '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2 && !STOPWORDS.has(t));
  }

  _countOverlap(arr, set) {
    let n = 0;
    for (const t of arr) if (set.has(t)) n++;
    return n;
  }

  _cosineSim(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  _averageVec(centroid, vec, count) {
    const out = new Array(centroid.length);
    const w = (count - 1) / count;
    for (let i = 0; i < centroid.length; i++) {
      out[i] = centroid[i] * w + vec[i] * (1 / count);
    }
    return out;
  }

  // ── Cooldown + existence ────────────────────────────────

  _signature(pattern) {
    const tokens = new Set();
    for (const c of pattern.items.slice(0, 5)) {
      for (const t of this._tokenize(c.taskTitle)) tokens.add(t);
    }
    const top = [...tokens].sort().slice(0, 5).join('|');
    return crypto.createHash('sha256').update(top).digest('hex');
  }

  /**
   * v7.9.0 Phase 2: only checks skills-pending/ — Phase 3 (v7.9.1)
   * will extend this to include skills-promoted/ and skills-quarantined/.
   */
  _patternAlreadyPending(sig) {
    if (!fs.existsSync(this.pendingDir)) return false;
    let entries;
    try { entries = fs.readdirSync(this.pendingDir, { withFileTypes: true }); }
    catch { return false; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const manifestPath = path.join(this.pendingDir, e.name, 'skill-manifest.json');
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (m.koennen && m.koennen.patternSignature === sig) return true;
      } catch { /* malformed — skip */ }
    }
    return false;
  }

  _loadCooldown() {
    if (!fs.existsSync(this.cooldownPath)) return {};
    try { return JSON.parse(fs.readFileSync(this.cooldownPath, 'utf8')); }
    catch { return {}; }
  }

  _persistCooldown(state) {
    try {
      fs.mkdirSync(path.dirname(this.cooldownPath), { recursive: true });
      fs.writeFileSync(this.cooldownPath, JSON.stringify(state, null, 2), 'utf8');
    } catch (err) {
      _log.warn(`[CRYSTALLIZE] cooldown persist failed: ${err.message}`);
    }
  }

  // ── Helpers ─────────────────────────────────────────────

  _isEnabled() {
    return this._setting('cognitive.koennen.enabled', true)
        && this._setting('cognitive.koennen.crystallization.enabled', true);
  }

  _setting(p, fallback) {
    if (!this.settings || typeof this.settings.get !== 'function') return fallback;
    try {
      const v = this.settings.get(p);
      return v == null ? fallback : v;
    } catch { return fallback; }
  }

  _withTimeout(promise, ms, tag) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(tag || `timeout-${ms}ms`)), ms);
      Promise.resolve(promise).then(
        (v) => { clearTimeout(t); resolve(v); },
        (e) => { clearTimeout(t); reject(e); },
      );
    });
  }
}

const STOPWORDS = new Set([
  'the','and','for','with','from','into','this','that','these','those',
  'der','die','das','und','oder','mit','aus','auf','fuer','fur',
  'eine','einen','einer','sein','ist',
  'task','goal','goals','tasks','doing','using','help',
]);

module.exports = { SkillCrystallizer };
