// ============================================================
// GENESIS — PromptBuilderRuntimeState.js (v7.4.0)
//
// Extracted from PromptBuilderSections.js to keep that file
// under the 700-LOC threshold. Contains only the v7.4.0
// runtime-state rendering method.
//
// Same pattern as PromptBuilderSectionsExtra.js — attached
// via Object.assign in PromptBuilder.js.
// ============================================================

'use strict';

const { createLogger } = require('../core/Logger');
const _log = createLogger('PromptBuilder');

const runtimeStateSection = {

  /**
   * v7.4.0: Runtime-state block from RuntimeStatePort.
   *
   * Shows Genesis' current Service-state to the LLM so it can
   * answer meta-questions ("wie fühlst du dich", "welche
   * settings", "was macht dein daemon") with actual values
   * instead of fabulated ones.
   *
   * Design:
   *   - German (user speaks German with Genesis, keeps
   *     system prompt consistent)
   *   - 800-char hard budget with truncation marker
   *   - Returns '' when port missing or snapshot empty
   *     (defensive — degradation stays silent)
   *   - No data transformation — the service's snapshot IS
   *     the data, we just format it
   */
  _runtimeStateContext() {
    if (!this.runtimeStatePort) return '';
    let snap;
    try {
      snap = this.runtimeStatePort.snapshot();
    } catch (err) {
      _log.debug('[PROMPT] Runtime snapshot unavailable:', err.message);
      return '';
    }
    if (!snap || typeof snap !== 'object') return '';
    const names = Object.keys(snap);
    if (names.length === 0) return '';

    const lines = ['[Aktueller Zustand — Momentaufnahme]'];

    // Settings — one compact line
    if (snap.settings) {
      const s = snap.settings;
      const parts = [];
      if (s.model)      parts.push(`Modell: ${s.model}`);
      if (s.backend)    parts.push(`(${s.backend})`);
      if (s.trustLevel) parts.push(`· Trust: ${s.trustLevel}`);
      if (s.language)   parts.push(`· Sprache: ${s.language}`);
      if (parts.length > 0) lines.push(parts.join(' '));
    }

    // Emotion — dominant + top-3 named emotions
    if (snap.emotionalState) {
      const e = snap.emotionalState;
      if (Array.isArray(e.top3) && e.top3.length > 0) {
        const top = e.top3
          .map(t => `${t.name} ${t.value}%`)
          .join(', ');
        const moodHint = e.mood ? ` (Stimmung: ${e.mood})` : '';
        lines.push(`Gefühl: ${top}${moodHint}`);
      }
    }

    // Needs — active ones only
    if (snap.needsSystem && Array.isArray(snap.needsSystem.active)
        && snap.needsSystem.active.length > 0) {
      const needs = snap.needsSystem.active
        .map(n => `${n.name} ${n.drive}%`)
        .join(', ');
      lines.push(`Bedürfnisse: ${needs}`);
    }

    // Metabolism — energy + calls
    if (snap.metabolism) {
      const m = snap.metabolism;
      const parts = [];
      if (typeof m.energyPercent === 'number') {
        parts.push(`Energie: ${m.energyPercent}%`);
      }
      if (typeof m.llmCalls === 'number') {
        parts.push(`${m.llmCalls} LLM-Calls in dieser Session`);
      }
      if (parts.length > 0) lines.push(parts.join(' · '));
    }

    // Daemon
    if (snap.daemon) {
      const d = snap.daemon;
      const status = d.running ? 'läuft' : 'gestoppt';
      const cycles = typeof d.cycles === 'number' ? `, ${d.cycles} Zyklen` : '';
      const gaps = typeof d.gapCount === 'number' && d.gapCount > 0
        ? `, ${d.gapCount} bekannte Lücken` : '';
      lines.push(`Daemon: ${status}${cycles}${gaps}`);
    }

    // IdleMind
    if (snap.idleMind) {
      const im = snap.idleMind;
      if (im.isIdle && im.currentActivity) {
        const ago = typeof im.lastActivityAgoSeconds === 'number'
          ? ` (vor ${im.lastActivityAgoSeconds}s)` : '';
        lines.push(`IdleMind: idle ${im.minutesIdle}m · "${im.currentActivity}"${ago}`);
      } else if (im.isIdle) {
        lines.push(`IdleMind: idle ${im.minutesIdle}m`);
      } else {
        lines.push(`IdleMind: aktiv`);
      }
    }

    // GoalStack
    if (snap.goalStack) {
      const g = snap.goalStack;
      const parts = [`${g.open} offen`];
      if (g.paused > 0) parts.push(`${g.paused} pausiert`);
      if (g.blocked > 0) parts.push(`${g.blocked} blockiert`);
      const counts = parts.join(', ');
      const top = g.topTitle ? ` · top: "${g.topTitle}"` : '';
      lines.push(`Ziele: ${counts}${top}`);
    }

    // PeerNetwork
    if (snap.peerNetwork) {
      const p = snap.peerNetwork;
      lines.push(`Peers: ${p.peerCount} sichtbar`);
    }

    let block = lines.join('\n');

    // Budget enforcement (Rev 2.1: 800 char limit, hard).
    const BUDGET = 800;
    if (block.length > BUDGET) {
      block = block.slice(0, BUDGET - 15) + '\n[...gekürzt]';
    }
    return block;
  },

};

module.exports = { runtimeStateSection };
