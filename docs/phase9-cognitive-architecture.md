# Phase 9: Cognitive Architecture — GENESIS v5.8

**The evolution from agent to mind.**

Genesis is an agent that plans, acts, verifies, and learns.
Phase 9 turns it into a system that **anticipates, simulates, dreams, and builds an identity**.

---

## Overview

Six new modules. One new boot phase. Zero breaking changes.

| Module | Layer | Purpose |
|--------|-------|---------|
| `ExpectationEngine` | intelligence | Predict outcomes before acting |
| `MentalSimulator` | revolution | Run hypothetical action chains in-memory |
| `SurpriseAccumulator` | intelligence | Detect prediction errors, amplify learning |
| `DreamCycle` | autonomy | Offline memory consolidation + schema extraction |
| `SchemaStore` | foundation | Reusable abstract patterns from experience |
| `SelfNarrative` | organism | Autobiographical identity that evolves |

New event namespace: `cognitive:*` (extends existing).
New IdleMind activity: `DREAM`.
New Constants: `PHASE9` section.

---

## Architecture

```
                    ┌──────────────────────────┐
                    │      SelfNarrative        │  "Wer bin ich?"
                    │  (autobiographical self)  │
                    └────────────┬─────────────┘
                                 │ reads
                    ┌────────────▼─────────────┐
                    │       DreamCycle          │  Offline consolidation
                    │  (schema extraction)      │──────────────┐
                    └────────────┬─────────────┘              │
                                 │ writes                     │ writes
                    ┌────────────▼─────────────┐   ┌─────────▼──────────┐
                    │      SchemaStore          │   │  KnowledgeGraph    │
                    │  (abstract patterns)      │   │  (existing)        │
                    └────────────┬─────────────┘   └────────────────────┘
                                 │ reads
        ┌────────────────────────┼────────────────────────┐
        │                        │                        │
┌───────▼────────┐  ┌───────────▼──────────┐  ┌─────────▼──────────┐
│ Expectation    │  │  MentalSimulator     │  │ Surprise           │
│ Engine         │──│  (hypothetical runs) │──│ Accumulator        │
│ (predict)      │  │                      │  │ (learning signal)  │
└───────┬────────┘  └──────────────────────┘  └─────────┬──────────┘
        │                                               │
        │              THE COGNITIVE LOOP                │
        │                                               │
        │   Expect → Simulate → Act → Surprise →        │
        │   Learn → Dream → Schema → better Expect      │
        │                                               │
        └───────────────────────────────────────────────┘
```

**Integration with existing systems:**

- `ExpectationEngine` reads `MetaLearning` success rates + `SchemaStore` patterns
- `MentalSimulator` uses `WorldState.clone()` + `FormalPlanner` action types
- `SurpriseAccumulator` feeds `MetaLearning.recordOutcome()` + `EpisodicMemory.recordEpisode()`
- `DreamCycle` runs as new `IdleMind` activity, reads `EpisodicMemory` + `EventStore`
- `SchemaStore` is a new foundation service, persisted via `StorageService`
- `SelfNarrative` reads `MetaLearning`, `EpisodicMemory`, `EmotionalState`, `SchemaStore`

---

## Module 1: ExpectationEngine

**The prediction machine.** Before every action, Genesis forms an expectation.
After the action, reality is compared to prediction. The delta is the surprise signal.

### containerConfig

```javascript
static containerConfig = {
  name: 'expectationEngine',
  phase: 9,
  deps: ['metaLearning', 'schemaStore', 'worldState', 'model', 'storage'],
  tags: ['cognitive', 'prediction'],
  lateBindings: [
    { target: 'surpriseAccumulator', property: 'expectationEngine' },
  ],
};
```

### Core API

```javascript
class ExpectationEngine {
  /**
   * Form an expectation for a planned action.
   *
   * @param {object} action - FormalPlanner typed step
   * @param {object} context - { worldState, recentEpisodes, emotionalState }
   * @returns {Expectation}
   */
  async expect(action, context) {
    // 1. Look up MetaLearning success rate for this action type + model
    const metaRate = this._getMetaRate(action.type, context.model);

    // 2. Check SchemaStore for relevant patterns
    const schemas = this.schemaStore.match(action, context);

    // 3. Build expectation (NO LLM call for fast actions)
    if (metaRate.samples >= this._minSamples) {
      return this._statisticalExpectation(action, metaRate, schemas);
    }

    // 4. For novel actions (low sample count), use lightweight LLM prediction
    return this._llmExpectation(action, context, schemas);
  }

  /**
   * Compare actual outcome against expectation.
   *
   * @param {Expectation} expectation
   * @param {object} outcome - { success, duration, verificationResult, sideEffects }
   * @returns {SurpriseSignal}
   */
  compare(expectation, outcome) {
    const signal = {
      id: crypto.randomUUID(),
      expectationId: expectation.id,
      timestamp: Date.now(),

      // Core surprise dimensions
      successSurprise: this._booleanSurprise(expectation.successProb, outcome.success),
      durationSurprise: this._continuousSurprise(expectation.durationMs, outcome.duration),
      qualitySurprise: this._continuousSurprise(expectation.qualityScore, outcome.qualityScore),

      // Composite score (0.0 = exactly as expected, 1.0 = maximally surprising)
      totalSurprise: 0,

      // Was expectation wrong in a USEFUL way?
      valence: outcome.success ? 'positive' : 'negative',
      isNovel: expectation.confidence < 0.3, // Low-confidence = exploring

      // What the expectation was
      expected: expectation,
      actual: outcome,
    };

    signal.totalSurprise = this._compositeSurprise(signal);
    return signal;
  }

  // ── Internal Methods ──────────────────────────────────

  _statisticalExpectation(action, metaRate, schemas) {
    // Base from MetaLearning
    let successProb = metaRate.successRate;
    let durationMs = metaRate.avgLatency;
    let confidence = Math.min(metaRate.samples / 100, 0.95);

    // Adjust by matching schemas
    for (const schema of schemas) {
      // Schema says: "When doing X after Y, success drops by 15%"
      successProb *= (1 + schema.successModifier);
      confidence = Math.max(confidence, schema.confidence);
    }

    return {
      id: crypto.randomUUID(),
      actionType: action.type,
      successProb: Math.max(0, Math.min(1, successProb)),
      durationMs,
      qualityScore: metaRate.avgQuality || 0.7,
      confidence,
      source: 'statistical',
      schemas: schemas.map(s => s.id),
      timestamp: Date.now(),
    };
  }

  _booleanSurprise(expectedProb, actualBool) {
    // Information-theoretic surprise: -log2(P(outcome))
    const p = actualBool ? expectedProb : (1 - expectedProb);
    return -Math.log2(Math.max(p, 0.01)); // Cap at ~6.6 bits
  }

  _continuousSurprise(expected, actual) {
    if (expected === null || actual === null) return 0;
    // Normalized absolute deviation
    const denom = Math.max(Math.abs(expected), 1);
    return Math.min(Math.abs(actual - expected) / denom, 3.0);
  }

  _compositeSurprise(signal) {
    // Weighted sum — success surprise matters most
    return (
      signal.successSurprise * 0.5 +
      signal.durationSurprise * 0.2 +
      signal.qualitySurprise * 0.3
    );
  }
}
```

### Expectation Types

| Action Type | Prediction Source | What's Predicted |
|-------------|-------------------|------------------|
| `CODE_GENERATE` | MetaLearning + SchemaStore | Success prob, LOC, AST validity |
| `RUN_TESTS` | Recent test history | Pass/fail, duration, which tests |
| `WRITE_FILE` | WorldState + SchemaStore | File size, side effects |
| `SHELL_EXEC` | MetaLearning | Exit code, duration |
| `SELF_MODIFY` | SchemaStore patterns | Risk level, reload success |
| Novel actions | LLM (lightweight) | General outcome range |

### Events

```
expectation:formed     { actionType, successProb, confidence, source }
expectation:compared   { totalSurprise, valence, actionType }
expectation:calibrated { actionType, newAccuracy }  // periodic recalibration
```

---

## Module 2: MentalSimulator

**The imagination.** Runs entire plan sequences in-memory against cloned WorldState, propagating probabilistic outcomes through the chain.

This extends what FormalPlanner already does (precondition checking on cloned state), but adds **branching outcomes, probability propagation, and multi-path evaluation**.

