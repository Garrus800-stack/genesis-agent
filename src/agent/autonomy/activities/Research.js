// @ts-checked-v5.7
// ============================================================
// GENESIS — activities/Research.js (v7.3.1)
// Web-based learning from trusted domains (npm, GitHub, SO).
// Conditional: webFetcher available + network ok.
// Gates (from scorer): energy >=0.5, trust >=1, max 3/h, 30min cooldown.
// Frontier boosts: UnfinishedWork (1.4x), Suspicion (1.3x),
//   NeedsSystem.knowledge > 0.6 (1.5x).
// Curiosity boosts: Genome (0.5+cur), Frontier curiosity-sustained
//   (1 + 0.3*cd).
// ============================================================

'use strict';

const { createLogger } = require('../../core/Logger');
const _log = createLogger('IdleMind');

module.exports = {
  name: 'research',
  weight: 1.2,
  cooldown: 0,

  shouldTrigger(ctx) {
    // Availability gates
    if (!ctx.services.webFetcher) return 0;
    if (!ctx.snap.networkOk) return 0;

    let boost = 1.0;

    // Energy gate — hard zero
    const energy = ctx.snap.emotional?.energy ?? 0.5;
    if (energy < 0.5) return 0;

    // Trust gate — hard zero
    const trust = ctx.snap.trustLevel ?? 1;
    if (trust < 1) return 0;

    // Rate limit: max 3 per hour
    const now = ctx.now;
    const recentResearch = (ctx.activityLog || [])
      .filter(a => a.activity === 'research' && now - a.timestamp < 60 * 60 * 1000);
    if (recentResearch.length >= 3) return 0;

    // Cooldown: 30min after last research
    const lastR = recentResearch[recentResearch.length - 1];
    if (lastR && now - lastR.timestamp < 30 * 60 * 1000) {
      boost *= 0.1;
    }

    // NeedsSystem recommendations (general)
    const needRec = (ctx.snap.needs || []).find(n => n.activity === 'research');
    if (needRec) boost += needRec.score * 3;

    // Knowledge need boost
    const needs = ctx.snap.needsRaw || {};
    if ((needs.knowledge || 0) > 0.6) boost *= 1.5;

    // Genome curiosity
    const cur = ctx.snap.genomeTraits?.curiosity;
    if (cur !== undefined) boost *= (0.5 + cur);

    // Frontier boosts
    if ((ctx.snap.unfinishedWork || []).length > 0) boost *= 1.4;
    if ((ctx.snap.suspicions || []).length > 0) boost *= 1.3;

    // EmotionalFrontier curiosity sustained
    for (const imp of (ctx.snap.imprints || [])) {
      const curiositySust = (imp.sustained || []).filter(s => s.dim === 'curiosity');
      if (curiositySust.length > 0) {
        const cooldownFactor = ctx.cycleState.recentImprintIds?.has(imp.nodeId) ? 0.5 : 1.0;
        boost *= (1 + 0.3 * cooldownFactor);
      }
    }

    return boost;
  },

  async run(idleMind) {
    if (idleMind._pendingResearch) return null;

    const topic = _pickResearchTopic(idleMind);
    _log.debug(`[IDLE] Research topic: ${topic ? topic.label + ' (source: ' + topic.source + ')' : 'null — no topic found'}`);
    if (!topic) return null;

    idleMind._pendingResearch = { topic, startedAt: Date.now() };

    idleMind.bus.fire('idle:research-started', {
      topic: topic.label, source: topic.source, query: topic.query,
    }, { source: 'IdleMind' });

    _doResearchAsync(idleMind, topic).catch(err => {
      _log.debug('[IDLE] Research failed:', err.message);
      idleMind._pendingResearch = null;
    });

    return `Research started: ${topic.label}`;
  },
};

// ── Helpers (moved from IdleMindActivities.js) ────────────

