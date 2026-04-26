# Genesis Agent — Architecture Deep-Dive

> Comprehensive technical analysis of Genesis Agent. Some sections may reference earlier version numbers where the underlying architecture is unchanged.
> Last updated for v7.4.5: 12 boot phases, 167 services (154 manifest + 13 bootstrap), 273 source files, 5668 tests, 240+ capabilities, 16 hash-locked files, 11 PreservationInvariants rules, four active gates (Injection blocking, Self-Gate telemetry-only, Tool-Call-Verification detective, Slash-Discipline preventive), synchronous source-read with per-turn budget, `failFastMs` semantics on CircuitBreaker (v7.4.3 — LLM circuit opted out, MCP circuit keeps 15s fail-fast), CI ratchet locked at the v7.4.5 baseline (5667 floor, branches 76).

---

## 1. System Overview

Genesis Agent is a **self-modifying, self-verifying, cognitive AI agent** built as an Electron desktop application with multi-backend LLM support (Anthropic Claude, OpenAI-compatible, local via Ollama). The codebase comprises **273 JS source modules** across **~85,000 LOC** of production code, supported by **335 test files / 5668 tests** with coverage gates enforced in CI. It is the first AI agent framework with **closed-loop self-improvement** (CognitiveSelfModel → AdaptiveStrategy, v6.0.2), **proportional intelligence** (CognitiveBudget → ExecutionProvenance → AdaptivePromptStrategy, v6.0.4), and **automatic offline failover** (NetworkSentinel, v6.0.5).

### Key Numbers

| Metric | Value |
|--------|-------|
| Production LOC (src/) | ~92,000 |
| Source Modules | 269 JS files |
| Test Files / Tests | 329 / 5583 |
| DI Services | 167 (154 manifest + 13 bootstrap) |
| Boot Phases | 12 |
| npm Dependencies | 3 production + 3 optional + 6 dev |
| Event Types (catalogued) | 405 |
| IPC Channels | 67 main ↔ 67 preload |
| LLM Backends | 3 (Ollama, Anthropic, OpenAI-compatible) |
| Coverage Gates | 80% lines, 75.9% branches, 78% functions |
| Fitness Score | 127/130 (98%) |
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
  └── Register all 154 services from 12 phase files via ContainerManifest (+13 bootstrap = 167 runtime, cognitive default profile)
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

---

## 5. The 12-Phase Service Architecture

### Phase 1: Foundation (34 files, ~9,400 LOC)

Core infrastructure: Settings, ModelBridge, Sandbox, ConversationMemory, KnowledgeGraph, GraphStore, EventStore, WorldState, EmbeddingService, ModuleSigner, SelfModel (split into 4 files via Prototype-Delegation in v7.4.1), PromptEngine, StorageService, LLMCache, WebFetcher, ASTDiff, CapabilityGuard, UncertaintyGuard, DesktopPerception, TrustLevelSystem, LinuxSandboxHelper, BootTelemetry, BootRecovery, AwarenessPort + NullAwareness, GenesisBackup (v7.2.3), and 4 LLM backends (Ollama, Anthropic, OpenAI, Mock).

**ModelBridge** (~590 LOC) — Multi-backend LLM abstraction (Ollama, OpenAI-compatible, Anthropic) with:
- Priority-based semaphore (chat=10, agentLoop=5, idleMind=1)
- Starvation timeout (5 min)
- Response cache (skip non-deterministic tasks)
- Per-task temperature profiles

### Phase 2: Intelligence (27 files, ~9,900 LOC)

Decision-making: IntentRouter (split via IntentPatterns data extract in v7.4.3), ToolRegistry, WorkerPool, PromptBuilder + PromptBuilderSections + PromptBuilderRuntimeState, ContextManager, DynamicContextBudget, CircuitBreaker (`failFastMs` semantics in v7.4.3), CodeAnalyzer, CodeSafetyScanner, ReasoningEngine, VerificationEngine, GenericWorker, FailureTaxonomy, LocalClassifier, GraphReasoner, UserModel.

