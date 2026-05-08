# Genesis Agent — Architecture Deep-Dive

> Comprehensive technical analysis of Genesis Agent. Some sections may reference earlier version numbers where the underlying architecture is unchanged.
> Last updated for v7.7.2: 12 boot phases, 168 services (155 manifest + 13 bootstrap), 338 source files, 6907 tests (Win baseline), 250+ capabilities, 21 hash-locked files (drift-checked by `audit-hash-lock-coverage.js` since v7.6.2; widened in v7.6.4 to cover PluginRegistry, SkillManager, PeerNetworkExchange — the three 2-of-3-gate files that act as the only defense against unscanned third-party code from plugins, skills, and peer exchange), 11 PreservationInvariants rules, five active runtime gates (Injection blocking, Self-Gate telemetry-only, Tool-Call-Verification detective, Slash-Discipline preventive, Reasoning-Block Filter strip-and-emit) plus 15 CI audit gates (full inventory in GATE-INVENTORY.md), synchronous source-read with per-turn budget, `failFastMs` semantics on CircuitBreaker (v7.4.3 — LLM circuit opted out, MCP circuit keeps 15s fail-fast), Model-Availability TTL marker with persistence (v7.5.6 — auth/rate-limit/timeout-aware lockout), Activity-claim confabulation detection on SelfStatementLog (v7.5.7 — present-progressive activity-claims cross-checked against goalStack snapshot), CostStream failover-counter (v7.6.3 — `model:failover-unavailable` events tracked separately from cost rows). CI ratchet locked at the v7.6.0 baseline (6014 floor, fitness 124 floor). 12 contract prefixes guard core safety boundaries (gate, injection-gate, preservation, self-gate, sandbox, shell-safety, self-statement, code-safety, capability, mcp-security, plugin, selfmod) — verified by `audit-contracts --strict` since v7.6.4.

---

## 1. System Overview

Genesis Agent is a **self-modifying, self-verifying, cognitive AI agent** built as an Electron desktop application with multi-backend LLM support (Anthropic Claude, OpenAI-compatible, local via Ollama). The codebase comprises **338 JS source modules** across **~106,000 LOC** of production code, supported by **406 test files / 6907 tests** (Win baseline, v7.7.2) with coverage gates enforced in CI. It is the first AI agent framework with **closed-loop self-improvement** (CognitiveSelfModel → AdaptiveStrategy, v6.0.2), **proportional intelligence** (CognitiveBudget → ExecutionProvenance → AdaptivePromptStrategy, v6.0.4), **automatic offline failover** (NetworkSentinel, v6.0.5), and **same-backend failover with TTL-marked unavailability** (v7.5.6 — recovers from sticky model errors like 403/429/timeout without per-tick retry storms).

### Key Numbers

| Metric | Value |
|--------|-------|
| Production LOC (src/) | ~101,500 |
| Source Modules | 338 JS files |
| Test Files / Tests | 406 / 6907 (Win baseline) |
| DI Services | 168 (155 manifest + 13 bootstrap) |
| Boot Phases | 12 |
| Boot Time (Windows, cold) | ~1.3 s |
| npm Dependencies | 3 production + 1 optional + 9 dev |
| Event Types (catalogued) | 453 |
| Event Schemas | 453 |
| IPC Channels | 68 main ↔ 68 preload |
| LLM Backends | 3 (Ollama, Anthropic, OpenAI-compatible) |
| Coverage Gates | 80% lines, 76% branches, 78% functions |
| Live Coverage | 83.78% lines · 77.37% branches · 80.49% functions |
| Fitness Score | 130/130 (100%) |
| Circular Dependencies | 0 |
| Cross-Layer Violations | 0 |
| @ts-nocheck Files | 0 |

### Dependency Profile

Remarkably minimal — no frameworks, no bundlers in production:

| Package | Purpose |
|---------|---------|
| electron | Desktop shell |
| acorn | AST parsing for CodeSafetyScanner |
| chokidar | File watching for HotReloader |
| monaco-editor | Code editor in UI |
| tree-kill | Process tree cleanup |
| c8 (dev) | Coverage |
| electron-builder (dev) | Packaging |

---

## 2. Boot Sequence

The boot process is organized into 4 distinct phases within `AgentCore.boot()`:

```
Phase 1: Bootstrap
  └── Register non-manifest instances: rootDir, guard, bus, storage, lang, logger

Phase 2: Manifest
  └── Register all 155 services from 12 phase files via ContainerManifest (+13 bootstrap = 168 runtime, cognitive default profile)
      └── Auto-discovery scans src/agent/ → builds filename→directory map

Phase 3: Resolve & Init
  └── Phase-aware topological sort (primary: phase, secondary: deps)
  └── For each service: resolve → asyncLoad() → boot()
  └── Service-specific wiring that needs multiple services

Phase 4: Wire & Start
  └── Container.wireLateBindings() — cross-phase property injection
  └── Container.verifyLateBindings() — null-check verification
  └── Container.postBoot() → start() on services with timers/watchers
  └── Register tool handlers, start autonomous systems
```

### Phase-Aware Topological Sort (v4.0.0+)

The `Container._topologicalSort()` sorts primarily by boot phase (ascending), secondarily by dependency edges within each phase. In v4.0.0, non-optional late-bindings are also traversed as dependency edges, ensuring they resolve before `wireLateBindings()` runs.

---

## 3. Dependency Injection

The `Container` is a custom lightweight DI container with:

- **Singleton default** — all services are singletons (overridable per-registration)
- **Circular dependency detection** — runtime check via resolving Set
- **Late-bindings** — declarative cross-phase property injection:
  ```javascript
  lateBindings: [
    { prop: 'emotionalState', service: 'emotionalState', optional: true },
  ]
  ```
- **Phase enforcement** — dev-mode warning when deps reference higher-phase services
- **Hot-reload support** — `replace()` with EventBus listener cleanup via `bus.removeBySource()`
- **Verification** — `verifyLateBindings()` checks that resolved values are actually non-null

### ContainerManifest Auto-Discovery

At boot, `ContainerManifest.js` scans `src/agent/` subdirectories and builds a filename→directory map. Phase files reference modules via `R('ModuleName')` — no manual path management. New modules only need to exist in the right directory and have an entry in the correct phase file.

---

## 4. Security Architecture

### 4.1 Three-Pillar Model

```
┌──────────────────────────────────────────────────────────────┐
│  PILLAR 1: Kernel Immutability                                │
│  main.js, preload.js, src/kernel/ — SHA-256 hashed at boot   │
│  All write attempts blocked. Periodic integrity verification. │
├──────────────────────────────────────────────────────────────┤
│  PILLAR 2: Critical File Hash-Lock (v3.5.4)                  │
│  CodeSafetyScanner, VerificationEngine, Constants,            │
│  EventBus, Container — SHA-256 locked via lockCritical()     │
│  Agent cannot weaken its own safety checks.                   │
├──────────────────────────────────────────────────────────────┤
│  PILLAR 3: IPC Rate Limiter (Kernel-space)                   │
│  Token bucket per channel. Lives in main.js (immutable).     │
│  agent:chat: 10 burst, 2/sec — agent:clone: 2 burst, 0.1/s │
│  Read-only getters: unlimited.                                │
└──────────────────────────────────────────────────────────────┘
```

### 4.2 Code Safety Scanner

Two-pass AST-based analysis using `acorn`:

- **Pass 1 (AST walk):** `eval()`, `new Function()`, indirect eval, `process.exit()`, `vm.run*()`, kernel imports, dangerous fs operations, child_process access
- **Pass 2 (Regex fallback):** Template literals, dynamic requires, comment-hidden patterns

If `acorn` is not installed, self-modification is **completely blocked** (not degraded to regex-only). This is intentional — regex-only was identified as bypassable in v3.5.0.

### 4.3 Self-Modification Pipeline

The only code-change interface: `SelfModificationPipeline.js`

```
PLAN → SAFETY SCAN → TEST (sandbox) → GIT SNAPSHOT → APPLY → VERIFY → SIGN → RELOAD
```

- CodeSafetyScanner checks *before* disk write
- ModuleSigner (v4.0.0) signs *after* write with HMAC-SHA256
- VerificationEngine checks *after* reload
- Git snapshot enables rollback

### 4.4 Module Signing

`ModuleSigner` uses HMAC-SHA256 with a per-session secret derived from kernel SafeGuard hashes at boot. The secret is NOT stored on disk. If the kernel changes, all signatures invalidate — this is intentional.

