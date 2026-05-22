// @ts-check
// ============================================================
// GENESIS — activities/SkillRehearsal.js (v7.9.4)
// ------------------------------------------------------------
// The 16th IdleMind activity. During idle, Genesis picks a
// pending or rehearsing Können skill, generates a plausible
// input via LLM (with empty-object fallback), executes the
// skill through SkillManager.executeSkillByManifest, records
// the outcome to SkillEffectivenessTracker, and updates the
// skill manifest's rehearsalCount + rehearsedInputHashes.
//
// First rehearsal transitions status pending → rehearsing.
// All further updates are atomic via atomicWriteFileSync.
//
// BOOST:
//   curiosity-driven (0.5 + curiosity multiplier)
//   pendingCount-scaled (up to 1.6× when many skills wait)
//
// COOLDOWN: 10 min — shorter than typical because rehearsals
// are quick and there's natural variety from picking the
// least-rehearsed skill each time.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWriteFileSync, safeJsonParse } = require('../../core/utils');
const { createLogger } = require('../../core/Logger');
const _log = createLogger('SkillRehearsal');

const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;

module.exports = {
  name: 'skill-rehearsal',
  weight: 1.0,
  cooldown: DEFAULT_COOLDOWN_MS,

  shouldTrigger(ctx) {
    const sm = ctx.services?.skillManager;
    const tracker = ctx.services?.effectivenessTracker;
    if (!sm || !tracker) return 0;
    if (!sm.koennenDir) return 0;
    if (!fs.existsSync(sm.koennenDir)) return 0;

    const pendingCount = _countPending(sm.koennenDir);
    if (pendingCount === 0) return 0;

    let boost = 1.0;

    // Curiosity drives skill exploration.
    const cur = ctx.snap?.genomeTraits?.curiosity;
    if (typeof cur === 'number') boost *= (0.5 + cur);

    // More pending skills → more rehearsal pressure (capped 1.6).
    boost *= Math.min(1.6, 1 + 0.15 * pendingCount);

    return boost;
  },

  async run(idleMind) {
    const sm = idleMind.skillManager;
    const tracker = idleMind.effectivenessTracker;
    if (!sm || !tracker || !sm.koennenDir) return null;

    const target = _pickRehearsalTarget(sm.koennenDir);
    if (!target) return null;

    const input = await _generateRehearsalInput(target, idleMind);

    let resultText;
    try {
      const result = await sm.executeSkillByManifest(target.name, target.dir, input, {
        source: 'rehearsal',
      });
      const ok = !result.error;
      _updateAfterRehearsal(target, input, ok);
      _fireRehearsedEvent(idleMind.bus, target.name, ok);
      const errSuffix = result.error ? ' (' + String(result.error).slice(0, 80) + ')' : '';
      resultText = `Rehearsed ${target.name}: ${ok ? 'ok' : 'error'}${errSuffix}`;
    } catch (err) {
      _updateAfterRehearsal(target, input, false);
      _fireRehearsedEvent(idleMind.bus, target.name, false);
      resultText = `Rehearsed ${target.name}: exception (${err.message.slice(0, 80)})`;
    }
    return resultText;
  },
};

// ── Helpers ─────────────────────────────────────────────────

/**
 * Count pending+rehearsing skills in koennenDir.
 */
function _countPending(koennenDir) {
  let n = 0;
  try {
    for (const entry of fs.readdirSync(koennenDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(koennenDir, entry.name, 'skill-manifest.json');
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const m = safeJsonParse(fs.readFileSync(manifestPath, 'utf-8'), null, 'SkillRehearsal');
        if (!m) continue;
        // Legacy manifests without status default to 'pending' for counting purposes.
        const status = m.status || 'pending';
        if (status === 'pending' || status === 'rehearsing') n++;
      } catch { /* malformed → skip */ }
    }
  } catch { /* dir gone → 0 */ }
  return n;
}

/**
 * Pick the skill with fewest rehearsals (oldest as tiebreaker).
 */
