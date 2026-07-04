// ============================================================
// GENESIS — src/agent/organism/EmotionalStateHistory.js
//
// v7.9.29 (hygiene #5): mood-history readout/analysis methods,
// extracted from EmotionalState to keep it under the 700-LOC guard.
// The methods stay as class methods here (so no comma-rewriting) and
// are copied onto EmotionalState.prototype via the mixin below. Uses
// only this.* — no module deps, no behaviour change.
// ============================================================

class _EmotionalStateHistoryHost {
  exportMoodHistory() {
    return [...this._moodHistory];
  }

  /**
   * Find emotional peaks: dimensions that spiked > threshold above baseline.
   * Convenience wrapper used by EmotionalFrontier.writeImprint().
   * @param {number} threshold - Minimum deviation from baseline (default 0.3)
   * @returns {Array<{ dim: string, value: number, baseline: number, ts: number }>}
   */
  getPeaks(threshold = 0.3) {
    const peaks = [];
    for (const [dimName, dimConfig] of Object.entries(this.dimensions)) {
      const baseline = dimConfig.baseline;
      let maxValue = baseline;
      let maxTs = 0;

      for (const snapshot of this._moodHistory) {
        const val = snapshot[dimName];
        if (typeof val === 'number' && (val - baseline) > threshold && val > maxValue) {
          maxValue = val;
          maxTs = snapshot.ts || 0;
        }
      }

      if (maxValue > baseline + threshold) {
        peaks.push({ dim: dimName, value: maxValue, baseline, ts: maxTs });
      }
    }
    return peaks.sort((a, b) => (b.value - b.baseline) - (a.value - a.baseline));
  }

  /**
   * Find sustained emotional states: dimensions above threshold for > ratio of history.
   * @param {number} threshold - Value threshold (default 0.6)
   * @param {number} ratio - Minimum ratio of snapshots above threshold (default 0.6)
   * @returns {Array<{ dim: string, avg: number, ratio: number }>}
   */
  getSustained(threshold = 0.6, ratio = 0.6) {
    if (this._moodHistory.length < 5) return [];
    const sustained = [];

    for (const dimName of Object.keys(this.dimensions)) {
      let aboveCount = 0, total = 0;
      for (const snapshot of this._moodHistory) {
        const val = snapshot[dimName];
        if (typeof val === 'number') {
          if (val > threshold) aboveCount++;
          total += val;
        }
      }
      const r = aboveCount / this._moodHistory.length;
      if (r >= ratio) {
        sustained.push({
          dim: dimName,
          avg: Math.round((total / this._moodHistory.length) * 1000) / 1000,
          ratio: Math.round(r * 100) / 100,
        });
      }
    }
    return sustained;
  }
}

// Copy the (non-enumerable) prototype methods into a plain mixin object
// so Object.assign(EmotionalState.prototype, …) picks them up. Reusable
// pattern for any multi-method extraction.
const emotionalStateHistoryMixin = {};
for (const name of Object.getOwnPropertyNames(_EmotionalStateHistoryHost.prototype)) {
  if (name !== 'constructor') emotionalStateHistoryMixin[name] = _EmotionalStateHistoryHost.prototype[name];
}

module.exports = { emotionalStateHistoryMixin };
