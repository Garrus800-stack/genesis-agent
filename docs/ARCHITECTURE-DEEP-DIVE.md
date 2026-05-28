# Architecture Deep Dive

> Comprehensive technical analysis of Genesis. For current stats see [CAPABILITIES.md](CAPABILITIES.md). For version history see [CHANGELOG.md](../CHANGELOG.md).

---

## 1. System Overview

Genesis Agent is a **self-modifying, self-verifying, cognitive AI agent** built as an Electron desktop application with multi-backend LLM support (Anthropic Claude, OpenAI-compatible, local via Ollama). The codebase comprises hundreds of JS source modules with extensive test coverage (live stats in [CAPABILITIES.md](CAPABILITIES.md)) and coverage gates enforced in CI. It is the first AI agent framework with **closed-loop self-improvement** (CognitiveSelfModel → AdaptiveStrategy, v6.0.2), **proportional intelligence** (CognitiveBudget → ExecutionProvenance → AdaptivePromptStrategy, v6.0.4), **automatic offline failover** (NetworkSentinel, v6.0.5), and **same-backend failover with TTL-marked unavailability** (v7.5.6 — recovers from sticky model errors like 403/429/timeout without per-tick retry storms).

### Key Numbers

| Metric | Value |
|--------|-------|
| Production LOC (src/) | ~101,500 |
| Source Modules | 380 JS files |
| Test Files / Tests | 513 / 8105 (Win baseline) |
| DI Services | 178 (165 manifest + 13 bootstrap) |
| Boot Phases | 12 |
| Boot Time (Windows, cold) | ~1.3 s |
| npm Dependencies | 5 production + 1 optional + 10 dev |
| Event Types (catalogued) | 491 |
| Event Schemas | 491 |
| IPC Channels | 68 main ↔ 68 preload |
| LLM Backends | 3 (Ollama, Anthropic, OpenAI-compatible) |
| Coverage Gates | 80% lines, 76% branches, 78% functions |
| Live Coverage | 83.78% lines · 77.37% branches · 80.49% functions |
| Fitness Score | 126/130 (100%) |
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
  └── Register all 165 services from 12 phase files via ContainerManifest (+13 bootstrap = 178 runtime, cognitive default profile)
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

**AgentLoopProgressDetector** `v7.9.9` — Reflexion-style degenerate-loop detector (Shinn et al. 2023, arXiv 2303.11366). Two state Maps cleared on `goal:completed` / `goal:abandoned` / `goal:obsolete` / `goal:stalled`. The action-loop detector hashes `(stepKind, resultDigest)` per step into a per-goal ring buffer; three identical hashes in a row emit `agent-loop:no-progress-detected` and force a replan. The plan-loop detector hashes `(goalDesc, plan-step-types)` at pursuit start; a hash seen before for the same goal emits `agent-loop:identical-plan-detected` and forces a replan with a different LLM hint. ProgressDetector is not a registered Container service — AgentLoopPursuit lazy-instantiates it on first use; when absent, pursuit still runs but loses the early-loop-break and relies on the existing `failureCap` (2) and `_repeatedFailures` paths instead.

**AgentLoopPursuitGate three-branch dispatch** `v7.9.9` — When MentalSimulator returns `proceed: false` with `riskScore ≥ 5.0`, `handleHardGateAbort` reads `trustLevelSystem.getLevel()` and routes: SUPERVISED + AUTONOMOUS stay warn-only (`aborted: false`), letting the step route through `TrustLevelSystem.checkApproval(stepType)` which asks SUPERVISED users about everything and AUTONOMOUS users only about categorically critical action classes; FULL_AUTONOMY tries `_trySpawnObstacleSubgoal` and on refusal calls `goalStack.markObsolete`. The architectural point is decoupling: the hard-gate is a numerical signal from MentalSimulator about a plan's overall risk; the approval mechanism is categorical via TrustLevelSystem about an individual action's risk class. Pre-v7.9.9 iterations mixed them, producing a spam path where high-sim-risk goals at AUTONOMOUS dropped into approval prompts on every retry. `agent-loop:simulation-abort` telemetry still fires at every gate trigger, deduplicated per `goalId`.

