// @ts-check
// ============================================================
// GENESIS — CognitiveBudget.js (v6.0.4)
//
// Problem: Genesis behandelt "Was ist 2+2?" und "Refactore das
// gesamte Projekt" identisch — volle Pipeline, 20 Prompt-Sections,
// Organism-Signale, Consciousness-Gate-Checks, ~2s Latenz.
//
// Lösung: Schätze die kognitive Komplexität eines Requests und
// aktiviere nur die Services die proportional nötig sind.
//
// Tiers:
//   TRIVIAL   → Direct response, kein PromptBuilder, kein Organism
//               Latenz: <200ms, Tokens: minimal
//   MODERATE  → PromptBuilder light (5 Core-Sections), kein AgentLoop
//               Latenz: ~500ms, Tokens: normal
//   COMPLEX   → Volle Pipeline, alle Services
//               Latenz: ~2s, Tokens: normal
//   EXTREME   → Volle Pipeline + erweiterte Verification + Approval
//               Latenz: variabel, Tokens: hoch
//
// Integration:
//   ChatOrchestrator.handleStream() → CognitiveBudget.assess()
//   → PromptBuilder respektiert budget.maxSections
//   → IntentRouter nutzt budget.skipClassification
//
// Design: Stateless Classifier. Keine Persistence, keine Events
// (außer Metriken). Pure Function-Logik.
// ============================================================

'use strict';

const { createLogger } = require('../core/Logger');
const _log = createLogger('CognitiveBudget');

// ── Complexity Tiers ──────────────────────────────────────

const TIERS = {
  TRIVIAL:  { name: 'trivial',  maxSections: 3,  skipClassification: true,  skipOrganism: true,  skipConsciousness: true,  allowAgentLoop: false },
  MODERATE: { name: 'moderate', maxSections: 8,  skipClassification: false, skipOrganism: false, skipConsciousness: true,  allowAgentLoop: false },
  COMPLEX:  { name: 'complex',  maxSections: 99, skipClassification: false, skipOrganism: false, skipConsciousness: false, allowAgentLoop: true  },
  EXTREME:  { name: 'extreme',  maxSections: 99, skipClassification: false, skipOrganism: false, skipConsciousness: false, allowAgentLoop: true  },
};

// ── Trivial Patterns ──────────────────────────────────────
// Requests that need zero cognitive overhead.

const TRIVIAL_PATTERNS = [
  // Greetings
  /^(hi|hello|hey|hallo|moin|servus|guten\s*(tag|morgen|abend))[\s!.?]*$/i,
  // Simple math
  /^(was|what)\s+(ist|is|sind|are)\s+\d+\s*[+\-*/×÷]\s*\d+\s*\??$/i,
  // Yes/No/Thanks
  /^(ja|nein|yes|no|ok|okay|danke|thanks|thx|klar|sure|nope)[\s!.?]*$/i,
  // Single word queries
  /^(hilfe|help|status|version|info|ping)[\s!.?]*$/i,
  // Retry/continue
  /^(weiter|continue|nochmal|retry|again)[\s!.?]*$/i,
];

// ── Complex Indicators ────────────────────────────────────
// Signals that a request needs the full pipeline.

const COMPLEX_INDICATORS = [
  // Multi-step instructions
  /\b(erstell|create|build|implement|write|schreib|bau|make)\b.*\b(und|and|then|dann|also|außerdem)\b/i,
  // Code generation
  /\b(function|class|component|api|endpoint|server|database|migration)\b/i,
  // File operations
  /\b(datei|file|save|speicher|erstell.*datei|create.*file)\b/i,
  // Self-modification
  /\b(self-mod|modify|refactor|überarbeite|verbessere)\b/i,
  // Analysis
  /\b(analys|review|audit|benchmark|compare|vergleich)\b/i,
  // Shell/system
  /^\$\s|^npm |^git |^pip |^docker /,
];

// ── Extreme Indicators ────────────────────────────────────
// Signals that need approval / extended verification.

const EXTREME_INDICATORS = [
  /\b(refactor.*projekt|refactor.*project|überarbeite.*alles)\b/i,
  /\b(delete|löschen|remove.*all|entfern.*all)\b/i,
  /\b(deploy|production|prod|release|veröffentlich)\b/i,
  /\b(clone|klon|spawn|fork)\b/i,
];

class CognitiveBudget {
  /** @param {{ bus?: *, config?: * }} [deps] */
  constructor({ bus, config } = {}) {
    this.bus = bus || { emit() {} };
    const cfg = config || {};
    this._enabled = cfg.enabled !== false;

    // Stats
    this._stats = {
      total: 0,
      trivial: 0,
      moderate: 0,
      complex: 0,
      extreme: 0,
      avgAssessMs: 0,
    };
  }

