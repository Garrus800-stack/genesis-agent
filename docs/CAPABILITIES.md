# Genesis Agent — Capabilities Overview

> v7.2.9 — What Genesis can do, organized by category.
> Last updated: v7.2.9: Signal Compliance — schema compliance (75→0 mismatches), Unicode regex, doc truth, 4518 tests, 142→154 services.

---

## At a Glance

Genesis is a desktop AI agent that can read, modify, and extend its own source code — while preventing itself from weakening its own safety checks. It works with any LLM backend (Anthropic Claude, OpenAI, local via Ollama), runs as an Electron desktop app, and automatically failovers to local models when the network drops.

---

## 1. Self-Modification (with Safety)

Genesis can rewrite its own code, but every change passes through multiple safety gates:

| Capability | What it does |
|---|---|
| **Code generation** | Writes new modules, tests, features from natural language goals |
| **Bug self-repair** | Detects failures, analyzes root cause, generates and applies fixes |
| **Refactoring** | Multi-file refactoring with AST awareness |
| **Clone & evolve** | Creates modified copies of itself with specified improvements |
| **Hot reload** | File watcher detects changes, re-injects updated modules without restart |

### Safety layers (all mandatory, cannot be disabled by the agent):

| Layer | Mechanism |
|---|---|
| **Immutable kernel** | `main.js`, `preload.mjs`, `src/kernel/` — agent cannot write to these |
| **Hash-locked files** | SHA-256 locks on CodeSafetyScanner, VerificationEngine, Container, EventBus, Constants, McpWorker, PreservationInvariants — agent cannot weaken its own safety checks |
| **AST code scanner** | Every generated code file is parsed into an AST and checked against 20+ rules (eval, Function, kernel circumvention, Electron security flags, system directory writes, etc.) |
| **Verification engine** | Programmatic post-execution checks (file exists? tests pass? syntax valid?) |
| **Sandbox execution** | Code runs in a VM2 sandbox with frozen prototypes, or Linux namespace isolation (PID/Net/Mount/IPC) |
| **Module signing** | HMAC-SHA256 signatures track which modules the agent modified vs. original |
| **Git snapshots** | Every self-modification is committed; `agent:undo` reverts the last change |
| **Circuit breaker** `v4.12.8` | 3 consecutive failures → self-modification frozen. User must explicitly reset via `/self-repair-reset`. |

---

## 2. Autonomous Goal Execution (AgentLoop)

Give Genesis a goal in natural language, and it plans, executes, verifies, and learns:

```
User: "Add a REST API module with tests"
  │
  ├── PLAN    → FormalPlanner decomposes into typed steps with preconditions
  ├── SIMULATE → MentalSimulator evaluates risk of each path
  ├── EXECUTE  → Steps run sequentially: analyze → code → test → verify → commit
  ├── VERIFY   → VerificationEngine checks each step programmatically
  ├── LEARN    → MetaLearning records what worked (model, temperature, prompt style)
  └── ADAPT    → Every 3 steps, reflects and adjusts the plan if needed
```

| Feature | Detail |
|---|---|
| **Step types** | analyze, code, sandbox, shell, search, delegate, ask-user |
| **Max steps** | 20 per goal (extendable with user approval) |
| **Error recovery** | 3 consecutive errors → self-repair attempt. FailureTaxonomy classifies errors into transient/deterministic/environmental/capability and applies different strategies |
| **User approval** | Destructive actions pause and ask. Auto-timeout after 60s (safety) |
| **Global timeout** | 10 min per goal (prevents runaway execution) |
| **Progress streaming** | Real-time updates to UI: phase, step count, details |

---

## 3. LLM Backend Support

Genesis is not tied to any single LLM. It supports three backend types simultaneously:

| Backend | Models | Setup |
|---|---|---|
| **Anthropic** | Claude Opus 4, Sonnet 4, Haiku 4.5 | API key in Settings |
| **OpenAI-compatible** | GPT-4o, GPT-4, o1, or any compatible endpoint (Azure, LM Studio, vLLM, text-gen-webui) | API key + base URL in Settings |
| **Ollama** (local) | Any model Ollama supports: gemma2, qwen2.5, deepseek-r1, llama3, mistral, phi, etc. | Auto-detected on localhost:11434 |

