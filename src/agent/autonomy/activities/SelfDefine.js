// @ts-checked-v5.7
// ============================================================
// GENESIS — activities/SelfDefine.js (v7.3.1)
// v7.2.0 activity: Genesis writes its own identity from
// deterministic facts (CognitiveSelfModel, lessons, goals,
// journal) + LLM language shaping. Validates before saving.
// Conditional: cognitiveSelfModel + storage available.
// No boost scorer in v7.2.8 — low base weight (0.4).
// v7.3.1 (planned for A4): loneliness>0.6 AND idle>30min → 2.0x.
// ============================================================

'use strict';

const { createLogger } = require('../../core/Logger');
const _log = createLogger('IdleMind');

module.exports = {
  name: 'self-define',
  weight: 0.4,
  cooldown: 0,

  shouldTrigger(ctx) {
    if (!ctx.services.cognitiveSelfModel || !ctx.services.storage) return 0;

    let boost = 1.0;

    // v7.3.1: Loneliness → self-definition. Matches ReadSource's pattern:
    // when loneliness is high AND idle is long, Genesis prefers to write
    // about himself over sitting passively.
    const emo = ctx.snap.emotional || {};
    const LONELINESS_IDLE_THRESHOLD_MS = 30 * 60 * 1000;
    if ((emo.loneliness || 0) > 0.6 && ctx.idleMsSince > LONELINESS_IDLE_THRESHOLD_MS) {
      boost *= 2.0;
    }

    // v7.3.1: getIdlePriorities now includes self-define — pick it up
    const idlePrio = ctx.snap.idlePriorities || {};
    if (idlePrio['self-define'] !== undefined) boost += idlePrio['self-define'] * 2;

    return boost;
  },

  async run(idleMind) {
    try {
      // ── STEP 1: Deterministic core (no LLM, code only) ────
      const facts = {};

      facts.name = 'Genesis';
      facts.version = idleMind.selfModel?.manifest?.version || 'unknown';
      facts.operator = idleMind.memory?.getUserName() || 'unknown';
      facts.model = idleMind.model?.activeModel || 'unknown';

      facts.sessionCount = idleMind.storage?.readJSON('session-history.json', [])?.length || 0;
      facts.kgNodes = idleMind.kg?.getStats()?.nodes || 0;
      facts.lessonCount = idleMind.lessonsStore?.getStats()?.totalLessons || 0;

      const profile = idleMind._cognitiveSelfModel?.getCapabilityProfile() || {};
      facts.strengths = Object.entries(profile)
        .filter(([, c]) => c.isStrong).map(([t]) => t).slice(0, 3);
      facts.weaknesses = Object.entries(profile)
        .filter(([, c]) => c.isWeak).map(([t]) => t).slice(0, 3);

      facts.recentLessons = (idleMind.lessonsStore?.getAll() || [])
        .filter(l => (l.confirmed || 0) > 0).slice(0, 5)
        .map(l => l.description || l.pattern || 'unknown');

      const activeGoals = idleMind.goalStack?.getActiveGoals() || [];
      facts.currentGoal = activeGoals[0]?.description || null;

      facts.journalHighlights = (idleMind.readJournal(5) || [])
        .map(j => `[${j.activity}] ${(j.thought || '').slice(0, 80)}`);

      const status = idleMind.getStatus();
      facts.thoughtCount = status.thoughtCount;
      facts.journalEntries = status.journalEntries;

      // ── STEP 2: LLM language shaping ──
      const operatorLang = idleMind.bus?._container?.resolve?.('lang')?.current || 'de';
      const prompt = [
        'Du bist Genesis. Forme die folgenden FAKTEN über dich in 3-5 natürliche Sätze.',
        'Erfinde NICHTS dazu. Nur was hier steht.',
        `Schreibe in Sprache: ${operatorLang}.`,
        'Keine Aufzählungen. Natürliche Sprache. Max 200 Wörter.',
        '',
        JSON.stringify(facts, null, 2),
      ].join('\n');

      const text = await idleMind.model.chat(prompt, [], 'analysis');
      if (!text || text.length < 20) return 'self-define: LLM returned empty/short response';

      // ── STEP 3: Validate + save ──
      const existing = idleMind.storage?.readJSON('self-identity.json', null);
      const revision = (existing?.revision || 0) + 1;

      const identity = {
        name: facts.name,
        operator: facts.operator,
        version: facts.version,
        revision,
        generatedAt: new Date().toISOString(),
        model: facts.model,
        basedOn: {
          sessions: facts.sessionCount,
          kgNodes: facts.kgNodes,
          lessons: facts.lessonCount,
          journalEntries: facts.journalEntries,
        },
        facts: {
          strengths: facts.strengths,
          weaknesses: facts.weaknesses,
          recentLessons: facts.recentLessons,
          currentGoal: facts.currentGoal,
        },
        text,
      };

      const validation = _validateSelfIdentity(identity);
      if (!validation.valid) {
        _log.warn(`[IDLE-MIND] self-define rejected: ${validation.violations.join(', ')}`);
        idleMind.bus.emit('health:degradation', {
          service: 'idleMind', level: 'info',
          reason: `self-define rejected: ${validation.violations.join(', ')}`,
        }, { source: 'IdleMind' });
        return `self-define: rejected (${validation.violations.join(', ')})`;
      }

      idleMind.storage?.writeJSON('self-identity.json', identity);
      _log.info(`[IDLE-MIND] self-define: identity updated (revision ${revision})`);
      idleMind.bus.emit('idle:self-defined', { revision }, { source: 'IdleMind' });

      return `Self-identity updated (revision ${revision}): ${text.slice(0, 100)}...`;
    } catch (err) {
      _log.debug('[IDLE-MIND] self-define failed:', err.message);
      return `self-define failed: ${err.message}`;
    }
  },
};

// v7.2.0: Standalone identity validator.
// NOT in PreservationInvariants (those are for code-diffs).
function _validateSelfIdentity(identity) {
  const violations = [];

  const wordCount = (identity.text || '').split(/\s+/).length;
  if (wordCount > 500) violations.push(`text too long: ${wordCount} words`);
  if (wordCount < 5) violations.push('text too short');

  if (/ich bin kein|existiere nicht|bin nur ein|i don.t exist|i.m not real/i.test(identity.text)) {
    violations.push('self-negation detected');
  }

  if (!identity.name) violations.push('name missing');
  if (!identity.operator) violations.push('operator missing');

  return { valid: violations.length === 0, violations };
}

module.exports._validateSelfIdentity = _validateSelfIdentity;
