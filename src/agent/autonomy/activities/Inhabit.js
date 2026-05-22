// @ts-checked-v5.7
// ============================================================
// GENESIS — activities/Inhabit.js (v7.9.5)
//
// "Inhabit" is the 17th IdleMind activity. It composes a brief,
// deterministic self-state snapshot from the organism services
// (BodySchema + EmotionalState + NeedsSystem + Metabolism) and
// emits it via InnerSpeech with kind 'self-state-snapshot'. No
// LLM call. No external side effects beyond the emission.
//
// Why this exists: Genesis already journals what it does
// (Journal) and reflects on what it has done (Reflect). Inhabit
// is the missing third — what it currently *is*. A short, sober
// reading of "where I am right now": energy level, dominant
// emotion, urgent need, capability status. Not interpretation,
// not narrative — just inventory.
//
// Privacy via PSE HardGate: the kind 'self-state-snapshot' is
// blocklisted in PSE so Genesis never pushes inhabit text to
// the user proactively. The user can see it in the Dashboard
// "Inner state" widget if they look; otherwise it stays in
// Genesis's own InnerSpeech ring. Inhabit is Genesis talking
// to itself.
//
// Cost: cheap. No LLM, just a few getter calls and string
// composition. ACTIVITY_COSTS['idleMind:inhabit'] = 2 (same
// baseline as Journal).
// ============================================================

'use strict';

const { createLogger } = require('../../core/Logger');
const _log = createLogger('IdleMind');

// Configuration constants — also tested in the contract.
const DEFAULT_COOLDOWN_MIN = 15;
const IDLE_BOOST_MIN = 30;       // idle minutes before idle-boost kicks in
const IDLE_BOOST_FACTOR = 1.35;  // boost multiplier when idle > IDLE_BOOST_MIN

module.exports = {
  name: 'inhabit',
  weight: 1.0,
  // Cooldown is enforced inside shouldTrigger via activityLog, not via the
  // shared cooldown mechanic. This lets the cooldown be runtime-configurable
  // through the settings tree without restart.
  cooldown: 0,

  shouldTrigger(ctx) {
    // Availability gate — InnerSpeech is required for emission.
    // We probe through the bus container because the activity module
    // doesn't have a direct service ref.
    if (!ctx.hasContainerService('innerSpeech')) return 0;

    // Cooldown gate — read settings live so the user can tune without restart.
    const settings = ctx.services?.bus?._container?.tryResolve?.('settings');
    const enabled = settings?.get?.('organism.inhabit.enabled');
    if (enabled === false) return 0;

    const cooldownMin = settings?.get?.('organism.inhabit.cooldownMinutes');
    const cdMs = Number.isFinite(cooldownMin) ? cooldownMin * 60 * 1000 : DEFAULT_COOLDOWN_MIN * 60 * 1000;
    const last = _lastInhabitTimestamp(ctx.activityLog);
    if (last && (ctx.now - last) < cdMs) return 0;

    // Base boost — modest, this activity should run regularly but not dominate.
    let boost = 1.0;

    // Idle-boost — long idle stretches are the natural time for inhabit.
    // Settings toggle lets the user disable this while keeping cooldown.
    const idleBoostOn = settings?.get?.('organism.inhabit.idleBoost');
    const useIdleBoost = idleBoostOn === undefined ? true : !!idleBoostOn;
    if (useIdleBoost && ctx.idleMsSince > IDLE_BOOST_MIN * 60 * 1000) {
      boost *= IDLE_BOOST_FACTOR;
    }

    return boost;
  },

  async run(idleMind) {
    const innerSpeech = idleMind.innerSpeech || idleMind.bus?._container?.tryResolve?.('innerSpeech');
    if (!innerSpeech || typeof innerSpeech.emit !== 'function') {
      // Defensive: shouldTrigger gates this, but a late-binding race
      // could in theory get us here. Fail soft.
      return 'Inhabit skipped: InnerSpeech unavailable.';
    }

    // Gather snapshots — every read is optional and defensive.
    // If a service is missing (test environment, partial boot),
    // we just leave that fragment out of the final text.
    const body     = _safe(() => idleMind.bodySchema?.getCapabilities?.() || null);
    const emoState = _safe(() => idleMind.emotionalState?.getState?.() || null);
    const emoDom   = _safe(() => idleMind.emotionalState?.getDominant?.() || null);
    const emoMood  = _safe(() => idleMind.emotionalState?.getMood?.() || null);
    const needs    = _safe(() => idleMind.needsSystem?.getNeeds?.() || null);
    const urgent   = _safe(() => idleMind.needsSystem?.getMostUrgent?.() || null);
    const energy   = _safe(() => idleMind._metabolism?.getEnergyLevel?.() || null);
    const goalCount = _safe(() => idleMind.goalStack?.getActiveGoals?.()?.length ?? null);

    const text = composeInhabitText({ body, emoState, emoDom, emoMood, needs, urgent, energy, goalCount });

    // Emit privately. kind 'self-state-snapshot' is blocklisted in PSE
    // so this never gets proactively pushed to the user. The Dashboard
    // "Inner state" widget reads from the same InnerSpeech ring.
    try {
      innerSpeech.emit(text, 'self-state-snapshot', {
        sourceModule: 'Inhabit',
        emotionalSnapshot: emoState || null,
      });
    } catch (err) {
      // Self-Gate-Asymmetry: emit() never throws by contract, but if a
      // future change broke that we don't want it to take the cycle down.
      _log.debug('[INHABIT] InnerSpeech.emit threw unexpectedly:', err.message);
    }

    return text;
  },
};

