// @ts-checked-v5.7
// ============================================================
// GENESIS — AgentLoopCognition.js (v4.0.0 — Resilient Cognitive Hooks)
//
// v4.0.0 UPGRADE: All Phase 9 hooks now route through
// CognitiveHealthTracker.guard() instead of bare try/catch.
// When a service fails systematically, it gets backoff/disabled
// automatically instead of re-failing on every invocation.
//
// v4.0: Composition delegate for Phase 9 cognitive hooks.
// Follows the same pattern as AgentLoopPlanner (v3.8.0) and
// AgentLoopSteps — a delegate that receives a reference to
// the AgentLoop instance.
//
// This delegate provides TWO hooks into the AgentLoop:
//   1. preExecute(plan) — called after planning, before execution
//      Runs MentalSimulator + forms expectations per step.
//   2. postStep(plan, stepIndex, step, result) — called after each
//      step's execution + verification. Compares outcome to expectation.
//
// GRACEFUL DEGRADATION: If Phase 9 services are not installed,
// both hooks return immediately with no effect. AgentLoop v3.8
// behavior is 100% preserved.
//
// Integration (3 lines in AgentLoop.js):
//   constructor: this.cognition = new AgentLoopCognitionDelegate(this);
//   pursue():    const cog = await this.cognition.preExecute(plan);
//   _executeLoop: this.cognition.postStep(plan, i, step, result);
// ============================================================

const { createLogger } = require('../core/Logger');
const _log = createLogger('AgentLoopCognition');
class AgentLoopCognitionDelegate {
  constructor(loop) {
    this.loop = loop;
  }

  /** @returns {object|null} CognitiveHealthTracker if available */
  get _tracker() {
    return this.loop.cognitiveHealthTracker || null;
  }

  /**
   * Pre-execution hook: simulate the plan + form expectations.
   */
  async preExecute(plan) {
    const simulator = this.loop.mentalSimulator;
    const expectationEngine = this.loop.expectationEngine;

    // v7.1.7 F1: Reset step-scoped lesson collector
    // lesson:applied events fire synchronously during PromptBuilder.build() → LessonsStore.recall()
    // which happens before step execution. We collect them here and correlate in postStep().
    this._stepRecalledLessons = [];
    // key-dedup prevents listener leaks — no unsub needed
    this.loop.bus?.on('lesson:applied', (data) => {
      if (data?.id) this._stepRecalledLessons.push(data);
    }, { source: 'AgentLoopCognition', key: 'lesson-step-collector' });

    if (!simulator && !expectationEngine) {
      return { proceed: true };
    }

    const result = { proceed: true };
    const tracker = this._tracker;

    // ── 0. Consult consciousness — check for apprehension ──
    const consciousness = this.consultConsciousness(plan);
    if (consciousness.paused) {
      _log.info('[COGNITION] Plan paused by consciousness — ethical deliberation required');
      result.consciousnessWarning = consciousness.concerns.join(' ');
    }
    if (consciousness.concerns.length > 0) {
      result.consciousnessConcerns = consciousness.concerns;
    }
    if (consciousness.valueContext) {
      result.valueContext = consciousness.valueContext;
    }

    // ── 1. Run simulation if available ───────────────────
    if (simulator && plan.steps && plan.steps.length > 0) {
      const simResult = tracker
        ? await tracker.guard('mentalSimulator', () => simulator.simulate(plan.steps), {
            context: `plan: ${plan.title || 'unknown'}`,
          })
        : this._safeSim(simulator, plan);

      if (simResult) {
        result.simulation = simResult;
        if (simResult.recommendation === 'replan') {
          return {
            proceed: false,
            reason: 'simulation-risk',
            riskScore: simResult.riskScore,
            expectedValue: simResult.expectedValue,
            recommendation: simResult.recommendation,
            simulation: simResult,
          };
        }
      }
    }

    // ── 2. Form expectations per step ────────────────────
    if (expectationEngine && plan.steps) {
      const expectations = tracker
        ? await tracker.guard('expectationEngine', () => {
            const exps = [];
            for (const step of plan.steps) {
              exps.push(expectationEngine.expect(step, {
                model: this.loop.model?.activeModel || null,
              }));
            }
            return exps;
          }, { context: `${plan.steps.length} steps` })
        : this._safeExpect(expectationEngine, plan);

      plan._expectations = expectations || null;
    }

    return result;
  }

