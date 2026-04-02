// @ts-checked-v5.7 — unbound `this` in prototype-delegation object
// ============================================================
// GENESIS — DreamCycleAnalysis.js (v5.6.0)
//
// Extracted from DreamCycle.js — pattern detection, schema
// extraction, memory consolidation, and insight generation.
// Attached via prototype delegation (same pattern as IdleMind
// → IdleMindActivities, PromptBuilder → PromptBuilderSections).
//
// Each method accesses DreamCycle instance state via `this`.
// ============================================================

const { createLogger } = require('../core/Logger');
const _log = createLogger('DreamCycle');

const analysis = {

  // ════════════════════════════════════════════════════════
  // PHASE 2: PATTERN DETECTION (pure heuristic)
  // ════════════════════════════════════════════════════════

  _detectPatterns(episodes) {
    const patterns = [];
    patterns.push(...this._findActionSequences(episodes));
    patterns.push(...this._findErrorClusters(episodes));
    patterns.push(...this._findSurprisePatterns(episodes));
    return patterns;
  },

  _findActionSequences(episodes) {
    const actionTags = ['CODE_GENERATE', 'WRITE_FILE', 'RUN_TESTS', 'SHELL_EXEC',
                        'SELF_MODIFY', 'ANALYZE', 'SEARCH', 'GIT_SNAPSHOT'];
    const sequences = new Map();

    const actionEpisodes = episodes.filter(e =>
      e.metadata?.actionType || e.tags?.some(t => actionTags.includes(t.toUpperCase()))
    );

    const windows = this._groupByTimeWindow(actionEpisodes, 30 * 60 * 1000);

    for (const window of windows) {
      if (window.length < 2) continue;
      const seqKey = window.map(e =>
        (e.metadata?.actionType || e.tags?.find(t => actionTags.includes(t.toUpperCase())) || 'unknown')
      ).join('→');

      const lastSuccess = window[window.length - 1].metadata?.success;
      if (!sequences.has(seqKey)) sequences.set(seqKey, []);
      sequences.get(seqKey).push({ success: lastSuccess, windowSize: window.length });
    }

    const results = [];
    for (const [key, occurrences] of sequences) {
      if (occurrences.length >= 2) {
        const successCount = occurrences.filter(o => o.success).length;
        results.push({
          type: 'action-sequence',
          key,
          occurrences: occurrences.length,
          successRate: successCount / occurrences.length,
          detail: occurrences,
        });
      }
    }
    return results;
  },

  _findErrorClusters(episodes) {
    const errorEps = episodes.filter(e =>
      e.tags?.includes('error') || e.tags?.includes('negative') ||
      e.metadata?.success === false
    );
    if (errorEps.length < 2) return [];

    const clusters = new Map();
    for (const ep of errorEps) {
      const key = ep.metadata?.actionType || 'unknown';
      if (!clusters.has(key)) clusters.set(key, []);
      clusters.get(key).push(ep);
    }

    const results = [];
    for (const [key, eps] of clusters) {
      if (eps.length >= 2) {
        results.push({
          type: 'error-cluster',
          key: `errors-in-${key}`,
          occurrences: eps.length,
          successRate: 0,
          detail: eps.slice(0, 5).map(e => (e.summary || '').slice(0, 100)),
        });
      }
    }
    return results;
  },

  _findSurprisePatterns(episodes) {
    const surprisingEps = episodes.filter(e =>
      (e.metadata?.surprise || 0) > 0.8 || (e.emotionalWeight || 0) > 0.7
    );
    if (surprisingEps.length < 2) return [];

    const positive = surprisingEps.filter(e => e.metadata?.valence === 'positive' || e.tags?.includes('positive'));
    const negative = surprisingEps.filter(e => e.metadata?.valence === 'negative' || e.tags?.includes('negative'));

    const results = [];
    if (positive.length >= 2) {
      results.push({
        type: 'surprise-positive',
        key: 'unexpected-successes',
        occurrences: positive.length,
        successRate: 1.0,
        detail: positive.slice(0, 5).map(e => (e.summary || '').slice(0, 100)),
      });
    }
    if (negative.length >= 2) {
      results.push({
        type: 'surprise-negative',
        key: 'unexpected-failures',
        occurrences: negative.length,
        successRate: 0,
        detail: negative.slice(0, 5).map(e => (e.summary || '').slice(0, 100)),
      });
    }
    return results;
  },

  _groupByTimeWindow(episodes, windowMs) {
    if (episodes.length === 0) return [];
    const sorted = [...episodes].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    const windows = [];
    let currentWindow = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      const gap = (sorted[i].timestamp || 0) - (sorted[i - 1].timestamp || 0);
      if (gap < windowMs) {
        currentWindow.push(sorted[i]);
      } else {
        if (currentWindow.length > 0) windows.push(currentWindow);
        currentWindow = [sorted[i]];
      }
    }
    if (currentWindow.length > 0) windows.push(currentWindow);
    return windows;
  },

  // ════════════════════════════════════════════════════════
  // PHASE 3: SCHEMA EXTRACTION
  // ════════════════════════════════════════════════════════

  async _batchExtractSchemas(patterns) {
    const patternSummaries = patterns.slice(0, 8).map((p, i) =>
      `${i + 1}. [${p.type}] "${p.key}" — ${p.occurrences} occurrences, ` +
      `${(p.successRate * 100).toFixed(0)}% success rate` +
      (p.detail?.length > 0 ? `\n   Context: ${JSON.stringify(p.detail).slice(0, 200)}` : '')
    ).join('\n');

    const prompt = `Analyze these recurring patterns in an AI agent's behavior. Extract 1-5 reusable schemas.

PATTERNS:
${patternSummaries}

Respond with JSON array only (no markdown):
[
  {
    "name": "short-kebab-case-name",
    "description": "What this pattern means in 1 sentence",
    "trigger": "space-separated keywords that indicate when this pattern applies",
    "successModifier": 0.0,
    "recommendation": "What the agent should do differently",
    "confidence": 0.0
  }
]

Rules:
- successModifier: -1.0 to 1.0 (negative = pattern reduces success, positive = increases)
- confidence: 0.0 to 1.0 (how reliable is this pattern?)
- Maximum 5 schemas. Only extract clear, actionable patterns.
- trigger should contain action type keywords (code_generate, run_tests, etc.)`;

    try {
      const raw = await this.model.chat(prompt, [], 'analysis');
      const parsed = this._parseJSONResponse(raw);
      if (!Array.isArray(parsed)) return [];

      return parsed.slice(0, 5).map(s => ({
        id: `schema_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: s.name || 'unnamed',
        description: s.description || '',
        trigger: s.trigger || '',
        successModifier: Math.max(-1, Math.min(1, Number(s.successModifier) || 0)),
        recommendation: s.recommendation || '',
        confidence: Math.max(0, Math.min(1, Number(s.confidence) || 0.5)),
        sourcePattern: 'dream-llm',
        occurrences: 1,
        createdAt: Date.now(),
      }));
    } catch (err) {
      _log.debug('[DREAM] LLM schema extraction failed:', err.message);
      return this._heuristicSchemas(patterns);
    }
  },

  _heuristicSchemas(patterns) {
    return patterns.map(p => ({
      id: `schema_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: `${p.type}-${p.key.replace(/[^a-z0-9-]/gi, '-').slice(0, 40)}`,
      description: `Pattern: ${p.type} "${p.key}" — ${p.occurrences} occurrences, ${(p.successRate * 100).toFixed(0)}% success`,
      trigger: p.key.replace(/→/g, ' ').toLowerCase(),
      successModifier: p.successRate < 0.5 ? -(1 - p.successRate) * 0.5 : (p.successRate - 0.5) * 0.3,
      recommendation: p.successRate < 0.5
        ? `This pattern has ${(p.successRate * 100).toFixed(0)}% success. Consider alternative approach.`
        : `This pattern works ${(p.successRate * 100).toFixed(0)}% of the time.`,
      confidence: Math.min(p.occurrences / 10, 0.8),
      sourcePattern: `dream-heuristic-${p.type}`,
      occurrences: p.occurrences,
      createdAt: Date.now(),
    }));
  },

  // ════════════════════════════════════════════════════════
  // PHASE 4: MEMORY CONSOLIDATION
  // ════════════════════════════════════════════════════════

  _consolidateMemories(episodes) {
    let strengthened = 0;
    let decayed = 0;

    for (const episode of episodes) {
      const surprise = episode.metadata?.surprise || episode.emotionalWeight || 0;
      if (surprise > 0.8) {
        this._strengthenMemory(episode);
        strengthened++;
      } else if (surprise < 0.2) {
        this._decayMemory(episode);
        decayed++;
      }
    }
    return { strengthened, decayed };
  },

  _strengthenMemory(episode) {
    if (!this.kg || !episode.metadata?.knowledgeNodeId) return;
    try {
      const node = this.kg.findNode(episode.metadata.knowledgeNodeId);
      if (node && node.properties) {
        node.properties.weight = Math.min((node.properties.weight || 0.5) + 0.1, 1.0);
        node.properties.lastStrengthened = Date.now();
      }
    } catch (_e) { _log.debug('[catch] dream schema store:', _e.message); }
  },

  _decayMemory(episode) {
    if (!this.kg || !episode.metadata?.knowledgeNodeId) return;
    try {
      const node = this.kg.findNode(episode.metadata.knowledgeNodeId);
      if (node && node.properties) {
        node.properties.weight = Math.max((node.properties.weight || 0.5) - this._memoryDecayRate, 0.05);
        node.properties.lastDecayed = Date.now();
      }
    } catch (_e) { _log.debug('[catch] dream KG strengthen:', _e.message); }
  },

  // ════════════════════════════════════════════════════════
  // PHASE 5: INSIGHT GENERATION
  // ════════════════════════════════════════════════════════

  _generateInsights(newSchemas) {
    if (!this.schemaStore) return [];

    const existingSchemas = this.schemaStore.getAll();
    const insights = [];

    for (const newSchema of newSchemas) {
      for (const existing of existingSchemas) {
        if (existing.id === newSchema.id) continue;

        const newWords = new Set((newSchema.trigger || '').split(/\s+/));
        const existWords = new Set((existing.trigger || '').split(/\s+/));
        let overlap = 0;
        for (const w of newWords) if (existWords.has(w)) overlap++;

        if (overlap >= 2 && newSchema.successModifier * existing.successModifier < 0) {
          insights.push({
            type: 'contradiction',
            description: `Schema "${newSchema.name}" contradicts "${existing.name}" — ` +
                         `one predicts ${newSchema.successModifier > 0 ? 'success' : 'failure'}, ` +
                         `the other ${existing.successModifier > 0 ? 'success' : 'failure'}`,
            schemas: [newSchema.id, existing.id],
            timestamp: Date.now(),
          });
        } else if (overlap >= 2) {
          insights.push({
            type: 'reinforcement',
            description: `Schema "${newSchema.name}" reinforces "${existing.name}"`,
            schemas: [newSchema.id, existing.id],
            timestamp: Date.now(),
          });
        }
      }
    }
    return insights.slice(0, 5);
  },

  // ════════════════════════════════════════════════════════
  // UTILITIES
  // ════════════════════════════════════════════════════════

  _parseJSONResponse(raw) {
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (_e) {
      const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (match) {
        try { return JSON.parse(match[1]); } catch (_e2) { _log.debug('[catch] JSON fence parse:', _e2.message); }
      }
      const arrMatch = raw.match(/\[[\s\S]*\]/);
      if (arrMatch) {
        try { return JSON.parse(arrMatch[0]); } catch (_e2) { _log.debug('[catch] JSON array extract:', _e2.message); }
      }
      return null;
    }
  },

};

module.exports = { analysis };