### 4.5 Sandbox

Dual-mode isolation (v4.0.0):

- **Process mode** (default for self-mod): Child process with minimal env, `--max-old-space-size` limit, restricted fs, no API keys
- **VM mode** (quick evals): `vm.createContext` with frozen globals, blocked `eval`/`Function`/`process`/`require`, capped log buffer, timer cleanup

**Note:** VM mode is explicitly NOT a true sandbox for untrusted code. It's documented as such in the codebase.

### 4.6 Reasoning-Block Filter (v7.5.6)

Reasoning models (DeepSeek-R1, R1-distill, QwQ, nemotron-3-nano) emit `<think>...</think>` blocks before their answer. Without filtering these would surface as duplicate output to the user — and worse, `parseToolCalls()` would scan them and execute phantom tool calls the model only "thought about". A `<tool_call>` containing `rm -rf /` inside `<think>` would have actually run.

Implementation in `src/agent/core/thinking-block-stream-filter.js`:

- `createThinkingBlockStreamFilter()` — stateful streaming filter (`push(chunk)` / `flush()` / `getReasoning()`); handles tag-splitting across chunk boundaries (e.g. `<thi` then `nk>` arriving in separate chunks)
- `stripThinkingBlocks(text)` — pure function for non-streaming responses

Integrated in three ChatOrchestrator paths:

- `handleStream()` — thinking-filter runs BEFORE tool-call-filter in the chunk pipeline; the variable name change `fullResponse → cleanResponse` in v7.5.6 reflects this
- `_directChat()` — `stripThinkingBlocks()` after each `model.chat()` call (initial + per tool-round); reasoning collected and fired as one aggregated event
- `_processToolLoop()` synthesis — `stripThinkingBlocks()` on synthesis output

Hardcoded tags: `<think>` and `<thinking>`, case-insensitive. Filtered reasoning is preserved and re-emitted as `model:thinking-trace { text, modelName }`, consumed by `ReasoningTracer` as a `model-reasoning` trace type — no observability is lost.

This is structurally a fifth security gate (after Injection blocking, Self-Gate telemetry, Tool-Call-Verification, Slash-Discipline): it strips a category of LLM output that would otherwise bypass tool-call audit on its way to execution.

### 4.7 Model-Availability TTL Marker (v7.5.6)

When a model fails with sticky errors — `auth` (401/403), `rate-limit` (429), or `timeout` — `ModelBridge.chat()` and `streamChat()` mark it unavailable for a TTL (1h / 5min / 10min respectively). `connection-error` and `other` reasons do NOT mark, since those are usually transient (ollama not yet warmed up, brief network blip).

API on `ModelBridge`:

| Method | Behavior |
|--------|----------|
| `markUnavailable(name, ttlMs, reason)` | Sets entry, fires `model:marked-unavailable` |
| `isMarkedUnavailable(name)` | Lazy-clears expired entries with `model:unavailable-cleared { automatic: true }` |
| `clearUnavailable(name?)` | Manual clear (`automatic: false`); no-arg clears all |

Persistence in `.genesis/model-unavailable.json` via `atomicWriteFileSync` (crash-safe rename) and `safeJsonParse` (corrupt-JSON-resilient). `_loadUnavailable()` prunes expired entries on boot.

`detectAvailable()` boot-time selection skips marked models at all four priority stages (preferred → cloud → best-available → first-available), with the last priority falling back to a marked model only as last resort if nothing else exists.

User control: `/model-reset [modelName]` slash-command for manual recovery.

The implementation is split across `ModelBridge.js` and a `ModelBridgeAvailability.js` mixin (extracted to keep the parent file under the 900-LOC architectural-fitness limit; same pattern as `CommandHandlers` mixin composition).

### 4.8 Same-Backend Failover (v7.5.6)

Pre-v7.5.6 `_findFallbackBackend()` rejected any chain entry whose backend matched the failed backend (`model.backend !== failedBackend`), which made `models.fallbackChain` useless when all configured fallbacks lived on the same backend (typical Ollama-only setup). The signature is now:

```js
_findFallbackBackend(failedBackend, failedModelName = null)
```