**VerificationEngine** (~680 LOC) — Programmatic truth: AST parsing, exit codes, file validation, import resolution. Returns PASS/FAIL/AMBIGUOUS. Only AMBIGUOUS falls back to LLM.

**CodeSafetyScanner** (~490 LOC) — Two-pass AST + regex analysis. Hash-locked (immutable to self-modification).

**IntentRouter** (~450 LOC after v7.4.3 IntentPatterns extract) — 4-stage cascade (regex → fuzzy → local classifier → LLM). 13 conversational meta-state patterns route directly to runtime block (v7.4.1).

### Phase 3: Capabilities (22 files, ~7,300 LOC)

External interaction: SkillManager, Reflector, CloneFactory, FileProcessor, HotReloader, PeerNetwork, ShellAgent, McpClient, McpServer, McpTransport (uses `failFastMs: 15000` for real fail-fast), SnapshotManager, ToolBootstrap, SelfSpawner, WebPerception, PluginRegistry, EffectorRegistry.

**ShellAgent** (~600 LOC) — 4 permission tiers (read/write/admin/root), blocklist, rate limiter. v4.0.0: Migrated from `execSync` to async `execFile` with array args (no shell injection).

### Phase 4: Planning (12 files, ~3,600 LOC)

Goal decomposition: GoalStack (auto-transitions: complete/fail/stall in v7.3.7), GoalPersistence, Anticipator, SolutionAccumulator, SelfOptimizer, MetaLearning, SchemaStore, Reflector, ValueStore.

**MetaLearning** — Tracks every LLM call's success rate by model, prompt style, and temperature. Feeds ExpectationEngine statistics.

**SchemaStore** (~500 LOC) — Stores abstract patterns extracted by DreamCycle. Keyword-indexed with confidence decay. Modifies expectations and guides planning.

### Phase 5: Hexagonal (22 files, ~6,900 LOC)

Orchestration layer: UnifiedMemory, EpisodicMemory (3-layer decay: Detail/Schema/Feeling, v7.3.7), AdaptiveMemory, ChatOrchestrator + ChatOrchestratorSourceRead + ChatOrchestratorHelpers, SelfModificationPipeline + SelfModificationPipelineModify (v7.4.3 split), LearningService, PeerCrypto, PeerHealth, PeerTransport, PeerNetwork, PeerConsensus, TaskDelegation, CommandHandlers + 6 domain mixins (v7.4.2 split: Code/Shell/Goals/Memory/System/Network).

**ChatOrchestrator** (~590 LOC after v7.3.9 source-read extract) — Routes messages through IntentRouter → handler dispatch → tool calls → LLM synthesis. Manages conversation history with configurable limits. Synchronous source-read for CHANGELOG/package.json with per-turn + session budget (v7.3.8).

**SelfModificationPipeline** (~450 LOC after v7.4.3 Modify-family extract) — Gate chain: circuit breaker → AwarenessPort coherence (currently inert with NullAwareness default, threshold 0.4) → Metabolism energy → write → verify → snapshot.

### Phase 6: Autonomy (12 files, ~4,300 LOC)

Background processes: AutonomousDaemon, IdleMind, HealthMonitor, CognitiveMonitor, ErrorAggregator, HealthServer, ServiceRecovery, DeploymentManager, NetworkSentinel, JournalWriter (v7.3.7), ActiveReferencesPort (v7.3.7), WakeUpRoutine (v7.3.7).

**IdleMind** (~570 LOC) — Activity selection: reflection, KG exploration, goal generation, tidying, journaling, dreaming (Phase 9), and LLM-as-knowledge-source (v7.2.8). Activity scoring uses NeedsSystem drive levels and emotional state.

### Phase 7: Organism (16 files, ~5,950 LOC)

Biological simulation: EmotionalState, EmotionalSteering, Homeostasis, HomeostasisEffectors, NeedsSystem, Metabolism, ImmuneSystem, BodySchema, Genome, AdaptiveStrategy, EmotionalFrontier (v7.1.5), and supporting modules.

