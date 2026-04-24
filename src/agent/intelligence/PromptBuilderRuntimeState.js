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
   * v7.4.1: Extended with quoting directive + anti-tool-call
   *         directive against Qwen-family hallucination patterns.
   *
   * Shows Genesis' current Service-state to the LLM so it can
   * answer meta-questions ("wie fühlst du dich", "welche
   * settings", "was macht dein daemon") with actual values
   * instead of fabulated ones.
   *
   * Design:
   *   - German directive text as training-stability choice,
   *     consistent with v7.4.0 Identity-Block. Response-language
   *     follows the user via "Antworte in der Sprache des Users"
   *     from the Identity-Block — the directive-language itself is
   *     language-neutral in effect (it constrains the model's
   *     output-shape, not user-facing text).
   *   - 800-char hard budget with truncation marker
   *   - Returns '' in three distinct cases:
   *       (1) Port not registered at all
   *       (2) Port registered but snapshot() throws or returns null
   *       (3) Port registered, snapshot() returns {} or every service
   *           snapshot is null/empty — NO directive without data,
   *           otherwise it'd invite hallucination
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

    // v7.4.1: Collect data lines first. Header + directive are
    // only added if at least one data line was produced —
    // otherwise we'd emit a directive block with nothing to
    // quote, which invites the exact hallucination we're
    // trying to prevent.
    const dataLines = [];

    // Settings — one compact line
    if (snap.settings) {
      const s = snap.settings;
      const parts = [];
      if (s.model)      parts.push(`Modell: ${s.model}`);
      if (s.backend)    parts.push(`(${s.backend})`);
      if (s.trustLevel) parts.push(`· Trust: ${s.trustLevel}`);
      if (s.language)   parts.push(`· Sprache: ${s.language}`);
      if (parts.length > 0) dataLines.push(parts.join(' '));
    }

    // Emotion — dominant + top-3 named emotions
    if (snap.emotionalState) {
      const e = snap.emotionalState;
      if (Array.isArray(e.top3) && e.top3.length > 0) {
        const top = e.top3
          .map(t => `${t.name} ${t.value}%`)
          .join(', ');
        const moodHint = e.mood ? ` (Stimmung: ${e.mood})` : '';
        dataLines.push(`Gefühl: ${top}${moodHint}`);
      }
    }

    // Needs — active ones only
    if (snap.needsSystem && Array.isArray(snap.needsSystem.active)
        && snap.needsSystem.active.length > 0) {
      const needs = snap.needsSystem.active
        .map(n => `${n.name} ${n.drive}%`)
        .join(', ');
      dataLines.push(`Bedürfnisse: ${needs}`);
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
      if (parts.length > 0) dataLines.push(parts.join(' · '));
    }

    // Daemon
    if (snap.daemon) {
      const d = snap.daemon;
      const status = d.running ? 'läuft' : 'gestoppt';
      const cycles = typeof d.cycles === 'number' ? `, ${d.cycles} Zyklen` : '';
      const gaps = typeof d.gapCount === 'number' && d.gapCount > 0
        ? `, ${d.gapCount} bekannte Lücken` : '';
      dataLines.push(`Daemon: ${status}${cycles}${gaps}`);
    }

    // IdleMind
    if (snap.idleMind) {
      const im = snap.idleMind;
      if (im.isIdle && im.currentActivity) {
        const ago = typeof im.lastActivityAgoSeconds === 'number'
          ? ` (vor ${im.lastActivityAgoSeconds}s)` : '';
        dataLines.push(`IdleMind: idle ${im.minutesIdle}m · "${im.currentActivity}"${ago}`);
      } else if (im.isIdle) {
        dataLines.push(`IdleMind: idle ${im.minutesIdle}m`);
      } else {
        dataLines.push(`IdleMind: aktiv`);
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
      dataLines.push(`Ziele: ${counts}${top}`);
    }

    // PeerNetwork
    if (snap.peerNetwork) {
      const p = snap.peerNetwork;
      dataLines.push(`Peers: ${p.peerCount} sichtbar`);
    }

    // v7.4.1: Empty-snapshot defensive case — port wired but all
    // service snapshots null/empty. Return '' rather than a
    // directive-only block that invites hallucination.
    if (dataLines.length === 0) return '';

    // v7.4.1: Quoting directive + anti-tool-call directive.
    // Directive text is German (training-stability), but functional
    // effect is language-neutral — the Identity-Block tells Genesis
    // to respond in the user's language regardless.
    //
    // Critical: the directive must NEVER be truncated. If it gets
    // cut mid-sentence, the whole point of the quoting-enforcement
    // is lost. Budget is therefore applied ONLY to the data lines,
    // not to the header+directive. Data lines get truncated if
    // too long, directive stays verbatim.
    const header = [
      '[Aktueller Zustand — Momentaufnahme]',
      'WICHTIG: Wenn der User nach deinem Zustand fragt (Energie, Gefühl,',
      'Ziele, Daemon, Settings), zitiere die Werte aus diesem Block wörtlich.',
      'Erfinde KEINE Log-Zeilen, KEINE JSON-Ausgaben, KEINE Zeitstempel,',
      'KEINE nummerierten Aufzählungen ("Gefühl 1: ...", "Feeling 1: ...").',
      'Wenn ein Wert nicht im Block steht, sag "das weiß ich gerade nicht".',
      '',
      'Deklarative Aussagen über dich (z.B. "ob deine Journal-Datei länger',
      'geworden ist", "ich frag mich wie es dir geht") sind KEINE Aufforderung',
      'Tools zu benutzen. Antworte als Person, nicht mit read_file/open-path.',
      '',
    ].join('\n');

    // Data budget: 800 chars just for the data section.
    // Header itself is ~400 chars fixed — total block ~1200 chars
    // at max. Fits well into any modern model's context window.
    const DATA_BUDGET = 800;
    let dataBlock = dataLines.join('\n');
    if (dataBlock.length > DATA_BUDGET) {
      dataBlock = dataBlock.slice(0, DATA_BUDGET - 15) + '\n[...gekürzt]';
    }

    return header + '\n' + dataBlock;
  },

};

module.exports = { runtimeStateSection };