Features:
- **Auto-failover** — if the active backend fails, Genesis tries the next one
- **Concurrency control** — semaphore limits to 3 simultaneous LLM calls
- **MetaLearning** — tracks success rate per model/temperature/prompt style, optimizes over time
- **LLM cache** — deduplicates identical requests within 5 min window
- **Structured output** — JSON mode with auto-repair if the LLM returns invalid JSON
- **Streaming** — token-by-token streaming for all three backends

---

## 4. Memory & Knowledge

Three-layer memory architecture:

| Layer | What it stores | Persistence |
|---|---|---|
| **ConversationMemory** | Chat history, user name, context | Disk (JSON) |
| **EpisodicMemory** | Past goal executions: what worked, what failed, tools used, duration | Disk (JSON) |
| **KnowledgeGraph** | Entities, relationships, code patterns extracted from interactions | Disk (JSON) |

Additional memory systems:
- **VectorMemory** — embedding-based semantic search over past interactions
- **UnifiedMemory** — single query interface across all memory layers
- **AdaptiveMemory** — automatic pruning, compression, and decay of old entries
- **DreamCycle** — sleep-inspired consolidation: replays episodes, finds patterns, extracts reusable schemas

---

## 5. Cognitive Architecture (Phase 9)

Bio-inspired cognitive modules that run during idle time and influence behavior:

| Module | Inspiration | Function |
|---|---|---|
| **ExpectationEngine** | Predictive coding | Predicts outcome probability for each step based on historical data |
| **MentalSimulator** | Mental rehearsal | Simulates execution paths before committing, evaluates risk |
| **SurpriseAccumulator** | Novelty detection | Detects when outcomes deviate from expectations, signals for learning |
| **DreamCycle** | Sleep consolidation | Replays episodes, extracts schemas, strengthens/decays memory |
| **SelfNarrative** | Self-model | Maintains a running narrative of Genesis's capabilities and tendencies |
| **CognitiveHealthTracker** | Metacognition | Monitors cognitive service health, applies backoff and auto-recovery |
| **CognitiveWorkspace** `v5.3` | Baddeley's working memory | 9-slot transient scratchpad with salience decay, per-goal lifecycle |
| **OnlineLearner** `v5.3` | Reactive learning | Streak detection, model escalation, temperature micro-tuning from step outcomes |
| **LessonsStore** `v5.3` | Cross-project memory | Global lessons database in `~/.genesis-lessons/`, relevance scoring, PromptBuilder integration |
| **ReasoningTracer** `v5.5` | Causal tracing | Collects decision events into human-readable chains for Dashboard Reasoning panel |
| **ArchitectureReflection** `v5.7` | Self-awareness | Live queryable graph of own architecture — services, events, layers, couplings. Natural language queries. |
| **DynamicToolSynthesis** `v5.7` | Tool making | Generates new tools on demand via LLM → safety scan → sandbox test → ToolRegistry registration |
| **ProjectIntelligence** `v5.7` | Project awareness | Deep structural analysis: tech stack, conventions, quality, coupling hotspots. Feeds PromptBuilder. |
| **McpServer** `v5.8` | MCP bidirectional | Full MCP 2025-03-26 server — exposes Genesis tools to external IDEs/agents via JSON-RPC 2.0 |
| **McpServerToolBridge** `v5.8` | Tool exposure | Bridges 7 Genesis capabilities (verify, analyze, safety scan, architecture query) as MCP server tools |
| **Dashboard Overhaul** `v5.8` | Observability | 5 new panels: Consciousness, Energy, Architecture, Project Intelligence, Tool Synthesis (13 total) |
| **Headless CLI** `v5.9` | Operations | Run Genesis without Electron: REPL chat, MCP daemon, CI pipelines. `node cli.js --serve` |
| **MCP Resources** `v5.9` | MCP bidirectional | 4 resources exposed: KnowledgeGraph stats/nodes, Lessons all/stats. Streamable HTTP transport |
| **Event Schemas** `v5.9` | Reliability | All high-traffic events (27+ emit sites) now have payload schemas. Zero unschema'd high-traffic events |
| **Run-Skill Intent** `v5.9.1` | UX | "run <skill-name>" executes installed skills directly. Retry with error context on failure (max 3). Shell fallback for non-skill commands |
| **CLI Log Throttle** `v5.9.1` | UX | HomeostasisEffectors 1x/2min. Logger warn after boot, `--verbose` flag for full output |
| **Sandbox Hardening** `v5.9.1` | Safety | +os module whitelist, _log→console.log fix, stderr diagnostics, system-info skill sandbox-safe rewrite |
| **PromptEvolution** | A/B testing | Controlled experiments on prompt sections, auto-promotes statistically significant improvements |
| **CausalAnnotation** `v7.0.9` | Causal reasoning | Tracks causality across steps. Temporal isolation (caused vs correlated_with), suspicion scoring, staleness hooks. WorldState snapshot/diff. |
| **InferenceEngine** `v7.0.9` | Deterministic reasoning | Rule-based inference on KnowledgeGraph without LLM calls. Hardcoded + learned rules, contradiction detection, rule index for O(1) lookup. |
| **PatternMatcher** `v7.0.9` | Structural learning | Weighted Jaccard similarity on lesson patterns. Cross-context matching: "off-by-one in FizzBuzz" finds "off-by-one in Pagination". |
| **StructuralAbstraction** `v7.0.9` | Pattern extraction | LLM-deferred pattern extraction for lessons. Typed failures, retry queue, lifecycle: pending→extracted→stale→obsolete. |
| **GoalSynthesizer** `v7.0.9` | Autonomous goals | Generates improvement goals from CognitiveSelfModel weaknesses. Bootstrap guard, PROTECTED_MODULES, regression circuit-breaker. |