**EmotionalState** (~640 LOC) — Five dimensions (curiosity, satisfaction, frustration, energy, loneliness), each 0.0–1.0 with baseline decay and watchdog against extremes. Reactivity balanced at ~1.3:1 success:error ratio (v3.5.3 fix for small models).

**NeedsSystem** — Four drives (knowledge, social, maintenance, rest) that grow passively and are satisfied by specific actions. Total DRIVE = weighted sum, used by IdleMind for activity selection.

**Metabolism** `v4.12.5` — Real energy accounting replaces fixed -0.02 per chat. Computes cost from token count (50%), latency (30%), and heap delta (20%). Logarithmic scaling above 2x baseline, capped at 0.15. Passive recovery during idle.

**ImmuneSystem** `v4.12.5` — Three-level self-repair: inflammation (quarantine crash-looping services), targeted repair (4 failure signatures with specific remedies), and adaptive immunity (persisted across sessions). All remedies operate on runtime state only — never modifies source code.

**HomeostasisEffectors** `v4.12.5` — Wires all homeostasis correction events to real actions: cache pruning, knowledge graph pruning, context budget pressure, and simplified-mode recommendations. Allostatic set-point adaptation shifts thresholds when vitals stay in WARNING for 10+ minutes.

### Phase 8: Revolution (17 files, ~6,700 LOC)

Autonomous execution: AgentLoop (~690 LOC + 4 delegates: Planner, Steps, Cognition, Recovery — split in v7.3.4), FormalPlanner, HTNPlanner, NativeToolUse, SessionPersistence, ModelRouter, ModuleRegistry, MultiFileRefactor, FailureAnalyzer, VectorMemory, ColonyOrchestrator, EmotionalFrontier, UnfinishedWorkFrontier, GoalSynthesizer (v7.1.7).

**AgentLoop** — The autonomous execution framework:
```
Perceive (WorldState) → Plan (FormalPlanner) → Act → Verify → Learn → Loop
```
Max 20 steps per goal (+10 after user approval), 3 consecutive error limit, 10-minute global timeout.

### Phase 9: Cognitive (33 files, ~12,500 LOC)

Expectation, surprise, learning, self-model, adaptation. The cognitive substrate that makes Genesis self-correcting and self-improving. Includes CognitiveSelfModel (empirical capability tracking with Wilson-score calibration), AdaptiveStrategy (closed-loop self-correction), OnlineLearner (real-time behavioral adaptation), PromptEvolution (A/B prompt optimization), MemoryConsolidator (KG/Lessons hygiene), TaskRecorder (execution replay), CoreMemories (v7.3.7), LessonsStore, GateStats (v7.3.6 — central gate-verdict telemetry), SuspicionFrontier, LessonFrontier, ArchitectureReflection.

Anticipation and identity: ExpectationEngine, MentalSimulator, SurpriseAccumulator, DreamCycle + DreamCyclePhases (v7.3.9 split), SelfNarrative, CognitiveHealthTracker.

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

- **424 catalogued event types** in EventTypes.js (1213 LOC) with JSDoc payload docs
- **424 payload schemas** in EventPayloadSchemas.js (759 LOC) — 100% coverage as of v7.4.1
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

Approximate as of v7.4.5 (numbers shift with each release):

```
  core/             22 files    7,200 LOC
  foundation/       34 files    9,400 LOC
  intelligence/     27 files    9,900 LOC
  capabilities/     22 files    7,300 LOC
  planning/         12 files    3,600 LOC
  hexagonal/        22 files    6,900 LOC
  autonomy/         12 files    4,300 LOC
  organism/         16 files    5,950 LOC
  revolution/       17 files    6,700 LOC
  cognitive/        33 files   12,500 LOC
  ports/            12 files    1,500 LOC
  manifest/         12 files    2,300 LOC
  ─────────────────────────────────────────────
  agent/ total     241 files  ~77,500 LOC
  + UI/kernel       19 files  ~10,000 LOC
  = src/ total     273 modules ~85,000 LOC
```
