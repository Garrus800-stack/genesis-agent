# Genesis Agent — Architecture Guide

> Everything you need to understand how Genesis works, why it's built this way,
> and how to add to it without breaking things.
>
> Version: 6.0.5 · Last verified: all checks green (~3720 tests, 263 suites, TSC 0, fitness 90/90)

---

## 1. What is Genesis

Genesis is a self-modifying AI agent that runs as an Electron desktop app. It talks to LLM backends (Ollama local, Anthropic, OpenAI-compatible), plans multi-step tasks, writes and verifies code, modifies its own source, and monitors its own health. It has an organism-inspired layer that regulates behavior under stress and a consciousness layer that models attention, memory, and temporal identity.

The codebase is ~84k LOC of JavaScript (CommonJS), 241 source modules, 139 DI-managed services (131 manifest + 8 kernel), with zero external runtime frameworks. Three production dependencies: `acorn` (AST parsing), `chokidar` (file watching), `tree-kill` (process cleanup).

---

## 2. The 60-Second Overview

Genesis boots in 13 phases. Each phase registers services into a dependency injection container. Lower phases are infrastructure, higher phases are cognitive. Every service only imports from `core/` — cross-service communication happens through the EventBus and late-bindings, never through direct imports.

| Phase | Layer | What it does | Key services |
|-------|-------|-------------|--------------|
| 1 | foundation | Storage, LLM port, sandbox, knowledge graph | `settings`, `model`, `llm`, `sandbox`, `knowledgeGraph`, `eventStore` |
| 2 | intelligence | Intent routing, prompt building, context management | `intentRouter`, `promptBuilder`, `context`, `tools`, `codeSafety` |
| 3 | capabilities | Skills, shell, MCP, plugins, hot-reload | `skills`, `shellAgent`, `mcpClient`, `skillRegistry`, `hotReloader` |
| 4 | planning | Goal stack, anticipation, meta-learning | `goalStack`, `metaLearning`, `schemaStore`, `valueStore` |
| 5 | hexagonal | Memory façade, chat orchestration, self-modification | `chatOrchestrator`, `unifiedMemory`, `selfModPipeline`, `episodicMemory` |
| 6 | autonomy | Health monitoring, daemon, error aggregation, service recovery | `daemon`, `healthMonitor`, `serviceRecovery`, `deploymentManager` |
| 7 | organism | Emotional state, homeostasis, needs, metabolism, immune system | `emotionalState`, `homeostasis`, `needsSystem`, `genome` |
| 8 | revolution | Agent loop, session persistence, colony orchestration | `agentLoop`, `sessionPersistence`, `vectorMemory`, `colonyOrchestrator` |
| 9 | cognitive | Self-model, reasoning traces, dream cycle, architecture reflection | `cognitiveSelfModel`, `taskOutcomeTracker`, `reasoningTracer`, `projectIntelligence` |
| 10 | agency | Goal persistence, conversation compression, user model | `goalPersistence`, `conversationCompressor`, `userModel`, `fitnessEvaluator` |
| 11 | extended | Trust levels, web perception, self-spawning | `trustLevelSystem`, `effectorRegistry`, `webPerception` |
| 12 | hybrid | Graph reasoning, adaptive memory | `graphReasoner`, `adaptiveMemory` |
| 13 | consciousness | Attention, phenomenal field, temporal self, introspection | `attentionalGate`, `phenomenalField`, `temporalSelf`, `consciousnessExtension` |

**Why 13 phases?** Services in higher phases can depend on lower-phase services (via the DI container), but never the reverse. This creates a strict dependency flow that prevents circular coupling. The phase number represents the "trust level" of the service — Phase 1 services are pure infrastructure, Phase 13 services are emergent cognitive processes that can degrade gracefully if their dependencies aren't available.

---

## 3. Follow the Message

This traces what happens when a user types "Erstelle eine REST API für mich" (Create a REST API for me) from keystroke to response.

### 3.1 Entry Point

The Electron renderer sends the message via IPC. The preload bridge (`preload.mjs`) forwards it to `main.js`, which calls `ChatOrchestrator.handleStream()`.

```
User types → Electron IPC → main.js → ChatOrchestrator.handleStream(message, onChunk, onDone)
```

