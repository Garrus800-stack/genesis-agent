// ============================================================
// GENESIS AGENT — AutonomousDaemon.js
// Background self-improvement loop. The thing that makes
// the agent grow WITHOUT being asked.
//
// Cycles:
// - HEALTH: Periodic integrity & syntax checks
// - OPTIMIZE: Identify and suggest improvements
// - GAPS: Detect missing capabilities and try to build them
// - CONSOLIDATE: Compress and organize memory
// - LEARN: Extract patterns from successful interactions
// ============================================================

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const { INTERVALS } = require('../core/Constants');
const { applySubscriptionHelper } = require('../core/subscription-helper');
const _log = createLogger('AutonomousDaemon');

class AutonomousDaemon {
  constructor({ bus,  reflector, selfModel, memory, model, prompts, skills, sandbox, guard, intervals }) {
    this.bus = bus || NullBus;
    this.reflector = reflector;
    this.selfModel = selfModel;
    this.memory = memory;
    this.model = model;
    this.prompts = prompts;
    this.skills = skills;
    this.sandbox = sandbox;
    this.guard = guard;
    this._intervals = intervals || null;
    // v6.0.7: Trust-gated optimization
    this.trustLevelSystem = null; // late-bound
    // v7.3.5: Goal lifecycle review
    this.goalStack = null; // late-bound

    // v7.3.6 patch: track bus subscriptions for clean shutdown
    this._unsubs = [];

    this.running = false;
    this.intervalHandle = null;
    this._bootTimer = null; // FIX v5.0.0: Declare for TypeScript/doc visibility
    this.cycleCount = 0;
    this.lastResults = {};

    // Configuration
    this.config = {
      cycleInterval: 5 * 60 * 1000,  // Every 5 minutes
      healthInterval: 3,               // Health check every 3 cycles
      optimizeInterval: 12,            // Optimization every 12 cycles (1 hour)
      gapInterval: 24,                 // Gap detection every 24 cycles (2 hours)
      consolidateInterval: 6,          // Memory consolidation every 6 cycles
      learnInterval: 6,                // Pattern learning every 6 cycles
      goalReviewInterval: 12,          // v7.3.5: Goal lifecycle review every 12 cycles (1 hour)
      maxAutoRepairs: 3,               // Max auto-repairs per cycle
      autoRepair: true,                // Auto-repair syntax errors
      autoOptimize: false,             // Don't auto-apply optimizations (too risky)
      logLevel: 'info',                // 'debug' | 'info' | 'warn'
    };

    // Capability gap tracker
    this.knownGaps = [];
    this.gapAttempts = new Map(); // DA-1: bounded by gap count (~10), cap 50 // gapId → attempt count
  }

  // ── Lifecycle ────────────────────────────────────────────

  start() {
    if (this.running) return;
    this.running = true;

    this._log('info', 'Daemon started');
    this.bus.fire('daemon:started', {}, { source: 'AutonomousDaemon' });

    // FIX v6.1.1: Listen for capability gaps detected by LearningService
    // When Genesis says "I can't", queue it for skill creation on next cycle
    this._dynamicGaps = [];
    this._sub('learning:capability-gap', (data) => {
      if (!data) return;
      // v7.3.6 #10: Unicode-aware cleanup. Was restricted to ASCII+German.
      // Now preserves all letter/digit characters (plus whitespace and hyphen)
      // across scripts — user topics in any language stay intact.
      const topic = ( data.userRequest || '').slice(0, 100).replace(/[^\p{L}\p{N}\s-]/gu, '').trim();
      const _ad = /** @type {any} */ (this);
      if (topic.length > 5 && _ad._dynamicGaps.length < 20) {
        _ad._dynamicGaps.push({ id: `gap:user:${Date.now()}`, topic, type: 'user-request', request: data.userRequest });
        this._log('info', `Capability gap detected from user: "${topic}"`);
      }
    }, { source: 'AutonomousDaemon' });

    // Run first cycle after boot has settled (30 seconds)
    // FIX v5.0.0: Store timer handle so stop() can cancel it
    this._bootTimer = setTimeout(() => this._runCycle(), INTERVALS.DAEMON_BOOT_DELAY);

    // Schedule recurring cycles (via IntervalManager if available)
    if (this._intervals) {
      this._intervals.register('daemon-cycle', () => this._runCycle(), this.config.cycleInterval);
    } else {
      this.intervalHandle = setInterval(
        () => this._runCycle(),
        this.config.cycleInterval
      );
    }
  }