It skips only the specific failed model name plus any model marked unavailable. Cross-backend escape (ollama → anthropic → openai) is preserved as last resort.

`_handleFailoverError(err, ctx)` (private helper, v7.5.6) unifies the failover-error handling between `chat()` and `streamChat()`: classify → mark-if-sticky → record failure to MetaLearning → look up fallback → dispatch retry → record success (or emit `failover-unavailable` and rethrow on null fallback). This also closed a pre-existing gap: `_recordMetaOutcome` previously hardcoded `this.activeModel`, so during failover the dead model was logged with `success: true` and the actual fallback model got no record. The helper passes `calledModel` for the failure path and the captured `_fallbackModel.name` for the post-failover success path. `streamChat()` now records to MetaLearning at all — pre-v7.5.6 streaming-failure rates were invisible to the learner.

---

## 5. The 12-Phase Service Architecture

### Phase 1: Foundation (41 files, ~11,300 LOC)

Core infrastructure: Settings, ModelBridge (split via `ModelBridgeAvailability` mixin in v7.5.6 to manage TTL-marked unavailability), Sandbox, ConversationMemory, KnowledgeGraph, GraphStore, EventStore, WorldState, EmbeddingService, ModuleSigner, SelfModel (split into 4 files via Prototype-Delegation in v7.4.1), PromptEngine, StorageService, LLMCache, WebFetcher, ASTDiff, CapabilityGuard, UncertaintyGuard, DesktopPerception, TrustLevelSystem, LinuxSandboxHelper (`isAvailable()` contract tightened in v7.5.6 — only returns `true` when at least one wrappable namespace is available), BootTelemetry, BootRecovery, AwarenessPort + NullAwareness, GenesisBackup (v7.2.3), and 4 LLM backends (Ollama, Anthropic, OpenAI, Mock).

**ModelBridge** (~590 LOC) — Multi-backend LLM abstraction (Ollama, OpenAI-compatible, Anthropic) with:
- Priority-based semaphore (chat=10, agentLoop=5, idleMind=1)
- Starvation timeout (5 min)
- Response cache (skip non-deterministic tasks)
- Per-task temperature profiles

### Phase 2: Intelligence (28 files, ~10,100 LOC)

Decision-making: IntentRouter (split via IntentPatterns data extract in v7.4.3), ToolRegistry, WorkerPool, PromptBuilder + PromptBuilderSections + PromptBuilderRuntimeState, ContextManager, DynamicContextBudget, CircuitBreaker (`failFastMs` semantics in v7.4.3), CodeAnalyzer, CodeSafetyScanner, ReasoningEngine, VerificationEngine, GenericWorker, FailureTaxonomy, LocalClassifier, GraphReasoner, UserModel.

**VerificationEngine** (~680 LOC) — Programmatic truth: AST parsing, exit codes, file validation, import resolution. Returns PASS/FAIL/AMBIGUOUS. Only AMBIGUOUS falls back to LLM.

**CodeSafetyScanner** (~490 LOC) — Two-pass AST + regex analysis. Hash-locked (immutable to self-modification).

**IntentRouter** (~450 LOC after v7.4.3 IntentPatterns extract) — 4-stage cascade (regex → fuzzy → local classifier → LLM). 13 conversational meta-state patterns route directly to runtime block (v7.4.1).

### Phase 3: Capabilities (25 files, ~7,800 LOC)

External interaction: SkillManager, Reflector, CloneFactory, FileProcessor, HotReloader, PeerNetwork, ShellAgent (with `ShellPlanner`, `ShellSafety`, `ShellOSAdapter` extracted in v7.5.4), McpClient, McpServer, McpTransport (uses `failFastMs: 15000` for real fail-fast), SnapshotManager, ToolBootstrap, SelfSpawner, WebPerception, PluginRegistry, EffectorRegistry.

**ShellAgent** (~600 LOC) — 4 permission tiers (read/write/admin/root), blocklist, rate limiter. v4.0.0: Migrated from `execSync` to async `execFile` with array args (no shell injection). v7.5.4: Plan-generation extracted to `ShellPlanner`.

### Phase 4: Planning (13 files, ~3,940 LOC)

Goal decomposition: GoalStack (auto-transitions: complete/fail/stall in v7.3.7), GoalPersistence, Anticipator, SolutionAccumulator, SelfOptimizer, MetaLearning, SchemaStore, Reflector, ValueStore.

