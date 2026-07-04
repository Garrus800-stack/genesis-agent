// ============================================================
// GENESIS — src/agent/autonomy/AutonomousDaemonActivities.js
//
// v7.9.29 (hygiene #8): idle-cycle maintenance activities (health
// check, memory consolidation, history learning, optimisation
// suggestions + persistence), extracted from AutonomousDaemon to
// keep it under the 700-LOC guard. Class methods copied onto
// AutonomousDaemon.prototype via the mixin. this.* + _log.
// ============================================================

const { createLogger } = require('../core/Logger');
const _log = createLogger('AutonomousDaemon');

class _AutonomousDaemonActivitiesHost {
  async _healthCheck() {
    this._log('debug', 'Health check...');

    // 1. Kernel integrity
    const kernelOk = this.guard.verifyIntegrity();

    // 2. Module diagnosis
    const diagnosis = await this.reflector.diagnose();

    // v7.9.7 Bug E: separate actionable from informational issues. Reflector
    // produces four types — kernel (critical), syntax (high), read-error (high),
    // missing-dependency (high). Of those, reflector.repair() can only actually
    // fix 'syntax'; the others return `fixed: false` with a "module must be
    // created or path corrected" string. Pre-fix the daemon kept logging every
    // 15 minutes "19 issue(s), 0 fixed" because the 19 sticky missing-dependency
    // issues counted against the issue-count and never moved. Now: informational
    // issues are tracked separately so the repaired-vs-actionable ratio is honest.
    const actionableIssues = diagnosis.issues.filter(i => i.type === 'syntax');
    const informationalIssues = diagnosis.issues.filter(i => i.type !== 'syntax');

    // 3. Auto-repair if enabled
    let repaired = [];
    if (this.config.autoRepair && actionableIssues.length > 0) {
      // v6.0.7: Trust-gated repair scope (v7.9.7: 3-level system).
      // SUPERVISED (0): syntax only (safe). AUTONOMOUS+ (1,2): syntax + style + optimization.
      const trustLevel = this.trustLevelSystem?.getLevel?.() ?? 0;
      const allowedTypes = trustLevel >= 1
        ? ['syntax', 'style', 'optimization']
        : ['syntax'];

      const repairableIssues = actionableIssues
        .filter(i => allowedTypes.includes(i.type) && i.severity !== 'critical')
        .slice(0, this.config.maxAutoRepairs);

      if (repairableIssues.length > 0) {
        this._log('info', `Auto-repairing ${repairableIssues.length} issue(s)... (trust=${trustLevel})`);
        repaired = await this.reflector.repair(repairableIssues);

        this.bus.fire('daemon:auto-repair', {
          issues: repairableIssues.length,
          fixed: repaired.filter(r => r.fixed).length,
          trustLevel,
        }, { source: 'AutonomousDaemon' });
      }
    }

    const result = {
      kernelOk: kernelOk.ok,
      issues: actionableIssues.length,
      informational: informationalIssues.length,
      repaired: repaired.filter(r => r.fixed).length,
      scannedModules: diagnosis.scannedModules,
    };
    // v7.9.7: log split — actionable count drives the visible line, informational
    // count gets a quieter mention so the operator can tell when something
    // repairable shows up. Pre-fix the 19 sticky missing-dependency issues hid
    // behind the same "19 issue(s), 0 fixed" line every cycle and looked like
    // a broken auto-repair.
    if (result.issues > 0 || result.repaired > 0) {
      this._log('info', `Health check: ${result.issues} actionable issue(s), ${result.repaired} fixed (plus ${result.informational} informational)`);
    } else if (result.informational > 0) {
      this._log('debug', `Health check: nothing to repair (${result.informational} informational issue(s) tracked)`);
    } else {
      this._log('debug', 'Health check: nothing to repair');
    }
    // v7.9.5 live-fix: persist the actual issue list (not just the count)
    // so `/health-issues` can surface them. Deduped by signature so a
    // sticky issue set doesn't bloat the file across hundreds of cycles.
    this._persistHealthIssues(diagnosis.issues || []);
    return result;
  }