  /**
   * Post-step hook: compare expectation with actual outcome.
   */
  postStep(plan, stepIndex, step, result) {
    // v7.1.7 F1: Correlate recalled lessons with step outcome
    this._correlateLessons(result);

    const expectationEngine = this.loop.expectationEngine;
    if (!expectationEngine || !plan._expectations || !plan._expectations[stepIndex]) {
      return;
    }

    const tracker = this._tracker;
    const doCompare = () => {
      const expectation = plan._expectations[stepIndex];
      const outcome = {
        success: !result.error,
        duration: result.durationMs || 0,
        qualityScore: this._deriveQuality(result),
        verificationResult: result.verification || null,
      };
      expectationEngine.compare(expectation, outcome);
    };

    if (tracker) {
      tracker.guardSync('expectationEngine', doCompare, {
        context: `step ${stepIndex}: ${step.type || 'unknown'}`,
      });
    } else {
      try { doCompare(); }
      catch (err) { _log.debug('[COGNITION] Post-step comparison failed:', err.message); }
    }
  }

  /**
   * v7.1.7: Correlate lessons recalled during prompt-build with step outcome.
   * Called at the start of postStep() — lessons were collected during preExecute→step.
   * @param {object} result - Step execution result
   */
  _correlateLessons(result) {
    const lessons = this._stepRecalledLessons;
    if (!lessons || lessons.length === 0) return;

    const lessonsStore = this.loop.lessonsStore;
    if (!lessonsStore || typeof lessonsStore.updateLessonOutcome !== 'function') return;

    const success = !result?.error;
    for (const lesson of lessons) {
      try {
        lessonsStore.updateLessonOutcome(lesson.id, success);
      } catch (err) {
        _log.debug('[COGNITION] Lesson correlation failed:', err.message);
      }
    }

    if (lessons.length > 0) {
      _log.debug(`[COGNITION] Correlated ${lessons.length} lesson(s): ${success ? 'confirmed' : 'contradicted'}`);
    }

    // Reset for next step
    this._stepRecalledLessons = [];
  }

  // ── Fallback methods (when tracker unavailable) ────────

  _safeSim(simulator, plan) {
    try { return simulator.simulate(plan.steps); }
    catch (err) { _log.debug('[COGNITION] Simulation failed:', err.message); return null; }
  }

  _safeExpect(expectationEngine, plan) {
    try {
      const exps = [];
      for (const step of plan.steps) {
        exps.push(expectationEngine.expect(step, { model: this.loop.model?.activeModel || null }));
      }
      return exps;
    } catch (err) { _log.debug('[COGNITION] Expectation formation failed:', err.message); return null; }
  }

  _deriveQuality(result) {
    if (result.error) return 0.2;
    if (result.verification) {
      switch (result.verification.status) {
        case 'pass': return 0.9;
        case 'fail': return 0.2;
        case 'ambiguous': return 0.5;
      }
    }
    return 0.6;
  }

  // ════════════════════════════════════════════════════════════
  // AWARENESS CONSULTATION
  //
  // Delegates to AwarenessPort.consult() + ValueStore enrichment.
  // AwarenessPort replaces the former 14-module Consciousness Layer.
  // ════════════════════════════════════════════════════════════