  start() {
    _log.info(`[COG-BUDGET] Active — proportional intelligence ${this._enabled ? 'enabled' : 'disabled'}`);
  }

  stop() {}

  // ═══════════════════════════════════════════════════════════
  // ASSESSMENT
  // ═══════════════════════════════════════════════════════════

  /**
   * Assess the cognitive complexity of a user message.
   *
   * @param {string} message - The user's input
   * @param {{ intentHint?: string, historyLength?: number }} [context]
   * @returns {{ tier: object, tierName: string, reason: string }}
   */
  assess(message, context = {}) {
    if (!this._enabled) {
      return { tier: TIERS.COMPLEX, tierName: 'complex', reason: 'budget disabled' };
    }

    const t0 = Date.now();
    const msg = (message || '').trim();
    const len = msg.length;

    // ── Rule 1: Empty or ultra-short → trivial
    if (len === 0) {
      return this._record('trivial', 'empty message', t0);
    }

    // ── Rule 2: Known trivial patterns
    for (const pattern of TRIVIAL_PATTERNS) {
      if (pattern.test(msg)) {
        return this._record('trivial', 'pattern match', t0);
      }
    }

    // ── Rule 3: Extreme indicators (check BEFORE short-trivial, even short messages)
    for (const pattern of EXTREME_INDICATORS) {
      if (pattern.test(msg)) {
        return this._record('extreme', 'extreme pattern match', t0);
      }
    }

    // ── Rule 4: Intent hint from previous classification
    if (context.intentHint) {
      const intent = context.intentHint.toLowerCase();
      if (['execute-code', 'self-modify', 'create-skill', 'run-skill', 'shell'].includes(intent)) {
        return this._record('complex', `intent: ${intent}`, t0);
      }
    }

    // ── Rule 5: Very short + no complex indicators → trivial
    if (len < 20 && !COMPLEX_INDICATORS.some(p => p.test(msg))) {
      return this._record('trivial', 'short message, no complexity signals', t0);
    }

    // ── Rule 6: Complex indicators
    for (const pattern of COMPLEX_INDICATORS) {
      if (pattern.test(msg)) {
        return this._record('complex', 'complex pattern match', t0);
      }
    }

    // ── Rule 7: Long messages are at least moderate
    if (len > 200) {
      return this._record('moderate', 'long message', t0);
    }

    // ── Default: moderate
    return this._record('moderate', 'default', t0);
  }

  /**
   * Check if a prompt section should be included given the current budget.
   *
   * @param {string} sectionName - e.g. '_organismContext', '_consciousnessContext'
   * @param {{ tier: object }} budget - Result from assess()
   * @returns {boolean}
   */
  shouldIncludeSection(sectionName, budget) {
    if (!this._enabled) return true;
    const tier = budget?.tier || TIERS.COMPLEX;

    // Organism sections
    if (tier.skipOrganism && /organism|emotional|homeostasis|needs|body/i.test(sectionName)) {
      return false;
    }

    // Consciousness sections
    if (tier.skipConsciousness && /consciousness|attention|phenomenal|temporal|introspection/i.test(sectionName)) {
      return false;
    }

    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // STATS
  // ═══════════════════════════════════════════════════════════

  getStats() {
    return { ...this._stats };
  }

  getReport() {
    const s = this._stats;
    const total = s.total || 1;
    return {
      ...s,
      distribution: {
        trivial: Math.round((s.trivial / total) * 100),
        moderate: Math.round((s.moderate / total) * 100),
        complex: Math.round((s.complex / total) * 100),
        extreme: Math.round((s.extreme / total) * 100),
      },
      avgAssessMs: Math.round(s.avgAssessMs * 100) / 100,
    };
  }

  // ═══════════════════════════════════════════════════════════
  // INTERNAL
  // ═══════════════════════════════════════════════════════════

  /** @private */
  _record(tierName, reason, t0) {
    const tier = TIERS[tierName.toUpperCase()];
    const elapsed = Date.now() - t0;

    this._stats.total++;
    this._stats[tierName]++;
    this._stats.avgAssessMs =
      (this._stats.avgAssessMs * (this._stats.total - 1) + elapsed) / this._stats.total;

    return { tier, tierName, reason };
  }
}

module.exports = { CognitiveBudget, TIERS, TRIVIAL_PATTERNS, COMPLEX_INDICATORS, EXTREME_INDICATORS };