  // v7.9.5 live-fix: rolling jsonl of recent health-issue snapshots.
  // Pre-fix, daemon found 19 issues per cycle for hours and the user
  // had no way to see what they were. Now visible via /health-issues.
  _persistHealthIssues(issues) {
    try {
      const fs = require('fs');
      const path = require('path');
      const rootDir = this._storage?.getRootDir?.()
        || this.selfModel?.rootDir
        || process.cwd();
      const dir = path.join(rootDir, '.genesis');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'daemon-health-issues.jsonl');
      // Dedup: skip persist if the same fingerprint as last entry.
      const fingerprint = (issues || []).map(i => `${i.type || ''}:${i.file || ''}:${i.severity || ''}`).sort().join('|');
      if (fingerprint === this._lastHealthFingerprint) return;
      this._lastHealthFingerprint = fingerprint;
      const entry = JSON.stringify({
        ts: Date.now(),
        cycle: this.cycleCount,
        count: issues.length,
        issues: (issues || []).slice(0, 50),
      }) + '\n';
      fs.appendFileSync(file, entry);
      this._trimJsonlFile(file, 100);
    } catch (err) {
      this._log('debug', `health-issues persist failed: ${err.message}`);
    }
  }

  // v7.9.5: shared rolling-trim — keep only last N jsonl lines.
  _trimJsonlFile(file, maxLines) {
    try {
      const fs = require('fs');
      const text = fs.readFileSync(file, 'utf-8');
      const lines = text.split('\n').filter(Boolean);
      if (lines.length <= maxLines) return;
      const kept = lines.slice(-maxLines).join('\n') + '\n';
      fs.writeFileSync(file, kept);
    } catch { /* best-effort */ }
  }

  // ── Memory Consolidation ─────────────────────────────────

  _consolidateMemory() {
    if (!this.memory) return { consolidated: 0 };
    this._log('debug', 'Memory consolidation...');

    const stats = this.memory.getStats();

    // Extract facts from recent episodes that haven't been processed
    const recentEpisodes = this.memory.recallEpisodes('', 10);
    let newFacts = 0;

    for (const episode of recentEpisodes) {
      // Look for factual statements in episode summaries
      const factPatterns = [
        /(?:nutzer|user)\s+(?:heißt|ist|arbeitet|benutzt|mag|bevorzugt)\s+(.+)/gi,
        /(?:projekt|project)\s+(?:heißt|ist|verwendet)\s+(.+)/gi,
      ];

      for (const pattern of factPatterns) {
        const match = pattern.exec(episode.summary);
        if (match) {
          const factKey = `auto:${episode.topics[0] || 'general'}`;
          const stored = this.memory.learnFact(factKey, match[0], 0.5, 'consolidation');
          if (stored) newFacts++;
        }
      }
    }

    // Decay old patterns with low success rates
    const patterns = this.memory.db?.procedural || [];
    let decayed = 0;
    for (const pattern of patterns) {
      if (pattern.attempts > 5 && pattern.successRate < 0.2) {
        pattern.successRate *= 0.9; // Gradual decay
        decayed++;
      }
    }

    const result = { episodes: stats.episodes, newFacts, decayed };
    // v7.9.4: surface meaningful work at info level, stay quiet otherwise.
    if (newFacts > 0 || decayed > 0) {
      this._log('info', `Memory consolidation: ${newFacts} new fact(s), ${decayed} pattern(s) decayed`);
    }
    return result;
  }

  // ── Pattern Learning ─────────────────────────────────────

  _learnFromHistory() {
    if (!this.memory) return { patterns: 0 };
    this._log('debug', 'Learning from history...');

    // Look at recent tool call successes/failures from the event bus
    const recentEvents = this.bus.getHistory(100);
    const toolEvents = recentEvents.filter(e =>
      e.event === 'tools:completed' || e.event === 'tools:error'
    );

    let newPatterns = 0;
    for (const event of toolEvents) {
      try {
        const data = JSON.parse(event.data);
        if (data.name) {
          this.memory.learnPattern(
            `tool:${data.name}`,
            data.name,
            event.event === 'tools:completed'
          );
          newPatterns++;
        }
      } catch (err) { _log.debug('[DAEMON] Malformed tool event:', err.message); }
    }

    // Learn from reasoning outcomes
    const reasoningEvents = recentEvents.filter(e => e.event === 'reasoning:completed');
    for (const event of reasoningEvents) {
      try {
        const data = JSON.parse(event.data);
        if (data.strategy && data.quality) {
          this.memory.learnPattern(
            `strategy:${data.task?.slice(0, 30)}`,
            data.strategy,
            data.quality > 0.6
          );
        }
      } catch (err) { _log.debug('[DAEMON] Malformed reasoning event:', err.message); }
    }

    // v7.9.4: surface real pattern learning at info level.
    if (newPatterns > 0) {
      this._log('info', `Pattern learning: ${newPatterns} new pattern(s)`);
    }
    return { patterns: newPatterns };
  }

  // ── Optimization Suggestions ─────────────────────────────

  async _suggestOptimizations() {
    this._log('debug', 'Optimization analysis...');

    const suggestions = await this.reflector.suggestOptimizations();

    // Check event bus stats for bottlenecks
    const eventStats = this.bus.getStats();
    const hotEvents = Object.entries(eventStats)
      .filter(([_, s]) => s.emitCount > 100)
      .map(([event, s]) => `${event}: ${s.emitCount} calls`);

    if (hotEvents.length > 0) {
      suggestions.push({
        type: 'performance',
        detail: `Frequent events (potential bottlenecks): ${hotEvents.join(', ')}`,
      });
    }

    // Report via event bus (UI can show these)
    if (suggestions.length > 0) {
      this.bus.fire('daemon:suggestions', { suggestions }, { source: 'AutonomousDaemon' });
      // v7.9.4: surface optimization suggestions at info level.
      this._log('info', `Optimization analysis: ${suggestions.length} suggestion(s)`);
      // v7.9.5 live-fix: previously the event went into the void — no UI
      // subscriber, no persistence. Now rolling jsonl + /suggestions slash.
      this._persistSuggestions(suggestions);
    }

    return { count: suggestions.length, suggestions };
  }

  // v7.9.5 live-fix: rolling jsonl of recent optimization snapshots.
  _persistSuggestions(suggestions) {
    try {
      const fs = require('fs');
      const path = require('path');
      const rootDir = this._storage?.getRootDir?.()
        || this.selfModel?.rootDir
        || process.cwd();
      const dir = path.join(rootDir, '.genesis');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'daemon-suggestions.jsonl');
      const entry = JSON.stringify({
        ts: Date.now(),
        cycle: this.cycleCount,
        count: suggestions.length,
        suggestions: (suggestions || []).slice(0, 50),
      }) + '\n';
      fs.appendFileSync(file, entry);
      this._trimJsonlFile(file, 100);
    } catch (err) {
      this._log('debug', `suggestions persist failed: ${err.message}`);
    }
  }
}

const autonomousDaemonActivitiesMixin = {};
for (const name of Object.getOwnPropertyNames(_AutonomousDaemonActivitiesHost.prototype)) {
  if (name !== 'constructor') autonomousDaemonActivitiesMixin[name] = _AutonomousDaemonActivitiesHost.prototype[name];
}

module.exports = { autonomousDaemonActivitiesMixin };
