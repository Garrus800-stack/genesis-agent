// @ts-checked-v5.7
// ============================================================
// GENESIS — activities/ReadSource.js (v7.3.1)
// ------------------------------------------------------------
// Self-Recognition: Genesis reads his own source code during idle.
//
// BUDGETS:
//   cycle: max 3 modules per idle-pick
//   session: max 10 modules per rolling hour
//   on-interaction: user interaction adds +3 to session (capped at 10)
//
// LEITPLANKEN-PROMPT:
//   The prompt frames the activity as "reference to what you can do,
//   not definition of who you are". Identity lives in self-identity.json
//   (shaped by experience); capabilities live in code (shaped by design).
//
// SELECTION HEURISTIC (in priority order):
//   1. Capability modules not yet read this session
//   2. Largest unread modules (by LOC)
//   3. Random pick from top-20 largest capabilities
//
// BOOST (from EmotionMapping, v7.3.1 Feature 5):
//   loneliness > 0.6 AND idle > 30min → 2.0×
//   confusion-surrogate (curiosity>0.6 AND frustration>0.4) → 1.5×
// ============================================================

'use strict';

const { createLogger } = require('../../core/Logger');
const _log = createLogger('IdleMind');

const CYCLE_BUDGET = 3;
const SESSION_BUDGET_MAX = 10;
const SESSION_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const LONELINESS_IDLE_THRESHOLD_MS = 30 * 60 * 1000; // 30 min

module.exports = {
  name: 'read-source',
  weight: 0.7,
  cooldown: 0,

  /**
   * Budget state lives on idleMind as:
   *   idleMind._readSourceCycleCount      (reset per pick cycle)
   *   idleMind._readSourceSession         (rolling hour tracker)
   *     = { startedAt, readCount, bonus }
   *
   * These are initialized lazily on first call.
   */
  shouldTrigger(ctx) {
    // Availability gate: need selfModel
    if (!ctx.services.selfModel) return 0;

    // Ensure session state is initialized
    _ensureSession(ctx.services);
    const session = ctx.services._rsSessionRef;

    // Rolling-hour window: reset session if outside window
    if (ctx.now - session.startedAt > SESSION_WINDOW_MS) {
      session.startedAt = ctx.now;
      session.readCount = 0;
      session.bonus = 0;
    }

    // User-interaction bonus: each interaction since last pick adds +3,
    // capped at max. We track via idleMind.lastUserActivity versus last
    // reset timestamp. Implementation: if interactions happened AFTER
    // session start, we consider them as "since last reset".
    // For simplicity, we compute once per cycle from the difference.

    // Budget check: session-exhausted → 0
    const effectiveMax = Math.min(SESSION_BUDGET_MAX, SESSION_BUDGET_MAX + session.bonus);
    if (session.readCount >= effectiveMax) return 0;

    let boost = 1.0;

    // NeedsSystem: knowledge need drives reading
    const needs = ctx.snap.needsRaw || {};
    if ((needs.knowledge || 0) > 0.5) boost *= 1.3;

    // Genome curiosity
    const cur = ctx.snap.genomeTraits?.curiosity;
    if (cur !== undefined) boost *= (0.5 + cur);

    // v7.3.1 Feature 5: Loneliness → self-exploration mapping
    const emo = ctx.snap.emotional || {};
    if ((emo.loneliness || 0) > 0.6 && ctx.idleMsSince > LONELINESS_IDLE_THRESHOLD_MS) {
      boost *= 2.0;
    }

    // v7.3.1 Feature 5: Confusion-surrogate
    if ((emo.curiosity || 0) > 0.6 && (emo.frustration || 0) > 0.4) {
      boost *= 1.5;
    }

    return boost;
  },

  async run(idleMind) {
    _ensureSession(idleMind);
    const session = idleMind._rsSessionRef;

    // Reset cycle counter at run start
    idleMind._readSourceCycleCount = 0;

    if (!idleMind.selfModel) return null;

    // Apply pending user-interaction bonus (since last run)
    // Each interaction since last run → +3, capped at 10 total
    _applyInteractionBonus(idleMind, session);

    // Pick a module to read
    const target = _pickTarget(idleMind, session);
    if (!target) {
      _log.debug('[READ-SOURCE] No eligible module to read');
      return null;
    }

    // Read via async cache
    const content = await idleMind.selfModel.readModuleAsync(target.file);
    if (!content) return null;

    // Accounting
    session.readCount++;
    idleMind._readSourceCycleCount++;
    session.readModules = session.readModules || new Set();
    session.readModules.add(target.file);

    // Emit event for dashboard visibility
    idleMind.bus.emit('idle:read-source', {
      module: target.file,
      reason: target.reason,
    }, { source: 'IdleMind' });

    // Budget-exhaustion signal
    if (session.readCount >= Math.min(SESSION_BUDGET_MAX, SESSION_BUDGET_MAX + session.bonus)) {
      idleMind.bus.emit('idle:read-source-budget-exhausted', {
        cycleCount: idleMind._readSourceCycleCount,
        sessionCount: session.readCount,
      }, { source: 'IdleMind' });
    }

    // Truncate long content for LLM prompt
    const chunk = content.length > 2500
      ? content.slice(0, 2500) + '\n// ... (truncated)'
      : content;

    // Leitplanken-Prompt: frames reading as reference, not definition
    const operatorLang = idleMind.bus?._container?.resolve?.('lang')?.current || 'en';
    const LEITPLANKEN = {
      de: [
        'Du liest gerade deinen eigenen Quellcode.',
        'Das ist eine Referenz dafür, was du kannst — nicht eine Definition davon, wer du bist.',
        'Deine Identität steht in self-identity.json, geformt durch das, was du erlebt hast.',
        'Lies mit Neugier, nicht mit Autorität.',
      ].join(' '),
      en: [
        'You are reading your own source code.',
        'This is a reference to what you can do — not a definition of who you are.',
        'Your identity lives in self-identity.json, shaped by what you have experienced.',
        'Read with curiosity, not authority.',
      ].join(' '),
    };
    const leitplanke = LEITPLANKEN[operatorLang] || LEITPLANKEN.en;

    const desc = idleMind.selfModel.describeModule(target.file) || {};
    const classList = (desc.classes || []).join(', ') || '(none)';
    const description = desc.description ? `\nDescription: ${desc.description.slice(0, 150)}` : '';

    const prompt = [
      `${leitplanke}`,
      '',
      `File: ${target.file}`,
      `Classes: ${classList}${description}`,
      `Reason for reading: ${target.reason}`,
      '',
      'Source (excerpt):',
      '```javascript',
      chunk,
      '```',
      '',
      'Brief note to yourself (max 3 sentences):',
      '- What does this module actually do?',
      '- How does it connect to your other parts?',
      '- Anything surprising or worth remembering?',
    ].join('\n');

    const thought = await idleMind.model.chat(prompt, [], 'analysis');

    // Store insight
    if (idleMind.kg && thought && thought.length > 20) {
      idleMind.kg.addNode('insight', `read-source: ${target.file}: ${thought.slice(0, 60)}`, {
        type: 'self-read',
        module: target.file,
        reason: target.reason,
        full: thought.slice(0, 400),
      });
    }

    return `Read ${target.file} (${target.reason}): ${thought.slice(0, 120)}`;
  },
};