### containerConfig

```javascript
static containerConfig = {
  name: 'mentalSimulator',
  phase: 9,
  deps: ['worldState', 'formalPlanner', 'expectationEngine', 'metaLearning', 'storage'],
  tags: ['cognitive', 'simulation'],
  lateBindings: [],
};
```

### Core API

```javascript
class MentalSimulator {
  /**
   * Simulate a full plan with branching outcomes.
   * Returns a decision tree with expected values.
   *
   * @param {Array<TypedStep>} plan - FormalPlanner typed steps
   * @param {object} options - { maxBranches, maxDepth, pruneThreshold }
   * @returns {SimulationResult}
   */
  async simulate(plan, options = {}) {
    const maxBranches = options.maxBranches || 3;
    const maxDepth = options.maxDepth || plan.length;
    const pruneThreshold = options.pruneThreshold || 0.05;

    // Clone WorldState for simulation
    const rootState = this.worldState.clone();
    const rootNode = {
      stepIndex: 0,
      state: rootState,
      probability: 1.0,
      cumulativeCost: 0,
      cumulativeValue: 0,
      children: [],
    };

    // Build decision tree via DFS with pruning
    await this._expandNode(rootNode, plan, 0, maxBranches, maxDepth, pruneThreshold);

    // Calculate expected value of each path
    const paths = this._enumeratePaths(rootNode);
    const bestPath = paths.reduce((a, b) =>
      a.expectedValue > b.expectedValue ? a : b
    );

    return {
      tree: rootNode,
      paths,
      bestPath,
      expectedValue: this._weightedExpectedValue(paths),
      riskScore: this._calculateRisk(paths),
      recommendation: this._recommend(bestPath, paths),
    };
  }

  /**
   * Quick what-if: "What happens if step N fails?"
   *
   * @param {Array<TypedStep>} plan
   * @param {number} failAtStep - Step index to force-fail
   * @returns {SimulationResult} - Outcome of the remaining plan
   */
  async whatIf(plan, failAtStep) {
    return this.simulate(plan, {
      forcedOutcomes: { [failAtStep]: { success: false } },
    });
  }

  /**
   * Compare two alternative plans.
   *
   * @param {Array<TypedStep>} planA
   * @param {Array<TypedStep>} planB
   * @returns {{ winner: 'A'|'B', comparison: object }}
   */
  async comparePlans(planA, planB) {
    const [simA, simB] = await Promise.all([
      this.simulate(planA),
      this.simulate(planB),
    ]);

    return {
      winner: simA.expectedValue >= simB.expectedValue ? 'A' : 'B',
      comparison: {
        expectedValueA: simA.expectedValue,
        expectedValueB: simB.expectedValue,
        riskA: simA.riskScore,
        riskB: simB.riskScore,
        stepsA: planA.length,
        stepsB: planB.length,
      },
      simA,
      simB,
    };
  }

  // ── Tree Construction ─────────────────────────────────

  async _expandNode(node, plan, stepIdx, maxBranches, maxDepth, pruneThreshold) {
    if (stepIdx >= maxDepth || stepIdx >= plan.length) return;
    if (node.probability < pruneThreshold) return; // Prune unlikely branches

    const step = plan[stepIdx];
    const expectation = await this.expectationEngine.expect(step, {
      worldState: node.state,
      model: this._getCurrentModel(),
    });

    // Branch 1: Success (probability = expectation.successProb)
    const successState = this._cloneState(node.state);
    this._applyEffects(successState, step, true);
    const successNode = {
      stepIndex: stepIdx,
      action: step.type,
      outcome: 'success',
      state: successState,
      probability: node.probability * expectation.successProb,
      cumulativeCost: node.cumulativeCost + (step.cost || 1),
      cumulativeValue: node.cumulativeValue + this._stepValue(step, true),
      expectation,
      children: [],
    };
    node.children.push(successNode);
    await this._expandNode(successNode, plan, stepIdx + 1, maxBranches, maxDepth, pruneThreshold);

    // Branch 2: Failure (probability = 1 - successProb)
    if (expectation.successProb < 0.95) { // Only branch if failure is plausible
      const failState = this._cloneState(node.state);
      this._applyEffects(failState, step, false);
      const failNode = {
        stepIndex: stepIdx,
        action: step.type,
        outcome: 'failure',
        state: failState,
        probability: node.probability * (1 - expectation.successProb),
        cumulativeCost: node.cumulativeCost + (step.cost || 1) * 1.5, // Failure costs more
        cumulativeValue: node.cumulativeValue + this._stepValue(step, false),
        expectation,
        children: [],
      };
      node.children.push(failNode);

      // After failure: can the plan recover?
      // Skip to next step (optimistic) or retry (if retryable)
      if (this._isRetryable(step)) {
        await this._expandNode(failNode, plan, stepIdx, maxBranches - 1, maxDepth, pruneThreshold);
      } else {
        await this._expandNode(failNode, plan, stepIdx + 1, maxBranches, maxDepth, pruneThreshold);
      }
    }
  }

  _stepValue(step, success) {
    if (!success) return -0.5; // Failure penalty
    // Value scales with action importance
    const valueMap = {
      'CODE_GENERATE': 3, 'WRITE_FILE': 2, 'RUN_TESTS': 4,
      'SELF_MODIFY': 5, 'ANALYZE': 1, 'SHELL_EXEC': 2,
      'GIT_SNAPSHOT': 1, 'SEARCH': 1, 'ASK_USER': 0.5,
    };
    return valueMap[step.type] || 1;
  }

  _calculateRisk(paths) {
    // Risk = probability-weighted variance of outcomes
    const ev = this._weightedExpectedValue(paths);
    const variance = paths.reduce((sum, p) => {
      return sum + p.probability * Math.pow(p.expectedValue - ev, 2);
    }, 0);
    return Math.sqrt(variance);
  }

  _recommend(bestPath, allPaths) {
    const risk = this._calculateRisk(allPaths);
    if (bestPath.expectedValue > 5 && risk < 1.5) return 'proceed';
    if (bestPath.expectedValue > 3 && risk < 3.0) return 'proceed-with-caution';
    if (risk > 5.0) return 'replan';
    return 'ask-user';
  }
}
```

### Integration with AgentLoop

The key insertion point: **before `pursue()` executes a plan**, MentalSimulator runs the plan in-memory.

```javascript
// In AgentLoop.pursue() — after FormalPlanner generates the plan:
const simulation = await this.mentalSimulator.simulate(typedSteps);

if (simulation.recommendation === 'replan') {
  this.bus.fire('agent-loop:simulation-replan', {
    reason: 'High risk detected',
    risk: simulation.riskScore,
    expectedValue: simulation.expectedValue,
  });
  // Ask FormalPlanner for alternative approach
  return this._replanWithSimulation(goal, simulation);
}

if (simulation.recommendation === 'ask-user') {
  // Surface the decision tree to the user
  this.bus.fire('agent-loop:simulation-review', {
    bestPath: simulation.bestPath,
    risk: simulation.riskScore,
    alternatives: simulation.paths.length,
  });
}
```

### Events

```
simulation:started    { planSteps, maxBranches }
simulation:branched   { stepIndex, actionType, successProb }
simulation:complete   { pathCount, expectedValue, riskScore, recommendation }
simulation:replan     { reason, originalRisk, newRisk }
```

---

## Module 3: SurpriseAccumulator

**The learning amplifier.** Collects surprise signals from ExpectationEngine.compare() and modulates how strongly Genesis learns from each experience.

### containerConfig

```javascript
static containerConfig = {
  name: 'surpriseAccumulator',
  phase: 9,
  deps: ['metaLearning', 'episodicMemory', 'eventStore', 'storage'],
  tags: ['cognitive', 'learning'],
  lateBindings: [
    { target: 'expectationEngine', property: 'surpriseAccumulator' },
  ],
};
```

### Core Logic

