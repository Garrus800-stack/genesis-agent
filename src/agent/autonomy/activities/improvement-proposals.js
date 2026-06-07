// ============================================================
// GENESIS — autonomy/activities/improvement-proposals.js (v7.9.20)
// Pure proposal-building. NO imports — deterministic, fully unit-testable.
//
// Turns agent-loop-analysis insights (already in the knowledge graph) into
// improvement proposals, applying three filters:
//   - dedup vs. existing proposals (proposed/attempted)
//   - dismissed-cooldown dedup (a rejected proposal stays suppressed until
//     its cooldownUntil passes)
//   - facet-O harm filter (skip files a self-modification lesson flagged as
//     regressed — never propose touching them again)
// ============================================================

'use strict';

/**
 * @param {Array<{insight?:string, full?:string, module?:string, file?:string}>} insights
 * @param {object} [opts]
 * @param {Array<object>} [opts.existing]    - current proposals (any status), carry .key/.status/.cooldownUntil
 * @param {Array<string>} [opts.harmedFiles] - files a self-modification lesson flagged (facet O)
 * @param {number} [opts.now]
 * @param {number} [opts.max]                - cap per build
 * @returns {Array<object>} freshly built proposals ({ id, key, title, rationale, file, createdAt, status:'proposed' })
 */
function buildProposals(insights, { existing = [], harmedFiles = [], now = Date.now(), max = 5 } = {}) {
  if (!Array.isArray(insights)) return [];

  // Keys already known (proposed/attempted) or dismissed-within-cooldown are blocked.
  const blocked = new Set();
  for (const p of existing || []) {
    if (!p || !p.key) continue;
    if (p.status === 'dismissed') {
      if (p.cooldownUntil && now < p.cooldownUntil) blocked.add(p.key);
    } else {
      blocked.add(p.key);
    }
  }
  const harmed = new Set(harmedFiles || []);

  const out = [];
  for (const ins of insights) {
    if (!ins) continue;
    const file = ins.module || ins.file || null;
    const text = String(ins.full || ins.insight || ins.description || ins.label || '').trim();
    if (!text) continue;
    const key = `${file || ''}::${text.slice(0, 80)}`.toLowerCase();
    if (blocked.has(key)) continue;
    if (file && harmed.has(file)) continue;
    blocked.add(key);                      // also dedup within this batch
    out.push({
      id: `prop_${now}_${out.length}`,
      key,
      title: text.slice(0, 100),
      rationale: text,
      file,
      createdAt: new Date(now).toISOString(),
      status: 'proposed',
    });
    if (out.length >= max) break;
  }
  return out;
}

module.exports = { buildProposals };