  stop() {
    this.running = false;
    // v7.3.6 patch: unsubscribe tracked bus listeners
    this._unsubAll();
    // FIX v5.0.0: Clear boot-delay timer to prevent post-stop cycle
    if (this._bootTimer) {
      clearTimeout(this._bootTimer);
      this._bootTimer = null;
    }
    if (this._intervals) {
      this._intervals.clear('daemon-cycle');
    } else if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this._log('info', 'Daemon stopped');
    this.bus.fire('daemon:stopped', {}, { source: 'AutonomousDaemon' });
  }

  // ── Main Cycle ───────────────────────────────────────────

  async _runCycle() {
    if (!this.running) return;
    this.cycleCount++;

    const cycleStart = Date.now();
    const actions = [];

    try {
      // HEALTH CHECK
      if (this.cycleCount % this.config.healthInterval === 0) {
        const health = await this._healthCheck();
        actions.push({ type: 'health', ...health });
      }

      // MEMORY CONSOLIDATION
      if (this.cycleCount % this.config.consolidateInterval === 0) {
        const consolidated = await this._consolidateMemory();
        actions.push({ type: 'consolidate', ...consolidated });
      }

      // PATTERN LEARNING
      if (this.cycleCount % this.config.learnInterval === 0) {
        const learned = await this._learnFromHistory();
        actions.push({ type: 'learn', ...learned });
      }

      // OPTIMIZATION SUGGESTIONS
      if (this.cycleCount % this.config.optimizeInterval === 0) {
        const optimizations = await this._suggestOptimizations();
        actions.push({ type: 'optimize', ...optimizations });
      }

      // CAPABILITY GAP DETECTION
      if (this.cycleCount % this.config.gapInterval === 0) {
        const gaps = await this._detectCapabilityGaps();
        actions.push({ type: 'gaps', ...gaps });
      }

      // v7.3.5: GOAL LIFECYCLE REVIEW — auto-complete, auto-fail, auto-stall
      // Prevents the "6/8 forever" pattern observed before v7.3.5: goals that
      // hit their final step but whose status never flipped, and goals that
      // quietly stalled with no update for days. GoalStack.reviewGoals() does
      // the walk, this just schedules it.
      if (this.cycleCount % this.config.goalReviewInterval === 0) {
        const review = await this._reviewGoals();
        actions.push({ type: 'goal-review', ...review });
      }

    } catch (err) {
      this._log('warn', `Cycle ${this.cycleCount} error: ${err.message}`);
    }

    const duration = Date.now() - cycleStart;
    this.lastResults = { cycle: this.cycleCount, actions, duration, timestamp: new Date().toISOString() };

    if (actions.length > 0) {
      this.bus.fire('daemon:cycle-complete', this.lastResults, { source: 'AutonomousDaemon' });
    }
  }

  // ── Health Check ─────────────────────────────────────────

