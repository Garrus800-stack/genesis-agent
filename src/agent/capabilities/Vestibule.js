// @ts-checked-v5.9
// ============================================================
// GENESIS — Vestibule.js (v7.9.46 — "Die Vorhalle", stage V1)
//
// The membrane between Genesis' inside and the outside world.
// Builds the curated status snapshot and fills HIS voice
// templates. Pure functions, injected sources.
//
// Privacy by construction (plan L2): focus is composed ONLY of
// the idle activity type and an active goal title. When a chat
// is running, the vestibule says "in conversation" — never what
// about. This module has NO access to chat history, journal,
// dream-state, resonance or pending-moments.
// ============================================================

const fs = require('fs');
const path = require('path');

/** Slots his templates may use — anything else is rejected by the voice tool. */
const VOICE_SLOTS = ['focus', 'since', 'state', 'load', 'who'];

/** Voice file: written only by him via the vestibule-voice tool (stage V5). */
function voicePath(genesisDir) { return path.join(genesisDir, 'vorhalle', 'stimme.json'); }

function loadVoice(genesisDir) {
  try {
    const raw = fs.readFileSync(voicePath(genesisDir), 'utf-8');
    const v = JSON.parse(raw);
    if (v && typeof v === 'object') return v;
  } catch { /* absent or broken → door stays closed (plan H6) */ }
  return null;
}

/**
 * Build the curated snapshot. All inputs injected; no I/O here.
 * @param {{ idleStatus?: any, goalTitle?: string|null, chatActive?: boolean, dreamActive?: boolean, statesMap?: Record<string,string> }} src
 */
function buildSnapshot(src = {}) {
  const s = src.idleStatus || {};
  const acts = Array.isArray(s.recentActivities) ? s.recentActivities : [];
  const lastAct = acts.length ? String(acts[acts.length - 1].activity || 'quiet') : 'quiet';
  const focus = src.chatActive
    ? 'in conversation'
    : (src.goalTitle ? `${lastAct}: ${String(src.goalTitle).slice(0, 80)}` : lastAct);
  const sinceMin = Math.max(0, Math.round((Number(s.idleSince) || 0) / 60000));
  const state = (src.statesMap && src.statesMap[lastAct]) || lastAct;
  const load = src.dreamActive ? 'resting' : (src.chatActive ? 'engaged' : 'available');
  return { focus, since: `${sinceMin}m`, state, load };
}

/** Fill {slot} occurrences from VOICE_SLOTS only; unknown braces stay literal. */
function fillTemplate(template, snapshot, who) {
  let out = String(template || '');
  const vals = { ...snapshot, who: who || '' };
  for (const k of VOICE_SLOTS) out = out.split('{' + k + '}').join(String(vals[k] ?? ''));
  return out;
}

module.exports = { VOICE_SLOTS, voicePath, loadVoice, buildSnapshot, fillTemplate };