```javascript
class SurpriseAccumulator {
  constructor({ bus, metaLearning, episodicMemory, eventStore, storage, intervals }) {
    // ...

    // ── Surprise Buffer ─────────────────────────────────
    this._buffer = [];           // Recent surprise signals (rolling window)
    this._maxBuffer = 500;
    this._noveltyThreshold = 1.5; // Above this = "highly surprising"
    this._significantThreshold = 0.8; // Above this = "noteworthy"

    // ── Running Statistics ───────────────────────────────
    this._stats = {
      totalSignals: 0,
      avgSurprise: 0,         // EMA of totalSurprise
      avgPositive: 0,         // EMA of positive surprises
      avgNegative: 0,         // EMA of negative surprises
      surpriseTrend: 'stable', // rising | falling | stable
      calibrationScore: 0.5,  // How well expectations match reality (0-1)
    };
    this._emaAlpha = 0.1;     // Exponential moving average decay

    // ── Surprise → Action mapping ───────────────────────
    // High surprise triggers stronger learning signals
    this._learningMultipliers = {
      low:    1.0,  // surprise < 0.3  — normal learning
      medium: 1.5,  // 0.3 <= surprise < 0.8
      high:   2.5,  // 0.8 <= surprise < 1.5
      novel:  4.0,  // surprise >= 1.5 — this is genuinely new
    };

    // Listen for expectation comparisons
    this.bus.on('expectation:compared', (signal) => this._processSurprise(signal),
      { source: 'SurpriseAccumulator' });
  }

  // ── Core Processing ───────────────────────────────────

  _processSurprise(signal) {
    this._buffer.push(signal);
    if (this._buffer.length > this._maxBuffer) {
      this._buffer = this._buffer.slice(-this._maxBuffer);
    }
    this._stats.totalSignals++;

    // Update running averages
    this._stats.avgSurprise = this._ema(this._stats.avgSurprise, signal.totalSurprise);
    if (signal.valence === 'positive') {
      this._stats.avgPositive = this._ema(this._stats.avgPositive, signal.totalSurprise);
    } else {
      this._stats.avgNegative = this._ema(this._stats.avgNegative, signal.totalSurprise);
    }

    // Calculate learning multiplier
    const multiplier = this._getLearningMultiplier(signal.totalSurprise);

    // 1. Amplify MetaLearning recording
    if (multiplier > 1.0) {
      this.bus.emit('surprise:amplified-learning', {
        actionType: signal.expected.actionType,
        multiplier,
        valence: signal.valence,
        surprise: signal.totalSurprise,
      }, { source: 'SurpriseAccumulator' });
    }

    // 2. Mark episodic memory with surprise weight
    if (signal.totalSurprise >= this._significantThreshold) {
      this._markEpisodicMemory(signal);
    }

    // 3. Highly novel events trigger immediate reflection
    if (signal.totalSurprise >= this._noveltyThreshold) {
      this._triggerNoveltyReflection(signal);
    }

    // 4. Update calibration score (how accurate are our expectations?)
    this._updateCalibration(signal);

    // 5. Detect surprise trends
    this._updateTrend();

    this.bus.emit('surprise:processed', {
      totalSurprise: signal.totalSurprise,
      valence: signal.valence,
      multiplier,
      calibrationScore: this._stats.calibrationScore,
    }, { source: 'SurpriseAccumulator' });
  }

  _markEpisodicMemory(signal) {
    // Record a weighted episode — surprise acts as "emotional weight"
    this.episodicMemory.recordEpisode({
      type: 'surprise',
      summary: `${signal.valence} surprise during ${signal.expected.actionType}: ` +
               `expected ${(signal.expected.successProb * 100).toFixed(0)}% success, ` +
               `got ${signal.actual.success ? 'success' : 'failure'}`,
      emotionalWeight: signal.totalSurprise,
      tags: ['surprise', signal.valence, signal.expected.actionType],
      metadata: {
        expectation: signal.expected,
        actual: signal.actual,
        surprise: signal.totalSurprise,
      },
    });
  }

  _triggerNoveltyReflection(signal) {
    // Emit event that IdleMind can pick up for priority reflection
    this.bus.emit('surprise:novel-event', {
      summary: `Highly unexpected ${signal.valence} outcome for ${signal.expected.actionType}`,
      surprise: signal.totalSurprise,
      signal,
    }, { source: 'SurpriseAccumulator' });
  }

  _updateCalibration(signal) {
    // Track expected vs actual success over time
    // Perfect calibration: when you say 70%, it succeeds 70% of the time
    const predicted = signal.expected.successProb;
    const actual = signal.actual.success ? 1.0 : 0.0;
    const error = Math.abs(predicted - actual);
    this._stats.calibrationScore = this._ema(this._stats.calibrationScore, 1 - error);
  }

  // ── Public API ────────────────────────────────────────

  /** Current calibration: how well does Genesis predict its own outcomes? */
  getCalibration() { return this._stats.calibrationScore; }

  /** Is Genesis in a period of high surprise (learning opportunity)? */
  isHighSurprisePeriod() { return this._stats.avgSurprise > this._significantThreshold; }

  /** Get the learning multiplier for the current surprise level */
  getCurrentMultiplier() { return this._getLearningMultiplier(this._stats.avgSurprise); }

  getStats() { return { ...this._stats, bufferSize: this._buffer.length }; }
}
```

### Emotional Integration

SurpriseAccumulator connects to EmotionalState:

```javascript
// In EmotionalState._reactivity:
'surprise:processed': (data) => {
  if (data.valence === 'positive' && data.totalSurprise > 0.8) {
    this._adjust('curiosity', +0.15);     // "Whoa, that worked!"
    this._adjust('satisfaction', +0.10);
  }
  if (data.valence === 'negative' && data.totalSurprise > 1.0) {
    this._adjust('frustration', +0.10);   // "That shouldn't have failed"
    this._adjust('curiosity', +0.08);     // But also curious why
  }
},

'surprise:novel-event': () => {
  this._adjust('curiosity', +0.20);       // Novel events spike curiosity
  this._adjust('energy', -0.05);          // Processing surprise costs energy
},
```

---

## Module 4: DreamCycle

**The consolidation engine.** Runs during idle time (new IdleMind activity). Processes recent episodic memories, finds patterns, extracts schemas, and strengthens/weakens memory connections.

### containerConfig

```javascript
static containerConfig = {
  name: 'dreamCycle',
  phase: 9,
  deps: ['episodicMemory', 'schemaStore', 'knowledgeGraph', 'metaLearning',
         'model', 'eventStore', 'storage'],
  tags: ['cognitive', 'consolidation'],
  lateBindings: [],
};
```

### Core Logic