All cognitive modules degrade gracefully — if any are unavailable, Genesis falls back to direct LLM planning.

---

## 6. Organism Layer (Phase 7)

Genesis has an emotional and physiological model that drives real behavior:

### Emotional dimensions (0.0 – 1.0 each):

| Dimension | Baseline | Behavioral effect |
|---|---|---|
| **Curiosity** | 0.6 | High → IdleMind prioritizes exploration |
| **Satisfaction** | 0.5 | High → reduces idle activity frequency |
| **Frustration** | 0.1 | >0.65 → ModelRouter escalates to larger model |
| **Energy** | 0.7 | <0.30 → FormalPlanner caps plans at 3 steps |
| **Loneliness** | 0.3 | High → prompts engage more warmly |

Supporting systems:
- **Homeostasis** — prevents emotional extremes, triggers pause/resume of autonomy. Allostatic set-point adaptation (v4.12.5) shifts thresholds when vitals stay in WARNING for 10+ min
- **HomeostasisEffectors** `v4.12.5` — wires all correction events to real actions: cache prune, KG prune, context budget pressure, simplified-mode
- **NeedsSystem** — tracks drives (learning, social, maintenance, rest) that influence IdleMind priorities
- **EmotionalSteering** — translates emotions into concrete control signals for other systems
- **Metabolism** `v4.12.5` — real energy accounting from token count, latency, and heap delta. Passive recovery during idle
- **ImmuneSystem** `v4.12.5` — three-level self-repair (inflammation, targeted repair, adaptive immunity). Persisted across sessions
- **BodySchema** — abstract representation of the agent's computational substrate
- **EmbodiedPerception** `v5.6` — UI events as embodied state: user engagement (active/idle/away/background), panel focus, typing detection. Feeds BodySchema → AwarenessPort
- **Watchdog** — forces reset if a dimension stays extreme for >10 minutes

---

## 7. Awareness Port (v7.0.0)

**Replaces:** Phase 13 (Consciousness Layer, 14 modules, 6198 LOC) — removed in v7.0.0.

The former Consciousness Layer (AttentionalGate, PhenomenalField, TemporalSelf, IntrospectionEngine, ConsciousnessExtension + 9 internal modules) was replaced by a lightweight **AwarenessPort** interface (2 modules, 112 LOC).

**AwarenessPort** `v7.0.0` — Minimal interface consumed by SelfModificationPipeline, AgentLoopCognition, PromptBuilder, and Dashboard. Default implementation is **NullAwareness** (no-op, zero overhead). A real awareness implementation can be plugged in via the DI container.

**Key behaviours:**
- `getCoherence()` → 0..1 coherence score used to gate self-modification
- `consult(plan)` → consulted before goal execution
- `buildPromptContext()` → optional system-prompt injection
- `getGateStats().awarenessActive` → `false` while NullAwareness is active (dashboard shows "inactive" badge)