**MetaLearning** — Tracks every LLM call's success rate by model, prompt style, and temperature. Feeds ExpectationEngine statistics. v7.5.6: now receives the actual `calledModel` (not `this.activeModel`), so failover events correctly attribute the failure to the dead model and the post-failover success to the fallback model. Streaming calls (`streamChat`) also feed MetaLearning starting v7.5.6.

**SchemaStore** (~500 LOC) — Stores abstract patterns extracted by DreamCycle. Keyword-indexed with confidence decay. Modifies expectations and guides planning.

### Phase 5: Hexagonal (23 files, ~7,300 LOC)

Orchestration layer: UnifiedMemory, EpisodicMemory (3-layer decay: Detail/Schema/Feeling, v7.3.7), AdaptiveMemory, ChatOrchestrator + ChatOrchestratorSourceRead + ChatOrchestratorHelpers, SelfModificationPipeline + SelfModificationPipelineModify (v7.4.3 split), LearningService, PeerCrypto, PeerHealth, PeerTransport, PeerNetwork, PeerConsensus, TaskDelegation, CommandHandlers + 6 domain mixins (v7.4.2 split: Code/Shell/Goals/Memory/System/Network).

**ChatOrchestrator** (~640 LOC) — Routes messages through IntentRouter → handler dispatch → tool calls → LLM synthesis. Manages conversation history with configurable limits. Synchronous source-read for CHANGELOG/package.json with per-turn + session budget (v7.3.8). Streams `<think>...</think>` blocks through `thinking-block-stream-filter` before tool-call parsing (v7.5.6) — phantom tool calls inside reasoning blocks cannot reach the executor.

**SelfModificationPipeline** (~450 LOC after v7.4.3 Modify-family extract) — Gate chain: circuit breaker → AwarenessPort coherence (currently inert with NullAwareness default, threshold 0.4) → Metabolism energy → write → verify → snapshot.

### Phase 6: Autonomy (28 files, ~6,070 LOC)

Background processes: AutonomousDaemon, IdleMind, HealthMonitor, CognitiveMonitor, ErrorAggregator, HealthServer, ServiceRecovery, DeploymentManager, NetworkSentinel, JournalWriter (v7.3.7), ActiveReferencesPort (v7.3.7), WakeUpRoutine (v7.3.7), and 16 Activities modules (Calibrate, Consolidate, Dream, Explore, Ideate, Improve, Journal, MCPExplore, PickContext, Plan, ReadSource, Reflect, Research, SelfDefine, Study, Tidy).

**IdleMind** (~570 LOC) — Activity selection: reflection, KG exploration, goal generation, tidying, journaling, dreaming (Phase 9), and LLM-as-knowledge-source (v7.2.8). Activity scoring uses NeedsSystem drive levels and emotional state.

### Phase 7: Organism (16 files, ~5,950 LOC)

Biological simulation: EmotionalState, EmotionalSteering, Homeostasis, HomeostasisEffectors, NeedsSystem, Metabolism, ImmuneSystem, BodySchema, Genome, AdaptiveStrategy, EmotionalFrontier (v7.1.5), and supporting modules.

**EmotionalState** (~640 LOC) — Five dimensions (curiosity, satisfaction, frustration, energy, loneliness), each 0.0–1.0 with baseline decay and watchdog against extremes. Reactivity balanced at ~1.3:1 success:error ratio (v3.5.3 fix for small models).

**NeedsSystem** — Four drives (knowledge, social, maintenance, rest) that grow passively and are satisfied by specific actions. Total DRIVE = weighted sum, used by IdleMind for activity selection.

**Metabolism** `v4.12.5` — Real energy accounting replaces fixed -0.02 per chat. Computes cost from token count (50%), latency (30%), and heap delta (20%). Logarithmic scaling above 2x baseline, capped at 0.15. Passive recovery during idle.

**ImmuneSystem** `v4.12.5` — Three-level self-repair: inflammation (quarantine crash-looping services), targeted repair (4 failure signatures with specific remedies), and adaptive immunity (persisted across sessions). All remedies operate on runtime state only — never modifies source code.

