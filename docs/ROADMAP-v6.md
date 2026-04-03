# Genesis — Development Roadmap

**v5.9.7. Prioritized by impact, not novelty.**

---

## Current State

| Metric | Value |
|--------|-------|
| Source Files / LOC | 227 / ~76.6k |
| Test Suites / Tests | 173 / ~2930 |
| Boot Phases | 13 |
| Registered Services | 121 |
| Circular Dependencies | 0 |
| Cross-Layer Violations | 0 |
| Shutdown Integrity | ✅ All 44 services, sync writes |
| Fitness Score | 90/90 (100%) |
| TypeScript CI | ✅ Strict mode, 0 errors |
| @ts-nocheck files | 0 (was 25) |
| Coverage Ratchet | 70/60/65 (lines/branches/functions) |

---

## Completed (detail in CHANGELOG.md)

| Version | Focus |
|---------|-------|
| v5.1.0  | Reliability: MCP CircuitBreaker, 100% test coverage, Windows compat, UI fixes, chat/model fixes |
| v5.2.0  | Observability: Correlation IDs, fitness trending, PromptEvolution, CC reduction, god-class extraction |
| v5.3.0  | Cognitive: SA-P5 OnlineLearner, SA-P6 CognitiveWorkspace, SA-P7 LessonsStore, boot profiles |
| v5.4.0  | Hardening: TypeScript strict CI, Dashboard extraction, WorldState CQRS-lite |
| v5.5.0  | Safety: PreservationInvariants (11 rules), ReasoningTracer, shutdown data-loss fixes |
| v5.6.0  | Tech debt: 12 god-class extractions, CC reduction, @ts-nocheck batches, SA-P4 Embodied Perception, DA-1/DA-2/DA-3 |
| v5.7.0  | Monitor cleanup + SA-P3 + SA-P8: CC>30 18→12, @ts-nocheck 101→25, ArchitectureReflection, DynamicToolSynthesis, ProjectIntelligence |
| v5.8.0  | MCP Bidirectional, Dashboard Overhaul (5 panels), @ts-nocheck 25→0, Channel sync fix |
| v5.9.0  | MCP Server Phase 2: Auto-start, Streamable HTTP, Resources (KnowledgeGraph + LessonsStore) |
| v5.9.1  | CLI UX: 12 bugs fixed from real-world testing — run-skill intent, retry, shell fix, log throttle, sandbox fixes |
| v5.9.2  | Hardening + V6 Foundations: MCP server security, CI strictness, coverage ratchet, Colony/Deploy foundations, UI Phase 2 complete (4 panels), Electron 39, CI badge |
| v5.9.3  | CI Fix + Quality Infrastructure: Green pipeline restored (audit:events:strict, TS6), ServiceRecovery (auto-healing), 3 built-in skills, lifecycle integration tests, release automation |
| v5.9.6  | Organism Context Containment: Homeostasis prompt containment (behavioral-only), organism context guard, formatting metric prohibition |
| v5.9.7  | SelfModel Data Layer + Context Overflow: TaskOutcomeTracker (V6-11 data collection), ConversationCompressor (V6-5 LLM-based history compression), coverage ratchet 70/60/65 |

### Completed SA Items

| ID   | Name | Version |
|------|------|---------|
| SA-P4 | Embodied Perception | v5.6.0 |
| SA-P3 | Architecture Reflection | v5.7.0 |
| SA-P8 | Dynamic Tool Synthesis | v5.7.0 |
| SA-P5 | Online Learning | v5.3.0 |
| SA-P6 | Working Memory (CognitiveWorkspace) | v5.3.0 |
| SA-P7 | Cross-Project Learning (LessonsStore) | v5.3.0 |
| Self-Preservation Invariants | PreservationInvariants.js | v5.5.0 |
| Reasoning Trace UI | ReasoningTracer.js | v5.5.0 |

---

## Open — v6.0 Roadmap

### V6-1: Colony-Mode (Multi-Agent Coordination)

Multiple Genesis instances working together on a shared goal.