  async _healthCheck() {
    this._log('debug', 'Health check...');

    // 1. Kernel integrity
    const kernelOk = this.guard.verifyIntegrity();

    // 2. Module diagnosis
    const diagnosis = await this.reflector.diagnose();

    // 3. Auto-repair if enabled
    let repaired = [];
    if (this.config.autoRepair && diagnosis.issues.length > 0) {
      // v6.0.7: Trust-gated repair scope
      // Level 0-1: syntax only (safe). Level 2+: syntax + style + optimization.
      const trustLevel = this.trustLevelSystem?.getLevel?.() ?? 0;
      const allowedTypes = trustLevel >= 2
        ? ['syntax', 'style', 'optimization']
        : ['syntax'];

      const repairableIssues = diagnosis.issues
        .filter(i => allowedTypes.includes(i.type) && i.severity !== 'critical')
        .slice(0, this.config.maxAutoRepairs);

      if (repairableIssues.length > 0) {
        this._log('info', `Auto-repariere ${repairableIssues.length} Problem(e)... (trust=${trustLevel})`);
        repaired = await this.reflector.repair(repairableIssues);

        this.bus.fire('daemon:auto-repair', {
          issues: repairableIssues.length,
          fixed: repaired.filter(r => r.fixed).length,
          trustLevel,
        }, { source: 'AutonomousDaemon' });
      }
    }

    return {
      kernelOk: kernelOk.ok,
      issues: diagnosis.issues.length,
      repaired: repaired.filter(r => r.fixed).length,
      scannedModules: diagnosis.scannedModules,
    };
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

    return { episodes: stats.episodes, newFacts, decayed };
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
    }