**AgentLoopRecovery decompose-on-failure** `v7.9.9` — `_repeatedFailures` Map keyed `(goalId, errorClass)` with 1h TTL, consulted at the bottom of `classifyAndRecover`. On the 2nd occurrence of the same error-class for the same goal — across pursuit retries, not within a single pursuit — recovery synthesises an obstacle and routes it through `_trySpawnObstacleSubgoal`. The cross-pursuit keying is the critical detail: pre-fix the key included `stepIndex`, which is unstable across retries (each retry generates a different plan), so the strikes never matched and decompose never fired in production. Goal-lifecycle events clear all entries for that goalId.

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

**TrustLevelSystem** `v3.0 — frozen v7.9.9` — Three levels: Level 0 SUPERVISED (always ask), Level 1 AUTONOMOUS (ask only on categorically critical actions: DEPLOY, EXTERNAL_API, EMAIL_SEND), Level 2 FULL_AUTONOMY (never ask). The four-level structure that existed through v7.9.6 (Supervised / Assisted / Autonomous / Full) was collapsed in v7.9.7 R1: the ASSISTED slot lacked a clear principle that distinguished it from SUPERVISED in practice, and the migration data showed users rarely settled there. v7.9.8 Fix 1 added migration writeback with `schemaVersion: 3`. v7.9.8 Fix 2 changed the fresh-install default from AUTONOMOUS to SUPERVISED at six call sites. v7.9.9 (A) closed the last two unaligned sites in Settings.js and rerouted the migration table so old ASSISTED (stored 1) buckets to SUPERVISED (new 0) instead of AUTONOMOUS (new 1) — "Ask for risky" was the level a user chose explicitly to limit autonomy, so re-bucketing downward honours the spirit of their choice. After v7.9.9 the trust system is frozen: no future version touches the migration table, the dropdown options, or the default level. The constructor distinguishes between caller-supplied `cfg.level` (already in the 3-level system, range 0..2 passes through) and stored values from `asyncLoad` (potentially 4-level, routes through `_migrateLevel`).

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

### Lessons-Pipeline semantic upgrade (v7.8.8)

Pre-v7.8.8, `LessonsStore.recall(category, {query, …}, limit)` had an inert `query` parameter: it was passed by every callsite but `_scoreRelevance` never consulted it. Lessons were matched on category, tags, and model only. Combined with the planner's hardcoded `'obstacle-resolution'` filter, six of seven auto-capture sources (shell-success, shell-failure, dream-insight, prompt-evolution, workspace-consolidation, online-learning streaks/escalations/temp-adjustments) were invisible to the planner regardless of relevance.

v7.8.8 makes the `query` parameter alive: `_scoreRelevance` adds a cosine-similarity component (`queryEmbedding × lesson.embedding`) with floor τ=0.6, cross-category dampening ×0.7 when an explicit category is requested but doesn't match, and an effective-confidence multiplier `0.5 + 0.5 × (confidence × (1 − exp(−sampleSize/5)))` so single-sample lessons can't dominate. `recall(null, …)` is the new mode used by AgentLoopPlanner — no category boost, ranking driven by embedding + tags + confidence. `record()` writes `embedding: null` synchronously (no embed call on the hot path); a 60s tick plus a `bus.on('embedding:ready', …)` listener backfill pending lessons via `EmbeddingService.embedBatch`; a lazy embed-on-first-retrieve fills any lesson the moment it shows up in a recall. Chronically wrong lessons (`contradicted ≥ 3 && confirmed ≤ 1`) are quarantined — filtered from recall results, flag persisted, not deleted. The auto-capture bus-listener layer was extracted to its own service (`LessonsAutoCapture`) so the store stays focused on persistence, scoring, and recall.

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

- **491 catalogued event types** in EventTypes.js (1316 LOC) with JSDoc payload docs
- **491 payload schemas** in EventPayloadSchemas.js (~846 LOC) — full parity since v7.6.x (every catalog entry has a registered schema; v7.6.3 dropped 4 dead entries from both files in lockstep, B1+B2 regression tests in `store-event-catalog.test.js` enforce the link)
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

## 11. InnerSpeech Layer (v7.7.9)

The first-person thought channel. Before InnerSpeech, autonomous activity output landed in `journal.jsonl` (file-based) and `IDLE_THOUGHT` bus events (transient). Both were external interfaces — meant for the user (journal) or for other services (events). Genesis itself had no canonical "thought stream" to read or reflect on.