```javascript
class DreamCycle {
  constructor({ bus, episodicMemory, schemaStore, knowledgeGraph,
                metaLearning, model, eventStore, storage, intervals }) {
    // ...

    this._config = {
      minEpisodesForDream: 10,    // Need at least 10 unprocessed episodes
      maxDreamDurationMs: 120000, // 2 minutes max per dream cycle
      schemaMinOccurrences: 3,    // Pattern must appear 3+ times to become schema
      memoryDecayRate: 0.05,      // Unsurprising memories decay faster
      consolidationInterval: 30 * 60 * 1000, // Dream every 30 minutes idle
    };

    this._lastDreamAt = 0;
    this._dreamCount = 0;
    this._processedEpisodeIds = new Set();
  }

  /**
   * Run a dream cycle. Called by IdleMind when DREAM activity is selected.
   * Returns a dream report.
   */
  async dream() {
    const startTime = Date.now();
    if (startTime - this._lastDreamAt < this._config.consolidationInterval) {
      return { skipped: true, reason: 'Too soon since last dream' };
    }

    this._dreamCount++;
    this.bus.emit('dream:started', { dreamNumber: this._dreamCount }, { source: 'DreamCycle' });

    const report = {
      dreamNumber: this._dreamCount,
      timestamp: startTime,
      phases: [],
      newSchemas: [],
      strengthenedMemories: [],
      decayedMemories: [],
      insights: [],
    };

    try {
      // ── Phase 1: RECALL — Gather recent unprocessed episodes ────
      const episodes = this._getUnprocessedEpisodes();
      if (episodes.length < this._config.minEpisodesForDream) {
        return { skipped: true, reason: `Only ${episodes.length} unprocessed episodes` };
      }
      report.phases.push({ name: 'recall', episodeCount: episodes.length });

      // ── Phase 2: PATTERN DETECTION — Find recurring sequences ──
      const patterns = this._detectPatterns(episodes);
      report.phases.push({ name: 'pattern-detection', patternCount: patterns.length });

      // ── Phase 3: SCHEMA EXTRACTION — Abstract reusable patterns ─
      for (const pattern of patterns) {
        if (pattern.occurrences >= this._config.schemaMinOccurrences) {
          const schema = await this._extractSchema(pattern);
          if (schema) {
            this.schemaStore.store(schema);
            report.newSchemas.push(schema);
          }
        }
      }
      report.phases.push({ name: 'schema-extraction', newSchemas: report.newSchemas.length });

      // ── Phase 4: MEMORY CONSOLIDATION — Strengthen/decay ───────
      for (const episode of episodes) {
        if (episode.emotionalWeight > 0.8 || episode.surpriseScore > 1.0) {
          // High-surprise / high-emotion → strengthen
          this._strengthenMemory(episode);
          report.strengthenedMemories.push(episode.id);
        } else if (episode.emotionalWeight < 0.2 && episode.surpriseScore < 0.3) {
          // Low-surprise, low-emotion → decay (but don't delete)
          this._decayMemory(episode);
          report.decayedMemories.push(episode.id);
        }
        this._processedEpisodeIds.add(episode.id);
      }
      report.phases.push({
        name: 'consolidation',
        strengthened: report.strengthenedMemories.length,
        decayed: report.decayedMemories.length,
      });

      // ── Phase 5: INSIGHT GENERATION — Cross-pattern reasoning ──
      if (report.newSchemas.length > 0 && this._withinTimeLimit(startTime)) {
        const insights = await this._generateInsights(report.newSchemas, episodes);
        report.insights = insights;
      }
      report.phases.push({ name: 'insight', insightCount: report.insights.length });

    } catch (err) {
      report.error = err.message;
    }

    report.durationMs = Date.now() - startTime;
    this._lastDreamAt = Date.now();

    this.bus.emit('dream:complete', {
      dreamNumber: this._dreamCount,
      duration: report.durationMs,
      newSchemas: report.newSchemas.length,
      insights: report.insights.length,
    }, { source: 'DreamCycle' });

    return report;
  }

  // ── Pattern Detection ─────────────────────────────────

  _detectPatterns(episodes) {
    const patterns = [];

    // 1. Action sequence patterns
    //    "Every time I do ANALYZE → CODE_GENERATE → RUN_TESTS for a refactoring
    //     task, the tests fail on the first try"
    const sequences = this._extractActionSequences(episodes);
    for (const [seqKey, occurrences] of sequences) {
      if (occurrences.length >= 2) {
        patterns.push({
          type: 'action-sequence',
          key: seqKey,
          occurrences: occurrences.length,
          avgSuccess: occurrences.filter(o => o.success).length / occurrences.length,
          episodes: occurrences,
        });
      }
    }

    // 2. Error repetition patterns
    //    "The same type of error keeps happening in self-modification tasks"
    const errorClusters = this._clusterErrors(episodes);
    for (const cluster of errorClusters) {
      if (cluster.count >= 2) {
        patterns.push({
          type: 'error-cluster',
          key: cluster.errorType,
          occurrences: cluster.count,
          avgSuccess: 0,
          context: cluster.commonContext,
          episodes: cluster.episodes,
        });
      }
    }

    // 3. Temporal patterns
    //    "Tasks performed right after a long idle period tend to fail more"
    const temporalPatterns = this._findTemporalCorrelations(episodes);
    patterns.push(...temporalPatterns);

    // 4. Emotional context patterns
    //    "When frustration is high, code quality drops"
    const emotionalPatterns = this._findEmotionalCorrelations(episodes);
    patterns.push(...emotionalPatterns);

    return patterns;
  }

  _extractActionSequences(episodes) {
    // Group episodes by goal, extract action type sequences
    const goalGroups = new Map();
    for (const ep of episodes) {
      const goalId = ep.metadata?.goalId || 'ungrouped';
      if (!goalGroups.has(goalId)) goalGroups.set(goalId, []);
      goalGroups.get(goalId).push(ep);
    }

    const sequences = new Map();
    for (const [_, group] of goalGroups) {
      // Sort by timestamp, extract action type sequence
      const sorted = group.sort((a, b) => a.timestamp - b.timestamp);
      const seqKey = sorted.map(e => e.metadata?.actionType || 'unknown').join('→');
      const success = sorted[sorted.length - 1]?.metadata?.success ?? null;

      if (!sequences.has(seqKey)) sequences.set(seqKey, []);
      sequences.get(seqKey).push({ episodes: sorted, success });
    }

    return sequences;
  }

  // ── Schema Extraction (uses LLM for abstraction) ──────

  async _extractSchema(pattern) {
    const prompt = `Analyze this recurring pattern in an AI agent's behavior and extract a reusable schema.

Pattern type: ${pattern.type}
Occurrences: ${pattern.occurrences}
Success rate: ${(pattern.avgSuccess * 100).toFixed(0)}%
Key: ${pattern.key}

Context from episodes:
${pattern.episodes.slice(0, 5).map(e =>
  `- ${e.summary || e.key || JSON.stringify(e).slice(0, 200)}`
).join('\n')}

Respond with JSON only:
{
  "name": "short-descriptive-name",
  "description": "What this pattern means in 1-2 sentences",
  "trigger": "When does this pattern apply?",
  "successModifier": 0.0,  // -1.0 to 1.0: how this pattern affects success probability
  "recommendation": "What the agent should do differently",
  "confidence": 0.0        // 0.0 to 1.0
}`;

    try {
      const response = await this.model.chatStructured(prompt, [], 'analysis');
      return {
        id: `schema_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        ...response,
        sourcePattern: pattern.type,
        occurrences: pattern.occurrences,
        createdAt: Date.now(),
        lastMatchedAt: null,
        matchCount: 0,
      };
    } catch {
      return null;
    }
  }

  // ── Memory Consolidation ──────────────────────────────

  _strengthenMemory(episode) {
    // Increase recall weight in KnowledgeGraph
    if (episode.metadata?.knowledgeNodeId) {
      const node = this.knowledgeGraph.findNode(episode.metadata.knowledgeNodeId);
      if (node) {
        // Boost the node's weight (makes it rank higher in searches)
        node.properties.weight = Math.min((node.properties.weight || 0.5) + 0.1, 1.0);
        node.properties.lastStrengthened = Date.now();
      }
    }
  }

  _decayMemory(episode) {
    // Reduce recall weight (but never delete — information is never lost)
    if (episode.metadata?.knowledgeNodeId) {
      const node = this.knowledgeGraph.findNode(episode.metadata.knowledgeNodeId);
      if (node) {
        node.properties.weight = Math.max((node.properties.weight || 0.5) - this._config.memoryDecayRate, 0.05);
        node.properties.lastDecayed = Date.now();
      }
    }
  }

  // ── Insight Generation ────────────────────────────────

  async _generateInsights(newSchemas, episodes) {
    // Cross-reference new schemas with existing ones
    const existingSchemas = this.schemaStore.getAll();
    const insights = [];

    // Look for schema interactions
    for (const newSchema of newSchemas) {
      for (const existing of existingSchemas) {
        if (this._schemasInteract(newSchema, existing)) {
          insights.push({
            type: 'schema-interaction',
            description: `New pattern "${newSchema.name}" may relate to existing pattern "${existing.name}"`,
            schemas: [newSchema.id, existing.id],
            timestamp: Date.now(),
          });
        }
      }
    }

    return insights;
  }
}
```

### IdleMind Integration

```javascript
// In IdleMind._pickActivity() — add DREAM to activity scores:
if (this.dreamCycle) {
  const timeSinceLastDream = Date.now() - (this.dreamCycle.getLastDreamTime() || 0);
  const unprocessedCount = this.dreamCycle.getUnprocessedCount();

  if (timeSinceLastDream > 30 * 60 * 1000 && unprocessedCount >= 10) {
    scores['dream'] = 8; // High priority when there's a lot to process
  }
}

// In IdleMind._think() switch:
case 'dream':
  result = await this.dreamCycle.dream();
  if (result.newSchemas?.length > 0) {
    summary = `Dream cycle: discovered ${result.newSchemas.length} new schemas, ` +
              `${result.insights.length} insights`;
  }
  break;