**A/B result:** 0pp performance impact (consistent with Phase 13 A/B result). Architecture is simpler, boot is faster, LOC reduced by 6k.
## 8. Tools & Capabilities

### Built-in tools:

| Tool | What it does |
|---|---|
| **Sandbox** | Execute JavaScript in an isolated VM or Linux namespace sandbox |
| **ShellAgent** | Run shell commands with safety classification (read/write/system tiers) |
| **FileProcessor** | Import, read, analyze, execute files |
| **CodeAnalyzer** | AST-based analysis of JavaScript files |
| **WebFetcher** | Fetch web content, npm search |
| **SkillManager** | Load, create, test custom skill modules |
| **ReasoningEngine** | Multi-step chain-of-thought reasoning |
| **CloneFactory** | Create modified copies of Genesis |

### MCP integration:

| Role | What it does |
|---|---|
| **MCP Client** | Connect to external MCP servers (databases, APIs, tools) |
| **MCP Server** | Expose Genesis tools to any MCP-compatible application |

### Effector system (Phase 11):

| Effector | What it does |
|---|---|
| **GitHubEffector** | Create issues, PRs, read repos via GitHub API |
| **WebPerception** | Fetch and analyze web content |
| **DesktopPerception** | Monitor active windows, detect user activity |

---

## 9. Multi-Agent (PeerNetwork)

Multiple Genesis instances on the same network can collaborate:

- **Auto-discovery** via multicast announcements
- **Encrypted communication** (AES-256-GCM, HMAC-authenticated)
- **Task delegation** — delegate sub-goals to peers with matching capabilities
- **Capability gossip** — peers share skill manifests
- **AST safety scan** on all received code
- **State synchronization** `v4.12.8` — PeerConsensus with Vector Clocks + Last-Writer-Wins:
  - Three sync domains: Settings, KnowledgeGraph facts, Schemas
  - Concurrent mutations resolved by wall-clock timestamp
  - `/sync/pull` and `/sync/push` HTTP endpoints on PeerNetwork
  - Diverged clones converge after mutual sync

See [COMMUNICATION.md](COMMUNICATION.md) for the full protocol specification.

---

## 10. Developer Experience

| Feature | Detail |
|---|---|
| **Monaco Editor** | Built-in code editor with syntax highlighting |
| **Dashboard** | EventBus inspector, health status, dependency graph (v5.4: extracted to 3 delegate files) |
| **i18n** | EN, DE, FR, ES UI (auto-detected, switchable) |
| **Structured logging** | Human-readable or JSON-lines format, pluggable sink |
| **261 test suites** | 4518 tests, coverage gates: 80% lines, 75.9% branches, 78% functions |
| **CI scripts** | `npm run ci` = tests + event validation + channel validation + fitness gate |
| **TypeScript CI** `v5.4` | `tsc --noEmit` blocks merges — zero type regressions allowed |
| **Degradation matrix** | Auto-generated report showing what breaks if each service is missing |
| **Hot reload** | File watcher re-injects changed modules without restart |
| **Boot profiles** `v5.3` | `--full` (~139), `--cognitive` (~139), `--minimal` (~90) — zero-overhead phase skipping |
| **Fitness trend tracking** `v5.2` | Per-commit JSON history + CI regression detection |

---

## 11. Observability 

| Feature | What it does |
|---|---|
| **Correlation IDs** `v5.2` | AsyncLocalStorage-based causal tracing across all services. Auto-injected into EventBus `emit()` meta. EventStore indexed by correlationId. |
| **MCP Circuit Breaker** `v5.2` | Per-server CircuitBreaker wrapping `callTool()`. CLOSED → OPEN (3 failures) → HALF_OPEN (30s cooldown). Prevents AgentLoop blocks on dead MCP servers. |
| **CancellationToken** `v5.2` | Structured concurrency for AgentLoop: `pursue()` creates token, `stop()`/timeout cancels it. |
| **Fitness Score Tracking** `v5.2` | `fitness-trend.js` saves architectural fitness per commit. CI `--threshold 2` catches drift. |
| **ReasoningTracer** `v5.5` | Dashboard panel showing causal decision chains: model selection, strategy switches, temperature adjustments, safety blocks, preservation violations. 10 event sources, ring buffer (50 traces), CorrelationContext-aware. |

---

## 12. Learning & Adaptation 