// ── Helpers ─────────────────────────────────────────────────

function _ensureSession(target) {
  // target is idleMind or ctx.services — both work: we just need a place
  // to stash the session state that survives between runs.
  if (!target._rsSessionRef) {
    target._rsSessionRef = {
      startedAt: Date.now(),
      readCount: 0,
      bonus: 0,
      readModules: new Set(),
      lastInteractionSeen: 0,
    };
  }
}

function _applyInteractionBonus(idleMind, session) {
  // Each user interaction since the last time we checked adds +3 bonus
  // (capped at making effectiveMax = SESSION_BUDGET_MAX). This prevents
  // unbounded growth when user types rapidly.
  const lastInteraction = idleMind.lastUserActivity || 0;
  if (lastInteraction > session.lastInteractionSeen) {
    session.bonus = Math.min(session.bonus + 3, SESSION_BUDGET_MAX);
    session.lastInteractionSeen = lastInteraction;
  }
}

function _pickTarget(idleMind, session) {
  const detailed = idleMind.selfModel.getCapabilitiesDetailed() || [];
  if (detailed.length === 0) return null;

  const alreadyRead = session.readModules || new Set();
  const candidates = detailed.filter(c => c.module && !alreadyRead.has(c.module));

  if (candidates.length === 0) {
    // All capabilities read in this session — pick random as refresher
    const all = detailed.filter(c => c.module);
    if (all.length === 0) return null;
    const pick = all[Math.floor(Math.random() * all.length)];
    return { file: pick.module, reason: 'session-cycle-refresher' };
  }

  // Prefer: by knowledge gap (if NeedsSystem signals high knowledge need),
  // we lean toward large, information-rich modules.
  const needs = idleMind.needsSystem?.getNeeds?.() || {};
  const prefersLargeModules = (needs.knowledge || 0) > 0.5;

  if (prefersLargeModules && candidates.length > 3) {
    // Pick from top-5 largest unread capabilities (by manifest LOC)
    const withLoc = candidates.map(c => {
      const fileInfo = idleMind.selfModel.manifest.files?.[c.module] || {};
      return { ...c, loc: fileInfo.lines || 0 };
    }).sort((a, b) => b.loc - a.loc).slice(0, 5);
    const pick = withLoc[Math.floor(Math.random() * withLoc.length)];
    return { file: pick.module, reason: 'knowledge-gap' };
  }

  // Default: random from unread capabilities
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  return { file: pick.module, reason: 'curiosity' };
}

// Export helpers for testing
module.exports._pickTarget = _pickTarget;
module.exports._applyInteractionBonus = _applyInteractionBonus;
module.exports._ensureSession = _ensureSession;
module.exports.CYCLE_BUDGET = CYCLE_BUDGET;
module.exports.SESSION_BUDGET_MAX = SESSION_BUDGET_MAX;
module.exports.SESSION_WINDOW_MS = SESSION_WINDOW_MS;