    return { count: suggestions.length, suggestions };
  }

  // ── Capability Gap Detection ─────────────────────────────
  // This is the extraordinary part: the agent figures out
  // what it CAN'T do and tries to build that capability.

  async _detectCapabilityGaps() {
    this._log('debug', 'Detecting capability gaps...');

    const gaps = [
      ...this._analyzeFailurePatterns(),
      ...this._checkDesiredCapabilities(),
      ...(this._dynamicGaps || []),  // FIX v6.1.1: Include user-request gaps
    ];
    // Clear dynamic gaps after processing
    if (this._dynamicGaps) this._dynamicGaps = [];

    const newSkills = await this._attemptSkillBuilds(gaps);
    this.knownGaps = gaps;
    return { gaps: gaps.length, newSkills, details: gaps };
  }

  // ── Goal Lifecycle Review (v7.3.5) ───────────────────────
  // Fixes the observed "goals at 6/8 or 7/8 forever" pattern: goals whose
  // status never flips when all steps finish, goals that quietly stall
  // with no update for days, goals that exhausted their retry budget but
  // stayed active. The walk logic lives in GoalStack.reviewGoals — the
  // daemon's job is just to schedule it.
  async _reviewGoals() {
    if (!this.goalStack || typeof this.goalStack.reviewGoals !== 'function') {
      return { changed: 0, reviewed: 0, skipped: 'no-goal-stack' };
    }
    try {
      const report = this.goalStack.reviewGoals();
      if (report.changed && report.changed.length > 0) {
        this._log('info', `[GOAL-REVIEW] ${report.changed.length} state changes across ${report.reviewed} active goals`);
      }
      return { changed: report.changed?.length || 0, reviewed: report.reviewed || 0, detail: report.changed };
    } catch (err) {
      this._log('warn', `goal review failed: ${err.message}`);
      return { changed: 0, reviewed: 0, error: err.message };
    }
  }

  /** Analyze recent episodes for repeated failure topics */
  _analyzeFailurePatterns() {
    const recentEpisodes = this.memory?.db?.episodic?.slice(-30) || [];
    const failurePatterns = new Map();
    const FAILURE_PHRASES = ['not possible', 'nicht möglich', 'I cannot', 'kann ich nicht', 'error', 'Fehler'];

    for (const ep of recentEpisodes) {
      if (ep.lastExchange?.some(m => FAILURE_PHRASES.some(p => m.content?.includes(p)))) {
        for (const topic of ep.topics) {
          failurePatterns.set(topic, (failurePatterns.get(topic) || 0) + 1);
        }
      }
    }

    const gaps = [];
    for (const [topic, count] of failurePatterns) {
      if (count >= 2) gaps.push({ id: `gap:${topic}`, topic, occurrences: count, type: 'repeated-failure' });
    }
    return gaps;
  }

  /** Check for commonly desired capabilities not yet available */
  _checkDesiredCapabilities() {
    const currentCaps = this.selfModel.getCapabilities();
    const DESIRED = [
      { name: 'web-access', check: () => currentCaps.includes('web-access') || this.skills?.loadedSkills?.has('web-search') },
      { name: 'file-management', check: () => currentCaps.includes('file-management') || this.skills?.loadedSkills?.has('file-manager') },
      { name: 'scheduling', check: () => this.skills?.loadedSkills?.has('scheduler') },
      { name: 'data-visualization', check: () => this.skills?.loadedSkills?.has('chart-gen') },
    ];

    return DESIRED
      .filter(d => !d.check())
      .map(d => ({ id: `gap:${d.name}`, topic: d.name, type: 'missing-capability' }));
  }

  /** Attempt to build skills for detected capability gaps */
  async _attemptSkillBuilds(gaps) {
    let built = 0;
    for (const gap of gaps) {
      const attempts = this.gapAttempts.get(gap.id) || 0;
      if (attempts >= 2) continue;
      if (!['missing-capability', 'user-request'].includes(gap.type) || !this.skills || !this.model) continue;

      this._log('info', `Attempting to build skill for capability gap: ${gap.topic}`);
      this.gapAttempts.set(gap.id, attempts + 1);
      if (this.gapAttempts.size > 50) { const k = this.gapAttempts.keys().next().value; this.gapAttempts.delete(k); }

      try {
        // FIX v6.1.1: Use the actual user request for context when available
        const description = gap.request
          ? `The user asked: "${gap.request}". Create a skill that handles this. Use only allowed sandbox modules (path, fs, os, crypto, util).`
          : `Create a skill named "${gap.topic}" that provides the "${gap.topic}" capability. Keep it simple and robust.`;
        const result = await this.skills.createSkill(description);
        if (result.includes('✅')) {
          built++;
          this.bus.fire('daemon:skill-created', { skill: gap.topic, reason: 'capability-gap' }, { source: 'AutonomousDaemon' });
        }
      } catch (err) {
        this._log('warn', `Skill creation for ${gap.topic} failed: ${err.message}`);
      }
    }
    return built;
  }

  // ── Public API ───────────────────────────────────────────

  getStatus() {
    return {
      running: this.running,
      cycleCount: this.cycleCount,
      lastResults: this.lastResults,
      knownGaps: this.knownGaps,
      config: this.config,
    };
  }

  /**
   * v7.4.0: Runtime snapshot for RuntimeStatePort.
   * I/O-free, in-memory only. Uses same in-memory fields
   * as getStatus() but drops config and lastResults (the
   * full lastResults is noisy; we expose only which checks
   * have run at least once).
   */
  getRuntimeSnapshot() {
    // Which checks have ever produced a result? Gives the
    // LLM a compact picture of activity without dumping the
    // full lastResults payload.
    const checksRun = Object.keys(this.lastResults || {});
    return {
      running: this.running,
      cycles: this.cycleCount,
      checksRun,
      gapCount: Array.isArray(this.knownGaps) ? this.knownGaps.length : 0,
    };
  }

  /** Force a specific check to run immediately */
  runCheck(type) {
    switch (type) {
      case 'health': return this._healthCheck();
      case 'optimize': return this._suggestOptimizations();
      case 'gaps': return this._detectCapabilityGaps();
      case 'consolidate': return this._consolidateMemory();
      case 'learn': return this._learnFromHistory();
      default: throw new Error(`Unknown check type: ${type}`);
    }
  }

  _log(level, message) {
    const levels = { debug: 0, info: 1, warn: 2 };
    if (levels[level] >= levels[this.config.logLevel]) {
      _log.info(`[DAEMON:${level.toUpperCase()}] ${message}`);
    }
  }
}

// v7.3.6 patch: apply subscription-helper mixin
applySubscriptionHelper(AutonomousDaemon, { defaultSource: 'AutonomousDaemon' });

module.exports = { AutonomousDaemon };
