// ============================================================
// GENESIS — foundation/ModelBridgeFailover.js (v7.6.5)
//
// Failover-helper mixin extracted from ModelBridge.js in v7.6.5
// (A2 file-size-guard closeout). Holds the three small helpers
// that resolve and emit failover-related decisions:
//
//   _findFallbackBackend(failedBackend, failedModelName?)
//   _classifyFailoverReason(err)
//   _emitFailoverUnavailable(failedBackend, err)
//
// Why split: ModelBridge.js was 700 LOC (the architectural-fitness
// File-Size-Guard counts the trailing newline, so the file reported
// 701 against the 700 soft-guard). These three helpers form a
// coherent failover-resolution cluster — pure functions of
// ModelBridge state with no shared private fields beyond what
// `this` already carries (settings, availableModels, backends,
// _fallbackModel, bus). Extracting them is purely structural;
// runtime semantics unchanged.
//
// Coupling note: methods read/write
//   this._settings              read fallbackChain
//   this.availableModels        read iterate
//   this.backends               read isConfigured
//   this._fallbackModel         write — picked fallback for next dispatch
//   this.isMarkedUnavailable()  read — own availability mixin
//   this.bus.fire(...)          write — model:failover-unavailable
//
// Mixed onto ModelBridge.prototype at module-load via Object.assign
// — see ModelBridge.js bottom + the canonical Mixin Convention in
// ARCHITECTURE.md § 5.8.
// ============================================================

'use strict';

// v7.9.37 pass 4 (B2): Ollama convention — cloud endpoints carry ':cloud'.
// Module-level helper (NOT a mixin method — v7.6.5 counts exactly four).
function isCloudModel(name) { return /:cloud$/i.test(String(name || '')); }