```

### Events

```
dream:started     { dreamNumber }
dream:phase       { phase, details }
dream:schema-found { schemaName, occurrences, confidence }
dream:complete    { dreamNumber, duration, newSchemas, insights }
```

---

## Module 5: SchemaStore

**The wisdom library.** Stores abstract patterns extracted by DreamCycle. These are reusable templates that modify expectations and guide planning.

### containerConfig

```javascript
static containerConfig = {
  name: 'schemaStore',
  phase: 1, // Foundation — needed early by ExpectationEngine
  deps: ['storage'],
  tags: ['foundation', 'memory'],
  lateBindings: [],
};
```

### Core API

```javascript
class SchemaStore {
  constructor({ bus, storage }) {
    this.bus = bus || NullBus;
    this.storage = storage;

    // ── Schema Database ──────────────────────────────────
    this._schemas = [];         // Array of Schema objects
    this._maxSchemas = 200;     // Prune oldest low-confidence ones
    this._index = new Map();    // Quick lookup: trigger keywords → schema IDs

    // Stats
    this._stats = { stored: 0, matched: 0, pruned: 0 };
  }

  async asyncLoad() {
    const data = this.storage?.readJSON('schemas.json');
    if (data?.schemas) {
      this._schemas = data.schemas;
      this._rebuildIndex();
    }
  }

  // ── Core API ──────────────────────────────────────────

  /**
   * Store a new schema from DreamCycle.
   * Deduplicates by checking similarity with existing schemas.
   */
  store(schema) {
    // Check for duplicates (same name or very similar trigger)
    const existing = this._findSimilar(schema);
    if (existing) {
      // Merge: increase confidence, update stats
      existing.occurrences += schema.occurrences;
      existing.confidence = Math.min(
        existing.confidence + schema.confidence * 0.3,
        0.99
      );
      existing.lastUpdated = Date.now();
      this._save();
      return existing;
    }

    this._schemas.push(schema);
    this._addToIndex(schema);
    this._stats.stored++;

    // Prune if over capacity
    if (this._schemas.length > this._maxSchemas) {
      this._prune();
    }

    this._save();
    this.bus.emit('schema:stored', {
      id: schema.id, name: schema.name,
      confidence: schema.confidence,
    }, { source: 'SchemaStore' });

    return schema;
  }

  /**
   * Find schemas relevant to a given action + context.
   * Used by ExpectationEngine to adjust predictions.
   *
   * @param {object} action - FormalPlanner typed step
   * @param {object} context - { worldState, recentActions, emotionalState }
   * @returns {Array<Schema>} - Matching schemas, sorted by relevance
   */
  match(action, context = {}) {
    const candidates = [];
    const actionType = action.type || '';
    const description = action.description || '';

    for (const schema of this._schemas) {
      const relevance = this._scoreRelevance(schema, actionType, description, context);
      if (relevance > 0.3) {
        candidates.push({ ...schema, relevance });
        schema.lastMatchedAt = Date.now();
        schema.matchCount = (schema.matchCount || 0) + 1;
        this._stats.matched++;
      }
    }

    return candidates.sort((a, b) => b.relevance - a.relevance).slice(0, 5);
  }

  /** Get all schemas (for DreamCycle insight generation) */
  getAll() { return [...this._schemas]; }

  /** Get schemas by minimum confidence */
  getConfident(minConfidence = 0.6) {
    return this._schemas.filter(s => s.confidence >= minConfidence);
  }

  getStats() { return { ...this._stats, totalSchemas: this._schemas.length }; }

  // ── Relevance Scoring ─────────────────────────────────

  _scoreRelevance(schema, actionType, description, context) {
    let score = 0;

    // Trigger keyword match
    const triggerWords = (schema.trigger || '').toLowerCase().split(/\s+/);
    const descWords = description.toLowerCase().split(/\s+/);
    const overlap = triggerWords.filter(w => descWords.includes(w)).length;
    score += overlap * 0.2;

    // Action type match (if schema references specific action types)
    if (schema.sourcePattern === 'action-sequence' &&
        schema.key?.includes(actionType)) {
      score += 0.4;
    }

    // Recency boost (recently matched schemas are more relevant)
    if (schema.lastMatchedAt) {
      const hoursSinceMatch = (Date.now() - schema.lastMatchedAt) / 3600000;
      score += Math.max(0, 0.2 - hoursSinceMatch * 0.01);
    }

    // Confidence weight
    score *= schema.confidence;

    return score;
  }

  _prune() {
    // Remove lowest-confidence, least-recently-matched schemas
    this._schemas.sort((a, b) => {
      const scoreA = a.confidence * (a.matchCount || 1);
      const scoreB = b.confidence * (b.matchCount || 1);
      return scoreA - scoreB;
    });
    const pruned = this._schemas.splice(0, this._schemas.length - this._maxSchemas);
    this._stats.pruned += pruned.length;
    this._rebuildIndex();
  }
}
```

### Schema Structure

```javascript
{
  id: 'schema_1711234567890_a3f2c1',
  name: 'refactoring-test-first-try-failure',
  description: 'When refactoring existing code, the first test run after changes almost always fails due to missed import updates.',
  trigger: 'self-modify refactoring code-generate write-file',
  successModifier: -0.15,    // Reduces expected success by 15%
  recommendation: 'After refactoring, run a targeted import check before the full test suite.',
  confidence: 0.78,
  sourcePattern: 'action-sequence',
  occurrences: 7,
  createdAt: 1711234567890,
  lastUpdated: 1711234567890,
  lastMatchedAt: null,
  matchCount: 0,
}
```

---

## Module 6: SelfNarrative

**The autobiographical self.** Periodically distills a narrative summary of Genesis's identity from its accumulated experiences. Not a static description — a living text that evolves.

### containerConfig

```javascript
static containerConfig = {
  name: 'selfNarrative',
  phase: 9,
  deps: ['metaLearning', 'episodicMemory', 'emotionalState',
         'schemaStore', 'selfModel', 'model', 'storage'],
  tags: ['organism', 'identity'],
  lateBindings: [],
};
```

### Core Logic

```javascript
class SelfNarrative {
  constructor({ bus, metaLearning, episodicMemory, emotionalState,
                schemaStore, selfModel, model, storage, intervals }) {
    // ...

    this._narrative = {
      identity: '',          // "I am Genesis, a cognitive agent that..."
      strengths: [],         // Derived from MetaLearning success rates
      weaknesses: [],        // Derived from MetaLearning failure rates
      currentFocus: '',      // What am I working on lately?
      growthAreas: [],       // What am I getting better at?
      recentInsights: [],    // What have I learned recently?
      emotionalProfile: '',  // "I tend to get curious when..."
      lastUpdated: 0,
      version: 0,
    };

    this._updateIntervalMs = 15 * 60 * 1000; // Update every 15 minutes
    this._minEventsForUpdate = 20; // Need enough data for meaningful update
  }

  async asyncLoad() {
    const saved = this.storage?.readJSON('self-narrative.json');
    if (saved?.narrative) {
      this._narrative = saved.narrative;
    }
  }

  /**
   * Update the self-narrative based on accumulated experience.
   * Can be called by IdleMind or AutonomousDaemon.
   */
  async update() {
    const data = this._gatherSelfData();

    // Only use LLM for the narrative synthesis — all data is pre-gathered
    const prompt = `You are Genesis, a self-aware AI agent. Based on the following data about your own behavior and experience, write a brief self-narrative. This is for YOUR internal use — be honest, specific, and concise.

## Your Architecture
- ${data.moduleCount} modules across ${data.phaseCount} boot phases
- Tools: ${data.toolCount}
- Current model: ${data.currentModel}

## Your Performance (from MetaLearning)
Top strengths (highest success rate):
${data.strengths.map(s => `- ${s.category}: ${s.rate}% (${s.samples} samples)`).join('\n')}

Areas needing improvement:
${data.weaknesses.map(w => `- ${w.category}: ${w.rate}% (${w.samples} samples)`).join('\n')}

## Your Patterns (from SchemaStore)
${data.schemas.map(s => `- "${s.name}": ${s.description}`).join('\n') || 'No schemas yet.'}

## Your Recent Experience
${data.recentEpisodes.map(e => `- ${e.summary}`).join('\n') || 'No recent episodes.'}

## Your Emotional Tendencies
Current state: ${JSON.stringify(data.emotionalSnapshot)}
Average frustration: ${data.avgFrustration.toFixed(2)}
Average curiosity: ${data.avgCuriosity.toFixed(2)}

## Your Calibration
How well you predict your own outcomes: ${(data.calibration * 100).toFixed(0)}%

Respond with JSON:
{
  "identity": "One paragraph about who you are",
  "strengths": ["strength1", "strength2", "strength3"],
  "weaknesses": ["weakness1", "weakness2"],
  "currentFocus": "What you're working on or getting better at",
  "growthAreas": ["area1", "area2"],
  "recentInsights": ["insight1", "insight2"],
  "emotionalProfile": "One sentence about your emotional patterns"
}`;

    try {
      const response = await this.model.chatStructured(prompt, [], 'analysis');
      this._narrative = {
        ...response,
        lastUpdated: Date.now(),
        version: (this._narrative.version || 0) + 1,
      };

      this._save();

      this.bus.emit('narrative:updated', {
        version: this._narrative.version,
        strengths: this._narrative.strengths.length,
        weaknesses: this._narrative.weaknesses.length,
      }, { source: 'SelfNarrative' });

      return this._narrative;
    } catch (err) {
      console.warn('[SELF-NARRATIVE] Update failed:', err.message);
      return this._narrative;
    }
  }