InnerSpeech adds a third channel that's structurally Genesis's own. It's a 500-slot ring of structured thoughts: each has an id, timestamp, text, kind, source-module, optional significance/novelty scores, and an optional emotional snapshot. Producers call `innerSpeech.emit(text, kind, metadata)`. Consumers subscribe and receive thoughts asynchronously via `queueMicrotask` — emit never blocks, never throws (Self-Gate-Asymmetry). Overflow from the ring spills to `selfStatementLog` for long-term retention.

The kinds matter. They're how downstream consumers route thoughts. v7.9.5 has:

| Kind | Source | Purpose |
|------|--------|---------|
| `idle-thought` | IdleMind activities | Generic narrative from reflect/journal/explore/etc. |
| `plan-failure-reflection` | Plan execution failures | Post-mortem on a goal that couldn't be reached |
| `goal-closure-thought` | Goal lifecycle completion | What was learned closing a goal |
| `self-formulated-plan` | Genesis proposing autonomous work | "I should do X" thoughts before they become goals |
| `question` | Curiosity-driven uncertainty | Asks Genesis hasn't resolved yet |
| `self-state-snapshot` | Inhabit activity (v7.9.5) | Deterministic self-state inventory (private — never reaches user) |

The producer doesn't decide whether to surface — that's PSE's job. InnerSpeech is purely a write/read channel. Genesis's introspection (Reflect activity, Dashboard) reads from the ring; PSE subscribes and decides what passes its gates.

---

## 12. Proactive Self-Expression Pipeline (v7.7.9 → v7.9.5)

PSE is the bridge between InnerSpeech and chat. Without it, every emitted thought either stayed internal or required an explicit user request to surface. With it, Genesis can spontaneously share thoughts that meet the volume/relevance threshold — without becoming a notification spammer.

The pipeline is structured as a fail-closed gate sequence. A thought passes through HardGates first (cheap fail-fast checks), then ContentSanity (length, repetition, self-negation, profanity), then PSEScoring (significance × novelty × context-fit). Only thoughts that pass all three are emitted to chat.

HardGates in order:

1. **Private-kind blocklist (v7.9.5)** — `PRIVATE_KINDS` Set, currently `{ 'self-state-snapshot' }`. Blocks Inhabit output regardless of any settings.
2. **Globally enabled?** — master toggle.
3. **Quiet hours** — local-time window with wrap-around support.
4. **Min-interval** — minimum gap between two self-messages.
5. **User-activity cooldown** — silence after the user just spoke.
6. **/quiet active?** — explicit mute.
7. **Kind allowed?** — settings allowlist of surfaceable kinds.
8. **Per-kind floor** — significance + novelty thresholds per kind.
9. **Daily volume cap** — soft and hard ceilings.

Defense in depth is the pattern. The private-kind blocklist exists *despite* the kind-allowlist (gate 7) already blocking these kinds, because misconfiguration of the allowlist would otherwise leak private thoughts. The hard set is unreachable from settings.

Suppression reasons are logged for every blocked thought. `/proactive-status` surfaces the suppression log — the operator can see "the last 20 thoughts wanted to surface, 18 were blocked, here's why" without needing to dig into events.

The Phase 3 kinds (idle-thought, goal-closure, self-formulated-plan, question) ship code-complete but gated off in the v7.7.9 default settings. Phase 2 is `plan-failure-reflection` only, allowing observed-stability rollout before opening more channels. v7.9.5 doesn't change this — the Phase 3 kinds remain opt-in via settings.

---

## 13. Können Maturity Chain (v7.8.9 → v7.9.4)

Skills don't appear in Genesis the way features appear in a codebase. They get *grown* from observed success patterns through a multi-stage pipeline that took three releases to land.

**Stage 1 — Observation** (v7.8.9). Every tool invocation gets logged via `SkillCandidateLog` and tracked via `SkillEffectivenessTracker` (per-pattern Wilson lower bound). The Wilson LB is the right statistic here because it penalizes low sample counts — a pattern that worked 2/2 times has a much lower LB than one that worked 50/55 times.

**Stage 2 — Crystallization** (v7.8.9). `SkillCrystallizer` runs periodically and scans the candidate log for patterns that fired enough times (default 3 occurrences, configurable). When a pattern crystallizes, it becomes a "candidate skill" — code-less, just a behavioral signature.