const failoverMixin = {

  /**
   * Find a fallback backend when one fails.
   * @param {string} failedBackend - The backend that failed
   * @param {string|null} failedModelName - The specific model that failed (v7.5.7+):
   *   when provided, that single model is skipped in the chain (instead
   *   of the entire backend, which made the chain useless when all configured
   *   fallbacks shared one backend with the primary).
   */
  _findFallbackBackend(failedBackend, failedModelName = null) {
    const chain = this._settings?.get?.('models.fallbackChain') || [];
    for (const modelName of chain) {
      if (modelName === failedModelName) continue;
      if (this.isMarkedUnavailable(modelName)) continue;
      const model = this.availableModels.find(m => m.name === modelName);
      if (model) {
        this._fallbackModel = model;
        return model.backend;
      }
    }
    // Cross-backend escape: try other backends in priority order
    const order = ['ollama', 'anthropic', 'openai'];
    for (const b of order) {
      if (b === failedBackend) continue;
      if (b === 'ollama' && this.availableModels.some(m =>
        m.backend === 'ollama' && !this.isMarkedUnavailable(m.name)
      )) return b;
      if (this.backends[b].isConfigured()) return b;
    }
    return null;
  },

  // v7.4.8: classify failover errors into structured categories so
  // consumers (dashboard, CostStream later, MetaLearning) can aggregate
  // without string-matching err.message themselves.
  _classifyFailoverReason(err) {
    // v7.9.37 pass 4 (B1): the R1a wrapper throws "[CONTINUATION] … max-continuations …" —
    // without this pattern the failover re-marked the model with reason=undefined,
    // overwriting the wrapper's good mark (field 10.07.: persist showed reason:None).
    if (/max-continuations|continuation-exhausted/i.test((err && err.message) || '')) {
      return 'continuation-exhausted';
    }
    const msg = (err?.message || '').toLowerCase();
    // v7.5.7-fix: subscription checked before generic 401/403 'auth'
    // — Ollama Cloud Pro-gates carry both. Without this, gated cloud
    // models would get the 1h auth-TTL not the 24h subscription-TTL.
    // v7.9.49 (field): HTTP 402 is Payment Required — that IS the class, whatever
    // words follow it. The patterns below were written around the phrasings we had
    // seen, and Ollama's actual message contains none of them: "this model uses
    // extra usage only (not included plan usage) and your extra usage balance is
    // empty". So no reason matched, the model was never marked unavailable, and
    // Genesis paid a failed round trip on every single message. The status code
    // cannot be rephrased; the sentence can.
    if (/\b402\b|payment required/.test(msg)) return 'subscription-required';
    if (/extra usage|not included (in )?(your )?plan|billing|add (extra )?credit/.test(msg)) return 'subscription-required';
    if (/subscription|requires.*upgrade|upgrade for access|ollama\.com\/upgrade/.test(msg)) return 'subscription-required';
    // v7.8.2: tightened quota detection. v7.8.1 used `limit.{0,20}reached`
    // and bare `reset.{0,20}(in|on|at)` which matched normal 5min rate-
    // limits ("rate-limit reached", "reset in 60 seconds") and unrelated
    // text ("Weekly digest is unavailable"). The four patterns below only
    // match when a time-scale word (weekly/monthly/daily) or a long reset
    // window (days/weeks/months) qualifies the limit.
    if (/\b(weekly|monthly|daily)\s+(quota|limit|usage)/.test(msg)) return 'quota-exhausted';
    if (/quota.{0,20}(exceeded|reached|exhausted)/.test(msg)) return 'quota-exhausted';
    if (/usage.{0,20}(quota|limit).{0,20}(exceeded|reached|exhausted)/.test(msg)) return 'quota-exhausted';
    if (/reset.{0,20}(in|on|at).{0,40}(day|days|week|weeks|month|months|tomorrow|next\s+\w+day)/.test(msg)) return 'quota-exhausted';
    if (/rate.?limit|429|too many/.test(msg)) return 'rate-limit';
    if (/timeout|timed out|etimedout/.test(msg)) return 'timeout';
    if (/econnrefused|enotfound|eai_again|network|socket hang up|fetch failed/.test(msg)) return 'connection-error';
    // v7.9.25: a retired/decommissioned model is permanently gone. Classify it
    // BEFORE auth so a 410 that also mentions keys still gets the sticky model-
    // retired TTL, not the short auth one. Without this a 410 fell through to
    // 'other' (no TTL entry), so the dead model was retried first on every call.
    // The 410 status is matched only in a status/code/http context so an unrelated
    // "410 tokens" does not trip it.
    if (/\bretired\b|decommission|(?:status|code|http)[^0-9]{0,5}410\b|\b410\s+gone\b/.test(msg)) return 'model-retired';
    if (/401|403|unauthor|invalid.*key|api.?key/.test(msg)) return 'auth';
    return 'other';
  },

  // v7.9.37 pass 3 (R1b): when preferred AND the whole fallback chain are
  // unavailable, pick the best still-usable discovered model (score-ranked,
  // same mechanism the boot auto-select uses). Returns { name, backend } or
  // null when truly nothing is usable — the caller then falls through to the
  // existing failover-unavailable path.
  _pickDegradedLocal() {
    try {
      const eligible = (this.availableModels || [])
        .filter(m => m && m.name && !this.isMarkedUnavailable(m.name));
      if (eligible.length === 0) return null;
      // v7.9.37 pass 4 (B2): prefer non-cloud when any is usable — but the
      // user's cloud-only setup stays first-class (cloud wins if it's all there is).
      const nonCloud = eligible.filter(m => !isCloudModel(m.name));
      const chosen = this._selectBestModel(nonCloud.length > 0 ? nonCloud : eligible);
      return chosen ? { name: chosen.name, backend: chosen.backend || 'ollama' } : null;
    } catch (_e) { return null; }
  },

  // v7.4.8: emitted when _findFallbackBackend returns null. Closes the
  // observability gap — without this event, "Genesis tried to failover
  // but had nothing to switch to" was invisible in EventStore.
  _emitFailoverUnavailable(failedBackend, err) {
    const chain = this._settings?.get?.('models.fallbackChain') || [];
    const reason = chain.length === 0
      ? 'no-chain-configured'
      : 'all-other-backends-unavailable';
    this.bus.fire('model:failover-unavailable', {
      from: failedBackend || 'unknown',
      reason,
      error: err.message,
    }, { source: 'ModelBridge' });
  },

};

module.exports = { failoverMixin, isCloudModel };