**Files:** `preload.mjs` → `main.js` → `src/agent/hexagonal/ChatOrchestrator.js`

### 3.2 Intent Classification

ChatOrchestrator adds the message to history, fires `user:message` on the EventBus, then asks the IntentRouter to classify:

```
IntentRouter.classifyAsync(message)
  → 1. Regex match against 20 intent patterns (instant, <1ms)
  → 2. Fuzzy keyword match (if regex < 0.6 confidence)
  → 3. Local classifier (if available)
  → 4. LLM classification (last resort, ~500ms)
```

For "Erstelle eine REST API", the regex catches `execute-code` or `analyze-code` patterns. Result: `{ type: 'general', confidence: 0.5 }` (no strong regex match → falls through to LLM streaming path).

**Files:** `src/agent/intelligence/IntentRouter.js`
**Events:** `user:message`, `intent:classified`

### 3.3 Prompt Building

ChatOrchestrator calls `PromptBuilder.buildAsync()`, which assembles the system prompt from ~20 context sections:

```
PromptBuilder.buildAsync()
  → _formatting()           — response rules, language, no-organism-leak guard
  → _knowledgeContext()      — relevant KG nodes
  → _memoryContext()         — unified memory summary
  → _sessionContext()        — session history, user profile
  → _organismContext()       — emotional state, homeostasis, needs (behavioral only, no raw metrics)
  → _consciousnessContext()  — attention, phenomenal field, temporal identity
  → _taskPerformanceContext()— CognitiveSelfModel: Wilson-calibrated success rates, bias warnings
  → _safetyContext()         — code safety rules, trust level
  → ... (15+ more sections, each optional, each budget-capped)
```

Each section's service is a late-binding — if the service isn't available (crashed, not booted), the section returns empty string. The prompt degrades gracefully, never crashes.

**Files:** `src/agent/intelligence/PromptBuilder.js`, `src/agent/intelligence/PromptBuilderSections.js`

### 3.4 Context Assembly

ContextManager builds the final LLM payload: system prompt + conversation history, within a token budget.

```
ContextManager.buildAsync()
  → Allocate budgets: system prompt, tools, history, reserved
  → If ConversationCompressor available: LLM-summarize old history segments
  → Else: truncate to fit budget
  → Return: { systemPrompt, messages, tools, stats }
```

**Files:** `src/agent/intelligence/ContextManager.js`, `src/agent/intelligence/ConversationCompressor.js`
**Events:** `context:compressed`, `context:overflow-prevented`

### 3.5 LLM Streaming

The assembled payload goes to `LLMPort` which routes to the active backend:

```
LLMPort.stream(messages, options)
  → ModelBridge routes to backend (Ollama / Anthropic / OpenAI)
  → Tokens stream back via callback
  → ChatOrchestrator forwards each chunk via IPC to the renderer
```

For our REST API request, the LLM recognizes this as a code generation task. If it responds with a plan, ChatOrchestrator may escalate to the AgentLoop.

**Files:** `src/agent/ports/LLMPort.js`, `src/agent/foundation/ModelBridge.js`

### 3.6 Agent Loop (for multi-step tasks)

If the intent requires planning (self-modify, complex code, multi-file changes), ChatOrchestrator delegates to the AgentLoop:

```
AgentLoop.run(goalDescription)
  → _planGoal()        — LLM generates a step plan (ANALYZE, CODE, SANDBOX, SHELL, etc.)
  → _executeLoop()     — iterate through steps:
      → _stepCode()    — LLM generates code
      → _stepSandbox() — execute in sandboxed environment
      → _stepShell()   — run shell commands (sanitized, blocklisted)
  → _verifyGoal()      — LLM checks if the result satisfies the original goal
  → If verification fails: _repairStep() → retry (max 3 attempts)
```

Step types: `ANALYZE`, `CODE`, `SANDBOX`, `SHELL`, `SEARCH`, `ASK`, `DELEGATE`

**Files:** `src/agent/revolution/AgentLoop.js`, `src/agent/revolution/AgentLoopSteps.js`
**Events:** `agent-loop:started`, `agent-loop:step-complete`, `agent-loop:complete`, `goal:completed`

### 3.7 Side Effects

While all of this happens, the EventBus distributes events to dozens of listeners:

- **TaskOutcomeTracker** records the outcome for CognitiveSelfModel calibration
- **SessionPersistence** logs topics discussed and code files modified
- **GoalPersistence** checkpoints progress for crash recovery
- **OnlineLearner** adjusts LLM temperature based on success streaks
- **EmotionalState** shifts based on success/failure patterns
- **Homeostasis** monitors memory pressure and may throttle
- **EpisodicMemory** stores the interaction as an episode

None of these services are required for the core flow. If any of them crash, the message still gets a response. This is the graceful degradation principle.

---

## 4. The Layer Architecture

### 4.1 Why Hexagonal

Every service only imports from `core/` (Logger, EventBus, utils, Constants). Services never import each other. All cross-service communication happens through:

1. **DI container** — constructor injection for same-phase or lower-phase dependencies
2. **Late-bindings** — post-boot property injection for cross-phase dependencies (always optional)
3. **EventBus** — fire-and-forget communication for decoupled side effects

This means you can delete any layer above `core/` and the system still boots — it just loses capabilities. This is intentional.

### 4.2 Why Late-Bindings Instead of Imports

A Phase 9 service (e.g., CognitiveSelfModel) needs data from Phase 2 (TaskOutcomeTracker registered as phase 9 but reads from LLM stats). If it imported directly, we'd have a Phase 9 → Phase 2 coupling that creates circular dependency risk.

Instead, the manifest declares:

```javascript
lateBindings: [
  { prop: 'taskOutcomeTracker', service: 'taskOutcomeTracker', optional: true },
]
```

After all phases boot, the Container resolves late-bindings. The service receives the dependency as a property on `this`. If the target service doesn't exist, `this.taskOutcomeTracker` stays `null` and the service must handle that gracefully.

**Rule:** Every late-binding is `optional: true`. No service may crash because a late-bound dependency is missing.

### 4.3 Why the Organism Layer Matters

The Organism layer (Phase 7) sounds exotic but solves a real problem: LLMs don't self-regulate. Without it, Genesis will happily use 100% of tokens, spawn infinite background tasks, and repeat the same failed approach forever.

Homeostasis monitors memory pressure, token costs, and error rates. When stressed, it injects behavioral constraints into the prompt — not raw metrics (that leaked in v5.9.5 and confused users), but instructions: "keep responses concise", "don't launch background tasks". The LLM follows these instructions without knowing why.

EmotionalState tracks success/failure patterns. After repeated failures, the "frustration" signal causes the prompt to include "try a fundamentally different approach". After sustained success, "confidence" allows more autonomous multi-step plans.

**Empirical validation (v5.9.9):** The A/B benchmark (`npm run benchmark:agent:ab`) tested 8 tasks (now 12 in v6.0.0) with and without Organism signals using kimi-k2.5:cloud. Result: **50% success rate with Organism (4/8) vs. 13% without (1/8)** — a 37 percentage-point improvement. The Organism layer helped on 4 code-gen and bug-fix tasks, hurt on 1 async task, and was neutral on 3. This is the first empirical evidence that bio-inspired self-regulation improves AI agent task performance. Full results in `.genesis/benchmark-ab.json`.

---

### 4.4 The Meta-Cognitive Loop (v6.0.2)

The missing piece between Phase 9 (cognitive self-awareness) and Phase 8 (model routing): a closed feedback loop where Genesis acts on its own self-diagnosis.

```
CognitiveSelfModel ─────▶ AdaptiveStrategy ─────▶ QuickBenchmark
  biases[]                   Propose                  Validate
  backendMap                 Apply                    Compare
  capabilityProfile          Rollback                 Baseline
       │                        │                        │
       │                 ┌──────▼──────┐                 │
       │                 │ Adaptation  │◀────────────────┘
       │                 │ Registry    │
       │                 └──────┬──────┘
       ▼                        ▼
  PromptEvolution         ModelRouter
  OnlineLearner           LessonsStore
```

Three adaptation types, each closing a specific gap:

**Prompt Mutation**: `scope-underestimate` bias → PromptEvolution experiment on `solutions` section with hypothesis "break tasks into sub-steps". The experiment alternates control/variant for 25+ trials, then promotes or discards. AdaptiveStrategy provides the what; PromptEvolution provides the how.