**HomeostasisEffectors** `v4.12.5` — Wires all homeostasis correction events to real actions: cache pruning, knowledge graph pruning, context budget pressure, and simplified-mode recommendations. Allostatic set-point adaptation shifts thresholds when vitals stay in WARNING for 10+ minutes.

### Phase 8: Revolution (17 files, ~7,240 LOC)

Autonomous execution: AgentLoop (~830 LOC + 4 delegates: Planner, Steps, Cognition, Recovery — split in v7.3.4), FormalPlanner, HTNPlanner, NativeToolUse, SessionPersistence, ModelRouter, ModuleRegistry, MultiFileRefactor, FailureAnalyzer, VectorMemory, ColonyOrchestrator, EmotionalFrontier, UnfinishedWorkFrontier, GoalSynthesizer (v7.1.7).

**AgentLoop** — The autonomous execution framework:
```
Perceive (WorldState) → Plan (FormalPlanner) → Act → Verify → Learn → Loop
```
Max 20 steps per goal (+10 after user approval), 3 consecutive error limit, 10-minute global timeout.

### Phase 9: Cognitive (35 files, ~13,200 LOC)

Expectation, surprise, learning, self-model, adaptation. The cognitive substrate that makes Genesis self-correcting and self-improving. Includes CognitiveSelfModel (empirical capability tracking with Wilson-score calibration), AdaptiveStrategy (closed-loop self-correction), OnlineLearner (real-time behavioral adaptation), PromptEvolution (A/B prompt optimization), MemoryConsolidator (KG/Lessons hygiene), TaskRecorder (execution replay), CoreMemories (v7.3.7), LessonsStore, GateStats (v7.3.6 — central gate-verdict telemetry), SuspicionFrontier, LessonFrontier, ArchitectureReflection, **SelfStatementLog (v7.5.5 + DE/EN parity in v7.5.6)** — auto-classifies first-person statements (`strukturell` / `versprechen` / `emotional` / `uncertain`), persists to daily JSONL shards, fires `selfstatement:contradiction` when a structural claim lacks verified-data backing.

Anticipation and identity: ExpectationEngine, MentalSimulator, SurpriseAccumulator, DreamCycle + DreamCyclePhases (v7.3.9 split), SelfNarrative, CognitiveHealthTracker, **ReasoningTracer** — subscribes to `model:thinking-trace` (v7.5.6) to capture reasoning-model internal monologue as `model-reasoning` traces.

**Fully optional.** All late-bindings use `optional: true`. All hooks check for null. Genesis v3.8 behavior is 100% preserved without Phase 9.

### Phase 10: Agency (6 services)

Persistent agency layer: GoalPersistence, FailureTaxonomy, DynamicContextBudget, EmotionalSteering, LocalClassifier, UserModel.

**GoalPersistence** — Unfinished goals survive reboots. Crash recovery via step checkpoints. Wired to GoalStack and AgentLoop.

**FailureTaxonomy** `v4.1` — Classifies failures into transient (retry), deterministic (replan), environmental (update world model), capability (escalate model). Each class triggers a different recovery strategy.

**DynamicContextBudget** `v4.1` — Adapts context token allocation per intent: code-gen gets 55% code tokens, chat gets 40% conversation tokens. Learns from outcomes via MetaLearning.

**EmotionalSteering** `v4.1` — Translates emotional dimensions into concrete control signals: high frustration → escalate model, low energy → shorten plans, curiosity → explore. Injects prompt modifiers into PromptBuilder.

**LocalClassifier** `v4.1` — TF-IDF intent classifier trained from LLM fallbacks. Saves 2-3s per message by avoiding LLM-based classification for common intents.

**UserModel** `v4.12.4` — Theory of Mind: tracks user expertise, preferences, communication style across sessions. Informs prompt construction and response calibration.

### Phase 11: Extended Perception & Action (4 services)

Trust and effectors: TrustLevelSystem, EffectorRegistry, WebPerception, SelfSpawner.

**TrustLevelSystem** `v4.1` — Four levels: Level 0 (supervised), Level 1 (assisted), Level 2 (autonomous), Level 3 (full autonomy). Auto-upgrade suggestions based on MetaLearning success rates.