- **✅ ColonyOrchestrator**: Foundation module — goal decomposition, peer distribution, result merge, conflict detection, consensus-gated merge (v5.9.2)
- **Task Decomposition**: A "lead" agent breaks a large goal into sub-tasks and distributes them to worker agents
- **Result Merge**: Worker results are merged, conflicts resolved (e.g. two agents modifying the same file)
- **Consensus Protocol**: Before code changes are applied, agents vote via peer consensus (PeerConsensus.js already exists)
- **Shared Memory**: Colony-wide KnowledgeGraph and LessonsStore — what one agent learns, all agents know
- **Remaining**: Real peer integration testing, shared KG sync, multi-file conflict resolution UI
- **Prerequisite**: PeerNetwork ✅, TaskDelegation ✅, PeerConsensus ✅, ColonyOrchestrator ✅
- **Effort**: Medium (remaining)

### V6-2: Extended MCP Integration (Bidirectional) — ✅ Complete

Genesis is both an MCP client and a full MCP server.

- **✅ Genesis as MCP Server**: Full MCP 2025-03-26 protocol (JSON-RPC error codes, CORS, health, ping, listChanged, resources)
- **✅ McpServerToolBridge**: 7 tools exposed (verify-code, verify-syntax, code-safety-scan, project-profile, project-suggestions, architecture-query, architecture-snapshot)
- **✅ Auto-Start**: `mcp.serve.enabled` + `mcp.serve.port` in Settings → McpServer starts automatically on boot
- **✅ Streamable HTTP**: POST with `Accept: text/event-stream` returns SSE response (MCP 2025-03-26 transport)
- **✅ Resource Subscriptions**: 4 resources exposed (knowledge-graph/stats, knowledge-graph/nodes, lessons/all, lessons/stats) with `resources/list_changed` notifications
- **✅ Session Tracking**: `Mcp-Session-Id` header tracked per connection
- **Prerequisite**: McpServer.js ✅, McpTransport ✅, ToolRegistry ✅, McpServerToolBridge ✅
- **Effort**: Complete

### V6-3: Live Deployment

Genesis deploys code changes into running systems — not just into itself.

- **✅ DeploymentManager**: Foundation module — strategy pattern (Direct/Canary/Rolling/Blue-Green), health checks, auto-rollback, step tracking (v5.9.2)
- **External Hot-Swap**: Replace modules in external Node.js processes (via IPC/Socket)
- **Rolling Update**: For multi-service projects: update service-by-service with health checks between each step
- **Deployment Verification**: After each deploy: health check, smoke tests, automatic rollback on failure
- **Environment Awareness**: Genesis knows dev/staging/prod and adapts deployment strategy
- **Remaining**: External process IPC, real rolling update with load balancer, canary traffic splitting
- **Prerequisite**: HotReloader ✅, ShellAgent ✅, EffectorRegistry ✅, TrustLevels ✅, DeploymentManager ✅
- **Effort**: Medium (remaining)

### V6-4: UI Overhaul — ✅ Complete

Modern dashboard that visualizes the new cognitive capabilities.

- **✅ Consciousness Panel**: PhenomenalField awareness meter, valence/arousal, attention gate, temporal self, values alignment
- **✅ Energy Panel**: Metabolism gauge with level coloring, LLM call cost tracking
- **✅ Architecture Panel**: Service/event/layer/coupling counts, phase map pills
- **✅ Project Intelligence Panel**: Tech stack grid, conventions summary
- **✅ Tool Synthesis Panel**: Generated/active/failed/evicted counts, active tool pills
- **✅ Interactive Architecture Graph**: SVG force-directed layout, drag, click-to-highlight, phase-colored, hover tooltips (v5.9.2)
- **✅ Reasoning Trace Decision Trees**: Grouped by correlationId, collapsible chains, step connector visualization (v5.9.2)
- **✅ Proactive Insights Timeline**: IdleMind activities chronologically, thought counter, idle/active status, activity icons (v5.9.2)
- **✅ Coupling Hotspot Heatmap**: Top-20 services by connection count, heat-colored bars, in/out counts (v5.9.2)
- **Prerequisite**: Dashboard.js ✅, IPC channels ✅, all backend data available ✅, ArchitectureGraph.js ✅