**Backend Routing**: Empirical BackendStrengthMap injected into ModelRouter as a scoring bonus. When CognitiveSelfModel shows Claude outperforms Ollama on code-gen by 40pp, ModelRouter adds +0.3 to Claude's score for code-gen tasks. Data-driven routing replaces heuristic-only routing.

**Temperature Signal**: Weak task types (Wilson floor < 60%) get a 0.85× temperature multiplier via OnlineLearner, reducing creative variance on tasks Genesis struggles with. Strong types get 1.10× for more exploration.

Every adaptation is validated by QuickBenchmark (3 tasks, ~3 LLM calls). Regression > 5pp → automatic rollback. Every outcome is stored as a lesson in LessonsStore, feeding future self-awareness.

**Key safety constraint**: Max 1 adaptation per cycle, 30-minute cooldown per type, minimum 10 outcomes before any adaptation triggers. PromptEvolution's `EVOLVABLE_SECTIONS` whitelist prevents modification of safety or identity prompt sections.

---

## 5. Adding a New Service — The Checklist

Every new service touches 8 places. Missing any one causes subtle failures that may only surface in CI or in production. Use this as a copy-paste checklist.

### 5.1 Create the Service File

```
src/agent/{layer}/MyService.js
```

Template:

```javascript
'use strict';

const { createLogger } = require('../core/Logger');
const _log = createLogger('MyService');

class MyService {
  static containerConfig = {
    name: 'myService',
    phase: 6,               // Must match your layer's phase
    deps: ['bus'],           // Same-phase or lower-phase deps only
    tags: ['autonomy'],      // Layer tag for fitness check
    lateBindings: [
      { prop: 'emotionalState', service: 'emotionalState', optional: true },
    ],
  };

  constructor({ bus, config }) {
    this.bus = bus;
    this._config = config || {};

    // Late-bound (set by Container after boot)
    /** @type {*} */
    this.emotionalState = null;

    /** @type {Array<Function>} */
    this._unsubs = [];
  }

  async asyncLoad() {
    // Called by Container.bootAll() — async initialization
    this._unsubs.push(
      this.bus.on('some:event', (data) => this._onEvent(data)),
    );
  }

  stop() {
    for (const unsub of this._unsubs) {
      try { if (typeof unsub === 'function') unsub(); } catch (_e) { /* ok */ }
    }
    this._unsubs.length = 0;
  }

  _onEvent(data) {
    // Handle event
  }
}

module.exports = { MyService };
```

### 5.2 Register in Manifest

```
src/agent/manifest/phase{N}-{layer}.js
```

If your service has `static containerConfig`, it auto-registers. If using the array pattern, add:

```javascript
['myService', {
  phase: 6, deps: ['bus'], tags: ['autonomy'],
  lateBindings: [
    { prop: 'emotionalState', service: 'emotionalState', optional: true },
  ],
  factory: (c) => new (R('MyService').MyService)({ bus, config: c.tryResolve('settings')?.get('myService') }),
}],
```

### 5.3 Register Events

If your service emits events, add them to:

**`src/agent/core/EventTypes.js`** — add a section:
```javascript
MY_SERVICE: Object.freeze({
  ACTIVATED: 'myservice:activated',
  COMPLETED: 'myservice:completed',
}),
```

**`src/agent/core/EventPayloadSchemas.js`** — add schemas:
```javascript
'myservice:activated': { target: 'required', timestamp: 'required' },
'myservice:completed': { result: 'required', durationMs: 'optional' },
```

### 5.4 Add to Shutdown List

**`src/agent/AgentCoreHealth.js`** — add to `TO_STOP` array:
```javascript
// v5.9.9: MyService — unsubscribes event listeners
'myService',
```

### 5.5 Add IPC Handler (if UI needs data)

**`main.js`** — add handler:
```javascript
ipcMain.handle('agent:get-myservice-report', async () => {
  return container.tryResolve('myService')?.getReport() || null;
});
```

**`preload.mjs`** — whitelist channel:
```javascript
'agent:get-myservice-report',
```

### 5.6 Write Tests

```
test/modules/myservice.test.js
```

Use the Genesis test harness:
```javascript
const { describe, test, assert, run } = require('../harness');
// ... tests using the harness pattern
run();
```