async function _doResearchAsync(idleMind, topic) {
  if (!idleMind._webFetcher) { idleMind._pendingResearch = null; return; }

  if (idleMind._researchBackoffUntil && Date.now() < idleMind._researchBackoffUntil) {
    _log.debug('[IDLE] Research skipped — backoff active');
    idleMind._pendingResearch = null;
    return;
  }

  const url = _buildResearchUrl(topic);
  let fetchResult;
  try {
    fetchResult = await idleMind._webFetcher.fetch(url);
  } catch (err) {
    _log.debug('[IDLE] Research fetch failed:', err.message);
    const failures = (idleMind._researchFailures || 0) + 1;
    idleMind._researchFailures = Math.min(failures, 5);
    idleMind._researchBackoffUntil = Date.now() + Math.min(failures * failures * 60 * 1000, 30 * 60 * 1000);
    _log.debug(`[IDLE] Research backoff: ${idleMind._researchFailures} failures, next retry in ${Math.round((idleMind._researchBackoffUntil - Date.now()) / 60000)}min`);
    idleMind._pendingResearch = null;
    return;
  }

  idleMind._researchFailures = 0;
  idleMind._researchBackoffUntil = null;

  if (!fetchResult?.body) { idleMind._pendingResearch = null; return; }

  const deepUrl = _getDeepReadUrl(topic, fetchResult.body);
  if (deepUrl) {
    try {
      const deepFn = deepUrl.includes('raw.githubusercontent.com') ? 'fetchText' : 'fetch';
      const deepResult = await idleMind._webFetcher[deepFn](deepUrl);
      if (deepResult?.ok && deepResult.body?.length > 100) {
        fetchResult.body = _extractDeepContent(deepUrl, deepResult.body);
      }
    } catch (_e) { /* fallback to Phase 1 content */ }
  }

  if (!idleMind.model) { idleMind._pendingResearch = null; return; }
  const body = (typeof fetchResult.body === 'string' ? fetchResult.body : JSON.stringify(fetchResult.body)).slice(0, 5000);
  const DISTILL_FOCUS = {
    'unfinished-work': 'Focus on actionable next steps and concrete techniques to complete this work.',
    'suspicion': 'Focus on root cause analysis and what to watch out for.',
    'weakness': 'Focus on reusable techniques and patterns to improve this capability.',
    'curiosity': 'Focus on the most interesting or surprising facts. What would you want to remember?',
  };
  const focus = DISTILL_FOCUS[topic.source] || 'Focus on actionable knowledge.';
  const safeLabel = (topic.label || '').slice(0, 120).replace(/[<>{}\\`]/g, '');
  const prompt = `You are Genesis. You researched "${safeLabel}" and found this:\n\n${body}\n\nDistill the most useful insight in 2-3 sentences for your own reference. ${focus}`;

  let insight;
  try {
    insight = await idleMind.model.chat(prompt, [], 'analysis');
  } catch (err) {
    _log.debug('[IDLE] Research distillation failed:', err.message);
    idleMind._pendingResearch = null;
    return;
  }

  if (idleMind.kg && insight) {
    const quality = _scoreResearchInsight(insight, topic);
    if (quality.score >= 0.5) {
      idleMind.kg.addNode('research', `${topic.label}: ${insight.slice(0, 60)}`, {
        type: 'research-finding',
        topic: topic.label,
        source: topic.source,
        url: url,
        insight: insight.slice(0, 500),
        query: topic.query,
        qualityScore: quality.score,
      });
    } else {
      _log.debug(`[IDLE] Research insight rejected (quality ${quality.score.toFixed(2)}): ${quality.reason}`);
      idleMind._researchStats = idleMind._researchStats || { written: 0, rejected: 0 };
      idleMind._researchStats.rejected++;
    }
  }

  idleMind.bus.emit('knowledge:learned', {
    source: 'research', topic: topic.label, url,
  }, { source: 'IdleMind' });

  idleMind.bus.fire('idle:research-complete', {
    topic: topic.label, source: topic.source, insight: insight?.slice(0, 200),
  }, { source: 'IdleMind' });

  idleMind._pendingResearch = null;
  _log.info(`[IDLE] Research complete: ${topic.label}`);
}

function _pickResearchTopic(idleMind) {
  const sources = [];

  if (idleMind._unfinishedWorkFrontier) {
    try {
      const recent = idleMind._unfinishedWorkFrontier.getRecent(2);
      for (const node of recent) {
        const topic = node.description || node.pending_goals?.[0]?.description;
        if (topic) sources.push({
          query: `${topic.slice(0, 40)} best practices nodejs`,
          label: topic.slice(0, 50),
          source: 'unfinished-work',
          priority: 1.4,
        });
      }
    } catch (_e) { /* optional */ }
  }

  if (idleMind._suspicionFrontier) {
    try {
      const recent = idleMind._suspicionFrontier.getRecent(2);
      for (const node of recent) {
        if (node.dominant_category) {
          sources.push({
            query: `${node.dominant_category} common pitfalls solutions`,
            label: `${node.dominant_category} pitfalls`,
            source: 'suspicion',
            priority: 1.3,
          });
        }
      }
    } catch (_e) { /* optional */ }
  }

  if (idleMind._cognitiveSelfModel) {
    try {
      const weak = idleMind._cognitiveSelfModel.getWeakestCapability?.();
      if (weak) sources.push({
        query: `${weak.taskType} techniques improvement`,
        label: `improve ${weak.taskType}`,
        source: 'weakness',
        priority: 1.1,
      });
    } catch (_e) { /* optional */ }
  }

  if (sources.length === 0 && idleMind.kg) {
    try {
      const nodes = [...idleMind.kg.graph.nodes.values()]
        .filter(n => n.type !== 'system' && n.label?.length > 3)
        .sort((a, b) => (b.accessed || 0) - (a.accessed || 0))
        .slice(0, 5);
      const interesting = nodes[0];
      if (interesting) sources.push({
        query: `${interesting.label} tutorial guide`,
        label: `curiosity: ${interesting.label}`,
        source: 'curiosity',
        priority: 0.8,
      });
    } catch (_e) { /* optional */ }
  }

  if (sources.length === 0) return null;

  const totalWeight = sources.reduce((s, t) => s + t.priority, 0);
  let r = Math.random() * totalWeight;
  for (const s of sources) {
    r -= s.priority;
    if (r <= 0) return s;
  }
  return sources[0];
}

function _buildResearchUrl(topic) {
  const q = encodeURIComponent(topic.query.slice(0, 80));
  const strategies = [
    `https://registry.npmjs.org/-/v1/search?text=${q}&size=3`,
    `https://api.github.com/search/repositories?q=${q}&sort=stars&per_page=3`,
    `https://api.stackexchange.com/2.3/search?order=desc&sort=votes&intitle=${q}&site=stackoverflow&pagesize=3`,
  ];
  if (topic.source === 'weakness') return strategies[2];
  if (topic.source === 'suspicion') return strategies[1];
  if (topic.source === 'unfinished-work') return strategies[Math.random() < 0.5 ? 0 : 2];
  return strategies[Math.floor(Math.random() * strategies.length)];
}

function _getDeepReadUrl(topic, rawBody) {
  try {
    const data = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;

    if (data?.objects?.[0]?.package) {
      const repoUrl = data.objects[0].package.links?.repository || '';
      const match = repoUrl.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
      if (match) return `https://raw.githubusercontent.com/${match[1]}/HEAD/README.md`;
      return null;
    }

    if (data?.items?.[0]?.full_name) {
      return `https://raw.githubusercontent.com/${data.items[0].full_name}/HEAD/README.md`;
    }

    if (data?.items?.[0]?.question_id) {
      const id = data.items[0].question_id;
      return `https://api.stackexchange.com/2.3/questions/${id}/answers?order=desc&sort=votes&site=stackoverflow&filter=withbody&pagesize=1`;
    }
  } catch (_e) { /* not parseable — skip deep read */ }
  return null;
}

function _extractDeepContent(url, rawBody) {
  try {
    if (url.includes('stackexchange.com')) {
      const data = JSON.parse(rawBody);
      const answer = data.items?.[0]?.body || '';
      return answer.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
  } catch (_e) { /* parse failed — return raw */ }

  return rawBody;
}

function _scoreResearchInsight(insight, topic) {
  if (!insight || insight.length < 20) {
    return { score: 0, reason: 'too short' };
  }

  // v7.3.6 #10 — Unicode-aware tokenization. Previously used /\W+/ which
  // splits on everything except [A-Za-z0-9_], so "Müller" became ['M','ller']
  // and "Fähigkeit" became ['F','higkeit']. With /[^\p{L}\p{N}_]+/u we split
  // only on true non-letters/-digits across all scripts, keeping umlauts
  // and accented chars inside their words.
  const insightWords = new Set(insight.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(w => w.length > 2));
  const topicWords = new Set(
    `${topic.label || ''} ${topic.query || ''}`.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(w => w.length > 2)
  );
  const intersection = [...insightWords].filter(w => topicWords.has(w)).length;
  const union = new Set([...insightWords, ...topicWords]).size;
  const relevance = union > 0 ? intersection / union : 0;

  const FILLER = /\b(various|many|several|some|generally|typically|often|usually|important|useful|helpful)\b/gi;
  const fillerCount = (insight.match(FILLER) || []).length;
  const specificity = Math.min(insight.length / 200, 1) * Math.max(1 - fillerCount * 0.15, 0.2);

  const score = Math.round((relevance * 0.4 + specificity * 0.6) * 100) / 100;

  const reason = score < 0.5
    ? `low quality (relevance: ${relevance.toFixed(2)}, specificity: ${specificity.toFixed(2)})`
    : 'passed';

  return { score, reason };
}

// Export helpers for unit testing if needed
module.exports._pickResearchTopic = _pickResearchTopic;
module.exports._buildResearchUrl = _buildResearchUrl;
module.exports._getDeepReadUrl = _getDeepReadUrl;
module.exports._extractDeepContent = _extractDeepContent;
module.exports._scoreResearchInsight = _scoreResearchInsight;