**EffectorRegistry** `v4.1` — External action system with precondition checking. Built-in effectors: clipboard, notifications, browser, GitHub (issues, PRs, comments). Precondition failures emit `effector:blocked` events.

**SelfSpawner** `v4.1` — Fork-based parallel workers with LLM access, timeout, and memory limits. Up to 3 concurrent workers.

### Phase 12: Symbolic + Neural Hybrid (2 services)

Hybrid reasoning: GraphReasoner, AdaptiveMemory.

**GraphReasoner** `v4.1` — Deterministic graph traversal over KnowledgeGraph: impact analysis, dependency chains, cycle detection. No LLM needed — pure symbolic reasoning.

**AdaptiveMemory** `v4.1` — Intelligent forgetting: high surprise = slow decay (5×), routine = fast decay, access frequency boosts retention. Integrates with emotional state and surprise signals.

### Phase 13: Removed in v7.0.0

**Phase 13 (Consciousness Layer) was removed in v7.0.0.** The 14-module, 6198-LOC layer (AttentionalGate, PhenomenalField, TemporalSelf, IntrospectionEngine, ConsciousnessExtension + 9 internal modules) was replaced by the **AwarenessPort** interface (2 modules, 112 LOC) registered in Phase 1.

**Rationale:** A/B benchmarking showed 0pp performance impact with Phase 13 active vs. disabled. The layer added 6k LOC and 14 boot services with no measurable benefit. The AwarenessPort provides the same interface contract — `getCoherence()`, `consult(plan)`, `buildPromptContext()` — and a real implementation can be injected via DI when needed.

**Migration:** All 8 former consumers (`SelfModificationPipeline`, `PromptBuilder`, `AgentLoopCognition`, `AgentCoreHealth`, `AgentCoreWire`, `ContainerManifest`, `MemoryFacade`, `Dashboard`) now depend on `AwarenessPort` in Phase 1 via `NullAwareness` (default no-op).


## 6. Cognitive Architecture (Phase 9) — Data Flow

```
AgentLoop.pursue()
  │
  ├── FormalPlanner.plan()
  │       │
  │       ▼
  ├── MentalSimulator.simulate(plan)     ← Branching WorldState clones
  │       │                                  Probability via ExpectationEngine
  │       ▼                                  Pruning at <5%
  │   {proceed: true/false, riskScore}
  │
  ├── ExpectationEngine.expect(step)     ← Statistical (MetaLearning) or Heuristic
  │       │
  │       ▼
  ├── [Step Execution]
  │       │
  │       ▼
  ├── ExpectationEngine.compare()        ← SurpriseSignal = −log₂P
  │       │
  │       ▼
  ├── SurpriseAccumulator.accumulate()   ← Learning modulation:
  │       │                                  Low(<0.3)→1× | Med→1.5×
  │       ▼                                  High→2.5× | Novel(≥1.5)→4×
  │
  │   [Idle Time]
  │       │
  │       ▼
  ├── DreamCycle.dream()                 ← 5 phases: Replay → Pattern →
  │       │                                  Abstraction → Consolidation → Insight
  │       ▼                                  (Phases 1-4: heuristic, Phase 5: 1 LLM call)
  ├── SchemaStore.store()                ← Abstract patterns
  │
  │   [Accumulator Threshold]
  │       │
  │       ▼
  └── SelfNarrative.update()             ← ~200 tokens of metacognitive context
                                            injected into every PromptBuilder call
```

### Performance Design

- ExpectationEngine: **Zero LLM calls** (statistical or heuristic fallback)
- MentalSimulator: **Zero LLM calls** (pure data, WorldState clones)
- SurpriseAccumulator: **Zero LLM calls** (event-driven accumulation)
- DreamCycle: **One batched LLM call** per cycle (Phase 5 only, ~30-60s on gemma2:9b)
- SelfNarrative: **One LLM call** per update (event-driven threshold, not timer)

---

## 7. Memory Architecture

Five-layer memory system with unified facade. Episodic memory uses three-layer decay (Detail/Schema/Feeling, v7.3.7) instead of ring-buffer truncation.