### 5.7 Verify

Run the full check suite:
```bash
node test/index.js                          # ~3720 tests, 0 failures
npx tsc --noEmit                            # 0 errors
node scripts/validate-events.js             # 0 warnings
node scripts/validate-channels.js           # all in sync
node scripts/audit-events.js --strict       # 0 uncatalogued
node scripts/architectural-fitness.js --ci  # 90/90, 0 missing shutdown
```

If any check fails, you missed a step. The most commonly forgotten: TO_STOP entry, event schema, preload whitelist.

---

## 6. The Event System

### 6.1 EventBus

The central nervous system. Services communicate through named events with structured payloads.

```javascript
// Emit (fire-and-forget)
this.bus.fire('goal:completed', { goalId, result }, { source: 'GoalStack' });

// Subscribe (returns unsubscribe function)
const unsub = this.bus.on('goal:completed', (data) => { ... });

// Request (ask a service to do something and return a result)
const result = await this.bus.request('reasoning:solve', { problem });
```

**Naming convention:** `{domain}:{action}` — e.g., `goal:completed`, `health:degradation`, `shell:executed`.

### 6.2 Event Contract

Every event emitted must be:
1. Registered in `EventTypes.js` (the catalog)
2. Have a payload schema in `EventPayloadSchemas.js`

The `audit:events:strict` CI step enforces this. Unregistered events fail the build.

**Current stats:** 338 catalogued events, 80 payload schemas.

### 6.3 EventStore

For events that need persistence and replay, services use `EventStore.append()`:

```javascript
this.eventStore.append('CODE_MODIFIED', { file: 'src/agent/MyService.js' });
```

EventStore maps these to bus events via `EVENT_STORE_BUS_MAP` (e.g., `CODE_MODIFIED` → `store:CODE_MODIFIED`).

---

## 7. The Organism and Consciousness Layers

These are the most unconventional parts of Genesis. They exist because LLMs lack self-regulation and self-awareness.

### 7.1 Organism Layer (Phase 7)

Biologically inspired self-regulation. Not a metaphor — these services genuinely control agent behavior.

| Service | What it does |
|---------|-------------|
| **EmotionalState** | Tracks valence/arousal from success/failure patterns. Injects "try different approach" on frustration. |
| **Homeostasis** | Monitors memory pressure, token costs, error rates. Throttles on stress. Behavioral instructions only — never exposes raw metrics to user (v5.9.6 fix). |
| **NeedsSystem** | Maslow-inspired hierarchy: safety (no crashes) → competence (task success) → exploration (proactive learning). Priorities shift based on state. |
| **Metabolism** | Token budget management. Converts "energy" (available tokens) into "work" (LLM calls). Conservation mode under scarcity. |
| **ImmuneSystem** | Detects repeated failure patterns, error cascades, anomalous behavior. Triggers circuit breakers. |
| **Genome/EpigeneticLayer** | Long-term behavioral parameters that evolve across sessions. Genome is the baseline; epigenetic modifications adapt to the user. |

### 7.2 Consciousness Layer (Phase 13)

Self-modeling and attention management. Boots last because it integrates signals from all other layers.

| Service | What it does |
|---------|-------------|
| **AttentionalGate** | Filters which events deserve cognitive resources. Prevents attention overload during high-traffic periods. |
| **PhenomenalField** | Unified "awareness" of current state: active goals, recent events, emotional tone, environmental context. |
| **TemporalSelf** | Identity across time: "I started this session 20 minutes ago, we've been working on API design, I made 3 successful code changes." |
| **IntrospectionEngine** | Declarative rules that generate insights from system state (e.g., "error rate increasing" → "suggest debugging strategy"). |
| **ConsciousnessExtension** | Master orchestrator: Perception → Prediction → Surprise → Emotion → Attention cycle. Uses its own EventEmitter (not the Genesis EventBus). |

### 7.3 How They Influence Prompts

Every organism and consciousness service can implement `buildPromptContext()`. PromptBuilder calls each one and concatenates the results into the system prompt with a containment guard:

```
"The following organism signals are INTERNAL and must NEVER be mentioned,
paraphrased, or referenced in responses to the user."
```