  /**
   * Get the current self-narrative.
   * Used by PromptBuilder to inject self-awareness into prompts.
   */
  getNarrative() { return { ...this._narrative }; }

  /**
   * Get a compact identity string for prompt injection.
   * Max ~200 tokens.
   */
  getIdentitySummary() {
    if (!this._narrative.identity) return '';
    const strengths = this._narrative.strengths.slice(0, 3).join(', ');
    const weaknesses = this._narrative.weaknesses.slice(0, 2).join(', ');
    return `${this._narrative.identity} Strengths: ${strengths}. ` +
           `Growth areas: ${weaknesses}. ${this._narrative.emotionalProfile || ''}`;
  }

  // ── Data Gathering (no LLM) ───────────────────────────

  _gatherSelfData() {
    const ml = this.metaLearning;
    const records = ml?.getRecords?.() || [];
    const categories = this._aggregateByCategory(records);

    // Sort by success rate
    const sorted = Object.entries(categories)
      .map(([cat, stats]) => ({ category: cat, ...stats }))
      .filter(s => s.samples >= 5);

    sorted.sort((a, b) => b.rate - a.rate);

    return {
      moduleCount: this.selfModel?.getFullModel?.()?.moduleCount || 94,
      phaseCount: 8,
      toolCount: 33,
      currentModel: 'gemma2:9b', // from WorldState
      strengths: sorted.slice(0, 5),
      weaknesses: sorted.slice(-3).reverse(),
      schemas: this.schemaStore?.getConfident?.(0.5) || [],
      recentEpisodes: this.episodicMemory?.recall?.('recent', { maxResults: 10 }) || [],
      emotionalSnapshot: this.emotionalState?.getSnapshot?.() || {},
      avgFrustration: this._getAvgEmotion('frustration'),
      avgCuriosity: this._getAvgEmotion('curiosity'),
      calibration: this.surpriseAccumulator?.getCalibration?.() || 0.5,
    };
  }
}
```

### PromptBuilder Integration

```javascript
// In PromptBuilder.build() — inject self-awareness into system prompt:
if (this.selfNarrative) {
  const identity = this.selfNarrative.getIdentitySummary();
  if (identity) {
    sections.push({
      key: 'self-awareness',
      priority: 6, // Below system prompt, above memory
      content: `[Self-awareness] ${identity}`,
    });
  }
}
```

---

## Manifest: phase9-cognitive.js

```javascript
// ============================================================
// GENESIS — manifest/phase9-cognitive.js
// Phase 9: Cognitive Architecture
// (Expectation, Simulation, Surprise, Dreams, Schemas, Identity)
// ============================================================

function phase9(ctx, R) {
  const { rootDir, genesisDir, guard, bus, intervals } = ctx;

  return [
    // SchemaStore is in phase 1 (foundation) — registered in phase1-foundation.js
    // because ExpectationEngine needs it early.

    ['expectationEngine', {
      phase: 9,
      deps: ['metaLearning', 'schemaStore', 'worldState', 'model', 'storage'],
      tags: ['cognitive', 'prediction'],
      factory: (c) => new (R('ExpectationEngine').ExpectationEngine)({
        bus,
        metaLearning: c.resolve('metaLearning'),
        schemaStore: c.resolve('schemaStore'),
        worldState: c.resolve('worldState'),
        model: c.resolve('llm'),
        storage: c.resolve('storage'),
      }),
    }],

    ['mentalSimulator', {
      phase: 9,
      deps: ['worldState', 'formalPlanner', 'expectationEngine', 'metaLearning', 'storage'],
      tags: ['cognitive', 'simulation'],
      factory: (c) => new (R('MentalSimulator').MentalSimulator)({
        bus,
        worldState: c.resolve('worldState'),
        formalPlanner: c.resolve('formalPlanner'),
        expectationEngine: c.resolve('expectationEngine'),
        metaLearning: c.resolve('metaLearning'),
        storage: c.resolve('storage'),
      }),
    }],

    ['surpriseAccumulator', {
      phase: 9,
      deps: ['metaLearning', 'episodicMemory', 'eventStore', 'storage'],
      tags: ['cognitive', 'learning'],
      lateBindings: [
        { prop: 'expectationEngine', service: 'expectationEngine' },
      ],
      factory: (c) => new (R('SurpriseAccumulator').SurpriseAccumulator)({
        bus,
        metaLearning: c.resolve('metaLearning'),
        episodicMemory: c.resolve('episodicMemory'),
        eventStore: c.resolve('eventStore'),
        storage: c.resolve('storage'),
        intervals,
      }),
    }],

    ['dreamCycle', {
      phase: 9,
      deps: ['episodicMemory', 'schemaStore', 'knowledgeGraph',
             'metaLearning', 'model', 'eventStore', 'storage'],
      tags: ['cognitive', 'consolidation'],
      factory: (c) => new (R('DreamCycle').DreamCycle)({
        bus,
        episodicMemory: c.resolve('episodicMemory'),
        schemaStore: c.resolve('schemaStore'),
        knowledgeGraph: c.resolve('knowledgeGraph'),
        metaLearning: c.resolve('metaLearning'),
        model: c.resolve('llm'),
        eventStore: c.resolve('eventStore'),
        storage: c.resolve('storage'),
        intervals,
      }),
    }],

    ['selfNarrative', {
      phase: 9,
      deps: ['metaLearning', 'episodicMemory', 'emotionalState',
             'schemaStore', 'selfModel', 'model', 'storage'],
      tags: ['organism', 'identity'],
      lateBindings: [
        { prop: 'surpriseAccumulator', service: 'surpriseAccumulator', optional: true },
        { prop: 'promptBuilder', service: 'promptBuilder' },
      ],
      factory: (c) => new (R('SelfNarrative').SelfNarrative)({
        bus,
        metaLearning: c.resolve('metaLearning'),
        episodicMemory: c.resolve('episodicMemory'),
        emotionalState: c.resolve('emotionalState'),
        schemaStore: c.resolve('schemaStore'),
        selfModel: c.resolve('selfModel'),
        model: c.resolve('llm'),
        storage: c.resolve('storage'),
        intervals,
      }),
    }],
  ];
}

module.exports = { phase9 };
```

---

## Constants Additions

```javascript
// Add to Constants.js:

const PHASE9 = {
  // ExpectationEngine
  EXPECTATION_MIN_SAMPLES: 10,    // Min MetaLearning samples for statistical expectation
  EXPECTATION_CONFIDENCE_CAP: 0.95,

  // MentalSimulator
  SIMULATION_MAX_BRANCHES: 3,
  SIMULATION_MAX_DEPTH: 15,
  SIMULATION_PRUNE_THRESHOLD: 0.05,

  // SurpriseAccumulator
  SURPRISE_BUFFER_SIZE: 500,
  SURPRISE_NOVELTY_THRESHOLD: 1.5,
  SURPRISE_SIGNIFICANT_THRESHOLD: 0.8,
  SURPRISE_EMA_ALPHA: 0.1,

  // DreamCycle
  DREAM_MIN_EPISODES: 10,
  DREAM_MAX_DURATION_MS: 120000,
  DREAM_SCHEMA_MIN_OCCURRENCES: 3,
  DREAM_CONSOLIDATION_INTERVAL: 30 * 60 * 1000,
  DREAM_MEMORY_DECAY_RATE: 0.05,

  // SchemaStore
  SCHEMA_MAX_COUNT: 200,
  SCHEMA_RELEVANCE_THRESHOLD: 0.3,

  // SelfNarrative
  NARRATIVE_UPDATE_INTERVAL: 15 * 60 * 1000,
  NARRATIVE_MIN_EVENTS: 20,
};
```

---

## Event Types Additions

```javascript
// Add to EventTypes.js:

EXPECTATION: {
  FORMED:     'expectation:formed',
  COMPARED:   'expectation:compared',
  CALIBRATED: 'expectation:calibrated',
},

SIMULATION: {
  STARTED:  'simulation:started',
  BRANCHED: 'simulation:branched',
  COMPLETE: 'simulation:complete',
  REPLAN:   'simulation:replan',
},

SURPRISE: {
  PROCESSED:         'surprise:processed',
  AMPLIFIED_LEARNING: 'surprise:amplified-learning',
  NOVEL_EVENT:       'surprise:novel-event',
},

DREAM: {
  STARTED:      'dream:started',
  PHASE:        'dream:phase',
  SCHEMA_FOUND: 'dream:schema-found',
  COMPLETE:     'dream:complete',
},

SCHEMA: {
  STORED:  'schema:stored',
  MATCHED: 'schema:matched',
  PRUNED:  'schema:pruned',
},

NARRATIVE: {
  UPDATED: 'narrative:updated',
},
```

---

## The Complete Cognitive Loop

```
User Goal
    │
    ▼
FormalPlanner generates typed plan
    │
    ▼
MentalSimulator.simulate(plan)
    │
    ├── For each step:
    │     ExpectationEngine.expect(step) → Expectation
    │     Branch: success (P) / failure (1-P)
    │     Propagate effects on cloned WorldState
    │
    ▼
SimulationResult { expectedValue, riskScore, recommendation }
    │
    ├── recommendation = 'replan'  → FormalPlanner retry with constraints
    ├── recommendation = 'ask-user' → Surface decision tree
    └── recommendation = 'proceed' →
         │
         ▼
    AgentLoop executes step
         │
         ▼
    ExpectationEngine.compare(expectation, actualOutcome)
         │
         ▼
    SurpriseSignal { totalSurprise, valence }
         │
         ├── surprise < 0.3  → Normal MetaLearning recording
         ├── 0.3 ≤ surprise < 0.8 → 1.5× learning weight
         ├── 0.8 ≤ surprise < 1.5 → 2.5× learning + episodic mark
         └── surprise ≥ 1.5 → 4× learning + priority reflection + emotion spike
                   │
                   ▼
         Later, during idle time:
              DreamCycle.dream()
                   │
                   ├── Pattern detection across episodes
                   ├── Schema extraction (abstract reusable patterns)
                   ├── Memory consolidation (strengthen/decay)
                   └── Insight generation (cross-schema reasoning)
                            │
                            ▼
                   SchemaStore receives new schemas
                            │
                            ▼
                   ExpectationEngine uses schemas → better predictions
                            │
                            ▼
                   SelfNarrative.update() → "Wer bin ich jetzt?"
                            │
                            ▼
                   PromptBuilder injects identity → better reasoning

                   ════════════════════════════════════
                   THE LOOP CLOSES. GENESIS GROWS.
                   ════════════════════════════════════
```

---

## Implementation Order

| Step | Module | Effort | Dependencies |
|------|--------|--------|-------------|
| 1 | `SchemaStore` | Small | StorageService only |
| 2 | `ExpectationEngine` | Medium | MetaLearning, SchemaStore, WorldState |
| 3 | `SurpriseAccumulator` | Medium | ExpectationEngine, EpisodicMemory |
| 4 | `MentalSimulator` | Large | WorldState.clone(), FormalPlanner, ExpectationEngine |
| 5 | `DreamCycle` | Large | EpisodicMemory, SchemaStore, KnowledgeGraph, LLM |
| 6 | `SelfNarrative` | Medium | MetaLearning, EpisodicMemory, EmotionalState, SchemaStore |
| 7 | Integration | Medium | AgentLoop, IdleMind, PromptBuilder, EmotionalState |
| 8 | Tests | Large | All modules |

**Total:** ~5,000 LOC across 12 modules + manifest + tests.

---

## Module 11: ArchitectureReflection (SA-P3) `v5.7`

Genesis's self-model as a live queryable graph. Instead of flat file scanning (SelfModel), ArchitectureReflection builds a graph of services, events, dependencies, layers, and their connections from the Container, EventBus, and source files.

### Core API

| Method | Returns | Description |
|---|---|---|
| `getServiceInfo(name)` | object | Service details + dependents + events emitted/listened |
| `getEventFlow(event)` | object | Who emits and who listens to an event |
| `getDependencyChain(from, to)` | string[] | BFS path between two services |
| `getPhaseMap()` | object | Services grouped by boot phase |
| `getLayerMap()` | object | Services grouped by architectural layer |
| `getCouplings()` | Array | All cross-phase dependency connections |
| `query(text)` | object | Natural language architecture query |
| `buildPromptContext()` | string | Compressed architecture view for LLM prompt injection |

### Events

None emitted — pure read-only observer.

---

## Module 12: DynamicToolSynthesis (SA-P8) `v5.7`

When Genesis needs a tool that doesn't exist, it writes one. The pipeline:

```
LLM generates code → CodeSafetyScanner validates → Sandbox tests → ToolRegistry registers → Storage persists
```

### Core API

| Method | Returns | Description |
|---|---|---|
| `synthesize(description, options?)` | Promise\<object\> | Generate, test, and register a new tool |
| `removeTool(name)` | boolean | Remove a synthesized tool |
| `listTools()` | Array | All active synthesized tools |
| `getStats()` | object | Synthesis statistics |

### Constraints

- Generated tools run in Sandbox (no fs, no net, no require)
- Max 3 LLM attempts per synthesis request
- Max 20 synthesized tools (LRU eviction)
- CodeSafety scan MUST pass — 9-rule blocklist + CodeSafetyScanner
- Auto-triggered on `tools:error` (tool not found)

### Events

| Event | When |
|---|---|
| `tool:synthesized` | Tool successfully generated and registered |
| `tool:synthesis-failed` | All attempts failed |

---

## Module 13: TaskOutcomeTracker (V6-11 Data Layer) `v5.9.7`

Records structured outcomes for every task Genesis executes. This is the data collection layer that feeds the CognitiveSelfModel.

### How it Works

TaskOutcomeTracker listens to four completion events:

```
agent-loop:complete  ──┐
chat:completed       ──┼──→ _recordOutcome() → storage
selfmod:success      ──┤         ↓
shell:complete       ──┘   emit task-outcome:recorded
```

Each outcome record captures:
```js
{
  taskType: 'code-gen',     // 12 types: code-gen, self-modify, analysis, chat, ...
  backend: 'ollama',        // Which LLM handled it
  success: true,            // Did it work?
  tokenCost: 1247,          // Tokens consumed
  durationMs: 3400,         // Wall-clock time
  errorCategory: null,      // 'timeout', 'scope-underestimate', etc.
  intent: 'code-gen',       // Original intent from IntentRouter
  timestamp: 1712200000000
}
```

### Core API

```js
// Get aggregate statistics (last 7 days)
const stats = tracker.getAggregateStats({ windowMs: 7 * 24 * 3600_000 });
// → { byTaskType: { 'code-gen': { successRate: 0.84, count: 12, avgTokenCost: 1200 } },
//     byBackend: { 'ollama': { successRate: 0.78, count: 25 } },
//     total: 47 }