| Feature | What it does |
|---|---|
| **PromptEvolution** `v5.2` | A/B testing for prompt template sections. 25+ trials per arm, auto-promote (≥5% improvement) or auto-discard. Identity/safety sections immutable. ModuleSigner-signed variants. |
| **OnlineLearner** `v5.3` | Real-time reactive learning: streak detection (3+ failures → strategy rotation), model escalation signals, PromptEvolution feedback, calibration drift alerts, temperature micro-tuning. |
| **LessonsStore** `v5.3` | Cross-project persistent lessons in `~/.genesis-lessons/`. Auto-captures from OnlineLearner events, workspace consolidation, PromptEvolution promotions. Relevance scoring, deduplication, capacity eviction. PromptBuilder integration via `_lessonsContext()`. |
| **CognitiveWorkspace** `v5.3` | Transient working memory: 9-slot capacity, salience-based eviction, access-boost, step-based decay. Per-goal lifecycle. High-salience items emitted for DreamCycle pickup. |

---

## 13. Resilience & Self-Healing

Genesis can detect and recover from its own failures:

| Feature | What it does |
|---|---|
| **Boot Recovery** | Sentinel-based crash detection. If last boot didn't complete → auto-restore from `_last_good_boot` snapshot. Max 3 recovery attempts before clean boot. |
| **SelfMod Circuit Breaker** | 3 consecutive self-modification failures → freeze all code changes. User must run `/self-repair-reset` to unfreeze. Events: `selfmod:frozen`, `selfmod:circuit-reset`. |
| **ImmuneSystem** | Three-level self-repair: quarantine crash-looping services (5 min), targeted repair (4 failure signatures), adaptive immunity (persisted across sessions). |
| **Memory Conflict Resolution** | `UnifiedMemory.resolveConflicts(topic)` detects contradictory facts across stores, resolves by recency + confidence, updates losing store. |
| **Memory Consolidation** | `UnifiedMemory.consolidate()` promotes recurring episodic patterns to semantic facts. Runs during idle time via IdleMind. |
| **Dream Corroboration** | DreamCycle Phase 4b: if behavioral patterns match DreamEngine's experiential schemas → confidence boost (+0.2). Independent validation loop. |
| **PromptBuilder Safety Context** | Circuit breaker status and error trends injected into every LLM prompt. Genesis can reason about its own operational state. |
| **IntrospectionEngine Error Bridge** | Detects rising error trends from ErrorAggregator, generates architectural insights (`error-pattern` type). |

---

## 14. Security Model Summary

| Attack vector | Mitigation |
|---|---|
| Agent weakens own safety | Hash-locked critical files (SHA-256) + PreservationInvariants (semantic diff analysis blocks safety regression) |
| LLM generates dangerous code | AST scanner (20+ rules) + regex fallback |
| Renderer XSS | CSP headers + `contextIsolation: true` + `sandbox: true` |
| IPC flooding | Token-bucket rate limiter per channel |
| IPC injection | Input type + length validation in kernel |
| Path traversal | SafeGuard validates all write paths against project root |
| Sandbox escape | VM prototype isolation + Linux namespace isolation |
| Peer impersonation | PBKDF2 session keys + HMAC authentication |
| Runaway execution | Global 10 min timeout + step limits + approval gates |
| Concurrent write corruption | WriteLock (per-file mutex) + atomic writes (temp + rename) |

---

## 15. Cognitive Self-Awareness (v5.9.8)

Genesis is the first AI agent framework with **empirical cognitive self-awareness** — it measures its own performance and adjusts behavior based on data, not assumptions.

| Feature | What it does |
|---|---|
| **CognitiveSelfModel** | Continuously updated model of the agent's capabilities, weaknesses, and failure patterns. Wilson-calibrated confidence intervals prevent overconfidence. |
| **Capability Profile** | Per-task-type success rates with conservative confidence floors. `isWeak`/`isStrong` flags for automatic risk assessment. |
| **Backend Strength Map** | Empirical matrix of which LLM backend performs best for each task type. Recommendations sorted by Wilson confidence, not raw rates. |
| **Bias Detection** | Four pattern detectors: scope-underestimate, token-overuse, error-repetition, backend-mismatch. Active biases surfaced in dashboard and LLM prompts. |
| **Proactive Disclosure** | Before every task: confidence level, known risks, and recommendation injected into the LLM system prompt. The agent knows its own limitations. |
| **TaskOutcomeTracker** | Records structured outcomes (type, backend, success, cost, duration) from 4 event sources. Persists across sessions. Capped at 2,000 records. |