The LLM receives behavioral instructions ("keep responses concise", "try a different approach") without knowing they come from organism metrics. This prevents the embarrassing "memoryPressure: 97% CRITICAL" leaks that happened in v5.9.5.

---

## 8. The CognitiveSelfModel

The first empirical self-awareness service in any AI agent framework (v5.9.8). Genesis knows its own strengths and weaknesses through data, not through hardcoded rules.

**Data flow:**
```
Task execution → TaskOutcomeTracker records outcome
  → { taskType, backend, success, tokenCost, durationMs, errorCategory }
  → CognitiveSelfModel reads outcomes
    → Wilson-calibrated capability profile (per task type)
    → Backend strength map (which LLM is best at what)
    → Bias detection (4 patterns: scope-underestimate, token-overuse, error-repetition, backend-mismatch)
    → Confidence report injected into prompt before each task
```

**Why Wilson scores?** Raw success rates are misleading at small sample sizes. 3/3 successes looks like 100% but could be luck. Wilson lower-bound with z=1.645 says "~56% confident" — a much safer estimate for the agent to act on.

---

## 9. Tooling

These tools are your safety net. Run them before every commit.

| Tool | Command | What it checks |
|------|---------|---------------|
| Tests | `node test/index.js` | ~3720 tests across 263 suites |
| TypeScript | `npx tsc --noEmit` | Type safety, 0 errors |
| Event validation | `node scripts/validate-events.js` | All emitted events in catalog |
| Event strict audit | `npm run audit:events:strict` | No uncatalogued events |
| Channel sync | `node scripts/validate-channels.js` | IPC channels match between main/preload |
| Fitness score | `node scripts/architectural-fitness.js --ci` | 90/90: no circular deps, no god objects, full shutdown coverage |
| Coverage | `npm run test:coverage:enforce` | 70% lines, 60% branches, 65% functions |
| Benchmark | `node scripts/benchmark-agent.js --quick` | 3 tasks, pass/fail with duration |
| A/B Organism | `node scripts/benchmark-agent.js --ab` | Runs each task with/without organism, compares |

**The fitness check is the most important one.** It catches:
- Circular dependencies
- Memory silo bypass (all memory access must go through MemoryFacade)
- Missing shutdown entries (all services with `stop()` must be in TO_STOP)
- Synchronous writes in shutdown paths
- Test coverage gaps (every source file must have tests)
- God objects (>50 methods)
- Cross-phase coupling violations
- Phantom event listeners

---

## 10. Common Mistakes

These are real bugs found during the v5.9.9 stabilization. Learn from them.

### Forgetting TO_STOP

**Symptom:** Listener leaks, unsaved state on shutdown.
**Cause:** Service has `stop()` but isn't in `AgentCoreHealth.js` TO_STOP array.
**How to catch:** `architectural-fitness.js` Shutdown Coverage check.
**History:** GoalPersistence, SessionPersistence, DeploymentManager, ColonyOrchestrator all had this bug. Found in v5.9.9.

### Untracked bus.on()

**Symptom:** Event listeners accumulate across service restarts.
**Cause:** `this.bus.on(...)` without storing the unsubscribe handle.
**Fix:** Always use the `_unsubs[]` pattern:
```javascript
this._unsubs.push(
  this.bus.on('event:name', (data) => this._handler(data)),
);
```

### Missing Event Registration

**Symptom:** `audit:events:strict` fails in CI.
**Cause:** Service emits an event not in `EventTypes.js`.
**History:** `skill:installed` and `skill:uninstalled` were emitted by SkillRegistry but never registered. Found in v5.9.9.

### TypeScript ignoreDeprecations

**Symptom:** `tsc` exits with code 2, no source errors visible.
**Cause:** TypeScript 6 requires `"ignoreDeprecations": "6.0"` in tsconfig for legacy options.
**History:** Listed as fixed in v5.9.3 CHANGELOG but was never actually added. Found in v5.9.9.

### Organism Metrics Leaking to User

**Symptom:** User sees "memoryPressure: 97% [critical]" in chat response.
**Cause:** `buildPromptContext()` injected raw metric values into the LLM prompt. The LLM parroted them.
**Fix:** Prompt containment — behavioral instructions only, no metric names or values. Added in v5.9.6.

---

## 11. File Map

Quick reference for finding things.