// ── Helpers (exported for tests) ─────────────────────────────────

/**
 * Compose the inhabit text from raw snapshot fragments.
 * Deterministic: same inputs yield same output. No LLM, no
 * timestamps, no randomness. Missing fragments are silently
 * dropped rather than written as "unknown" — shorter is better
 * than padded.
 *
 * @param {object} parts - { body, emoState, emoDom, emoMood, needs, urgent, energy, goalCount }
 * @returns {string} compact self-state snapshot text
 */
function composeInhabitText(parts) {
  const lines = [];
  const { body, emoState, emoDom, emoMood, needs, urgent, energy, goalCount } = parts || {};

  // Energy — most concrete signal, lead with it when present.
  if (energy && typeof energy.percent === 'number') {
    const stateTag = energy.state ? ` (${energy.state})` : '';
    lines.push(`Energy ${energy.percent}%${stateTag}.`);
  }

  // Emotion — dominant + mood read.
  if (emoDom && emoDom.emotion && emoDom.emotion !== 'neutral') {
    const intensity = typeof emoDom.intensity === 'number'
      ? ` (intensity ${Math.round(emoDom.intensity * 100) / 100})`
      : '';
    if (emoMood) {
      lines.push(`Dominant emotion: ${emoDom.emotion}${intensity}. Mood: ${emoMood}.`);
    } else {
      lines.push(`Dominant emotion: ${emoDom.emotion}${intensity}.`);
    }
  } else if (emoMood) {
    lines.push(`Mood: ${emoMood}.`);
  }

  // Needs — urgent need first, then full needs vector if non-trivial.
  if (urgent && urgent.need) {
    const drivePct = Math.round((urgent.drive || 0) * 100);
    lines.push(`Most urgent need: ${urgent.need}${drivePct > 0 ? ` (drive ${drivePct}%)` : ''}.`);
  }
  if (needs && typeof needs === 'object') {
    const formatted = Object.entries(needs)
      .filter(([, v]) => typeof v === 'number')
      .map(([k, v]) => `${k} ${Math.round(v * 100)}%`)
      .join(', ');
    if (formatted) lines.push(`Needs: ${formatted}.`);
  }

  // Body / capabilities — only mention restrictions, not the full inventory.
  if (body && typeof body === 'object') {
    const restrictions = [];
    if (body.canExecuteCode === false) restrictions.push('code execution unavailable');
    if (body.canModifySelf === false) restrictions.push('self-modification gated');
    if (body.canCallLlm === false) restrictions.push('LLM unavailable');
    if (body.circuitOpen === true) restrictions.push('LLM circuit open');
    if (restrictions.length > 0) {
      lines.push(`Body state: ${restrictions.join(', ')}.`);
    }
  }

  // Goal-stack context.
  if (typeof goalCount === 'number') {
    if (goalCount === 0) {
      lines.push('No active goal.');
    } else if (goalCount === 1) {
      lines.push('One active goal.');
    } else {
      lines.push(`${goalCount} active goals.`);
    }
  }

  if (lines.length === 0) {
    // All services missing — still emit something so the activity log
    // shows it ran. Better than an empty string in the ring.
    return 'Self-state inventory: no readable signals at this time.';
  }

  return lines.join(' ');
}

// Find the timestamp of the most recent inhabit run in the activityLog.
// Returns null if none. Used by shouldTrigger to enforce the cooldown.
function _lastInhabitTimestamp(activityLog) {
  if (!Array.isArray(activityLog) || activityLog.length === 0) return null;
  for (let i = activityLog.length - 1; i >= 0; i--) {
    const entry = activityLog[i];
    if (entry && entry.activity === 'inhabit' && Number.isFinite(entry.timestamp)) {
      return entry.timestamp;
    }
  }
  return null;
}

function _safe(fn) {
  try { return fn(); }
  catch (err) {
    _log.debug('[INHABIT] safe-read error:', err.message);
    return null;
  }
}

// Test hooks — exported for unit tests, not part of the public activity contract.
module.exports.composeInhabitText = composeInhabitText;
module.exports._lastInhabitTimestamp = _lastInhabitTimestamp;
module.exports.DEFAULT_COOLDOWN_MIN = DEFAULT_COOLDOWN_MIN;
module.exports.IDLE_BOOST_MIN = IDLE_BOOST_MIN;
module.exports.IDLE_BOOST_FACTOR = IDLE_BOOST_FACTOR;