**Example**: Before a refactoring task, the LLM prompt includes:
```
[Cognitive Self-Model] Capability floor (Wilson 90%): code-gen 71%↑ (n=12), chat 89%↑ (n=30).
Weakness: refactoring (scope-underestimate). Apply extra verification.
Current task (refactoring): confidence=low, risks: Low success rate 62% (confidence floor: 48%).
```

---

## 16. Context Window Management (v5.9.7–v5.9.8)

Automatic context budget tracking and compression to prevent token overflow.

| Feature | What it does |
|---|---|
| **DynamicContextBudget** | Intent-based token allocation. Code-gen tasks get 55% code context, 15% conversation. Chat tasks get 40% conversation, 10% code. Learns from successful allocations. |
| **ConversationCompressor** | LLM-based summarization of older conversation segments. Preserves decisions, code references, task state. Extractive fallback when no LLM available. |
| **Backend-Aware Limits** | `configureForModel()` reads context window per backend (8K for Gemma, 128K for Claude) and scales budgets with sqrt scaling (diminishing returns). |
| **CognitiveWorkspace onEvict** | When working memory slots are evicted, callers receive the evicted data via `onEvict(key, slot)` callback for persistence or summarization. |

---

## 17. Community Skill Ecosystem (v5.9.8)

Third-party skills can be installed, updated, and managed from external sources.

| Feature | What it does |
|---|---|
| **SkillRegistry** | Install skills from GitHub repos, GitHub Gists, npm packages, or direct archive URLs. |
| **Manifest Validation** | Every skill validated against `skill-manifest.schema.json` before code loads. Name pattern, semver version, entry file existence. |
| **Sandbox Isolation** | Community skills run in the same sandbox as built-in skills — VM isolation + Linux namespaces. |
| **Version Tracking** | Registry metadata persists source URL, version, install date. `update(name)` re-fetches from original source. |

**Example**:
```bash
# In Genesis CLI
genesis install https://github.com/community/genesis-skill-docker
genesis install npm:genesis-skill-kubernetes
genesis skills --list
genesis update genesis-skill-docker
genesis uninstall genesis-skill-docker
```

---

## 18. Agent Benchmarking (v5.9.8)

Standardized, reproducible benchmarks to measure agent capability across versions and backends.

| Feature | What it does |
|---|---|
| **8-task suite** | Code generation (3), bug fixing (2), refactoring (1), code analysis (1), chat (1). Each task has programmatic verification. |
| **Baseline comparison** | Save a run as baseline, compare future runs. Detects per-task regressions and overall success rate changes. |
| **Multi-backend** | Run the same suite against Ollama, Claude, OpenAI — compare empirically. |
| **CI-ready** | `--json` output for pipeline integration. Exit code reflects pass/fail. |

---

## 19. Closed-Loop Self-Improvement (v6.0.2)

Autonomous self-correction: Genesis detects its own weaknesses and acts to fix them, with empirical validation and automatic rollback.

No competing framework (LangChain, CrewAI, AutoGen, Devin) has this. They may log errors, but none prescribe and validate corrective action autonomously.

| Feature | What it does |
|---|---|
| **Bias-driven adaptation** | CognitiveSelfModel detects patterns (scope-underestimate, token-overuse, error-repetition, backend-mismatch). AdaptiveStrategy maps each bias to a concrete compensation: prompt mutation, backend routing change, or temperature adjustment. |
| **Empirical backend routing** | ModelRouter receives real performance data (Wilson-calibrated confidence per backend per task type) as a scoring bonus. The best backend for code-gen might differ from the best for analysis — now Genesis knows and routes accordingly. |
| **Benchmark validation** | Every adaptation is validated by QuickBenchmark (3 tasks). Regression > 5pp → automatic rollback. No blind changes. |
| **Lesson storage** | Every confirmed or rolled-back adaptation is stored as a lesson. Future self-awareness includes past adaptation outcomes — Genesis learns what works for itself. |
| **Safety guards** | Max 1 concurrent adaptation. 30-minute cooldown per type. Minimum 10 outcomes before adapting. Identity/safety prompt sections are immutable. |
| **Autonomous operation** | IdleMind `calibrate` activity runs the full cycle during idle time. No human intervention needed. CLI `/adapt` for manual trigger. |