| Layer | Module | Persistence | Search |
|-------|--------|-------------|--------|
| Conversation | ConversationMemory | JSON via StorageService | Recency |
| Episodic | EpisodicMemory + 3-layer decay | JSON + embedding index | Temporal + vector |
| Semantic | KnowledgeGraph + GraphStore | JSON graph | Keyword + vector |
| Vector | VectorMemory | Flat-file vectors | Cosine similarity |
| World | WorldState | JSON snapshot | Key-value |
| Schema | SchemaStore (Phase 9) | JSON | Keyword + confidence |
| Core | CoreMemories (v7.3.7) | JSON, bidirectional links to episodes | Anchor-keyed |
| Unified | UnifiedMemory | Read facade | Hybrid |

The EmbeddingService integration is optional. Without an embedding backend (Ollama embeddings), the system degrades to keyword search.

---

## 8. Event System

The EventBus (~600 LOC) is the nervous system of Genesis:

- **452 catalogued event types** in EventTypes.js (1316 LOC) with JSDoc payload docs
- **453 payload schemas** in EventPayloadSchemas.js (~846 LOC) — full parity since v7.6.x (every catalog entry has a registered schema; v7.6.3 dropped 4 dead entries from both files in lockstep, B1+B2 regression tests in `store-event-catalog.test.js` enforce the link)
- **Dev-mode validation** — unknown events produce warnings with stack traces
- **Wildcard prefix-map** (v3.8.0) — O(k) matching instead of O(n)
- **Ring buffer history** (v4.0.0) — O(1) push instead of O(n) push+slice
- **Listener health monitoring** — `getListenerReport()` for leak detection
- **Middleware pipeline** — transform/filter events before delivery
- **GateStats** (v7.3.6) — central recording for all `pass`/`block`/`warn` gate verdicts; sampling for hot-path gates

---

## 9. Networking

### Peer-to-Peer

`PeerNetwork` + `PeerTransport` + `PeerCrypto` + `PeerHealth` enable multi-agent communication. AES-256-GCM encryption, PBKDF2 session keys with LRU cache. `PeerConsensus` provides LWW-register state synchronization with per-domain vector clocks (settings, knowledge, schemas).

### MCP (Model Context Protocol)

`McpClient` (~580 LOC) + `McpServer` (~610 LOC) + `McpTransport` — Genesis can consume external MCP tools and expose its own tools as an MCP server. CircuitBreaker per connection, `failFastMs: 15000` (v7.4.3 — 15s breaker window opens before 30s HTTP timeout).

### Task Delegation

`TaskDelegation` allows AgentLoop to delegate steps to peer agents.

### Network Resilience (v6.0.5)

`NetworkSentinel` monitors connectivity with periodic probes (30s interval, 2 external + Ollama local). On 3 consecutive failures: declares offline, auto-failovers to best local Ollama model via `ModelBridge._selectBestModel()`, queues mutations in a ring buffer (500 entries). On reconnect: restores previous cloud model, replays queued mutations. `BodySchema.canAccessWeb` reflects real connectivity status via late-bound sampler.

---

## 10. UI Architecture

Split from a monolithic `renderer.js` (v3.8.0) into focused modules:

| Module | Responsibility |
|--------|---------------|
| `chat.js` | Message rendering, streaming, markdown |
| `editor.js` | Monaco editor integration |
| `filetree.js` | File browser |
| `settings.js` | Settings panel |
| `statusbar.js` | Status indicators |
| `i18n.js` | Localization (EN, DE, FR, ES) |
| `dashboard.js` | 13-panel system overview |

Plus a global error boundary (v4.0.0) in `renderer-main.js`.

---

## 11. LOC Distribution by Directory

Approximate as of v7.5.6 (numbers shift with each release):

```
  core/             25 files    8,064 LOC
  foundation/       41 files   11,283 LOC
  intelligence/     28 files   10,127 LOC
  capabilities/     25 files    7,790 LOC
  planning/         13 files    3,938 LOC
  hexagonal/        23 files    7,315 LOC
  autonomy/         28 files    6,074 LOC
  organism/         16 files    5,954 LOC
  revolution/       17 files    7,236 LOC
  cognitive/        35 files   13,234 LOC
  ports/            12 files    1,614 LOC
  manifest/         12 files    2,438 LOC
  ─────────────────────────────────────────────
  agent/ total     259 files  ~84,900 LOC
  + UI/kernel       47 files  ~13,800 LOC
  = src/ total     338 modules ~107,000 LOC
```