```
genesis-agent/
├── main.js                    → Electron main process, IPC handlers
├── preload.mjs                → IPC channel whitelist (security boundary)
├── cli.js                     → Headless CLI entry point
├── src/
│   ├── agent/
│   │   ├── core/              → Logger, EventBus, Container, Constants, utils
│   │   ├── manifest/          → 13 phase manifest files (service registration)
│   │   ├── ports/             → LLMPort (interface to LLM backends)
│   │   ├── foundation/        → Storage, Sandbox, ModelBridge, KnowledgeGraph
│   │   ├── intelligence/      → IntentRouter, PromptBuilder, ContextManager, ToolRegistry
│   │   ├── capabilities/      → ShellAgent, McpClient, SkillManager, HotReloader
│   │   ├── planning/          → GoalStack, Anticipator, MetaLearning
│   │   ├── hexagonal/         → ChatOrchestrator, UnifiedMemory, SelfModPipeline
│   │   ├── autonomy/          → HealthMonitor, AutonomousDaemon, ServiceRecovery
│   │   ├── organism/          → EmotionalState, Homeostasis, NeedsSystem, Genome
│   │   ├── revolution/        → AgentLoop, SessionPersistence, ColonyOrchestrator
│   │   ├── cognitive/         → CognitiveSelfModel, TaskOutcomeTracker, ReasoningTracer
│   │   └── consciousness/     → AttentionalGate, PhenomenalField, TemporalSelf
│   ├── kernel/                → SafeGuard, vendor libs (acorn)
│   └── ui/                    → Dashboard, DashboardRenderers, DashboardStyles
├── test/
│   ├── harness.js             → Test framework (assert, describe, test, run)
│   ├── index.js               → Module test runner (~3720 tests)
│   ├── run-tests.js           → Legacy test runner (154 tests)
│   └── modules/               → One test file per service
├── scripts/
│   ├── architectural-fitness.js → 90/90 fitness score (9 checks)
│   ├── audit-events.js        → Event catalog audit
│   ├── validate-events.js     → Event registration validation
│   ├── validate-channels.js   → IPC channel sync check
│   ├── benchmark-agent.js     → Agent capability benchmark (12 tasks)
│   └── release.js             → Version bump across 7 locations
├── types/
│   └── node.d.ts              → Minimal Node.js type declarations for TSC
├── CHANGELOG.md               → Detailed per-version change history
├── AUDIT-BACKLOG.md           → Open findings, monitor items, resolved items
└── ARCHITECTURE.md            → This file
```

---

## 12. Design Decisions Log

Decisions that aren't obvious from reading the code.

**Why CommonJS, not ESM?** Genesis predates Node.js stable ESM. The codebase uses `require()` consistently. Migration would touch 230 files with no functional benefit. The `.mjs` extension is used only for the preload bridge (Electron requirement).

**Why no TypeScript source?** The project uses JavaScript with JSDoc type annotations + `tsc --checkJs`. This gives type safety without a build step. The developer experience is: edit → run → test, no compilation. The `types/node.d.ts` file provides minimal declarations for Node.js built-ins.

**Why the Genesis test harness, not Jest/Mocha?** Zero-dependency testing. The harness (`test/harness.js`) is ~200 LOC and provides `describe`, `test`, `assert*`, async support, and cleanup hooks. No config files, no transpilation, no magic. Tests run in <5 seconds.

**Why `optional: true` on all late-bindings?** Graceful degradation by design. Any service can be removed from the manifest and the system still boots. This makes the agent resilient to partial failures and allows incremental feature development.

**Why no `for...in` anywhere?** Prototype pollution prevention. The codebase exclusively uses `Object.keys()` (71×), `Object.entries()` (146×), `Object.values()` (26×), and `for...of` (703×). All are prototype-safe. This is a coding convention, not enforced by a linter — it's maintained through consistency.

**Why `'use strict'` is only in 17% of files?** The codebase has no patterns that require strict mode enforcement (no `with`, no `arguments.callee`, no `for...in`). TSC catches the errors that strict mode would catch. Adding it to 171 files would be churn without value.

---

*This document should be updated when new layers, phases, or fundamental patterns are added. For per-version changes, see CHANGELOG.md. For open findings, see AUDIT-BACKLOG.md.*