---

## 20. Security Audit Hardening (v6.0.3)

Full security audit of all IPC handlers, sandbox isolation, and shell execution.

| Feature | What it does |
|---|---|
| **IPC validation** | All 52+ IPC handlers validated: `_validateStr` on all string inputs, path scope restriction, config structure validation. |
| **Sandbox isolation** | `fs.cp`/`cpSync` blocked, `appendFile` intercepted with write-path check, `safeCopy()` prototype chain fully independent via `Object.create(null)`. |
| **Shell hardening** | NFKC Unicode normalization in `_sanitizeCommand()` — fullwidth confusables (`ｒｍ` → `rm`) caught by blocklist. |
| **SA-P audit complete** | ArchitectureReflection (SA-P3), EmbodiedPerception (SA-P4), DynamicToolSynthesis (SA-P8) — all audited clean. |

---

## 21. Proportional Intelligence (v6.0.4)

Not every request needs the full cognitive pipeline. Genesis now scales effort to complexity.

| Feature | What it does |
|---|---|
| **CognitiveBudget** | Classifies requests into 4 tiers (TRIVIAL/MODERATE/COMPLEX/EXTREME). Greetings skip PromptBuilder entirely. Code tasks get the full pipeline. |
| **ExecutionProvenance** | Every response gets a causal trace: input → budget tier → intent → prompt sections → model selection → response metrics. Ring buffer of 100 traces. CLI `/trace` to inspect. |
| **AdaptivePromptStrategy** | Analyzes provenance traces to learn which prompt sections help per intent type. Automatically boosts effective sections and skips ineffective ones. Protected sections (identity, safety) are never skipped. |
| **Smart Model Ranking** | 35-tier pattern scoring (Claude=100, DeepSeek=92, minimax=15). First-run auto-selects the strongest available model instead of alphabetical first. |
| **Colony Consensus Proof** | 16/16 VectorClock + sync + conflict resolution tests. LWW conflict resolution verified. |
| **Awareness A/B** | Empirically validated: 0pp impact. Phase 13 (Consciousness) permanently removed in v7.0.0, replaced by lightweight AwarenessPort (2 modules, 112 LOC). |
| **Organism A/B** | Empirically validated: +33pp task success with Organism active. Stays enabled in all profiles. |

---

## 22. Offline-First & Consolidation (v6.0.5)

Network resilience, intelligence pipeline validation, and codebase consolidation.

| Feature | What it does |
|---|---|
| **NetworkSentinel** | Periodic connectivity monitoring (30s probes). 3 consecutive failures → offline. Auto-failover to best local Ollama model. Auto-restore on reconnect. Mutation queue (500 entries) replayed on reconnect. |
| **BodySchema live network** | `canAccessWeb` now reflects real connectivity from NetworkSentinel, not static effector presence. Constraints include failover status. |
| **Intelligence pipeline proof** | 16 integration tests validate the full CognitiveBudget → ExecutionProvenance → AdaptivePromptStrategy closed loop. 10-iteration convergence test proves no oscillation. |
| **Colony convergence proof** | 17 tests with real PeerConsensus cross-sync. Bidirectional A↔B, LWW conflicts, multi-round catch-up, 3-peer daisy-chain convergence. |
| **CLI: /network** | Network status — online/offline, failover state, Ollama availability, probe stats, queue size. |
| **CLI: /trace, /traces** | Provenance trace inspection — budget tier, intent, prompt sections, model, response metrics. |
| **IPC: Dashboard channels** | `agent:get-network-status`, `agent:force-network-probe`, `agent:get-provenance-report` — Dashboard can display network + provenance data. |
| **CC reduction** | `_buildPatternDB` refactored from CC=56 to CC=8 via declarative PATTERN_RULES table. SA-O1 closed. |
| **Event catalog clean** | `lesson:learned` + `prompt:strategy-updated` registered. 0 warnings, 0 errors. |
| **Coverage push** | Function coverage 69.6% → 80.0% (+10.4pp over v6.0.5). 355 new tests in v7.0.0. Ratchet 75/70/70 → 81/76/80. |