  /**
   * Consult awareness before plan execution.
   * Returns enrichment data that should be injected into the
   * plan's context for the LLM.
   *
   * @param {object} plan - The plan about to be executed
   * @returns {object} { paused, concerns, valueContext }
   */
  consultConsciousness(plan) {
    // Delegate to AwarenessPort
    const awareness = this._resolveOptional('awareness');
    const result = awareness
      ? { ...awareness.consult(plan) }
      : { paused: false, concerns: [], valueContext: '' };

    // ValueStore enrichment (planning layer, independent of awareness)
    const values = this._resolveOptional('valueStore');
    if (values) {
      try {
        const domain = this._inferDomain(plan);
        const relevant = values.getForDomain?.(domain) || [];
        if (relevant.length > 0) {
          const ctx = relevant
            .slice(0, 3)
            .map(v => `${v.name} (${Math.round(v.weight * 100)}%): ${v.description}`)
            .join('; ');
          result.valueContext = result.valueContext
            ? `${result.valueContext}; ${ctx}`
            : ctx;
        }
      } catch (err) { _log.debug('[COGNITION] valueStore enrichment failed:', err.message); }
    }

    return result;
  }

  /**
   * Resolve an optional service from the AgentLoop's container
   * or direct reference. Returns null if unavailable.
   */
  _resolveOptional(name) {
    // Try direct reference on the loop first
    if (this.loop[name]) return this.loop[name];
    // Try container resolution
    try {
      const container = this.loop._container || this.loop.container;
      if (container?.has?.(name)) return container.resolve(name);
    } catch (err) { _log.debug(`[COGNITION] _resolveOptional('${name}') failed:`, err.message); }
    return null;
  }

  /**
   * Infer the action domain from a plan (for value lookup).
   */
  _inferDomain(plan) {
    const title = (plan.title || '').toLowerCase();
    const types = (plan.steps || []).map(s => (s.type || '').toLowerCase()).join(' ');
    const combined = title + ' ' + types;

    if (/code|refactor|implement|test|debug|write.*code/.test(combined)) return 'code';
    if (/deploy|release|ship|publish/.test(combined)) return 'deployment';
    if (/chat|respond|answer|communicate/.test(combined)) return 'communication';
    if (/self.*mod|modify.*self|evolve/.test(combined)) return 'self-modification';
    return 'all';
  }

  // ── Cognitive Level Diagnostic (v7.1.2 — extracted from AgentLoop) ──

  /**
   * Report cognitive level after late-bindings are wired.
   * Sets loop._cognitiveLevel to FULL|PARTIAL|NONE.
   */
  reportCognitiveLevel() {
    const loop = this.loop;
    const core = { verifier: loop.verifier, formalPlanner: loop.formalPlanner, worldState: loop.worldState };
    const extended = { episodicMemory: loop.episodicMemory, metaLearning: loop.metaLearning };
    const auxiliary = { htnPlanner: loop.htnPlanner, taskDelegation: loop.taskDelegation };

    const coreBound = Object.entries(core).filter(([, v]) => v != null).map(([k]) => k);
    const extBound = Object.entries(extended).filter(([, v]) => v != null).map(([k]) => k);
    const auxBound = Object.entries(auxiliary).filter(([, v]) => v != null).map(([k]) => k);
    const coreMissing = Object.entries(core).filter(([, v]) => v == null).map(([k]) => k);

    const level = coreBound.length === Object.keys(core).length ? 'FULL'
      : coreBound.length > 0 ? 'PARTIAL' : 'NONE';

    loop._cognitiveLevel = level;

    if (level !== 'FULL') {
      _log.warn(`[AGENT-LOOP] Cognitive level: ${level} — bound: [${coreBound.join(', ')}], missing: [${coreMissing.join(', ')}]`);
      loop.bus.emit('agent:status', {
        state: 'warning',
        detail: `AgentLoop cognitive level: ${level} — missing: ${coreMissing.join(', ')}`,
      }, { source: 'AgentLoop' });
    } else {
      _log.info(`[AGENT-LOOP] Cognitive level: FULL — core: [${coreBound.join(', ')}], extended: [${extBound.join(', ')}], aux: [${auxBound.join(', ')}]`);
    }
  }
}

module.exports = { AgentLoopCognitionDelegate };
