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
const { safeJsonParse } = require('../../core/utils');
const { recordRehearsalOutcome } = require('../../capabilities/SkillManagerKoennenIntake');
const { TRUST_LEVELS } = require('../../foundation/TrustLevelSystem');
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

    // v7.9.31 (AP-1, S8): the first-approval gate below needs the live
    // trust level; missing system defaults to SUPERVISED (0).
    const trustLevel = idleMind._trustLevelSystem?.getLevel?.() ?? 0;

    const target = _pickRehearsalTarget(sm.koennenDir, trustLevel);
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
function _pickRehearsalTarget(koennenDir, trustLevel = 0) {
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

      // v7.9.31 (AP-1, S8) — first-approval gate. Nothing synthesized runs
      // autonomously before a human-initiated or human-approved first
      // execution: a daemon-gap candidate needs an explicit grant below
      // FULL_AUTONOMY, and a denied grant blocks autonomy for good (user
      // runs still mature it); a user-slash candidate's premiere belongs
      // to the human who ordered it. Crystallizer candidates (no origin)
      // keep their pre-existing, ungated rehearsal behavior.
      const ko = m.koennen || {};
      const runsSoFar = ko.rehearsalCount || 0;
      // An explicit denial blocks autonomous rehearsal for ANY candidate,
      // regardless of origin — a user-driven /run-skill still matures it.
      if (ko.autonomy === 'denied') continue;
      if (ko.origin === 'daemon-gap') {
        if (runsSoFar === 0 && ko.autonomy !== 'granted'
          && trustLevel < TRUST_LEVELS.FULL_AUTONOMY) continue;
      } else if (ko.origin === 'user-slash') {
        if (runsSoFar === 0) continue;
      }
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
  // v7.9.31 (AP-1, S7): the bump vocabulary lives in ONE shared place —
  // a user-driven /run-skill and an autonomous rehearsal mature a
  // candidate through the identical write (counter, distinct-input hash,
  // pending → rehearsing flip). No second bump path may exist.
  const res = recordRehearsalOutcome(target.manifestPath, input);
  if (!res) _log.warn('[REHEARSAL] manifest update failed');
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