### V6-5: Context Window Manager

Automatic context budget tracking and compression to prevent token overflow.

- **✅ ContextBudget Service**: DynamicContextBudget tracks token usage per LLM call, intent-based allocation profiles (v4.10.0)
- **✅ Auto-Summarization**: ConversationCompressor — LLM-based history compression with extractive fallback, caching, ContextManager integration (v5.9.7)
- **Slot Integration**: Works with CognitiveWorkspace slots — evicted slots get summarized, not discarded
- **Backend-Aware Limits**: Reads max_tokens per backend (Anthropic/OpenAI/Ollama) and adapts budget dynamically
- **Remaining**: Slot integration, backend-aware dynamic limits
- **Prerequisite**: CognitiveWorkspace ✅, LLMPort ✅, AttentionalGate ✅, DynamicContextBudget ✅, ConversationCompressor ✅
- **Effort**: Low (remaining)
- **Priority**: High — directly improves output quality on long tasks

### V6-6: Skill Registry (Community Skills)

Discover, install, and manage third-party skills from external sources.

- **`genesis install <url>`**: Install skills from GitHub Gist, npm, or direct URL
- **Manifest Validation**: All installed skills validated against `skill-manifest.schema.json`
- **Sandbox Isolation**: Community skills run in existing sandbox with restricted permissions
- **Skill List / Search**: `genesis skills --available` queries a public registry index
- **Uninstall + Update**: Version tracking, `genesis update <skill>`, clean removal
- **Prerequisite**: SkillManager ✅, Sandbox ✅, skill-manifest.schema.json ✅
- **Effort**: Medium
- **Priority**: High — lowers barrier for external contributors

### V6-7: Memory Consolidation

Periodic pruning and merging of KnowledgeGraph and LessonsStore to prevent unbounded growth.

- **MemoryConsolidator Service**: Runs on IdleMind schedule or manual trigger
- **Redundancy Detection**: LLM-assisted merge of semantically duplicate KG nodes
- **Lesson Archival**: Lessons older than N days with low access count → archived to `~/.genesis-lessons/archive/`
- **Relevance Scoring**: Each KG node gets a decay-weighted relevance score (recency × access frequency)
- **Compaction Report**: Dashboard panel showing consolidation stats (merged/archived/retained)
- **Prerequisite**: KnowledgeGraph ✅, LessonsStore ✅, IdleMind ✅
- **Effort**: Medium
- **Priority**: Medium — prevents long-term performance degradation

### V6-8: Task Replay / Debug Mode

Record and deterministically replay complete task executions for debugging and regression testing.

- **TaskRecorder**: Serializes full execution trace (events, LLM calls, tool invocations, decisions) to `.genesis-replay` files
- **Deterministic Replay**: Replay with mocked LLM responses reproduces exact execution path
- **Diff View**: Compare two replays side-by-side (e.g. before/after a code change)
- **Integration with ReasoningTracer**: Replay visualized in existing Reasoning Trace Decision Trees panel
- **Prerequisite**: ReasoningTracer ✅, EventBus ✅, CorrelationIds ✅
- **Effort**: High
- **Priority**: Medium — unique differentiator, no competitor has this

### V6-9: Agent Benchmarking Suite

Standardized benchmarks to measure agent capability across versions and backends.

- **`scripts/benchmark-agent.js`**: Runs predefined task suite (code-gen, bug-fix, refactoring, multi-file edit)
- **Metrics**: Success rate, token consumption, latency, cost per task, per backend
- **Regression Detection**: Compare current run vs. baseline — flag capability regressions
- **README Integration**: Auto-generate benchmark table for README comparison section
- **Prerequisite**: SkillManager ✅, LLMPort ✅, Sandbox ✅
- **Effort**: Medium
- **Priority**: Medium — provides hard numbers for competitive positioning