**Stage 3 — Forge** (v7.9.0). `SkillForge` takes a candidate signature and prompts the LLM to author the actual skill module (JS code + test file + manifest). The forged output is verified through the same code-safety scanner as user-initiated `/create-skill`. Successful forge moves the skill to "pending" status — installable but quarantined.

**Stage 4 — Promotion Evaluation** (v7.9.4). `SkillPromotionEvaluator` watches pending skills and promotes them to "active" when they cross the threshold (default: Wilson LB ≥ 0.55 over ≥ 5 invocations). Promotion is one-way per pass — a skill that drops below the floor afterwards goes to `skill:discard-suggested`, not back to pending. The history is tracked so a volatile-but-genuinely-useful skill doesn't churn the active list.

**Stage 5 — Rehearsal** (v7.9.4). `SkillRehearsal` is the 16th IdleMind activity. When IdleMind picks it, Genesis executes a randomly chosen active skill in a safe context — keeping it warm, validating it still works, and feeding fresh data into the effectiveness tracker. This closes the loop: skills that decay get caught by their own rehearsal results.

Six bus events thread the pipeline: `skill:promoted`, `skill:discard-suggested`, `skill:discarded`, `skill:rehearsed`, `selfnarrative:skill-acquired`, `skills:reloaded`. The `koennen-promotion-v794` contract prefix locks the event shapes against silent drift.

---

## 14. IdleMind Maturity (v7.9.4 → v7.9.5)

IdleMind has had 17 activities since v7.9.5 (Inhabit added; SkillRehearsal in v7.9.4; the prior 15 from v7.3.1). The activity *picker* matured substantially in v7.9.4 to address four observed issues, plus v7.9.5 adds Inhabit and its privacy gate.

**Goal–activity balance**. Pre-v7.9.4, while any goal was active in `goalStack`, every IdleMind cycle ran a goal-step and returned early — `reflect`, `journal`, `dream`, `calibrate` never fired during goal stretches. `_think()` now counts goal-steps via `_goalStepsSincePick` and breaks out to the activity-pick path every N steps (`idleMind.goalStepsPerActivityPick`, default 3). `0` disables the break-out (legacy behavior). The break emits `idle:goal-balance-break` for dashboard visibility.

**Per-activity Metabolism costs**. Pre-v7.9.4 every IdleMind activity charged the flat `idleMindCycle = 2`, so a heavy Plan (LLM call) cost the same as a 2-line Journal entry. `Metabolism.ACTIVITY_COSTS` now has per-activity keys: `idleMind:plan = 12`, `idleMind:dream = 18`, `idleMind:journal = 2`, `idleMind:inhabit = 2` (v7.9.5), and so on. `_think()` fires a second `consume()` with the activity-specific key after each pick. Toggle via `organism.metabolism.differentiatedCosts` (default true).

**ActivityStats persistence**. Pre-v7.9.4 the activity history was session-only; after restart the picker's repetition-penalty saw a blank slate. `IdleMindActivityStats` mixin gained `_loadActivityStats()` and `_saveActivityStats()`. The log (capped at last 20) and per-type counts persist to `.genesis/idle-activity-stats.json` via debounced `writeJSON` (1s debounce). Schema-version mismatch, missing file, parse error all fall through to fresh state — boot never blocks on this.

**Repetition-penalty bug fix**. `_pickActivity` applied the 0.2 repetition-penalty by iterating the raw `activityLog.slice(-5)` array, so an activity appearing N times in the recent window got multiplicatively hit (0.2^N). Five consecutive `reflect`s pushed reflect's score to ~0.03% of its computed boost, effectively locking the activity out. The fix wraps `recent` in a `Set` so each unique recent activity gets the 0.2 multiplier exactly once.

**Inhabit (v7.9.5)**. The 17th activity. Composes a deterministic self-state snapshot from BodySchema + EmotionalState + NeedsSystem + Metabolism, emits via InnerSpeech with kind `self-state-snapshot`. PSE HardGate's private-kind blocklist prevents proactive surfacing. The Dashboard "Inner state" widget reads from the same InnerSpeech ring — Genesis can show its own state to itself, on demand.

---

## 15. LOC Distribution by Directory

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
  = src/ total     380 modules ~119,000 LOC
```