function _pickRehearsalTarget(koennenDir) {
  let entries;
  try {
    entries = fs.readdirSync(koennenDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(koennenDir, entry.name);
    const manifestPath = path.join(dir, 'skill-manifest.json');
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const m = safeJsonParse(fs.readFileSync(manifestPath, 'utf-8'), null, 'SkillRehearsal');
      if (!m) continue;
      const status = m.status || 'pending';
      if (status !== 'pending' && status !== 'rehearsing') continue;
      candidates.push({
        name: m.name,
        dir,
        manifest: m,
        manifestPath,
        rehearsals: m.koennen?.rehearsalCount || 0,
        crystallizedAt: m.koennen?.crystallizedAt || 0,
      });
    } catch { /* malformed → skip */ }
  }

  if (candidates.length === 0) return null;

  // Sort: fewest rehearsals first, oldest first as tiebreaker.
  candidates.sort((a, b) => {
    if (a.rehearsals !== b.rehearsals) return a.rehearsals - b.rehearsals;
    return a.crystallizedAt - b.crystallizedAt;
  });

  return candidates[0];
}

/**
 * Generate plausible input via LLM. Falls back to {} on any failure.
 */
async function _generateRehearsalInput(target, idleMind) {
  if (!idleMind.model || typeof idleMind.model.chat !== 'function') {
    return {};
  }

  const settings = idleMind._settings || (idleMind.bus?._container?.tryResolve?.('settings'));
  const llmEnabled = _setting(settings, 'cognitive.koennen.rehearsal.inputGeneration.llmFallback', true);
  if (!llmEnabled) return {};

  const timeoutMs = _setting(settings, 'cognitive.koennen.rehearsal.inputGeneration.timeoutMs', 30000);
  const interfaceSpec = target.manifest?.interface?.input || {};
  const description = target.manifest?.description || '';

  const prompt =
    'Generate ONE plausible test input for a skill, for rehearsal purposes.\n\n' +
    'Skill: ' + target.name + '\n' +
    'Description: ' + description + '\n' +
    'Input interface: ' + JSON.stringify(interfaceSpec, null, 2) + '\n\n' +
    'Return ONLY a JSON object. No fences, no commentary, no explanation.\n' +
    'If the interface is empty or unclear, return {}.';

  try {
    const response = await Promise.race([
      idleMind.model.chat(prompt, [], 'analysis'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
    ]);
    if (!response || typeof response !== 'string') return {};
    const cleaned = response.replace(/```json?\s*|\s*```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return (typeof parsed === 'object' && parsed !== null) ? parsed : {};
  } catch (err) {
    _log.debug(`[REHEARSAL] input generation failed: ${err.message}`);
    return {};
  }
}

/**
 * After rehearsal: increment count, add input hash, transition status.
 */
function _updateAfterRehearsal(target, input, _success) {
  try {
    // Re-read from disk in case another actor (PromotionEvaluator) touched it.
    const fresh = safeJsonParse(fs.readFileSync(target.manifestPath, 'utf-8'), null, 'SkillRehearsal');
    if (!fresh) return;

    fresh.koennen = fresh.koennen || {};
    fresh.koennen.rehearsalCount = (fresh.koennen.rehearsalCount || 0) + 1;

    // Distinct-input tracking — sha256 hash, capped at 50 entries.
    const inputHash = crypto.createHash('sha256')
      .update(JSON.stringify(input))
      .digest('hex')
      .slice(0, 16);
    if (!Array.isArray(fresh.koennen.rehearsedInputHashes)) {
      fresh.koennen.rehearsedInputHashes = [];
    }
    if (!fresh.koennen.rehearsedInputHashes.includes(inputHash)) {
      fresh.koennen.rehearsedInputHashes.push(inputHash);
      if (fresh.koennen.rehearsedInputHashes.length > 50) {
        fresh.koennen.rehearsedInputHashes = fresh.koennen.rehearsedInputHashes.slice(-50);
      }
    }

    // Transition pending → rehearsing on first rehearsal.
    if (fresh.status === 'pending' && fresh.koennen.rehearsalCount === 1) {
      fresh.status = 'rehearsing';
    }

    atomicWriteFileSync(target.manifestPath, JSON.stringify(fresh, null, 2), 'utf-8');
  } catch (err) {
    _log.warn(`[REHEARSAL] manifest update failed: ${err.message}`);
  }
}

function _fireRehearsedEvent(bus, skillName, success) {
  if (!bus || typeof bus.fire !== 'function') return;
  try {
    bus.fire('skill:rehearsed', { skillName, success }, { source: 'SkillRehearsal' });
  } catch (_e) { /* never block on telemetry */ }
}

function _setting(settings, path, fallback) {
  if (!settings || typeof settings.get !== 'function') return fallback;
  try {
    const v = settings.get(path);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}