### V6-10: Offline-First / Ollama Priority Mode

Graceful degradation to local-only operation when no internet is available.

- **Network Detection**: Periodic connectivity check, automatic backend failover
- **Ollama Auto-Switch**: When cloud backends unreachable, route all LLM calls to Ollama
- **KG Cache**: Local snapshot of KnowledgeGraph for offline queries
- **Degradation Matrix Extension**: Add network-aware rules to existing DegradationMatrix
- **Sync on Reconnect**: Queue mutations during offline, sync to cloud backends on reconnect
- **Prerequisite**: DegradationMatrix ✅, OllamaBackend ✅, KnowledgeGraph ✅
- **Effort**: Low–Medium
- **Priority**: Medium — natural extension of existing degradation infrastructure

### V6-11: Cognitive SelfModel

A continuously updated internal model of the agent's own capabilities, weaknesses, and failure patterns. No existing AI agent framework has this.

- **✅ TaskOutcomeTracker**: Data collection layer — records structured task outcomes (type, backend, success, cost, duration) from 4 event sources. Aggregate stats API. Persistence. Phase 9 manifest. (v5.9.7)
- **SelfModel Service**: Phase 9 cognitive service, updated after every completed task via OnlineLearner trigger
- **Capability Profile**: Empirical success/failure rate per task type (code-gen, refactoring, bug-fix, multi-file edit, research) with confidence intervals
- **Calibrated Estimation**: Predicted vs. actual duration/token cost per task type — accuracy improves over time
- **Backend Strength Map**: Per-backend (Anthropic/OpenAI/Ollama) empirical performance matrix — which backend excels at which task type, measured not assumed
- **Bias Detection**: Pattern extraction from own failures — "tends to over-engineer", "misses edge cases in async code", "underestimates multi-file refactoring scope"
- **Proactive Disclosure**: Before task execution: reports own confidence level and known risk factors for the task type
- **Colony Integration**: In V6-1 colony mode, each worker shares its SelfModel → lead agent routes tasks to the best-suited worker
- **Dashboard Panel**: Capability radar chart, calibration drift graph, bias log, per-backend comparison
- **Data Sources**: TaskOutcomeTracker (raw outcomes) ✅, ReasoningTracer (raw decisions) ✅, LessonsStore (historical patterns) ✅, CognitiveWorkspace (cognitive context) ✅, PreservationInvariants (overconfidence guard) ✅, OnlineLearner (update trigger) ✅
- **Preservation Rule**: SelfModel MUST NOT overestimate capabilities — PreservationInvariants enforces pessimistic calibration
- **Prerequisite**: TaskOutcomeTracker ✅, ReasoningTracer ✅, LessonsStore ✅, CognitiveWorkspace ✅, PreservationInvariants ✅, OnlineLearner ✅
- **Effort**: Medium (remaining — data layer complete, SelfModel service + dashboard remain)
- **Priority**: Critical — unique differentiator with no equivalent in any competing framework (LangChain, CrewAI, AutoGen, Devin). Genesis is the only project with the cognitive substrate to implement this.

---

## Explicitly Deferred

| Proposal | Reason |
|----------|--------|
| Predictive Load Balancer | Over-engineering for single-user desktop. Revisit for colony mode. |
| Shadow Execution for SelfMod | Existing sandbox + snapshot rollback covers 90%. Input replay is v7.0+. |
| Remove Consciousness Layer | Integration exists and is tested. Indirect influence via prompt context is the intended design. |
| Full OpenTelemetry | Too heavy. Correlation IDs provide 80% of the tracing value at 5% of the complexity. |

---

## How to Use This Roadmap

1. Run `node scripts/architectural-fitness.js` before starting any sprint.
2. Run `node scripts/fitness-trend.js` to check for drift.
3. Pick the highest-priority open item.
4. Implement, test, verify fitness score.
5. Don't add features that lower the fitness score.

**The rule: reliability before capability. Fix what's broken before building what's missing.**