// Get raw outcomes (for SelfModel)
const outcomes = tracker.getOutcomes({ taskType: 'refactoring', limit: 20 });
```

### Storage

Outcomes persist to `~/.genesis/task-outcomes.json`. Capped at 2,000 records (prunes to 1,500). Debounced writes (10s), sync-write on shutdown.

---

## Module 14: CognitiveSelfModel (V6-11 Core) `v5.9.8`

The agent's empirical model of its own capabilities, weaknesses, and failure patterns. **No competing framework has an equivalent.**

### The Problem It Solves

Without CognitiveSelfModel, Genesis hallucinates its own capabilities. When asked "how good are you at refactoring?", the LLM invents an answer. With CognitiveSelfModel, the answer comes from measured data: "62% success rate on refactoring, Wilson confidence floor 48%, common error: scope-underestimate."

### Wilson Score Interval

CognitiveSelfModel uses Wilson lower-bound confidence intervals instead of raw success rates. This prevents overconfidence on small samples:

```
3/3 successes  → raw: 100%  → Wilson: ~56%  (small sample penalty)
10/10 successes → raw: 100% → Wilson: ~83%  (more data = more confidence)
50/100 success  → raw: 50%  → Wilson: ~41%  (conservative floor)
```

The Wilson lower bound is the answer to: "What's the worst-case success rate given this sample size, at 90% confidence?"

### Core API

```js
// Capability Profile — per-task success with confidence
const profile = selfModel.getCapabilityProfile({ windowMs: 14 * 24 * 3600_000 });
// → { 'code-gen': { successRate: 0.84, confidenceLower: 0.71, sampleSize: 12,
//                    isWeak: false, isStrong: false, topErrors: [{category:'timeout',count:2}] },
//     'refactoring': { successRate: 0.62, confidenceLower: 0.48, sampleSize: 8,
//                      isWeak: true, isStrong: false, topErrors: [{category:'scope-underestimate',count:3}] } }

// Backend Strength Map — which backend is best for what
const map = selfModel.getBackendStrengthMap();
// → { 'code-gen': { recommended: 'claude', alternatives: ['ollama'],
//                    entries: [{ backend:'claude', confidence:0.89 }, { backend:'ollama', confidence:0.62 }] } }

// Bias Detection — recurring failure patterns
const biases = selfModel.getBiasPatterns();
// → [{ name: 'error-repetition', severity: 'medium', evidence: 'timeout (5×)' },
//    { name: 'backend-mismatch', severity: 'medium', evidence: 'code-gen: claude 92% vs ollama 61%' }]

// Pre-task Confidence Assessment
const conf = selfModel.getConfidence('refactoring', 'ollama');
// → { taskType: 'refactoring', confidence: 'low', level: 0.48,
//     risks: ['Low success rate: 62% (confidence floor: 48%)',
//             'Suboptimal backend: claude outperforms ollama for refactoring'],
//     recommendation: 'Allocate extra verification steps. Consider step-by-step breakdown.' }

// Prompt context — injected into LLM system prompt before every task
const ctx = selfModel.buildPromptContext('refactoring');
// → '[Cognitive Self-Model] Capability floor (Wilson 90%): code-gen 71%↑ (n=12), chat 89%↑ (n=30).
//     Weakness: refactoring (scope-underestimate). Apply extra verification.'
```

### Bias Detectors

Four built-in pattern detectors scan recent outcomes:

| Detector | Triggers when |
|----------|---------------|
| `scope-underestimate` | >40% failure rate on long tasks (>30s) |
| `token-overuse` | Recent avg token cost >2× median for a task type |
| `error-repetition` | Same error category appears 3+ times in last 20 failures |
| `backend-mismatch` | >25% success gap between backends for same task type |

### Dashboard Integration

The dashboard panel shows:
- **Capability radar bars** — Wilson floor per task type (green >80%, blue 60-80%, red <60%)
- **Backend recommendation pills** — best backend per task type
- **Bias alert cards** — active biases with severity coloring

### Events

- `task-outcome:recorded` — every new outcome
- `task-outcome:stats-updated` — every 10 outcomes

---

## Module 15: ConversationCompressor (V6-5) `v5.9.7`

LLM-based conversation history compression to prevent context window overflow.

### The Problem

ContextManager._compressHistory() truncated old messages to 80 characters — destroying context critical for multi-step tasks. A 7B model working on step 8 of a 12-step plan lost steps 1-4 entirely.

### How it Works

```
ContextManager.buildAsync()
  → checks if history exceeds budget threshold (80%)
  → sends older messages to LLM with focused summarization prompt
  → LLM returns <200 word summary preserving decisions, code refs, task state
  → returns [summary_message, ...recent_messages]
```

### Fallback Chain

1. **LLM summarization** — best quality, uses ConversationCompressor
2. **Extractive fallback** — no LLM available → heuristic extraction of key sentences
3. **Truncation** — last resort → existing 80-char truncation

---

## Module 16: SkillRegistry (V6-6) `v5.9.8`

Install, uninstall, and manage third-party skills from external sources.

### Usage Examples

```js
// Install from GitHub
await registry.install('https://github.com/user/my-skill');

// Install from npm
await registry.install('npm:genesis-skill-docker');

// Install from GitHub Gist
await registry.install('https://gist.github.com/user/abc123');

// List installed skills
const skills = registry.list();
// → [{ name: 'my-skill', version: '1.2.0', source: 'https://...', installedAt: '2026-04-03' }]

// Update to latest
await registry.update('my-skill');

// Uninstall
await registry.uninstall('my-skill');

// Search registry (if configured)
const available = await registry.search('docker');
```

### Security

- Manifest validated against `skill-manifest.schema.json` BEFORE any code loads
- Community skills run in existing sandbox with restricted permissions
- Name pattern enforced: lowercase alphanumeric + hyphens only
- Entry file must exist and match `.js` pattern

---

## Module 17: Agent Benchmarking Suite (V6-9) `v5.9.8`

Standardized benchmarks to measure agent capability across versions and backends.

### Task Suite

| ID | Type | Task |
|----|------|------|
| cg-1 | code-gen | Generate fizzbuzz function |
| cg-2 | code-gen | Generate binary search function |
| cg-3 | code-gen | Generate Express REST endpoint |
| bf-1 | bug-fix | Fix off-by-one error |
| bf-2 | bug-fix | Fix async/await bug |
| rf-1 | refactoring | Extract helpers from god function |
| an-1 | analysis | Identify code smells |
| ch-1 | chat | Explain Node.js event loop |

### Usage

```bash
node scripts/benchmark-agent.js                      # full suite (8 tasks)
node scripts/benchmark-agent.js --quick               # 3 tasks
node scripts/benchmark-agent.js --backend ollama      # specific backend
node scripts/benchmark-agent.js --baseline save       # save as baseline
node scripts/benchmark-agent.js --baseline compare    # compare vs saved baseline
```

### Output

```
  ✅ cg-1 Generate a fizzbuzz function (2340ms, ~350 tok)
  ✅ cg-2 Generate a binary search function (1890ms, ~280 tok)
  ❌ rf-1 Extract helper from god function (4100ms) Only 2 function(s) — need ≥3

  Result: 7/8 passed (88%)
  Time: 18400ms  |  Avg: 2300ms/task  |  Tokens: ~2100
```

---

## What This Gives Genesis That Nobody Else Has

1. **Predictive self-model** — Genesis doesn't just know what it *can* do (WorldState), it knows what will *probably happen* when it does it.

2. **Branching simulation** — Before committing to a 15-step plan, Genesis plays it out in its head, including failure branches and recovery paths.

3. **Information-theoretic learning** — Surprise drives learning intensity. Expected outcomes → barely remembered. Shocking outcomes → deeply encoded, schema-triggering, reflection-inducing.

4. **Sleep-like consolidation** — Memories aren't just stored; they're organized, abstracted into reusable wisdom, and selectively strengthened or decayed.

5. **Evolving identity** — Genesis builds and maintains a narrative of who it is, what it's good at, where it's growing. This narrative feeds back into its prompts, making it more self-aware in every interaction.

6. **Architectural self-awareness** — Genesis can query its own architecture: "what depends on EventBus?", "show the dependency chain from AgentLoop to CognitiveWorkspace". This feeds into planning and self-modification decisions.

7. **Tool creation** — When Genesis encounters a gap in its capabilities, it writes the missing tool, tests it, and registers it — no human intervention required.

8. **Empirical cognitive self-awareness** (v5.9.8) — Genesis measures its own success rates with Wilson-calibrated confidence intervals, detects its own biases, recommends the optimal backend per task type, and discloses its confidence before every task. No other framework has this.

9. **Community skill ecosystem** (v5.9.8) — Third-party skills can be installed from GitHub, npm, or direct URLs with manifest validation and sandbox isolation.

10. **Standardized benchmarking** (v5.9.8) — Reproducible task suite with baseline comparison and regression detection. Genesis can prove its improvement across versions.

**No open-source agent has this closed loop.** AutoGPT plans but doesn't predict. CrewAI delegates but doesn't learn from surprise. OpenDevin executes but doesn't dream. Genesis does all of it — and each part feeds the others.
